import {
  createPublicClient,
  createSecureClient,
  allActions,
  type PublicClient,
  type SecureClient,
  type PublicActions,
  type SecureActions,
} from '@polymarket/client';
import { privateKey } from '@polymarket/client/viem';
import { logger } from '../utils/logger.js';

// Per official ts-sdk README (primary source): use createPublicClient() for read-only,
// createSecureClient({ signer: privateKey(pk) from /viem, wallet: DEPOSIT_WALLET_ADDRESS, ... })
// then .extend(allActions) for the full decorated surface (listMarkets, placeLimitOrder, etc.).
// See https://github.com/Polymarket/ts-sdk/blob/main/README.md and packages/client for canonical patterns.

let publicClientInstance: PublicClient<PublicActions, SecureActions> | null = null;
let secureClientInstance: SecureClient<PublicActions, SecureActions> | null = null;

export function getPublicClient(): PublicClient<PublicActions, SecureActions> {
  if (!publicClientInstance) {
    // Per official ts-sdk: createPublicClient() + .extend(allActions) for full surface (listMarkets etc.).
    // See official README/packages/client for client creation and decorators.
    const raw = createPublicClient();
    publicClientInstance = raw.extend(allActions);
    logger.debug('Public client initialized (with allActions)');
  }
  return publicClientInstance;
}

/**
 * Creates the SecureClient using exactly the pattern in the official ts-sdk README (PRIMARY, with deposit wallet defaults):
 *   createSecureClient({ signer: privateKey(...) from @polymarket/client/viem , wallet? (omitted => SDK derives current Deposit Wallet), apiKey? for relayer etc. })
 *   then .extend(allActions).
 * See https://github.com/Polymarket/ts-sdk/blob/main/README.md + packages/client/src/clients.ts (latest: default secure to deposit, setupGasless no-op).
 *
 * Per latest SDK: if no WALLET env, omit to let SDK default to signer's deterministic Deposit Wallet (auto-deploy if needed for DEPOSIT_WALLET).
 * Gasless setup now happens inside createSecureClient for non-EOA; setupGaslessWallet is @deprecated no-op.
 */
export async function getSecureClient(): Promise<SecureClient<PublicActions, SecureActions>> {
  if (secureClientInstance) return secureClientInstance;

  const pk = process.env.EOA_PRIVATE_KEY || process.env.PRIVATE_KEY;
  const wallet = process.env.DEPOSIT_WALLET_ADDRESS || process.env.WALLET_ADDRESS;

  if (!pk) {
    throw new Error('Missing EOA_PRIVATE_KEY/PRIVATE_KEY for secure client');
  }

  const signer = privateKey(pk);

  // Full exhaustive auth support per SDK createSecureClient options + spec (relayer/builder/apiKey for gasless/attribution + EOA signer + optional deposit wallet).
  // Explicit extend(allActions) for full surface (trading, wallet, secure account, rewards, etc.).
  // Align to new default: pass wallet only if provided; SDK will default to derived Deposit Wallet.
  const config: any = { signer };
  if (wallet) {
    config.wallet = wallet;
  }
  if (process.env.RELAYER_API_KEY && process.env.RELAYER_API_KEY_ADDRESS) {
    config.apiKey = { key: process.env.RELAYER_API_KEY, address: process.env.RELAYER_API_KEY_ADDRESS };
  } else if (process.env.BUILDER_API_KEY && process.env.BUILDER_SECRET && process.env.BUILDER_PASSPHRASE) {
    // Builder HMAC path (SDK accepts via other means or post; here we note for completeness; gasless prefers relayer).
    config.builder = { key: process.env.BUILDER_API_KEY, secret: process.env.BUILDER_SECRET, passphrase: process.env.BUILDER_PASSPHRASE };
  }
  const raw = await createSecureClient(config);
  secureClientInstance = raw.extend(allActions);
  logger.info('Secure client initialized (full auth support + EOA signer + deposit wallet default per latest SDK, with allActions)');
  return secureClientInstance;
}

/**
 * Call setupGaslessWallet on the current secure client and replace the cached
 * instance with the returned client (per SDK contract and MCP requirement).
 * Returns the new client.
 *
 * Per latest SDK (feat: default secure client to deposit wallet): setupGaslessWallet is
 * @deprecated and a no-op (returns client as-is). Gasless/deposit wallet setup is now
 * performed inside createSecureClient for non-EOA wallets. Kept for compat + MCP tool.
 */
export async function setupGaslessWallet(): Promise<SecureClient<PublicActions, SecureActions>> {
  const current = await getSecureClient();
  const updated = await current.setupGaslessWallet();
  secureClientInstance = updated;
  logger.info('Gasless wallet setup (no-op per latest SDK deposit default; handled at createSecureClient)');
  return updated;
}

/**
 * Convenience for library consumers: ensure gasless + approvals on a client you hold.
 * For MCP, use the 'setup_gasless_wallet' tool + the trading approval tools directly.
 *
 * Per latest SDK: approvals are idempotent (safe to call repeatedly). Gasless setup
 * is handled at create time for deposit wallets; setupGaslessWallet is no-op.
 */
export async function ensureTradingSetup(secureClient: SecureClient<PublicActions, SecureActions>): Promise<void> {
  // Gasless/deposit now defaulted in createSecureClient (per feat default to deposit wallet).
  // isGaslessReady + setupGaslessWallet kept for compat but no longer required for standard flows.
  const isGasless = await secureClient.isGaslessReady().catch(() => false);
  if (!isGasless) {
    logger.info('Gasless not ready (setup now automatic for deposit wallets in createSecureClient)...');
  }

  // Approvals now idempotent per latest SDK.
  logger.info('Ensuring trading approvals (ERC20 + CTF setApprovalForAll, idempotent)...');
  const handle = await secureClient.setupTradingApprovals();
  await handle.wait();
  logger.info('Trading approvals confirmed');
}
