import type { Event, Market } from '@polymarket/client';
import { getPublicClient } from '../config/client.js';
import { KNOWN_AGENT_GOTCHAS } from '../mcp/agent-gotchas.js';
import { firstPage } from '../utils/pagination.js';
import { GAMMA_TAG_BY_SLUG, gammaTagId } from './gamma-tag-registry.js';
import {
  CATEGORY_TAG_SLUG,
  TOPIC_ALIASES,
  listDiscoverTopicHints,
} from './topic-aliases.js';

export { CATEGORY_TAG_SLUG, listDiscoverTopicHints };

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
  const lower = trimmed.toLowerCase();
  const upper = trimmed.toUpperCase();
  if (TOPIC_ALIASES[upper]) return TOPIC_ALIASES[upper];
  if (TOPIC_ALIASES[lower]) return TOPIC_ALIASES[lower];
  if (lower in GAMMA_TAG_BY_SLUG) return lower;
  return undefined;
}

/** All static Gamma tag slugs with stable numeric ids (for routing / discover_topic). */
export function listGammaTagSlugs(): Array<{ slug: string; id: number; label: string }> {
  return Object.entries(GAMMA_TAG_BY_SLUG).map(([slug, v]) => ({ slug, id: v.id, label: v.label }));
}

/** How discover_topic resolves a topic → tagId (registry first, then SDK fetchTag). */
export function resolveTopicTagRouting(topic: string): {
  topic: string;
  tagSlug: string;
  tagId?: number;
  tagIdSource: 'registry' | 'pending_sdk' | 'unknown';
} {
  const tagSlug = resolveTopicSlug(topic) ?? '';
  if (!tagSlug) return { topic, tagSlug: '', tagIdSource: 'unknown' };
  const staticId = gammaTagId(tagSlug);
  if (staticId != null) {
    return { topic, tagSlug, tagId: staticId, tagIdSource: 'registry' };
  }
  return { topic, tagSlug, tagIdSource: 'pending_sdk' };
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
  const staticId = gammaTagId(slug);
  if (staticId != null) {
    tagIdBySlugCache.set(slug, staticId);
    return staticId;
  }
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
  full?: boolean; // for intelligence routing: collect all pages server-side for large topics (e.g. world-cup full list) without client pagination
};

export type DiscoverTopicResult = {
  topic: string;
  tagSlug: string;
  tagId?: number;
  tagIdSource?: 'registry' | 'sdk_fetchTag';
  events: Event[];
  markets: Market[];
  sdkParamsUsed: { events: Record<string, unknown>; markets: Record<string, unknown> };
};

/** One native call: events + markets for a topic (weather, sports, etc.). */
export async function discoverTopic(req: DiscoverTopicRequest): Promise<DiscoverTopicResult> {
  const tagSlug = resolveTopicSlug(req.topic);
  if (!tagSlug) {
    throw new Error(
      `Unknown topic "${req.topic}". UK + US curated only — see get_agent_recipes.supportedTopicAliases (e.g. uk, london, politics, nfl, bitcoin, weather). Other regions: search({ q }).`
    );
  }

  const isFull = !!req.full;
  const pageSize = isFull ? 100 : Math.min(Math.max(req.pageSize ?? 12, 1), 25);
  const closed = req.closed ?? false;
  const includeEvents = req.includeEvents !== false;
  const includeMarkets = req.includeMarkets !== false;
  const pub = getPublicClient();

  // base params + auto-merge any filters passed from route intel (titleSearch, liquidityNumMin, volumeNumMin, rewardsMinSize, etc.)
  // so NL like "open world cup events with liquidity over 100k" auto-filters server-side, no mass raw data ever leaves MCP
  let eventsParams: any = { tagSlug, closed, pageSize };
  let marketsParams: any = { closed, pageSize };
  Object.keys(req).forEach((k) => {
    if (!['topic', 'pageSize', 'closed', 'includeEvents', 'includeMarkets', 'full'].includes(k)) {
      eventsParams[k] = (req as any)[k];
      marketsParams[k] = (req as any)[k];
    }
  });

  let events: Event[] = [];
  let markets: Market[] = [];
  let tagId: number | undefined;

  if (includeEvents) {
    if (isFull) {
      // full server-side collection for intelligence queries (e.g. "list all world cup")
      events = [];
      let offset = 0;
      while (true) {
        const params = { ...eventsParams, offset };
        const page = await firstPage(pub.listEvents(params));
        const items = page?.items ?? [];
        events.push(...items);
        if (items.length < pageSize) break;
        offset += pageSize;
      }
    } else {
      const page = await firstPage(pub.listEvents(eventsParams));
      events = page.items ?? [];
    }
  }

  if (includeMarkets) {
    tagId = await resolveTagIdFromSlug(tagSlug);
    if (tagId != null) {
      marketsParams.tagId = tagId;
      if (isFull) {
        markets = [];
        let offset = 0;
        while (true) {
          const params = { ...marketsParams, offset };
          const page = await firstPage(pub.listMarkets(params));
          const items = page?.items ?? [];
          markets.push(...items);
          if (items.length < pageSize) break;
          offset += pageSize;
        }
      } else {
        const page = await firstPage(pub.listMarkets(marketsParams as { tagId: number; closed: boolean; pageSize: number }));
        markets = page.items ?? [];
      }
    }
  }

  const tagIdSource: 'registry' | 'sdk_fetchTag' | undefined =
    tagId != null ? (gammaTagId(tagSlug) != null ? 'registry' : 'sdk_fetchTag') : undefined;

  return {
    topic: req.topic,
    tagSlug,
    tagId,
    tagIdSource,
    events,
    markets,
    sdkParamsUsed: { events: eventsParams, markets: marketsParams },
  };
}

