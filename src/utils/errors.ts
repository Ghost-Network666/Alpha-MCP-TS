import {
  ListMarketsError,
  ListEventsError,
  FetchMarketError,
  FetchOrderBookError,
  FetchPriceError,
  PlaceLimitOrderError,
  PlaceMarketOrderError,
  CancelOrderError,
  ListOpenOrdersError,
  ListPositionsError,
  ListActivityError,
} from '@polymarket/client';
import { logger, logError } from './logger.js';

export function isSdkError(error: unknown): boolean {
  return (
    ListMarketsError.isError(error) ||
    ListEventsError.isError(error) ||
    FetchMarketError.isError(error) ||
    FetchOrderBookError.isError(error) ||
    FetchPriceError.isError(error) ||
    PlaceLimitOrderError.isError(error) ||
    PlaceMarketOrderError.isError(error) ||
    CancelOrderError.isError(error) ||
    ListOpenOrdersError.isError(error) ||
    ListPositionsError.isError(error) ||
    ListActivityError.isError(error)
  );
}

export function handleSdkError(error: unknown, context: string): never | void {
  if (isSdkError(error)) {
    const e = error as any;
    if (e?.name === 'RateLimitError') {
      logger.warn(`Rate limited in ${context}. Backing off...`, { context });
    } else if (e?.name === 'RequestRejectedError') {
      logger.error(`Request rejected in ${context}: ${e.message}`, { context, code: e.code });
    } else {
      logError(`SDK error in ${context}`, error);
    }
    throw error;
  }
  logError(`Unexpected error in ${context}`, error);
  throw error;
}

/**
 * Wrap an SDK call with standardized error handling + logging.
 */
export async function withErrorHandling<T>(
  fn: () => Promise<T>,
  context: string
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    handleSdkError(error, context);
    throw error; // unreachable but satisfies TS
  }
}

/** Simple sleep for backoff */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rate limit resilient wrapper for SDK calls.
 * On RateLimitError it does exponential backoff with jitter (max 3 attempts).
 * Returns a structured result so the agent can react gracefully instead of the
 * MCP host seeing repeated hard failures that mark the server "unreachable".
 */
export async function callWithRateLimitProtection<T>(
  fn: () => Promise<T>,
  context: string,
  maxRetries = 2
): Promise<{ ok: true; data: T } | { ok: false; rateLimited: true; retryAfterMs: number; message: string }> {
  let attempt = 0;
  let delay = 1200; // start ~1.2s

  while (true) {
    try {
      const data = await fn();
      return { ok: true, data };
    } catch (error: any) {
      const isRateLimit =
        error?.name === 'RateLimitError' ||
        /rate limit|too many requests|429/i.test(String(error?.message || ''));

      if (!isRateLimit || attempt >= maxRetries) {
        if (isRateLimit) {
          logger.warn(`Rate limited in ${context} after ${attempt + 1} attempts`, { context });
          return {
            ok: false,
            rateLimited: true,
            retryAfterMs: Math.floor(delay * 1.8),
            message: `Rate limited ${context}. Wait ~${Math.ceil(delay / 1000)}s before retrying this type of call.`
          };
        }
        // Non-rate-limit error — let the normal error path handle it
        throw error;
      }

      // Rate limited — back off
      const jitter = Math.floor(Math.random() * 400);
      const wait = delay + jitter;
      logger.warn(`Rate limited in ${context} (attempt ${attempt + 1}). Backing off ${wait}ms`, { context });
      await sleep(wait);

      delay = Math.min(delay * 1.7, 8000); // cap around 8s
      attempt++;
    }
  }
}
