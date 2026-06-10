import { callWithRateLimitProtection } from '../utils/errors.js';

export type RewardCandidate = {
  rank: number;
  question: string;
  slug?: string;
  conditionId: string;
  yesTokenId?: string;
  noTokenId?: string;
  minSize?: string | number;
  maxSpread?: string | number;
  dailyRate?: string | number;
  cheapestMinCostUsd?: number;
  attractiveness: number;
  whyRecommended?: string;
  marketLink?: string;
};

function attractiveness(r: Record<string, unknown>): number {
  const minSz = parseFloat(String(r.rewardsMinSize ?? r.rewards_min_size ?? '50'));
  const maxSp = Number(r.rewardsMaxSpread ?? r.rewards_max_spread ?? 0.05);
  const rate = parseFloat(
    String(r.totalDailyRate ?? r.total_daily_rate ?? r.sponsoredDailyRate ?? r.nativeDailyRate ?? '0')
  );
  const ease = 100 / Math.max(1, minSz);
  const rateScore = Math.min(100, rate / 2);
  const spreadPenalty = Math.max(0.1, maxSp) * 50;
  return ease * 2 + rateScore - spreadPenalty;
}

/** Ranked reward market candidates (same enrichment as list_active_maker_reward_markets). */
export async function fetchRewardCandidates(
  pub: {
    listCurrentRewards: (a?: Record<string, unknown>) => Promise<{ firstPage: () => Promise<{ items?: unknown[] }> }>;
    listMarkets: (a: Record<string, unknown>) => Promise<{ firstPage: () => Promise<{ items?: unknown[] }> }>;
    fetchMidpoints: (request: Array<{ tokenId: string }>) => Promise<Record<string, string>>;
  },
  opts: { maxResults?: number; maxMinSize?: number; maxMinCostUsd?: number } = {}
): Promise<{ candidates: RewardCandidate[]; note?: string }> {
  const maxResults = Math.min(Math.max(opts.maxResults ?? 8, 1), 12);
  const maxMinSize = opts.maxMinSize;
  const maxMinCostUsd = opts.maxMinCostUsd;

  const protectedCall = await callWithRateLimitProtection(
    async () => {
      const paginator = await pub.listCurrentRewards({});
      return paginator.firstPage();
    },
    'listCurrentRewards for intelligence'
  );
  if (!protectedCall.ok) {
    return {
      candidates: [],
      note: protectedCall.message || 'Rate limited on rewards fetch',
    };
  }

  const page = protectedCall.data;
  let items = (page?.items || []) as Record<string, unknown>[];

  if (maxMinSize != null && !Number.isNaN(maxMinSize)) {
    items = items.filter((r) => {
      const minSz = parseFloat(String(r.rewardsMinSize ?? r.rewards_min_size ?? '999'));
      return minSz <= maxMinSize;
    });
  }

  if (!items.length) {
    return { candidates: [], note: 'No active reward programs after filters' };
  }

  // Cap programs before enrichment (avoids oversized Gamma keyset URLs)
  const enrichCap = Math.min(items.length, Math.max(maxResults * 4, 12));
  items = items.slice(0, enrichCap);

  const conditionIds = items.map((r) => r.conditionId).filter(Boolean) as string[];
  const marketsByCondition: Record<string, Record<string, unknown>> = {};
  const BATCH = 12;
  for (let i = 0; i < conditionIds.length; i += BATCH) {
    const chunk = conditionIds.slice(i, i + BATCH);
    if (!chunk.length) continue;
    try {
      const mktRes = await callWithRateLimitProtection(
        () => pub.listMarkets({ conditionIds: chunk, pageSize: chunk.length, closed: false }),
        'listMarkets batch intelligence'
      );
      if (mktRes.ok) {
        const mktPage = await mktRes.data.firstPage();
        for (const m of (mktPage?.items || []) as Record<string, unknown>[]) {
          if (m.conditionId) marketsByCondition[String(m.conditionId)] = m;
        }
      }
    } catch {
      /* non-fatal: partial enrichment */
    }
  }

  const allTokenIds: string[] = [];
  for (const m of Object.values(marketsByCondition)) {
    const yes =
      (m.outcomes as { yes?: { tokenId?: string } })?.yes?.tokenId ??
      (m as { yesTokenId?: string }).yesTokenId;
    const no =
      (m.outcomes as { no?: { tokenId?: string } })?.no?.tokenId ??
      (m as { noTokenId?: string }).noTokenId;
    if (yes) allTokenIds.push(yes);
    if (no) allTokenIds.push(no);
  }

  let midsByToken: Record<string, number> = {};
  if (allTokenIds.length) {
    const midRequest = [...new Set(allTokenIds)].map((tokenId) => ({ tokenId }));
    const midRes = await callWithRateLimitProtection(
      () => pub.fetchMidpoints(midRequest),
      'fetchMidpoints intelligence'
    );
    if (midRes.ok && midRes.data) {
      midsByToken = Object.fromEntries(
        Object.entries(midRes.data).map(([k, v]) => [k, parseFloat(String(v))])
      );
    }
  }

  const ranked = items
    .map((r) => {
      const m = marketsByCondition[String(r.conditionId)] || {};
      const minSz = r.rewardsMinSize ?? r.rewards_min_size;
      const daily = r.totalDailyRate ?? r.total_daily_rate ?? r.sponsoredDailyRate ?? '0';
      const slug = (m.slug as string) || String(r.conditionId);
      const yesTok =
        (m.outcomes as { yes?: { tokenId?: string } })?.yes?.tokenId ??
        (m.tokens as Array<{ outcome?: string; side?: string; tokenId?: string }>)?.find(
          (t) => t.outcome === 'Yes' || t.side === 'Yes'
        )?.tokenId ??
        (m as { yesTokenId?: string }).yesTokenId;
      const noTok =
        (m.outcomes as { no?: { tokenId?: string } })?.no?.tokenId ??
        (m.tokens as Array<{ outcome?: string; side?: string; tokenId?: string }>)?.find(
          (t) => t.outcome === 'No' || t.side === 'No'
        )?.tokenId ??
        (m as { noTokenId?: string }).noTokenId;

      const score = attractiveness(r);
      const yesMid = yesTok ? midsByToken[yesTok] : null;
      const noMid = noTok ? midsByToken[noTok] : null;
      const yesMinCostUsd = yesMid && minSz ? parseFloat(String(minSz)) * yesMid : null;
      const noMinCostUsd = noMid && minSz ? parseFloat(String(minSz)) * noMid : null;
      const cheapestCostUsd = Math.min(yesMinCostUsd ?? 999, noMinCostUsd ?? 999);

      return {
        entry: {
          rank: 0,
          question: (m.question as string) || `Market ${String(r.conditionId).slice(0, 10)}...`,
          slug,
          conditionId: String(r.conditionId),
          yesTokenId: yesTok,
          noTokenId: noTok,
          minSize: minSz,
          maxSpread: r.rewardsMaxSpread ?? r.rewards_max_spread,
          dailyRate: daily,
          cheapestMinCostUsd: cheapestCostUsd < 999 ? Number(cheapestCostUsd.toFixed(2)) : undefined,
          attractiveness: Number(score.toFixed(2)),
          whyRecommended:
            minSz && parseFloat(String(minSz)) <= 10
              ? 'Low min size (easy to qualify)'
              : daily && parseFloat(String(daily)) > 50
                ? 'High reward rate'
                : 'Active program',
          marketLink: `https://polymarket.com/market/${slug}`,
        } as RewardCandidate,
        score,
        cheapestCostUsd,
      };
    })
    .filter((x) => {
      if (maxMinCostUsd != null && !Number.isNaN(maxMinCostUsd)) {
        return x.cheapestCostUsd == null || x.cheapestCostUsd <= maxMinCostUsd;
      }
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((x, i) => {
      x.entry.rank = i + 1;
      return x.entry;
    });

  return { candidates: ranked };
}