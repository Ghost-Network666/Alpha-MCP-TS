import { getMarket } from '../data/markets.js';

export type NormalizeTokenResult =
  | { ok: true; tokenId: string; resolvedFrom?: string; marketQuestion?: string }
  | { ok: false; error: string };

export type ResolveTokenArgs = {
  tokenId?: string;
  market?: string;
  slug?: string;
  outcome?: 'yes' | 'no' | 'YES' | 'NO';
};

function extractOutcomeTokenId(market: Record<string, unknown>, outcome: 'yes' | 'no'): string | undefined {
  const outcomes = market.outcomes as
    | { yes?: { tokenId?: string }; no?: { tokenId?: string } }
    | Array<{ tokenId?: string; name?: string }>
    | undefined;
  if (outcomes && !Array.isArray(outcomes)) {
    const side = outcome === 'yes' ? outcomes.yes : outcomes.no;
    if (side?.tokenId) return String(side.tokenId);
  }
  if (Array.isArray(outcomes)) {
    const idx = outcome === 'yes' ? 0 : 1;
    if (outcomes[idx]?.tokenId) return String(outcomes[idx].tokenId);
  }
  const clob = market.clobTokenIds as string[] | undefined;
  if (Array.isArray(clob) && clob.length) {
    return outcome === 'yes' ? clob[0] : clob[1] ?? clob[0];
  }
  return undefined;
}

/** Strict hex check for clob token ids. */
export function normalizeClobTokenId(raw: unknown): NormalizeTokenResult {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: 'tokenId is required' };
  const hex = s.startsWith('0x') ? s : `0x${s}`;
  if (!/^0x[0-9a-fA-F]{40,}$/i.test(hex)) {
    return {
      ok: false,
      error:
        'Invalid clob tokenId hex. Use 0x… from fetch_market, or pass market/slug/decimal market id to auto-resolve.',
    };
  }
  return { ok: true, tokenId: hex, resolvedFrom: 'hex' };
}

/**
 * Resolve trading tokenId from hex, market slug, or decimal Gamma market id.
 * Decimal ids (e.g. "12345") fetch the market and return Yes/No clob tokenId.
 */
export async function resolveClobTokenId(
  input: string | ResolveTokenArgs,
  defaultOutcome: 'yes' | 'no' = 'yes'
): Promise<NormalizeTokenResult> {
  let raw: string | undefined;
  let outcome = defaultOutcome;

  if (typeof input === 'object' && input !== null) {
    const o = String(input.outcome || 'yes').toLowerCase();
    outcome = o === 'no' ? 'no' : 'yes';
    raw = (input.tokenId || input.market || input.slug || '').trim();
    if (!raw) {
      return { ok: false, error: 'Provide tokenId, market, or slug' };
    }
  } else {
    raw = String(input).trim();
  }

  if (!raw) return { ok: false, error: 'tokenId, market, or slug is required' };

  const hexTry = normalizeClobTokenId(raw);
  if (hexTry.ok) return hexTry;

  const isDecimalId = /^\d+$/.test(raw);
  const looksLikeSlug = !isDecimalId && /[a-zA-Z-]/.test(raw);

  const attempts: Array<{ kind: string; params: { id?: string; slug?: string } }> = [];
  if (isDecimalId) attempts.push({ kind: 'market_id', params: { id: raw } });
  if (looksLikeSlug) attempts.push({ kind: 'slug', params: { slug: raw } });
  if (!isDecimalId && !looksLikeSlug) {
    attempts.push({ kind: 'slug', params: { slug: raw } });
    attempts.push({ kind: 'market_id', params: { id: raw } });
  }

  let lastErr = '';
  for (const attempt of attempts) {
    try {
      const market = (await getMarket(attempt.params)) as Record<string, unknown>;
      const tokenId = extractOutcomeTokenId(market, outcome);
      if (!tokenId) {
        lastErr = `Market found but no ${outcome} tokenId on card`;
        continue;
      }
      const normalized = normalizeClobTokenId(tokenId);
      if (!normalized.ok) return normalized;
      return {
        ...normalized,
        resolvedFrom: attempt.kind,
        marketQuestion: String(market.question || ''),
      };
    } catch (e: unknown) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }

  return {
    ok: false,
    error: isDecimalId
      ? `Could not resolve decimal market id "${raw}" to clob tokenId (${lastErr}). Try fetch_market({ id: "${raw}" }).`
      : `Could not resolve "${raw}" as slug or tokenId (${lastErr}). Use fetch_market or discover_topic for Yes TokenId.`,
  };
}

export async function resolveConditionIdForToken(tokenId: string): Promise<string | undefined> {
  try {
    const market = await getMarket({ tokenId });
    const cid = (market as { conditionId?: string }).conditionId;
    return cid ? String(cid) : undefined;
  } catch {
    return undefined;
  }
}

/** MCP tool args → clob tokenId (throws plain Error for handler to format). */
export async function resolveTokenIdFromToolArgs(
  args: Record<string, unknown>
): Promise<{ tokenId: string; resolvedFrom?: string; marketQuestion?: string }> {
  const resolved = await resolveClobTokenId({
    tokenId: args.tokenId as string | undefined,
    market: (args.market || args.slug) as string | undefined,
    outcome: (args.outcome as 'yes' | 'no') || 'yes',
  });
  if (!resolved.ok) throw new Error(resolved.error);
  return {
    tokenId: resolved.tokenId,
    resolvedFrom: resolved.resolvedFrom,
    marketQuestion: resolved.marketQuestion,
  };
}