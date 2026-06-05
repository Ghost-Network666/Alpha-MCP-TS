import type { FarmabilitySnapshot } from './farmability.js';
import { computeBayesianPosterior } from './bayesian.js';
import type { RewardCandidate } from './rewards-candidates.js';

export type OpportunityInput = {
  tokenId: string;
  label?: string;
  prior?: number;
  externalSignal?: number;
  signalWeight?: number;
  source?: 'rewards' | 'discovery' | 'manual';
  rewardMeta?: Partial<RewardCandidate>;
  farmability?: FarmabilitySnapshot;
  liquidityScore?: number;
};

export type RankedOpportunity = {
  rank: number;
  tokenId: string;
  label: string;
  compositeScore: number;
  confidenceScore: number;
  confidence: 'high' | 'medium' | 'low';
  actionability: 'strong' | 'moderate' | 'weak' | 'skip';
  signals: {
    farmabilityScore?: number;
    rewardAttractiveness?: number;
    bayesianDivergenceBps?: number;
    cheapestMinCostUsd?: number;
    competitionSignal?: string;
    currentMid?: number;
    bookDepth?: number;
    liquidityScore?: number;
  };
  recommendation: string;
  nextTools: string[];
};

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function deriveActionability(
  composite: number,
  farm?: FarmabilitySnapshot
): RankedOpportunity['actionability'] {
  if (!farm?.success) return composite >= 40 ? 'weak' : 'skip';
  if (composite >= 72 && (farm.farmabilityScore ?? 0) >= 55) return 'strong';
  if (composite >= 48 && (farm.farmabilityScore ?? 0) >= 35) return 'moderate';
  if (composite >= 30) return 'weak';
  return 'skip';
}

export function rankOpportunities(
  inputs: OpportunityInput[],
  opts: { goal: string; maxResults?: number } = { goal: 'rewards' }
): RankedOpportunity[] {
  const maxResults = Math.min(Math.max(opts.maxResults ?? 5, 1), 10);
  const goal = opts.goal;

  const scored = inputs.map((inp) => {
    const farm = inp.farmability;
    const reward = inp.rewardMeta;
    let composite = 0;
    const signals: RankedOpportunity['signals'] = {};

    if (reward?.attractiveness != null) {
      signals.rewardAttractiveness = reward.attractiveness;
      composite += Math.min(40, reward.attractiveness * 0.35);
    }
    if (farm?.success && farm.farmabilityScore != null) {
      signals.farmabilityScore = farm.farmabilityScore;
      composite += farm.farmabilityScore * 0.45;
      signals.competitionSignal = farm.competitionSignal;
      signals.currentMid = farm.currentMid;
      signals.bookDepth = farm.approximateBookDepth;
    }
    if (inp.liquidityScore != null && inp.liquidityScore > 0) {
      signals.liquidityScore = inp.liquidityScore;
      composite += Math.min(18, Math.log10(inp.liquidityScore + 1) * 5);
    }
    if (
      (goal === 'discovery' || goal === 'mispricing') &&
      farm?.currentMid != null &&
      farm.currentMid >= 0.45 &&
      farm.currentMid <= 0.55
    ) {
      composite += 15;
    } else if (
      (goal === 'discovery' || goal === 'mispricing') &&
      inp.prior != null &&
      inp.prior >= 0.45 &&
      inp.prior <= 0.55
    ) {
      composite += 10;
    }
    if (reward?.cheapestMinCostUsd != null) {
      signals.cheapestMinCostUsd = reward.cheapestMinCostUsd;
      if (reward.cheapestMinCostUsd <= 5) composite += 12;
      else if (reward.cheapestMinCostUsd <= 10) composite += 6;
    }

    if (inp.prior != null && inp.externalSignal != null) {
      const bay = computeBayesianPosterior({
        prior: clamp01(inp.prior),
        signal: clamp01(inp.externalSignal),
        weight: inp.signalWeight ?? 0.4,
      });
      signals.bayesianDivergenceBps = bay.divergenceBps;
      composite += Math.min(25, bay.divergenceBps / 4);
    }

    const compositeScore = Number(Math.min(100, Math.max(0, composite)).toFixed(1));
    const confidenceScore = compositeScore;
    const confidence: RankedOpportunity['confidence'] =
      confidenceScore >= 70 ? 'high' : confidenceScore >= 45 ? 'medium' : 'low';
    const actionability = deriveActionability(confidenceScore, farm);

    let recommendation = farm?.recommendation || reward?.whyRecommended || 'Review manually';
    if (actionability === 'strong') {
      recommendation = `Actionable: ${recommendation}`;
    } else if (actionability === 'skip') {
      recommendation = `Low confidence — widen filters or pick another market. ${farm?.error || ''}`.trim();
    }
    if (goal === 'mispricing' && (signals.bayesianDivergenceBps ?? 0) >= 500) {
      recommendation = 'External signal diverges from platform price — host should validate thesis before sizing';
    }

    const nextTools: string[] = ['get_strategies', 'fetch_market', 'get_spread', 'get_order_book'];
    if (goal === 'rewards') {
      nextTools.push('suggest_qualified_size', 'place_optimized_reward_order');
    } else if (goal === 'weather' || goal === 'discovery') {
      nextTools.push('get_uk_weather_forecast', 'place_limit_order');
    } else {
      nextTools.push('suggest_qualified_size', 'place_limit_order');
    }
    if (farm?.success) nextTools.unshift('get_farmability');

    return {
      tokenId: inp.tokenId,
      label: inp.label || reward?.question || inp.tokenId.slice(0, 12) + '...',
      compositeScore,
      confidenceScore,
      confidence,
      actionability,
      signals,
      recommendation,
      nextTools: [...new Set(nextTools)],
    };
  });

  return scored
    .sort((a, b) => b.compositeScore - a.compositeScore)
    .slice(0, maxResults)
    .map((x, i) => ({ rank: i + 1, ...x }));
}