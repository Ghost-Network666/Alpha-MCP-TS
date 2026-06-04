import type { Event, Market } from '@polymarket/client';
import { getPublicClient } from '../config/client.js';
import { firstPage } from '../utils/pagination.js';

/** Ergonomic category labels agents use → platform tag slugs (SDK listEvents tagSlug / fetchTag for listMarkets tagId). */
export const CATEGORY_TAG_SLUG: Record<string, string> = {
  WEATHER: 'weather',
  CLIMATE: 'climate',
  SPORTS: 'sports',
  CRYPTO: 'crypto',
  POLITICS: 'politics',
  SCIENCE: 'science',
  ENTERTAINMENT: 'entertainment',
};

const TOPIC_ALIASES: Record<string, string> = {
  ...CATEGORY_TAG_SLUG,
  weather: 'weather',
  climate: 'climate',
  sports: 'sports',
  crypto: 'crypto',
  politics: 'politics',
  science: 'science',
  entertainment: 'entertainment',
};

const tagIdBySlugCache = new Map<string, number>();

function stripAgentOnlyFields(args: Record<string, unknown>) {
  const { category, search, active, limit, offset, topic, ...sdk } = args;
  if (search != null && sdk.titleSearch == null) sdk.titleSearch = search;
  if (active === true && sdk.closed == null) sdk.closed = false;
  if (active === false && sdk.closed == null) sdk.closed = true;
  if (limit != null && sdk.pageSize == null) sdk.pageSize = limit;
  return sdk;
}

export function resolveTopicSlug(topic?: string): string | undefined {
  if (!topic || typeof topic !== 'string') return undefined;
  const trimmed = topic.trim();
  const upper = trimmed.toUpperCase();
  if (TOPIC_ALIASES[upper]) return TOPIC_ALIASES[upper];
  if (TOPIC_ALIASES[trimmed.toLowerCase()]) return TOPIC_ALIASES[trimmed.toLowerCase()];
  return trimmed.toLowerCase();
}

/** @deprecated use resolveTopicSlug */
export function resolveCategoryTagSlug(category?: string): string | undefined {
  return resolveTopicSlug(category);
}

/** Params for listEvents — SDK has tagSlug/tagIds/titleSearch, not category. */
export function buildListEventsParams(args: Record<string, unknown> = {}): Record<string, unknown> {
  const sdk = stripAgentOnlyFields(args);
  const tagSlug =
    resolveTopicSlug(args.topic as string | undefined) ??
    resolveTopicSlug(args.category as string | undefined);
  if (tagSlug && sdk.tagSlug == null && sdk.tagIds == null) {
    sdk.tagSlug = tagSlug;
  }
  return sdk;
}

export async function resolveTagIdFromSlug(slug: string): Promise<number | undefined> {
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
  const tagSlug =
    resolveTopicSlug(args.topic as string | undefined) ??
    resolveTopicSlug(args.category as string | undefined);
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
  const label = args.topic ?? args.category;
  if (!label) return undefined;
  const slug = resolveTopicSlug(String(label));
  if (!slug) return undefined;
  if (tool === 'list_events') {
    return `Prefer discover_topic({ topic: "${label}" }) for one-call events+markets. This call mapped to tagSlug "${resolved.tagSlug ?? slug}".`;
  }
  if (resolved.tagId != null) {
    return `Prefer discover_topic({ topic: "${label}" }). This call used tagId ${resolved.tagId} (slug "${slug}").`;
  }
  return `Could not resolve tagId for "${label}". Use discover_topic({ topic: "${slug}" }) or list_events({ tagSlug: "${slug}" }).`;
}

export type DiscoverTopicRequest = {
  topic: string;
  pageSize?: number;
  closed?: boolean;
  includeEvents?: boolean;
  includeMarkets?: boolean;
};

export type DiscoverTopicResult = {
  topic: string;
  tagSlug: string;
  tagId?: number;
  events: Event[];
  markets: Market[];
  sdkParamsUsed: { events: Record<string, unknown>; markets: Record<string, unknown> };
};

/** One native call: events + markets for a topic (weather, sports, etc.). */
export async function discoverTopic(req: DiscoverTopicRequest): Promise<DiscoverTopicResult> {
  const tagSlug = resolveTopicSlug(req.topic);
  if (!tagSlug) {
    throw new Error(
      `Unknown topic "${req.topic}". Use: weather, climate, sports, crypto, politics, science, entertainment (any case).`
    );
  }

  const pageSize = Math.min(Math.max(req.pageSize ?? 12, 1), 25);
  const closed = req.closed ?? false;
  const includeEvents = req.includeEvents !== false;
  const includeMarkets = req.includeMarkets !== false;
  const pub = getPublicClient();

  const eventsParams = { tagSlug, closed, pageSize };
  const marketsParams: Record<string, unknown> = { closed, pageSize };

  let events: Event[] = [];
  let markets: Market[] = [];
  let tagId: number | undefined;

  if (includeEvents) {
    const page = await firstPage(pub.listEvents(eventsParams));
    events = page.items ?? [];
  }

  if (includeMarkets) {
    tagId = await resolveTagIdFromSlug(tagSlug);
    if (tagId != null) {
      marketsParams.tagId = tagId;
      const page = await firstPage(pub.listMarkets(marketsParams as { tagId: number; closed: boolean; pageSize: number }));
      markets = page.items ?? [];
    }
  }

  return {
    topic: req.topic,
    tagSlug,
    tagId,
    events,
    markets,
    sdkParamsUsed: { events: eventsParams, markets: marketsParams },
  };
}

/** Static recipes so agents never guess tool names/args for common flows. */
export function getAgentRecipes(): Record<string, unknown> {
  return {
    note: 'Copy these exact tools/call shapes. Trading always uses explicit price/size — never intent. Load prompts/get mcp_tool_structure_and_categories for full contract.',
    topics: {
      weather: {
        discover: { tool: 'discover_topic', arguments: { topic: 'weather', closed: false, pageSize: 15 } },
        ukForecast: { tool: 'get_uk_weather_forecast', arguments: { city: 'London', days: 7 } },
        then: 'fetch_market({ tokenId }) → place_limit_order({ tokenId, price, size, side }) with your numbers',
      },
      sports: {
        discover: { tool: 'discover_topic', arguments: { topic: 'sports', closed: false } },
      },
      crypto: {
        discover: { tool: 'discover_topic', arguments: { topic: 'crypto', closed: false } },
      },
      rewards: {
        scan: { tool: 'list_active_maker_reward_markets', arguments: { maxMinCostUsd: 10 } },
        check: { tool: 'get_farmability', arguments: { tokenId: '<from scan yesTokenId or noTokenId>' } },
        place: { tool: 'place_optimized_reward_order', arguments: { tokenId: '<id>', price: 0.5, size: 10, side: 'BUY' } },
      },
    },
    startup: [
      'prompts/get mcp_tool_structure_and_categories',
      'prompts/get mcp_llms_full_guide',
      'get_strategies',
      'discover_topic OR list_active_maker_reward_markets depending on strategy',
    ],
    loadMore: { tool: 'get_tools_by_category', arguments: { category: 'Trading' } },
    supportedTopics: Object.keys(CATEGORY_TAG_SLUG),
  };
}