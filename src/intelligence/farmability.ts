/** Shared farmability snapshot (SDK fetchOrderBook + listMarketRewards + fetchSpreads + fetchMidpoint). */

import {
  resolveConditionIdForToken,
  resolveClobTokenId,
  type ResolveTokenArgs,
} from '../utils/clob-token.js';

export type FarmabilitySnapshot = {
  success: boolean;
  tokenId: string;
  hasActiveRewards?: boolean;
  rewardsMinSize?: number;
  rewardsMaxSpread?: number;
  currentMid?: number;
  currentSpread?: number;
  spreadVsMaxAllowed?: number;
  costToQualifyUsd?: number;
  approximateBookDepth?: number;
  suggestedNearMidBuy?: number;
  suggestedNearMidSell?: number;
  competitionSignal?: string;
  farmabilityScore: number;
  recommendation: string;
  notes: string;
  error?: string;
};

type PubFarmability = {
  fetchOrderBook: (a: { tokenId: string }) => Promise<unknown>;
  listMarketRewards: (a: { conditionId: string }) => Promise<unknown>;
  fetchSpreads: (a: { tokenIds: string[] }) => Promise<unknown>;
  fetchMidpoint: (a: { tokenId: string }) => Promise<string>;
};

export async function fetchFarmabilitySnapshot(
  pub: PubFarmability,
  tokenIdRaw: string | ResolveTokenArgs
): Promise<FarmabilitySnapshot> {
  const normalized = await resolveClobTokenId(tokenIdRaw);
  if (!normalized.ok) {
    return {
      success: false,
      tokenId: String(typeof tokenIdRaw === 'string' ? tokenIdRaw : tokenIdRaw.tokenId || ''),
      farmabilityScore: 0,
      recommendation: 'Unavailable',
      notes: normalized.error,
      error: normalized.error,
    };
  }
  const tokenId = normalized.tokenId;
  try {
    const conditionId = (await resolveConditionIdForToken(tokenId)) || tokenId;
    const [book, rewards, spreads, midStr] = await Promise.all([
      pub.fetchOrderBook({ tokenId }).catch(() => null),
      pub.listMarketRewards({ conditionId }).catch(() => null),
      pub.fetchSpreads({ tokenIds: [tokenId] }).catch(() => null),
      pub.fetchMidpoint({ tokenId }).catch(() => null),
    ]);

    const program = (rewards as { items?: Array<{ rewardsMinSize?: string; rewardsMaxSpread?: string }> })
      ?.items?.[0];
    const hasActiveRewards = !!program;
    const minSize = program ? parseFloat(program.rewardsMinSize || '0') : 0;
    const maxSpread = program ? parseFloat(program.rewardsMaxSpread || '0') : 0;

    const b = book as {
      bids?: Array<{ price?: string; size?: string }>;
      asks?: Array<{ price?: string; size?: string }>;
    } | null;
    const bestBid = b?.bids?.[0]?.price ? parseFloat(b.bids[0].price) : null;
    const bestAsk = b?.asks?.[0]?.price ? parseFloat(b.asks[0].price) : null;
    let mid =
      bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
    if (mid == null && midStr != null) {
      const parsed = parseFloat(String(midStr));
      if (Number.isFinite(parsed)) mid = parsed;
    }

    const spreadMap = spreads as Record<string, string | { spread?: string }> | null;
    const spreadEntry = spreadMap?.[tokenId];
    const spreadFromBatch =
      typeof spreadEntry === 'string'
        ? parseFloat(spreadEntry)
        : spreadEntry?.spread
          ? parseFloat(spreadEntry.spread)
          : null;
    const currentSpread =
      spreadFromBatch != null && Number.isFinite(spreadFromBatch)
        ? spreadFromBatch
        : bestBid != null && bestAsk != null
          ? bestAsk - bestBid
          : null;

    const spreadVsAllowed =
      currentSpread != null && maxSpread > 0 ? currentSpread / maxSpread : null;
    const costToQualify = minSize > 0 && mid != null ? minSize * mid : null;

    const bidDepth =
      b?.bids?.slice(0, 3).reduce((sum, x) => sum + parseFloat(x.size || '0'), 0) || 0;
    const askDepth =
      b?.asks?.slice(0, 3).reduce((sum, x) => sum + parseFloat(x.size || '0'), 0) || 0;
    const totalDepth = bidDepth + askDepth;

    let suggestedNearMidBuy: number | undefined;
    let suggestedNearMidSell: number | undefined;
    if (mid != null) {
      suggestedNearMidBuy = Number(Math.max(0.001, mid - 0.0008).toFixed(4));
      suggestedNearMidSell = Number(Math.min(0.999, mid + 0.0008).toFixed(4));
    }

    const depthImbalance = totalDepth > 0 ? Math.abs(bidDepth - askDepth) / totalDepth : 1;
    const competitionSignal =
      totalDepth < 300
        ? 'thin-book (verify flow; potential low-comp but check activity)'
        : totalDepth > 8000
          ? 'deep-book (high competition likely; harder for sticky edge)'
          : depthImbalance < 0.5
            ? 'balanced-moderate depth (favorable for active sticky quoting)'
            : 'imbalanced depth (adverse selection risk higher)';

    let farmabilityScore = 0;
    if (hasActiveRewards) {
      if (minSize > 0 && mid) farmabilityScore += 25;
      if (spreadVsAllowed != null && spreadVsAllowed < 0.7) farmabilityScore += 35;
      if (currentSpread != null && currentSpread < 0.015) farmabilityScore += 20;
      if (costToQualify != null && costToQualify < 8) farmabilityScore += 15;
      if (totalDepth > 1000) farmabilityScore += 5;
      if (suggestedNearMidBuy && currentSpread != null && currentSpread < 0.01) farmabilityScore += 5;
    } else {
      if (mid != null) farmabilityScore += 20;
      if (currentSpread != null && currentSpread < 0.02) farmabilityScore += 25;
      if (totalDepth > 500) farmabilityScore += 20;
      if (totalDepth > 2000) farmabilityScore += 10;
    }

    const recommendation = !hasActiveRewards
      ? mid != null
        ? 'No active maker reward program on this market — book/mid snapshot only. Use get_order_book for depth; for rewards farming use list_active_maker_reward_markets.'
        : 'No reward program and no book/mid (token may be inactive). Try another token from discover_topic or list_active.'
      : farmabilityScore > 75
        ? 'Excellent for maker farming - tight spread, low cost, good eligibility, near-mid quoting feasible'
        : farmabilityScore > 55
          ? 'Good candidate - monitor for active flow and reprice as needed; use near-mid quotes'
          : farmabilityScore > 35
            ? 'Marginal - check for wide spreads or low activity; consider smaller test size or different market'
            : 'Poor right now - wide spread vs allowed, high cost, or low eligibility. Look for better opportunities per exit rules.';

    if (!book && mid == null) {
      return {
        success: false,
        tokenId,
        hasActiveRewards,
        farmabilityScore: 0,
        recommendation: 'Unavailable',
        notes:
          'SDK fetchOrderBook and fetchMidpoint both failed — token may lack CLOB liquidity. Use get_order_book after fetch_market from discover_topic.',
        error: 'No order book or midpoint for token',
      };
    }

    return {
      success: true,
      tokenId,
      hasActiveRewards,
      rewardsMinSize: hasActiveRewards && minSize ? minSize : undefined,
      rewardsMaxSpread: hasActiveRewards && maxSpread ? maxSpread : undefined,
      currentMid: mid != null ? Number(mid.toFixed(4)) : undefined,
      currentSpread:
        currentSpread != null ? Number(currentSpread.toFixed(4)) : undefined,
      spreadVsMaxAllowed:
        spreadVsAllowed != null ? Number(spreadVsAllowed.toFixed(2)) : undefined,
      costToQualifyUsd: costToQualify != null ? Number(costToQualify.toFixed(2)) : undefined,
      approximateBookDepth: Number(totalDepth.toFixed(0)),
      suggestedNearMidBuy,
      suggestedNearMidSell,
      competitionSignal,
      farmabilityScore: Math.min(100, Math.max(0, farmabilityScore)),
      recommendation,
      notes: hasActiveRewards
        ? 'SDK-native: fetchOrderBook + listMarketRewards + fetchSpreads + fetchMidpoint. Cross with strategy store + explicit place_* tools.'
        : 'SDK-native book-only mode (no listMarketRewards program). Resolved tokenId from hex/slug/decimal id when provided.',
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      success: false,
      tokenId,
      farmabilityScore: 0,
      recommendation: 'Unavailable',
      notes: msg,
      error: msg,
    };
  }
}