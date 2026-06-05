import { discoverTopic } from '../data/discovery.js';
import { weatherClient } from '../data/weather.js';
import { fetchFarmabilitySnapshot } from './farmability.js';
import { fetchRewardCandidates } from './rewards-candidates.js';
import { rankOpportunities, type OpportunityInput } from './ranking.js';

export type AlphaReportGoal = 'rewards' | 'weather' | 'mispricing' | 'discovery';

export type AlphaReportRequest = {
  goal: AlphaReportGoal;
  topic?: string;
  maxMinCostUsd?: number;
  maxMinSize?: number;
  tokenIds?: string[];
  externalSignals?: Array<{
    tokenId: string;
    prior?: number;
    signal: number;
    weight?: number;
    label?: string;
  }>;
  maxCandidates?: number;
  enrichFarmability?: boolean;
  /** Prefer markets whose Yes price is in this band (discovery/mispricing). Default 0.45–0.55 when unset for discovery. */
  midPriceMin?: number;
  midPriceMax?: number;
  liquidityNumMin?: number;
  volumeNumMin?: number;
};

export type AlphaReport = {
  success: boolean;
  goal: AlphaReportGoal;
  generatedAt: string;
  candidateCount: number;
  opportunities: ReturnType<typeof rankOpportunities>;
  context?: Record<string, unknown>;
  agentDirective: string;
  nextTools: string[];
  hostNote: string;
};

function marketLiquidityScore(m: Record<string, unknown>): number {
  const metrics = m.metrics as { liquidity?: string | number; volume24hr?: string | number } | undefined;
  const liq = parseFloat(String(metrics?.liquidity ?? (m as { liquidityNum?: number }).liquidityNum ?? 0)) || 0;
  const vol = parseFloat(String(metrics?.volume24hr ?? (m as { volumeNum?: number }).volumeNum ?? 0)) || 0;
  return liq + vol * 0.15;
}

function marketYesPrice(m: Record<string, unknown>): number | null {
  const yes = (m.outcomes as { yes?: { price?: string | number } })?.yes?.price;
  if (yes != null) {
    const p = parseFloat(String(yes));
    return Number.isFinite(p) ? p : null;
  }
  const last = (m as { prices?: { lastTradePrice?: string } }).prices?.lastTradePrice;
  if (last != null) {
    const p = parseFloat(String(last));
    return Number.isFinite(p) ? p : null;
  }
  return null;
}

function tokenIdsFromDiscovery(
  markets: Array<Record<string, unknown>>,
  limit: number,
  opts?: { midBand?: { min: number; max: number }; liquidityNumMin?: number; volumeNumMin?: number }
): string[] {
  const ids: string[] = [];
  const liqMin = opts?.liquidityNumMin ?? 5000;
  const volMin = opts?.volumeNumMin ?? 1000;
  const filtered = markets.filter((m) => {
    const metrics = m.metrics as { liquidity?: string; volume24hr?: string } | undefined;
    const liq = parseFloat(String(metrics?.liquidity ?? 0)) || 0;
    const vol = parseFloat(String(metrics?.volume24hr ?? 0)) || 0;
    return liq >= liqMin || vol >= volMin;
  });
  const pool = filtered.length ? filtered : markets;
  const sorted = [...pool].sort((a, b) => {
    const pa = marketYesPrice(a) ?? 0.5;
    const pb = marketYesPrice(b) ?? 0.5;
    const target = 0.5;
    const midScoreA = 1 - Math.min(1, Math.abs(pa - target) / 0.25);
    const midScoreB = 1 - Math.min(1, Math.abs(pb - target) / 0.25);
    const liqA = marketLiquidityScore(a);
    const liqB = marketLiquidityScore(b);
    return liqB * 0.55 + midScoreB * 0.45 - (liqA * 0.55 + midScoreA * 0.45);
  });
  for (const m of sorted) {
    const yesP = marketYesPrice(m);
    if (opts?.midBand && yesP != null && (yesP < opts.midBand.min || yesP > opts.midBand.max)) continue;
    const yes =
      (m.outcomes as { yes?: { tokenId?: string } })?.yes?.tokenId ??
      (m as { yesTokenId?: string }).yesTokenId;
    const no =
      (m.outcomes as { no?: { tokenId?: string } })?.no?.tokenId ??
      (m as { noTokenId?: string }).noTokenId;
    if (yes) ids.push(yes);
    if (no && (!opts?.midBand || yesP == null)) ids.push(no);
    if (ids.length >= limit * 2) break;
  }
  return [...new Set(ids)].slice(0, limit * 2);
}