/** Static recipes so agents never guess tool names/args for common flows. */
export function getAgentRecipes(): Record<string, unknown> {
  return {
    note: 'Tier-1 compact in tools/list. Full ~145 handlers via categories. Routing always on. Health: mcp_doctor or npm run doctor.',
    gammaTags: {
      count: listGammaTagSlugs().length,
      hint: 'discover_topic — UK + US curated topics only; alias → registry tagId',
      scope: 'UK_and_US_only',
      registryFastPath: ['uk', 'london', 'politics', 'nfl', 'bitcoin', 'weather', 'crypto', 'fed', 'election'],
      examples: ['bitcoin', 'nfl', 'openai', 'uk', 'weather'].map((topic) => {
        const tagSlug = resolveTopicSlug(topic) ?? topic;
        const tagId = gammaTagId(tagSlug);
        return {
          topic,
          tagSlug,
          tagId,
          tagIdSource: tagId != null ? 'registry' : 'sdk_fetchTag',
        };
      }),
    },
    supportedTopicAliases: listDiscoverTopicHints(),
    knownGotchas: KNOWN_AGENT_GOTCHAS,
    intentRouting: {
      tool: 'route_agent_intent',
      tradingRule:
        'Intent picks WHICH tools to call — never substitutes numeric price/size/side on place_*.',
      note: 'Supports 12+ NL queries via intent (e.g. "x sentiment fusion", "use host x_search for sentiment then externalSignals to alpha/strategy", "research categories first (External/Intelligence/Discovery) then execution after signals in strategy", "heartbeat/resource autonomy", "contradiction X vs book"). Host does x_search/sentiment (no native X search in MCP per rules); pass results as externalSignals array to generate_alpha_report/update_strategy. get_strategies() + fetch_sdk_readme first always. For true multi-market autonomy use composite lockedStrategyKey (e.g. "weather:low", "politics:high") in route_agent_intent or run_agent_cycle; the returned plan will include lockedStrategyKey, researchSource, priceMovementCondition, and precise next exact tool+args. Hermes (host) is the brain and owns the heartbeat.md / OpenClaw enforcement loop + primary control; the host (heartbeat-driven) keeps itself locked to that strategy entry and calls MCP planners from its ticks so the MCP remains active as the integration surface providing complete intent routing.',
      // NL intent routing layer removed; use get_agent_recipes for tool registry + examples of direct calls. Agent uses tools/list to see exposed tools and calls them by name.
      xSentimentForGaps: 'For sentiment/contradiction gaps: host x_keyword_search or semantic on topic (e.g. "weather forecast bearish"), map to externalSignals: [{tokenId, signal: 0.3 (bearish), label: "x_sentiment", weight:0.5}], feed to alpha_report (fuses vs book prior/skew/competitionSignal from farmability), then update_strategy. See alpha-report + reward_farming prompt.',
      researchExecutionOrder: 'ALWAYS (on Hermes host heartbeat tick): Research cats first via list_tool_categories + get_tools_by_category("External"|"Intelligence"|"Discovery") + alpha/external tools (with host externalSignals) -> store signals/filters in update_strategy (under the locked composite key Hermes manages) -> then Execution (Trading/Rewards/place_*) using explicit from get_strategies(locked) + calc. Never mix; get_strategies(locked) + send_heartbeat first on every host heartbeat tick. Use lockedStrategyKey="market:volume" for per-market per-volume distinct strategies (entry/exit/reprice/sizing/drawdown all live in that strategy store entry that the host owns and drives). Hermes is the brain; MCP strategy bag + planners are the integration surface.',
      lockedAutonomyPattern: 'Hermes (host) owns the brain + heartbeat.md / OpenClaw loop. The strict "stay locked only to this composite key" behavior (strategyLock) is **off by default** and is fully controlled by the host. 1. Host chooses composite key e.g. "weather:low". 2. (Optional but recommended for the mode) Call route_agent_intent({ intent: "enable_locked_autonomy", lockedStrategyKey: "weather:low" }) — this is the explicit "tool that locks the agent". It sets strategyLock: true on that key via update_strategy. To turn the strict lock off: route_agent_intent({ intent: "disable_locked_autonomy", lockedStrategyKey: "weather:low" }) or direct update_strategy({ tokenId: "weather:low", strategyLock: false }). Default (flag absent or false) = lock off. 3. On Hermes native heartbeat / resource notification (its enforcement layer): host calls send_heartbeat FIRST (per its heartbeat.md CLOB liveness contract to keep orders active) -> get_strategies({tokenId:"weather:low"}) -> route_agent_intent({ intent: "heartbeat_locked_autonomy" or a goal intent, lockedStrategyKey: "weather:low", heartbeat: true }). 4. The returned plan always loads the strategy first so the host sees the current strategyLock flag. If strategyLock === true: strict locked mode — execute narrow research steps (get_liquidity_health etc. + persist after each), obey price movement rules from the locked entry, "YOU STAY LOCKED to this exact market/volume tier ONLY for this tick", explicit place with numbers from locked+live, no deviation to other markets. If strategyLock === false (default): the key still provides excellent targeted research/signals via narrow tools, but there is no hard "stay only here" enforcement — the host brain may freely route to other keys or broader behavior. 5. After execution always update_strategy under THIS exact key with new lastPeg, signals, tick time for the next comparison. MCP planners return the deterministic research-backed plan; host executes and controls the lock state.',
      multiMarketHeartbeatOrchestration: 'For true multi-market autonomy (no human): Hermes maintains its own set of active lockedStrategyKeys (one per market/volume tier it is running). On every native heartbeat tick (its heartbeat.md driver): for each active key (or round-robin/subset to respect rate): send_heartbeat, get_strategies(locked), call the planner (route or run_agent_cycle) with lockedStrategyKey + heartbeat:true, receive the prescriptive plan (with priceMovementCondition, agentDirective locking it, exact next tool+args), execute the steps in order using live results for numbers (real-time price movement decision inside the locked rules), persist state via update_strategy under the exact key, obey the agentDirective ("LOCKED TO this key only. Real-time price movement check required. Stay on this strategy."). Research cats/alpha always scoped to the current locked key via externalSignals from host x_search. Native automation (run_agent_cycle) is triggered by the host heartbeat for the locked keys. MCP is the research/tool/strategy data layer only. End-to-end autonomous per tick, deterministic, locked, no guessing.',
      intelligenceLayerRole: 'MCP Intelligence layer (generate_alpha_report, compute_market_signals, rank_market_opportunities, get_farmability, alpha_report, list_active_maker_reward_markets for signals) is a research service that Hermes (the brain) calls via heartbeat. Job: produce research-backed signals (scores, ranked opportunities, bayesian divergence, competitionSignal, fusion/contradiction, farmability health, etc.) — not decisions. These signals are fed into the strategy store (supporting data layer) under the Hermes-managed locked per-market/per-volume composite key via update_strategy so Hermes can use them when executing the locked strategy. The Intelligence layer must never execute trades directly — only provide data. Always research (these tools + cats with host externalSignals) before any Execution in the locked plan for the current tick.\n\nUnlike the common categories of current prediction market intelligence systems, on-chain analytics platforms, and autonomous trading agents (simple alpha reports / ranking engines; Bayesian signal blending; basic regime detection; external data scraping + LLM summarization), the MCP Intelligence layer deliberately avoids hosting models or a model under MCP (because the MCP is used directly by Hermes and OpenClaw). It provides only deterministic research-backed signals and simple ranking/health/competition/farmability cards generated from native SDK data fused with host-injected externalSignals (from Hermes x_search, on-chain analytics platforms, etc.). Lightweight helpers such as computeBayesianPosterior (for contradiction detection in the signals card only) are present; these are not hosted models or Bayesian blending engines. Any complex modeling, regime detection, or LLM summarization is performed by Hermes (the brain) or supplied upstream via externalSignals. MCP stays the thin, callable research + signals + supporting bag + planner surface.\n\nSpecialized Narrow Research Mandates (the approved way to achieve "swarm-like" continuous research under heartbeat): The host (Hermes) loads the Intelligence category, then calls narrow single-mandate native tools (get_liquidity_health, get_competition_signal, compute_divergence, get_reward_farmability_snapshot, analyze_signal_contradiction, etc.) or the corresponding granular research_* intents via route_agent_intent on its own heartbeat ticks. After each narrow call the host immediately does update_strategy under the exact locked composite key with that focused signal. The MCP never runs internal continuous agents, swarms, or autonomous loops — all orchestration, sequencing, timing, and any further modeling on the persisted signals is done by Hermes on its heartbeat. This is how you get many specialized narrow research "agents" writing structured signals back to the strategy store while fully preserving intent routing + native tool usage as the fundamental contract.',
      endToEndProductionAutonomousExample: 'Hermes (brain) on native heartbeat tick (per heartbeat.md): 1. send_heartbeat (liveness). 2. get_strategies(lockedKey e.g. "weather:low" or full + filter for active). 3. list_tool_categories + get_tools_by_category("Intelligence"|"External"|"Discovery") or direct generate_alpha_report({goal, lockedStrategyKey, externalSignals: [from host x_search]}) + rank_market_opportunities + compute_market_signals for the locked key. 4. update_strategy({tokenId: lockedStrategyKey, alphaSignals: <from reports>, externalSignals, lastTick}). 5. get_farmability(token from locked) for real-time price movement vs locked priceMovementRules (drift etc.). 6. suggest_qualified_size from locked + live. 7. explicit place_optimized... or place_limit with numbers derived ONLY from locked + signals (no intent). 8. update_strategy({tokenId: lockedStrategyKey, lastPeg: currentMid, signals, ...}). 9. get_mcp_usage. Obey agentDirective (locked to this key only this tick). Research (intel + host signals) before exec. Use resources + wait_seconds for live between ticks. Multi-market: host manages set of lockedKeys, ticks independently or round-robin. Full deterministic no-guess via get_agent_recipes + planners + prompts. Production: mcp_doctor for health, search_tools for discovery, strategyStore for all rules/signals/priceMovement per locked key.\n\nHermes (host brain) may optionally apply its own Bayesian/regime/LLM modeling, further analysis, or scraping+LLM summarization to the persisted alphaSignals/externalSignals (or host x_search results) before the price-movement decision or sizing step. The MCP side stays pure signals + persist only — no models under MCP.',

    },
    startup: [
      'Routing always on — every native tool returns routing.nextTools; optional configure_agent_routing({ intent: "rewards_farm" })',
      'OR route_agent_intent({ intent: "session_startup" }) — fetch_sdk_readme + recipes',
      'Every native tool response includes routing.nextTools + toolPurpose + sdkMethod when routing enabled',
      'prompts/get never_guess_contract + agent_routing',
      'tools/list again after load_agent_profile (strict hosts)',
    ],
    setRoutingIntent: {
      tool: 'configure_agent_routing',
      arguments: { intent: 'rewards_farm' },
    },
    automation: {
      cycle: { tool: 'run_agent_cycle', arguments: { goal: 'rewards', maxMinCostUsd: 10 } },
      intents: { tool: 'route_agent_intent', arguments: { intent: 'rewards_farm', maxMinCostUsd: 10 } },
    },
    liveDocs: {
      sdkReadme: { tool: 'fetch_sdk_readme', arguments: {} },
      resource: 'polymarket://sdk/readme',
      mcpGuide: 'polymarket://mcp/llms.txt',
    },
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
      bitcoin: {
        discover: { tool: 'discover_topic', arguments: { topic: 'bitcoin', closed: false } },
      },
      nfl: {
        discover: { tool: 'discover_topic', arguments: { topic: 'nfl', closed: false } },
      },
      uk: {
        discover: { tool: 'discover_topic', arguments: { topic: 'uk', closed: false } },
      },
      ai: {
        discover: { tool: 'discover_topic', arguments: { topic: 'ai', closed: false } },
      },
      politics: {
        alpha: {
          tool: 'alpha_report',
          arguments: { goal: 'discovery', topic: 'politics', midPriceMin: 0.45, midPriceMax: 0.55 },
        },
        book: { tool: 'get_order_book', arguments: { tokenId: '<yesTokenId>' } },
        spread: { tool: 'get_spread', arguments: { tokenId: '<yesTokenId>' } },
      },
      rewards: {
        alpha: { tool: 'generate_alpha_report', arguments: { goal: 'rewards', maxMinCostUsd: 10 } },
        scan: { tool: 'list_active_maker_reward_markets', arguments: { maxMinCostUsd: 10 } },
        check: { tool: 'get_farmability', arguments: { tokenId: '<yesTokenId>' } },
        place: { tool: 'place_optimized_reward_order', arguments: { tokenId: '<yesTokenId>', side: 'BUY' } },
      },
      intelligence: {
        report: { tool: 'alpha_report', arguments: { goal: 'discovery', topic: 'politics', midPriceMin: 0.45, midPriceMax: 0.55 } },
        signals: { tool: 'compute_market_signals', arguments: { tokenId: '<tokenId>', signal: 0.55, weight: 0.4 } },
      },
    },
    profiles: {
      weather: { tool: 'load_agent_profile', arguments: { profile: 'weather' } },
      rewards: { tool: 'load_agent_profile', arguments: { profile: 'rewards' } },
      trading: { tool: 'load_agent_profile', arguments: { profile: 'trading' } },
      full: { tool: 'load_agent_profile', arguments: { profile: 'full' } },
    },
    findTool: { tool: 'search_tools', arguments: { query: '<keyword>', detail: 'summary' } },
    supportedTopics: listDiscoverTopicHints(),
    placeLimitOrder: {
      tool: 'place_limit_order',
      note: 'SDK PrepareLimitOrderRequest: tokenId, price, size, side, postOnly?, expiration? only — do NOT pass orderType',
      gtc: { tokenId: '<0x>', price: 0.5, size: 5, side: 'BUY' },
      gtd: { tokenId: '<0x>', price: 0.5, size: 5, side: 'BUY', orderType: 'GTD', expiration: 1735689600 },
    },
    builderSigning: {
      tool: 'generate_builder_headers',
      note: 'Official @polymarket/builder-signing-sdk integration (the missing GitHub piece). Use to generate canonical headers for Builder API auth (gasless attribution, /order etc with BUILDER_* creds). More robust than ad-hoc HMAC; always up-to-date. Example: generate_builder_headers({method: "POST", path: "/order", body: JSON.stringify(payload)}). Used internally for future-proof gasless flows with builder.',
      example: { method: 'POST', path: '/order', body: '{"marketId":"0x..."}' },
    },
    orderBook: { tool: 'get_order_book', arguments: { tokenId: '<0x or slug or decimal id>' } },
    strategies: {
      tool: 'get_strategies',
      note: 'Auto-seeds session defaults when store empty',
      arguments: {},
    },
    oneCallNativeIntent: {
      note: 'THE single native entry point that makes the agent never guess. For ANY Polymarket/Gamma question (discovery, events, World Cup, crypto, elections, sports, prices, catalogs, intelligence, filters, mass data, etc. — across all Gamma): call ONLY route_agent_intent({ naturalLanguage: "your exact question" }). MCP does full internal NLR classification (heuristic, no LLM), builds plan, auto-executes INTERNALLY for intel (full server-side offset paging collection + AUTOMATIC filter extraction from the NL — closed/open, liquidity/volume mins, titleSearch, rewards etc. — so 30k+ raw events never leak; everything MCP handled). Returns plan + directAnswer with the COMPLETE, already-filtered, structured, usable data (events + markets + tag + tokenIds + liquidity + prices + mids). agentDirective says "NATIVE INTENT DELIVERED ... complete answer from one call ... no further calls needed. Everything across Gamma handled inside MCP. No leaking, no raw function". Agent makes 1 call to MCP > gets the answer, no issues. This is full routing + intelligence routing. Filters/pagination/mass handling all internal — agent sees 1 tool and the answer.',
      example: {
        tool: 'route_agent_intent',
        arguments: { naturalLanguage: 'list all open world cup events with liquidity over 100k containing group' }
      }
    },
    publicWalletWatch: {
      note: 'To monitor any wallet\'s public activity (trades on markets it participates in) without auth (official UserWsClient limitation - only own wallet; listActivity maker and ClobUser realtime are auth-only per SDK): use extract_wallet_from_url on profile URL + list_trades({maker}) + (when loaded) subscribe_wallet_activity + the polymarket://wallet/{address}/activity resource for on-chain. 100% native where possible.',
    },
    realtimeResources: {
      note: 'Zero-token real-time awareness via MCP Resources (server-push, no polling). Subscribe to polymarket://user/orders (fills/cancels), polymarket://user/fills (filtered executions), polymarket://user/positions, polymarket://user/portfolio, polymarket://market/{tokenId}/book. Notifications/resources/updated on changes; re-read only when notified. route_agent_intent({ intent: "enable_realtime_streams" }) for plan. Enables agent learning from live events with minimal tokens.',
      keyUris: ['polymarket://user/orders', 'polymarket://user/fills', 'polymarket://user/activity', 'polymarket://market/{tokenId}/book'],
      protocol: 'resources/list + resources/subscribe + resources/read on notification',
    },
    lazyMetaTools: {
      note: 'Extreme token efficiency: default tools/list is small tier-1 meta only. Use search_tools for discovery, tool_describe(name) for on-demand full schema (no 110 upfront). Then direct call or (better) route_agent_intent(NL) for plans with exact steps. configure_lazy_tool_discovery intent for guidance. Reduces initial context >90%. All internal, agent never loads bloat.',
      metaTools: ['search_tools', 'tool_describe', 'route_agent_intent', 'get_agent_recipes', 'mcp_health', 'get_mcp_usage'],
    },
    fullApiCoverage: {
      note: '100% coverage means using the unified @polymarket/client SDK to its fullest – CLOB, Gamma (via GammaClient actions for market discovery/tags/events/series), Data (via DataClient for analytics/positions/PnL/activity/portfolio), and WebSocket user streams – all through the SDK, no external REST calls or raw HTTP. MCP exposes native tools/resources that call these SDK methods/clients only (e.g. discover_topic/list_tags/fetch_tag for Gamma, list_positions/generate_alpha_report for Data, place_optimized_reward_order for Relayer gasless, resources for WS). Confirmed: gamma-tag-registry.ts for Gamma metadata, list_positions etc. for Data, relayer config for gasless. full_api_coverage intent or route_agent_intent(NL) for plans. See mcp_llms_full_guide (starts with canonical SDK README) for exact mappings.',
      gamma: ['discover_topic (full paging + auto filters from NL, uses public/GammaClient paths)', 'list_tags', 'fetch_tag (SDK fetchTag)'],
      data: ['list_positions (with PnL via formatters, DataClient)', 'list_activity', 'fetch_portfolio_value', 'user resources (positions/portfolio/activity)'],
      streams: 'WS via SDK ReconnectingSubscription (user/market) bridged to MCP Resources (user/orders, user/fills, market/book) for real-time.',
      relayer: 'place_optimized_reward_order and relayer client for gasless (RelayerClient actions).',
    },
    sdkCoverageAndLimitations: {
      note: 'The MCP is built entirely on @polymarket/client (unified SDK consolidating CLOB/Gamma/Data/Relayer/WS). GammaClient for market discovery (gamma-tag-registry.ts, discover_topic, search). DataClient for analytics (list_positions with PnL, generate_alpha_report). RelayerClient for gasless (place_optimized_reward_order). WebSocket user streams via SDK subs to Resources. Limitation (API, not MCP gap): UserWsClient is authenticated feed – cannot monitor third-party wallet without that wallet\'s credentials. Agent never guesses: use route_agent_intent(NL) for 1-call plans that handle everything internally via SDK.',
      key: 'All operations SDK-only; see recipes and mcp_llms_full_guide for details.',
    },
    dynamicCredentials: {
      note: 'Runtime credential management for long-running/self-improving agents (no restart). reload_credentials for key rotation (picks current host .env). switch_profile(profilePath) for Hermes multi-profile identity changes. Integrates with loadProjectEnv detection (Hermes/OpenClaw). route for plans.',
      tools: ['reload_credentials', 'switch_profile'],
    },
    observability: {
      note: 'Lightweight for agent monitoring and self-improvement feedback loops. mcp_health (quick ok, source, resources, counts). mcp_doctor (full). get_mcp_usage (tool calls, blocks, patterns). Structured JSON to stderr in MCP mode. realtime + feedback data feeds agent learning (update_strategy with signals from observations).',
      tools: ['mcp_health', 'mcp_doctor', 'get_mcp_usage', 'get_routing_feedback'],
    },
  };
}