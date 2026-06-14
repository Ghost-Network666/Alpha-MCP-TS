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
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { logger } from '../utils/logger.js';
import { resolveClobAccountIdentity } from './account-identity.js';
import { withAccountIdentity } from './secure-client-wrap.js';

// Per official ts-sdk: createPublicClient() / createSecureClient({ signer, wallet?, credentials?, apiKey? }) + .extend(allActions).
// See https://github.com/Polymarket/ts-sdk/tree/main/packages/client

let publicClientInstance: PublicClient<PublicActions, SecureActions> | null = null;
let secureClientInstance: SecureClient<PublicActions, SecureActions> | null = null;

export function getPublicClient(): PublicClient<PublicActions, SecureActions> {
  if (!publicClientInstance) {
    const raw = createPublicClient();
    publicClientInstance = raw.extend(allActions);
    logger.debug('Public client initialized (with allActions)');
  }
  return publicClientInstance;
}

function buildRelayerApiKey(): { key: string; address: string } | undefined {
  if (process.env.RELAYER_API_KEY && process.env.RELAYER_API_KEY_ADDRESS) {
    return { key: process.env.RELAYER_API_KEY, address: process.env.RELAYER_API_KEY_ADDRESS };
  }
  return undefined;
}

function buildClobCredentials():
  | { key: string; secret: string; passphrase: string }
  | undefined {
  const key = process.env.CLOB_API_KEY;
  const secret = process.env.CLOB_SECRET;
  const passphrase = process.env.CLOB_PASS_PHRASE;
  if (key && secret && passphrase) {
    return { key, secret, passphrase };
  }
  return undefined;
}

/**
 * Authenticated client per ts-sdk `createSecureClient`:
 * - L2 CLOB creds from `CLOB_API_KEY` / `CLOB_SECRET` / `CLOB_PASS_PHRASE` when set
 * - Relayer gasless via `apiKey` when set
 * - Account identity corrected via `CLOB_SIGNATURE_TYPE` for balance/orders (POLY_PROXY funder accounts)
 */
export async function getSecureClient(): Promise<SecureClient<PublicActions, SecureActions>> {
  if (secureClientInstance) return secureClientInstance;

  const pk = process.env.EOA_PRIVATE_KEY || process.env.PRIVATE_KEY;
  const wallet = process.env.DEPOSIT_WALLET_ADDRESS || process.env.WALLET_ADDRESS;

  if (!pk) {
    throw new Error('Missing EOA_PRIVATE_KEY/PRIVATE_KEY for secure client');
  }

  const signer = privateKey(pk);
  const config: Parameters<typeof createSecureClient>[0] = { signer };

  if (wallet) {
    config.wallet = wallet;
  }

  const credentials = buildClobCredentials();
  if (credentials) {
    config.credentials = credentials as Parameters<typeof createSecureClient>[0]['credentials'];
  }

  const apiKey = buildRelayerApiKey();
  if (apiKey) {
    config.apiKey = apiKey;
  }

  const raw = await createSecureClient(config);
  const extended = raw.extend(allActions);
  const account = resolveClobAccountIdentity(extended.account, wallet);
  secureClientInstance = withAccountIdentity(extended, account);

  logger.info('Secure client initialized (ts-sdk createSecureClient + credentials + CLOB account identity)', {
    walletType: account.walletType,
    signer: account.signer,
    wallet: account.wallet,
    hasClobCredentials: !!credentials,
    hasRelayer: !!apiKey,
  });

  return secureClientInstance;
}

/** Reset cached client (tests / after env reload). */
export function resetSecureClient(): void {
  secureClientInstance = null;
}

export async function setupGaslessWallet(): Promise<SecureClient<PublicActions, SecureActions>> {
  const current = await getSecureClient();
  const updated = await current.setupGaslessWallet();
  const account = resolveClobAccountIdentity(updated.account);
  secureClientInstance = withAccountIdentity(updated.extend(allActions), account);
  logger.info('Gasless wallet setup complete', { walletType: account.walletType });
  return secureClientInstance;
}

export async function ensureTradingSetup(secureClient: SecureClient<PublicActions, SecureActions>): Promise<void> {
  const isGasless = await secureClient.isGaslessReady().catch(() => false);
  if (!isGasless) {
    logger.info('Gasless not ready (automatic for deposit wallets in createSecureClient)...');
  }

  logger.info('Ensuring trading approvals (idempotent)...');
  const handle = await secureClient.setupTradingApprovals();
  await handle.wait();
  logger.info('Trading approvals confirmed');
}

/**
 * Generate official Builder API authentication headers using the dedicated
 * @polymarket/builder-signing-sdk (the missing piece from Polymarket GitHub org).
 * This provides a robust, up-to-date way to sign for builder auth (gasless attribution,
 * builder API calls, etc.), future-proofing the direct HMAC path.
 *
 * Use when BUILDER_API_KEY/SECRET/PASSPHRASE are configured.
 * Supports local creds (primary for MCP) or remote signer.
 */
export async function generateBuilderHeaders(
  method: string,
  path: string,
  body?: string,
  timestamp?: number
): Promise<any> {
  const key = process.env.BUILDER_API_KEY;
  const secret = process.env.BUILDER_SECRET;
  const passphrase = process.env.BUILDER_PASSPHRASE;

  if (!key || !secret || !passphrase) {
    return undefined;
  }

  const builderConfig = new BuilderConfig({
    localBuilderCreds: {
      key,
      secret,
      passphrase,
    },
  });

  if (!builderConfig.isValid()) {
    logger.warn('Builder config invalid for header generation');
    return undefined;
  }

  const headers = await builderConfig.generateBuilderHeaders(method, path, body, timestamp);
  logger.debug('Generated builder headers via @polymarket/builder-signing-sdk', { method, path });
  return headers;
}

/** Convenience for common POST /order etc. */
export async function getBuilderAuthHeadersForOrder(body: string): Promise<any> {
  return generateBuilderHeaders('POST', '/order', body);
}