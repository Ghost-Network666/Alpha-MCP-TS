import {
  createPublicClient,
  createSecureClient,
  type PublicClient,
  type SecureClient,
  type PublicActions,
  type SecureActions,
  relayerApiKey,
} from '@polymarket/client';
import { builderApiKey } from '@polymarket/client/node';
import { privateKey } from '@polymarket/client/viem';
import { logger } from '../utils/logger.js';
import { requireAuthEnv } from './env.js';

let publicClientInstance: PublicClient<PublicActions, SecureActions> | null = null;
let secureClientInstance: SecureClient<PublicActions, SecureActions> | null = null;

export function getPublicClient(): PublicClient<PublicActions, SecureActions> {
  if (!publicClientInstance) {
    publicClientInstance = createPublicClient();
    logger.debug('Public client initialized');
  }
  return publicClientInstance;
}

/**
 * Creates (or returns cached) authenticated SecureClient.
 * Uses the unified @polymarket/ts-sdk for all operations (no custom fetch, no raw REST).
 * Automatically configures API key auth if builder/relayer keys present in env.
 * Call setupTradingApprovals() separately when needed for first-time wallets.
 */
export async function getSecureClient(): Promise<SecureClient<PublicActions, SecureActions>> {
  if (secureClientInstance) return secureClientInstance;

  // This will print a clear, friendly error + exit if keys are missing/invalid
  const auth = requireAuthEnv();

  const signer = privateKey(auth.PRIVATE_KEY);

  const options: Parameters<typeof createSecureClient>[0] = {
    wallet: auth.WALLET_ADDRESS,
    signer,
  };

  // Prefer builder API key (recommended for production attribution + limits)
  if (auth.BUILDER_API_KEY && auth.BUILDER_SECRET && auth.BUILDER_PASSPHRASE) {
    options.apiKey = builderApiKey({
      key: auth.BUILDER_API_KEY,
      secret: auth.BUILDER_SECRET,
      passphrase: auth.BUILDER_PASSPHRASE,
    });
    logger.info('Using Builder API key authentication');
  } else if (auth.RELAYER_API_KEY && auth.RELAYER_API_KEY_ADDRESS) {
    options.apiKey = relayerApiKey({
      key: auth.RELAYER_API_KEY,
      address: auth.RELAYER_API_KEY_ADDRESS,
    });
    logger.info('Using Relayer API key authentication');
  } else {
    logger.warn('No API key configured — using L1 wallet signature auth (lower rate limits)');
  }

  secureClientInstance = await createSecureClient(options);
  logger.info('Secure client initialized', { wallet: auth.WALLET_ADDRESS });

  return secureClientInstance;
}

/**
 * One-time setup for new wallets. Call this manually or on first run.
 * Sets up gasless wallet (if using relayer) + trading approvals (CTF + collateral).
 */
export async function ensureTradingSetup(secureClient: SecureClient<PublicActions, SecureActions>): Promise<void> {
  // Belt-and-suspenders: ensure we have valid auth even if someone calls this directly
  requireAuthEnv();

  const isGasless = await secureClient.isGaslessReady().catch(() => false);
  if (!isGasless) {
    logger.info('Setting up gasless wallet...');
    try {
      const updated = await secureClient.setupGaslessWallet();
      secureClientInstance = updated; // replace cached
      logger.info('Gasless wallet setup complete');
    } catch (err) {
      logger.warn('Gasless setup skipped or failed (may not be required)', { error: (err as Error).message });
    }
  }

  // Always ensure trading approvals (idempotent-ish)
  logger.info('Ensuring trading approvals (ERC20 + CTF setApprovalForAll)...');
  const handle = await secureClient.setupTradingApprovals();
  await handle.wait();
  logger.info('Trading approvals confirmed');
}
