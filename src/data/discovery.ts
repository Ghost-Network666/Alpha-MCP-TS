import { getPublicClient } from '../config/client.js';

/** Ergonomic category labels agents use → platform tag slugs (SDK listEvents tagSlug / fetchTag for listMarkets tagId). */
const CATEGORY_TAG_SLUG: Record<string, string> = {
  WEATHER: 'weather',
  CLIMATE: 'climate',
  SPORTS: 'sports',
  CRYPTO: 'crypto',
  POLITICS: 'politics',
  SCIENCE: 'science',
  ENTERTAINMENT: 'entertainment',
};

const tagIdBySlugCache = new Map<string, number>();

function stripAgentOnlyFields(args: Record<string, unknown>) {
  const { category, search, active, limit, offset, ...sdk } = args;
  if (search != null && sdk.titleSearch == null) sdk.titleSearch = search;
  if (active === true && sdk.closed == null) sdk.closed = false;
  if (active === false && sdk.closed == null) sdk.closed = true;
  if (limit != null && sdk.pageSize == null) sdk.pageSize = limit;
  return sdk;
}

export function resolveCategoryTagSlug(category?: string): string | undefined {
  if (!category || typeof category !== 'string') return undefined;
  const key = category.trim().toUpperCase();
  return CATEGORY_TAG_SLUG[key] ?? category.trim().toLowerCase();
}

/** Params for listEvents — SDK has tagSlug/tagIds/titleSearch, not category. */
export function buildListEventsParams(args: Record<string, unknown> = {}): Record<string, unknown> {
  const sdk = stripAgentOnlyFields(args);
  const tagSlug = resolveCategoryTagSlug(args.category as string | undefined);
  if (tagSlug && sdk.tagSlug == null && sdk.tagIds == null) {
    sdk.tagSlug = tagSlug;
  }
  return sdk;
}

async function resolveTagIdFromSlug(slug: string): Promise<number | undefined> {
  const cached = tagIdBySlugCache.get(slug);
  if (cached != null) return cached;
  const pub = getPublicClient();
  try {
    const tag = await pub.fetchTag({ slug });
    const id = Number((tag as { id?: string | number })?.id);
    if (Number.isFinite(id)) {
      tagIdBySlugCache.set(slug, id);
      return id;
    }
  } catch {
    /* fetchTag may fail for unknown slug */
  }
  return undefined;
}

/** Params for listMarkets — SDK has tagId (not category); resolve slug → tagId via fetchTag. */
export async function buildListMarketsParams(
  args: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  const sdk = stripAgentOnlyFields(args);
  const tagSlug = resolveCategoryTagSlug(args.category as string | undefined);
  if (tagSlug && sdk.tagId == null && sdk.tagIds == null) {
    const tagId = await resolveTagIdFromSlug(tagSlug);
    if (tagId != null) sdk.tagId = tagId;
  }
  return sdk;
}

export function discoveryAgentNote(
  tool: 'list_events' | 'list_markets',
  args: Record<string, unknown>,
  resolved: Record<string, unknown>
): string | undefined {
  if (!args.category) return undefined;
  const slug = resolveCategoryTagSlug(String(args.category));
  if (!slug) return undefined;
  if (tool === 'list_events') {
    return `category "${args.category}" is not an SDK field — mapped to tagSlug "${resolved.tagSlug ?? slug}". For markets use list_markets({ category: "${args.category}" }) (resolves tagId via fetchTag) or explicit tagSlug/tagIds.`;
  }
  if (resolved.tagId != null) {
    return `category "${args.category}" mapped to tagId ${resolved.tagId} (tag slug "${slug}"). Prefer list_tags + fetch_tag or explicit tagId/tagSlug over bare category when automating.`;
  }
  return `category "${args.category}" could not resolve to tagId; try search({ q: "weather" }) or list_events({ tagSlug: "${slug}" }).`;
}