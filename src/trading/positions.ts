/**
 * Unified Position Lifecycle (CTF On-Chain Actions)
 *
 * The @polymarket/client SDK provides a single surface for everything:
 * - Gamma (markets/events)
 * - Data & Orderbook
 * - CLOB trading
 * - WebSocket subscriptions
 * - CTF on-chain actions (split / merge / redeem)
 * - Gasless wallet + trading approvals
 *
 * This module wraps the on-chain position management flows using only SDK methods.
 */
import type { TransactionHandle, TransactionOutcome } from '@polymarket/client';
import { getSecureClient } from '../config/client.js';
import { withErrorHandling } from '../utils/errors.js';
import { logger, logTrade } from '../utils/logger.js';
import { collectAll } from '../utils/pagination.js';

const secure = () => getSecureClient();

/**
 * Split collateral (pUSD / USDC) into a complete set of outcome tokens for a condition.
 * This is the on-chain CTF action that lets you obtain Yes/No (or multi-outcome) tokens.
 */
export async function splitPosition(params: {
  conditionId: string;
  amount: bigint; // in smallest units (usually 6 decimals for USDC)
  /** Optional: wait for the transaction to be mined */
  wait?: boolean;
}): Promise<TransactionHandle | TransactionOutcome> {
  const client = await secure();
  logTrade('Splitting position (on-chain CTF)', {
    conditionId: params.conditionId.slice(0, 10) + '...',
    amount: params.amount.toString(),
  });

  const handle = await withErrorHandling(
    () => client.splitPosition({ conditionId: params.conditionId as any, amount: params.amount }),
    'positions.splitPosition'
  );

  if (params.wait) {
    const outcome = await handle.wait();
    logger.info('Split transaction confirmed', { tx: outcome.transactionHash });
    return outcome;
  }
  return handle;
}

/**
 * Merge a complete set of outcome tokens back into collateral.
 * The inverse of splitPosition.
 */
export async function mergePositions(params: {
  conditionId: string;
  amount: bigint | 'max';
  wait?: boolean;
}): Promise<TransactionHandle | TransactionOutcome> {
  const client = await secure();
  logTrade('Merging positions (on-chain CTF)', {
    conditionId: params.conditionId.slice(0, 10) + '...',
    amount: String(params.amount),
  });

  const handle = await withErrorHandling(
    () => client.mergePositions({ conditionId: params.conditionId as any, amount: params.amount }),
    'positions.mergePositions'
  );

  if (params.wait) {
    const outcome = await handle.wait();
    logger.info('Merge transaction confirmed', { tx: outcome.transactionHash });
    return outcome;
  }
  return handle;
}

/**
 * Redeem winning outcome tokens after a market has resolved.
 * This is how you turn resolved Yes/No tokens back into collateral.
 */
export async function redeemPositions(params: {
  marketId: string; // or conditionId in some flows
  wait?: boolean;
}): Promise<TransactionHandle | TransactionOutcome> {
  const client = await secure();
  logTrade('Redeeming resolved positions (on-chain CTF)', {
    marketId: params.marketId,
  });

  const handle = await withErrorHandling(
    () => client.redeemPositions({ marketId: params.marketId as any }),
    'positions.redeemPositions'
  );

  if (params.wait) {
    const outcome = await handle.wait();
    logger.info('Redeem transaction confirmed', { tx: outcome.transactionHash });
    return outcome;
  }
  return handle;
}

/**
 * Transfer ERC-20 (usually the collateral token pUSD/USDC) out of the platform wallet/proxy.
 */
export async function transferCollateral(params: {
  amount: bigint;
  recipientAddress: string;
  wait?: boolean;
}): Promise<TransactionHandle | TransactionOutcome> {
  const client = await secure();
  const collateralToken = (client as any).environment?.collateralToken;

  logTrade('Transferring collateral (ERC-20)', {
    to: params.recipientAddress,
    amount: params.amount.toString(),
    token: collateralToken,
  });

  const handle = await withErrorHandling(
    () =>
      client.transferErc20({
        amount: params.amount,
        recipientAddress: params.recipientAddress as any,
        tokenAddress: collateralToken,
      }),
    'positions.transferCollateral'
  );

  if (params.wait) {
    const outcome = await handle.wait();
    logger.info('Transfer confirmed', { tx: outcome.transactionHash });
    return outcome;
  }
  return handle;
}

/**
 * One-time (or idempotent) setup for gasless trading + CTF approvals.
 * Already exposed via config/client.ts ensureTradingSetup, but provided here for convenience.
 *
 * Updated for latest SDK: approvals idempotent; gasless/deposit defaults in createSecureClient;
 * setupGaslessWallet deprecated no-op.
 */
export async function setupTradingEnvironment(): Promise<void> {
  const client = await secure();
  logger.info('Running full trading environment setup (gasless + CTF approvals)...');

  const isGasless = await client.isGaslessReady().catch(() => false);
  if (!isGasless) {
    // Note: per latest SDK, gasless setup for deposit wallets is automatic inside createSecureClient.
    // setupGaslessWallet is @deprecated no-op. Call kept for compat.
    await client.setupGaslessWallet().catch(() => {});
    logger.info('Gasless setup invoked (may be no-op)');
  }

  // setupTradingApprovals is now idempotent per SDK update.
  const handle = await client.setupTradingApprovals();
  await handle.wait();
  logger.info('CTF + ERC20 trading approvals confirmed on-chain');
}

/**
 * List both open and closed positions for the authenticated wallet (unified via SDK).
 * Returns a Paginated for open positions (so callers can demo collectAll) + a small array of closed positions.
 */
export async function getAllPositions(marketIds?: string[]) {
  const client = await secure();

  const openPositionsPaginator = client.listPositions({ market: marketIds, pageSize: 100 });

  let closedPositions: any[] = [];
  try {
    const closedFn = (client as any).listClosedPositions;
    if (typeof closedFn === 'function') {
      const closedPaginator = closedFn.call(client, { market: marketIds });
      closedPositions = await collectAll(closedPaginator, { maxPages: 3 });
    }
  } catch (err: any) {
    logger.debug('listClosedPositions unavailable or failed', { error: err?.message });
  }

  // The paginator pattern is handled by our collectAll in most places.
  // Here we return the raw paginator for open + collected closed sample for flexibility/demo.
  return { openPositionsPaginator, closedPositions };
}
