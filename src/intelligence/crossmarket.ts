/**
 * Cross-market correlation and combinatorial arb signals.
 * Research: Logical arb (related markets), cross-platform (where possible), portfolio-level edges.
 * Capable: Uses existing market discovery + orderbook/positions for correlation hints.
 * Outside-the-box: "Beast portfolio" view for hosts to optimize across all open markets.
 */

import { fetchMarket } from '../data/markets.js'; // or list
import { getBookSnapshot } from '../data/orderbook.js';
import { logger } from '../utils/logger.js';

export interface CrossMarketSignal {
  primaryTokenId: string;
  relatedTokenIds: string[];
  correlationHint: number; // -1 to 1 (simplified from price moves or tags)
  comboEdge: number;
  recommendation: string;
  rationale: string;
}

export async function getCrossMarketSignal(primaryTokenId: string, related: string[]): Promise<CrossMarketSignal> {
  // In prod: use real correlation from recent mids or on-chain; here use tags + simple price diff
  const primaryBook = await getBookSnapshot(primaryTokenId);
  const primaryMid = (primaryBook.asks?.[0]?.price || 0.5 + primaryBook.bids?.[0]?.price || 0.5) / 2;

  let totalRelatedMid = 0;
  let count = 0;
  for (const rel of related.slice(0, 3)) {
    try {
      const b = await getBookSnapshot(rel);
      totalRelatedMid += (b.asks?.[0]?.price || 0.5 + b.bids?.[0]?.price || 0.5) / 2;
      count++;
    } catch {}
  }
  const avgRelated = count ? totalRelatedMid / count : primaryMid;
  const diff = primaryMid - avgRelated;
  const comboEdge = Math.abs(diff) * 0.8; // heuristic

  const correlationHint = Math.max(-0.9, Math.min(0.9, 1 - Math.abs(diff) * 5));

  return {
    primaryTokenId,
    relatedTokenIds: related,
    correlationHint,
    comboEdge,
    recommendation: comboEdge > 0.02 ? 'CONSIDER_HEDGE_OR_ARB_BUNDLE' : 'NO_STRONG_CROSS_EDGE',
    rationale: `Primary mid ${primaryMid.toFixed(3)} vs related avg ${avgRelated.toFixed(3)} (diff ${diff.toFixed(3)}). Correlation hint ${correlationHint.toFixed(2)}. Combo edge ~${(comboEdge*100).toFixed(1)}%.`,
  };
}