export async function buildAlphaReport(
  pub: Parameters<typeof fetchRewardCandidates>[0] & Parameters<typeof fetchFarmabilitySnapshot>[0],
  req: AlphaReportRequest
): Promise<AlphaReport> {
  const goal = req.goal;
  const maxCandidates = Math.min(Math.max(req.maxCandidates ?? 6, 1), 10);
  const enrichFarmability = req.enrichFarmability !== false;
  const inputs: OpportunityInput[] = [];
  const context: Record<string, unknown> = {};

  if (goal === 'rewards') {
    const { candidates, note } = await fetchRewardCandidates(pub, {
      maxResults: maxCandidates,
      maxMinCostUsd: req.maxMinCostUsd,
      maxMinSize: req.maxMinSize,
    });
    context.rewardScanNote = note;
    context.rewardCount = candidates.length;
    for (const c of candidates) {
      const tokenId = c.yesTokenId || c.noTokenId;
      if (!tokenId) continue;
      inputs.push({
        tokenId,
        label: c.question,
        source: 'rewards',
        rewardMeta: c,
        prior: c.yesTokenId === tokenId && c.cheapestMinCostUsd ? undefined : undefined,
      });
    }
  } else if (goal === 'weather' || goal === 'discovery') {
    const topic = req.topic || (goal === 'weather' ? 'weather' : 'crypto');
    const discovered = await discoverTopic({
      topic,
      closed: false,
      pageSize: Math.min(15, maxCandidates + 4),
    });
    context.tagSlug = discovered.tagSlug;
    context.tagId = discovered.tagId;
    context.eventCount = discovered.events.length;
    context.marketCount = discovered.markets.length;
    if (goal === 'weather') {
      try {
        const city = req.topic?.toLowerCase().includes('london')
          ? 'London'
          : req.topic?.toLowerCase().includes('edinburgh')
            ? 'Edinburgh'
            : 'London';
        const wx = await weatherClient.getForecast(city, 5);
        context.weatherReference = { city, provider: wx.provider, snapshot: wx.data };
        context.hostNote =
          'Compare forecast vs market prices; pass your estimate as externalSignals.signal on compute_market_signals.';
      } catch (e: unknown) {
        context.weatherReference = {
          error: e instanceof Error ? e.message : String(e),
          fallbackTool: 'get_uk_weather_forecast',
        };
      }
    }
    const midMin = req.midPriceMin ?? 0.45;
    const midMax = req.midPriceMax ?? 0.55;
    const liqMin = req.liquidityNumMin ?? 5000;
    const volMin = req.volumeNumMin ?? 1000;
    context.midPriceBand = { min: midMin, max: midMax };
    context.liquidityFilters = { liquidityNumMin: liqMin, volumeNumMin: volMin };
    const tids = req.tokenIds?.length
      ? req.tokenIds
      : tokenIdsFromDiscovery(
          discovered.markets as unknown as Record<string, unknown>[],
          maxCandidates,
          { midBand: { min: midMin, max: midMax }, liquidityNumMin: liqMin, volumeNumMin: volMin }
        );
    context.tokensAfterFilters = tids.length;
    for (const tokenId of tids.slice(0, maxCandidates)) {
      const m = (discovered.markets as Record<string, unknown>[]).find((mk) => {
        const yes = (mk.outcomes as { yes?: { tokenId?: string } })?.yes?.tokenId;
        return yes === tokenId;
      });
      inputs.push({
        tokenId,
        source: 'discovery',
        label: String(m?.question || topic).slice(0, 80),
        prior: m ? marketYesPrice(m) ?? undefined : undefined,
      });
    }
  } else {
    const tids = req.tokenIds || [];
    const signalMap = new Map(
      (req.externalSignals || []).map((s) => [s.tokenId, s])
    );
    for (const tokenId of tids.slice(0, maxCandidates)) {
      const sig = signalMap.get(tokenId);
      inputs.push({
        tokenId,
        source: 'manual',
        prior: sig?.prior,
        externalSignal: sig?.signal,
        signalWeight: sig?.weight,
        label: sig?.label,
      });
    }
    if (req.externalSignals?.length) {
      for (const sig of req.externalSignals) {
        if (!inputs.some((i) => i.tokenId === sig.tokenId)) {
          inputs.push({
            tokenId: sig.tokenId,
            prior: sig.prior,
            externalSignal: sig.signal,
            signalWeight: sig.weight,
            label: sig.label,
            source: 'manual',
          });
        }
      }
    }
  }

  if (enrichFarmability && inputs.length) {
    const cap = Math.min(inputs.length, 5);
    for (let i = 0; i < cap; i++) {
      inputs[i].farmability = await fetchFarmabilitySnapshot(pub, inputs[i].tokenId);
    }
  }

  for (const inp of inputs) {
    const sig = req.externalSignals?.find((s) => s.tokenId === inp.tokenId);
    if (sig) {
      inp.externalSignal = sig.signal;
      inp.signalWeight = sig.weight;
      inp.prior = sig.prior ?? inp.farmability?.currentMid;
      inp.label = sig.label ?? inp.label;
    } else if (inp.prior == null && inp.farmability?.currentMid != null) {
      inp.prior = inp.farmability.currentMid;
    }
  }

  const opportunities = rankOpportunities(inputs, { goal, maxResults: maxCandidates });

  if (!opportunities.length) {
    return {
      success: true,
      goal,
      generatedAt: new Date().toISOString(),
      candidateCount: 0,
      opportunities: [],
      context,
      agentDirective:
        'No ranked opportunities after scan/filters (scores are 0–100, never negative). DO NOT ask the human. Relax midPriceMin/Max or liquidityNumMin, try goal:"rewards" + list_active_maker_reward_markets, or discover_topic with a broader topic.',
      nextTools: ['get_strategies', 'list_active_maker_reward_markets', 'discover_topic', 'wait_seconds'],
      hostNote:
        'Deterministic MCP intelligence only — empty result is valid; host adjusts strategy filters.',
    };
  }

  const top = opportunities[0];
  let agentDirective =
    'DO NOT ask the human for options. Host LLM: read this structured report, call get_strategies(), then execute nextTools with explicit numeric params.';
  if (goal === 'rewards' && top) {
    agentDirective += ` Top pick tokenId ${top.tokenId} (score ${top.compositeScore}). If place fails, rotate via list_active_maker_reward_markets — never retry same token blindly.`;
  } else if ((goal === 'weather' || goal === 'discovery') && top) {
    agentDirective += ` Top pick ${top.tokenId}. Cross-check external data (e.g. get_uk_weather_forecast for weather) before place_limit_order.`;
  } else if (goal === 'mispricing' && top && (top.signals.bayesianDivergenceBps ?? 0) >= 500) {
    agentDirective += ` Strong divergence on ${top.tokenId} — validate thesis, then suggest_qualified_size + place_limit_order.`;
  }

  const nextTools = [
    'get_strategies',
    'generate_alpha_report',
    ...(top?.nextTools || ['fetch_market', 'get_farmability']),
  ];

  return {
    success: true,
    goal,
    generatedAt: new Date().toISOString(),
    candidateCount: inputs.length,
    opportunities,
    context,
    agentDirective,
    nextTools: [...new Set(nextTools)],
    hostNote:
      'Deterministic MCP intelligence only — no LLM inside server. Your host model reasons over this JSON and updates strategy store.',
  };
}