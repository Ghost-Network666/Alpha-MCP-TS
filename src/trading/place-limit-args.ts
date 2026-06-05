/**
 * Normalize place_limit_order args for SDK PrepareLimitOrderRequest only:
 * tokenId, price, size, side, postOnly?, expiration? — no orderType on wire.
 * @see @polymarket/client PrepareLimitOrderRequest
 */

export type PlaceLimitOrderNormalizeResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; error: string; agentDirective: string };

export function normalizePlaceLimitOrderArgs(
  args: Record<string, unknown>
): PlaceLimitOrderNormalizeResult {
  const rawType =
    args.orderType != null ? String(args.orderType).toUpperCase() : 'GTC';

  if (rawType === 'FOK' || rawType === 'FAK') {
    return {
      ok: false,
      error: `SDK placeLimitOrder does not support orderType ${rawType}.`,
      agentDirective:
        'Use place_market_order({ tokenId, side, amount or shares, orderType: "FAK"|"FOK" }) per SDK. Limit path is GTC (default) or GTD (expiration unix seconds).',
    };
  }

  const placeArgs: Record<string, unknown> = { ...args };
  delete placeArgs.orderType;

  if (rawType === 'GTD') {
    if (placeArgs.expiration == null) {
      placeArgs.expiration = Math.floor(Date.now() / 1000) + 86400;
    }
  } else {
    delete placeArgs.expiration;
  }

  if (placeArgs.postOnly === undefined) placeArgs.postOnly = true;

  return { ok: true, args: placeArgs };
}

/** @deprecated Use normalizePlaceLimitOrderArgs */
export function buildPlaceLimitOrderArgs(args: Record<string, unknown>): Record<string, unknown> {
  const r = normalizePlaceLimitOrderArgs(args);
  if (!r.ok) throw new Error(r.error);
  return r.args;
}