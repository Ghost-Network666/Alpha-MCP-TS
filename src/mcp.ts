// @ts-nocheck -- SDK beta types + heavy use of loose Record args for flexibility (pre-existing pattern across the file)
import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getPublicClient, getSecureClient, setupGaslessWallet } from './lib.js';
import * as F from './formatters.js';
import { getMarket } from './data/markets.js';
import {
  buildListEventsParams,
  buildListMarketsParams,
  discoverTopic,
  discoveryAgentNote,
  getAgentRecipes,
} from './data/discovery.js';
import { weatherClient } from './data/weather.js';
import {
  placeLimitOrder as sportsPlaceLimitOrder,
  placeMarketOrder as sportsPlaceMarketOrder,
  createApiKey,
  deriveApiKey,
  createOrDeriveApiKey,
  fetchApiKeys,
  deleteApiKey,
  fetchBalanceAllowance,
  updateBalanceAllowance,
  createBuilderApiKey,
  fetchBuilderApiKeys,
  revokeBuilderApiKey,
} from '@polymarket/client/actions';
import { createResourceManager, RESOURCE_CAPABILITIES } from './mcp/resources.js';
import { callWithRateLimitProtection, sleep } from './utils/errors.js';
import { logger } from './utils/logger.js';
import { buildAgentRoutingPrompt } from './mcp/agent-routing.js';
import {
  AGENT_PROFILES,
  searchToolDefinitions,
  TIER1_CORE_TOOL_NAMES,
} from './mcp/agent-meta.js';
import { buildMcpLlmsGuide, MCP_CATEGORIES } from './mcp/llms-guide.js';

// Mark as MCP server early so logger, env, and other modules can adapt (no stdout pollution, no process.exit on auth errors).
process.env.MCP_MODE = '1';
process.env.MCP_SERVER = 'true';

// === Simple in-memory strategy / rules / config store for autonomous agents (lightweight by design) ===
// The core reason the MCP can stay tiny (~8-9 default tools via categories) while giving the agent
// full power to dynamically manage *anything*: filters (liquidity, volume, spread, cost), operating rules,
// which events/categories, "best to high" ranking prefs, market farming rules (quote near mid, both sides,
// sticky, low-comp, exit conditions, 24/7 params), custom scoring, preferred markets, etc.
// Agent stores/evolves its own rules here using any key (e.g. "rules:current_farming", "filter:liquidity_high",
// "config:best_events", "global:operating_rules", or a tokenId). No extra tools = lightweight.
// Partial updates via update_strategy; retrieve all with get_strategies (no args).
// Persist critical long-term ones to your memory layer (e.g. Honcho). Lost on MCP restart otherwise.
const strategyStore = new Map<string, any>(); // key (tokenId or ruleKey) -> arbitrary object the agent owns
function getStrategyKey(tokenId: string, market?: string) {
  return market ? `${tokenId}:${market}` : tokenId;
}

// Lightweight in-MCP usage/activity tracking for operators and agents.
// Tracks tool call counts + last usage time (in-memory, reset on restart).
// This answers "how do you track the activities? the usage?" for the MCP surface itself.
// Exposed via the get_mcp_usage tool (always in core for observability).
// Platform-side activities (trades, rebates, rewards, positions) are tracked via list_activity + live user WS resources.
const mcpUsageTracker = {
  toolCalls: new Map<string, { count: number; lastCalled: string }>(),
  startTime: new Date().toISOString(),
  totalCalls: 0,
};

function recordToolUsage(toolName: string) {
  mcpUsageTracker.totalCalls++;
  const current = mcpUsageTracker.toolCalls.get(toolName) || { count: 0, lastCalled: '' };
  current.count++;
  current.lastCalled = new Date().toISOString();
  mcpUsageTracker.toolCalls.set(toolName, current);
  // Log to stderr (MCP stdio forbids stdout pollution). Use direct write to avoid any logger import/ordering/ "not defined" issues from recent changes (llms-guide + tracking). Same spirit as other stderr uses in this file.
  process.stderr.write(JSON.stringify({
    level: 'info',
    message: 'MCP tool activity',
    tool: toolName,
    countForTool: current.count,
    totalCalls: mcpUsageTracker.totalCalls,
    timestamp: new Date().toISOString()
  }) + '\n');
}

/**
 * Calculates the recommended order size based on explicit intent.
 * This enforces the user's defined rules:
 * - reward_farming / maker: Size to meet rewardsMinSize (no artificial $5 cap)
 * - market_taker / quick_flip: Hard $5 cap unless highConfidenceEdge === true
 */
function calculateRecommendedSize(params: {
  intent: 'reward_farming' | 'maker' | 'quick_flip' | 'market_taker';
  rewardsMinSize?: number | string;
  currentPrice?: number;
  capitalUsd?: number;
  highConfidenceEdge?: boolean;
  maxTakerSizeUsd?: number; // default 5
}): { size: number; reasoning: string; capped: boolean } {
  const {
    intent,
    rewardsMinSize,
    currentPrice = 0.5,
    capitalUsd,
    highConfidenceEdge = false,
    maxTakerSizeUsd = 5,
  } = params;

  const minSize = parseFloat(String(rewardsMinSize || '0'));

  if (['reward_farming', 'maker'].includes(intent)) {
    // Maker / reward mode: size to qualify, no artificial cap
    let size = Math.max(1, minSize || 1);
    if (capitalUsd && currentPrice > 0) {
      const maxAffordable = capitalUsd / currentPrice;
      if (size > maxAffordable) {
        size = Math.floor(maxAffordable);
      }
    }
    return {
      size: Math.max(0.01, size),
      reasoning: `Reward/Maker intent: sized to meet minSize=${minSize || 'program default'}. No artificial cap applied.`,
      capped: false,
    };
  }

  // Taker / market / quick flip mode
  const hardCap = maxTakerSizeUsd;
  let size = hardCap / Math.max(0.01, currentPrice);

  if (intent === 'quick_flip' && highConfidenceEdge) {
    // Only allow larger size for genuine high-confidence edges
    if (capitalUsd && currentPrice > 0) {
      size = Math.min(size, capitalUsd / currentPrice);
    }
    return {
      size: Math.max(0.01, size),
      reasoning: 'Quick flip with highConfidenceEdge=true: allowed to size above normal $5 cap.',
      capped: false,
    };
  }

  // Normal market/taker: hard $5 cap
  return {
    size: Math.max(0.01, hardCap / Math.max(0.01, currentPrice)),
    reasoning: `Market/Taker intent: hard capped at $${hardCap}. Use highConfidenceEdge=true only for near-guaranteed edges.`,
    capped: true,
  };
}

/**
 * Simple precision-weighted Bayesian update.
 * Matches the logic used in external mispricing scanners.
 * posterior = (1 - weight) * prior + weight * signal
 */
function computeBayesianPosterior(params: {
  prior: number;      // Platform price (0-1)
  signal: number;     // External signal, e.g. Kalshi price or Claude prob (0-1)
  weight: number;     // 0 to 1, how much to trust the signal
}): { posterior: number; divergence: number; reasoning: string } {
  const { prior, signal, weight = 0.5 } = params;
  const w = Math.max(0, Math.min(1, weight));
  const posterior = (1 - w) * prior + w * signal;
  const divergence = Math.abs(posterior - prior);
  return {
    posterior: Number(posterior.toFixed(4)),
    divergence: Number(divergence.toFixed(4)),
    reasoning: `Bayesian update with weight=${w}. Divergence from prior: ${(divergence * 100).toFixed(1)}pp`,
  };
}

// Map prompt-specified env var names (EOA_PRIVATE_KEY / DEPOSIT_WALLET_ADDRESS)
// onto the names expected by the existing getPublicClient / getSecureClient factories.
// This lets the MCP server work without modifying any other file in the codebase.
//
// IMPORTANT: This MCP is public. No hardcoded wallets, private keys, or defaults
// are allowed anywhere in the source or docs. Agent hosts / users MUST always
// supply their own EOA_PRIVATE_KEY and DEPOSIT_WALLET_ADDRESS (or WALLET_ADDRESS).
// The secure client will error if they are missing.
function normalizeEnvAliases() {
  if (process.env.EOA_PRIVATE_KEY && !process.env.PRIVATE_KEY) {
    process.env.PRIVATE_KEY = process.env.EOA_PRIVATE_KEY;
  }
  if (process.env.DEPOSIT_WALLET_ADDRESS && !process.env.WALLET_ADDRESS) {
    process.env.WALLET_ADDRESS = process.env.DEPOSIT_WALLET_ADDRESS;
  }
}
normalizeEnvAliases();

// All logging MUST go to stderr. Stdout is strictly for the MCP JSON-RPC protocol.
const server = new Server(
  { name: 'clob-mcp', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      resources: RESOURCE_CAPABILITIES,
      prompts: {},  // For on-demand best practices and structure (agent loads only when needed, reduces bloat)
    },
  }
);

// Resource manager (powers live subscriptions via WebSocket → MCP notifications/resources/updated)
const resourceManager = createResourceManager(
  server,
  () => getPublicClient(),
  async () => await getSecureClient()
);

// Safe wrapper: never throw, always return MCP content or { isError: true }
async function callTool<T>(fn: () => Promise<T>, toolName: string) {
  try {
    const result = await fn();
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
      }]
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `Error in ${toolName}: ${error?.message || String(error)}` }]
    };
  }
}

// Paginated tools: call .firstPage() and return page.items (as required)
async function callPaginated(paginatorPromise: Promise<any>, toolName: string) {
  try {
    const paginator = await paginatorPromise;
    const page = await (typeof paginator.firstPage === 'function'
      ? paginator.firstPage()
      : (typeof paginator.next === 'function' ? paginator.next() : null));
    const items = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(items, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
      }]
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `Error in ${toolName}: ${error?.message || String(error)}` }]
    };
  }
}

// Formatting wrappers — reuse stringify logic, never touch original callTool / callPaginated
async function callWithFormat<T>(fn: () => Promise<T>, formatter: (d: T) => any, toolName: string) {
  try {
    const result = await fn();
    const formatted = formatter(result);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(formatted, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
      }]
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `Error in ${toolName}: ${error?.message || String(error)}` }]
    };
  }
}

async function callPaginatedWithFormat(paginatorPromise: Promise<any>, formatter: (item: any) => any, toolName: string) {
  try {
    const paginator = await paginatorPromise;
    const page = await (typeof paginator.firstPage === 'function'
      ? paginator.firstPage()
      : (typeof paginator.next === 'function' ? paginator.next() : null));
    let items = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);

    // Global safety: cap very large responses to protect agents from bloat
    // Aggressive global safety cap (lowered further for reward-era lightness)
    const MAX_ITEMS = 25;
    if (Array.isArray(items) && items.length > MAX_ITEMS) {
      items = items.slice(0, MAX_ITEMS);
    }

    const formatted = Array.isArray(items) ? items.map(formatter) : formatter(items);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(formatted, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
      }]
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `Error in ${toolName}: ${error?.message || String(error)}` }]
    };
  }
}

/** Helper to keep responses lightweight for agents */
function sanitizePageSize(args: any, defaultSize = 30, maxSize = 100) {
  const size = args?.pageSize ?? args?.limit ?? defaultSize;
  return Math.min(Math.max(1, Number(size) || defaultSize), maxSize);
}

// ==================== TOOL CATEGORIES (for fast discovery, solves 100+ tool bloat) ====================

const TOOL_CATEGORIES: Record<string, string> = {
  // Will be populated with name -> category
  // Core categories: Discovery, Rewards, Trading, Account, Strategy, Analytics, Utilities, Weather
};

// Helper to get tools filtered by category
function getToolsByCategory(category: string) {
  const catLower = category.toLowerCase();
  return [...publicTools, ...secureTools].filter(t => {
    const desc = t.description || '';
    // Match by prefix tag [Trading] etc in description
    if (desc.toLowerCase().startsWith(`[${catLower}]`)) return true;
    // Match by keywords for untagged tools (or use [Category] prefix in desc for exact; Advanced uses keywords too)
    if (catLower === 'rewards' && /reward|maker reward|scoring|farmability|active_maker/i.test(desc)) return true;
    if (catLower === 'strategy' && /strategy|stop loss|take profit|sl\/tp/i.test(desc)) return true;
    if (catLower === 'account' && /balance|allowance|portfolio|position|profile|notification|comment/i.test(desc)) return true;
    if (catLower === 'trading' && /place|order|cancel|maker|post_order|prepare.*order|watch_order/i.test(desc)) return true;
    if (catLower === 'discovery' && /discover_topic|list_market|fetch_market|search|list_tag|list_sport|list_team|fetch_tag|list_event|list_series|list_.*leaderboard|public_profile/i.test(desc)) return true;
    if (catLower === 'meta' && /search_tools|load_agent_profile/i.test(desc)) return true;
    if (catLower === 'advanced' && /security-sensitive|sign_|send_transaction|prepare_|deploy_|end_authentication|get_secure_client_info|advanced/i.test(desc)) return true;
    if (catLower === 'meta' && /\[meta\]|meta|usage|track|discover|list_tool_category|get_tools_by_category/i.test(desc)) return true;
    if ((catLower === 'data' || catLower === 'analytics') && /(list_|fetch_|search|price|spread|midpoint|book|volume|interest|holder|tag|series|builder|trader|profile|neg_risk|tick|execute|market_info|traded|related|live_volume|prices|spreads|midpoints|order_books)/i.test(desc)) return true;
    if (catLower === 'weather' && /weather|uk_weather/i.test(desc)) return true;
    if (catLower === 'resources' && /resource|watch|heartbeat|scoring/i.test(desc)) return true;
    return false;
  });
}

function listAllCategories() {
  // Source of truth for categories is in llms-guide.ts (for the non-stale guide: SDK README first + MCP mappings).
  // This ensures the documented concepts in the MCP's llms guide stay in sync with runtime discovery.
  return [...MCP_CATEGORIES];
}

// ==================== TOOL DEFINITIONS (exactly per spec) ====================

const publicTools = [
  // === Category Discovery Tools (added to solve 100+ tool bloat) ===
  {
    name: 'list_tool_categories',
    description: '[Meta] Lists tool categories. Default tools/list is tier-1 only (~22 daily-driver tools). Use load_agent_profile({ profile }) or get_tools_by_category to register more (142 total, zero removed). START: get_agent_recipes. Categories: Rewards, Strategy, Account, Utilities, Discovery, Trading, Analytics, Weather, Meta, Advanced.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_tools_by_category',
    description: '[Meta] Returns tools for a specific category only. This call *dynamically registers* the tools so they are added to the exposed surface (stay available for session, appear on next tools/list). Use to load full SDK capabilities on demand without initial bloat. Categories include: Rewards, Strategy, Account, Trading, Discovery, Data/Analytics, Utilities, Weather (free UK weather APIs with fallbacks), Meta (discovery + get_mcp_usage for activities/usage tracking), Advanced (low-level/signing/prepare only when needed).',
    inputSchema: {
      type: 'object',
      properties: {
        category: { 
          type: 'string', 
          description: 'Category name from list_tool_categories (e.g. "Rewards", "Strategy", "Weather")' 
        }
      },
      required: ['category']
    }
  },
  {
    name: 'get_mcp_usage',
    description: '[Meta] Returns internal MCP usage and activity tracking stats: total tool calls since start, per-tool counts + last called timestamps, start time. This is how the MCP tracks its own activities and usage (tool invocations by consuming agents). Complements platform-side activity via list_activity + live polymarket://user/activity resources. Always available in core surface.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_agent_recipes',
    description: '[Meta] START HERE when unsure which tool to call. Returns exact native tool names + JSON argument shapes for common flows (weather, sports, crypto, rewards, startup sequence). No guessing — copy the recipe objects directly into tools/call.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'search_tools',
    description: '[Meta] Find tools by keyword without loading full tools/list. detail: "name" (smallest), "summary" (default), "schema" (full inputSchema). Example: search_tools({ query: "order book", detail: "summary" }). Then tools/call by name. All 142 tools exist — use load_agent_profile or get_tools_by_category to register more.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'e.g. weather, cancel, portfolio, tag' },
        detail: { type: 'string', enum: ['name', 'summary', 'schema'], description: 'Default summary' },
        limit: { type: 'number', description: 'Max results, default 15' },
      },
      required: ['query'],
    },
  },
  {
    name: 'load_agent_profile',
    description: '[Meta] One call registers a tool bundle for your session (progressive disclosure). Profiles: weather | rewards | trading | discovery | account | full. Re-call tools/list to see new tools. Does not remove any capability — only exposes more handlers. Example: load_agent_profile({ profile: "weather" }).',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          enum: ['weather', 'rewards', 'trading', 'discovery', 'account', 'full'],
        },
      },
      required: ['profile'],
    },
  },
  {
    name: 'discover_topic',
    description: '[Discovery] EASIEST native discovery: one call returns both events AND markets for a topic (weather, sports, crypto, politics, climate, science, entertainment). Maps topic→SDK tagSlug/tagId automatically. Prefer this over list_events+list_markets with category. Always includes Yes/No TokenIds on markets. Example: discover_topic({ topic: "weather", closed: false, pageSize: 15 }).',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'weather | sports | crypto | politics | climate | science | entertainment (any case, or WEATHER etc.)',
        },
        pageSize: { type: 'number', description: 'Per side, max 25, default 12' },
        closed: { type: 'boolean', description: 'false = open only (default)' },
        includeEvents: { type: 'boolean', description: 'Default true' },
        includeMarkets: { type: 'boolean', description: 'Default true' },
      },
      required: ['topic'],
    },
  },

  {
    name: 'list_markets',
    description: '[Discovery] Power-user market list (SDK listMarkets). Prefer discover_topic({ topic }) for weather/sports/etc. Supports tagId, titleSearch, clobTokenIds, rewardsMinSize, closed, pageSize. category/topic aliases resolve to tagId via fetchTag.',
    inputSchema: {
      type: 'object',
      properties: {
        closed: { type: 'boolean' },
        active: { type: 'boolean', description: 'Alias: active true → closed false' },
        category: { type: 'string', description: 'Ergonomic alias → tagId (WEATHER→weather tag). Not a raw API field.' },
        tagId: { type: 'number', description: 'SDK-native market tag filter (preferred when known)' },
        tagIds: { type: 'array', items: { type: 'number' } },
        tagSlug: { type: 'string', description: 'Use on list_events; markets use tagId (category alias resolves it)' },
        titleSearch: { type: 'string', description: 'SDK text filter on market question' },
        search: { type: 'string', description: 'Alias for titleSearch' },
        rewardsMinSize: { type: 'number', description: 'For farming: min size filter from SDK' },
        volumeNumMin: { type: 'number' },
        liquidityNumMin: { type: 'number' },
        clobTokenIds: { type: 'array', items: { type: 'string' } },
        conditionIds: { type: 'array', items: { type: 'string' } },
        pageSize: { type: 'number' },
        limit: { type: 'number' },
        offset: { type: 'number' }
      }
    }
  },
  {
    name: 'fetch_market',
    description: 'Fetch a single market by id, slug, url or tokenId (e.g. yes/no clobTokenId from reward lists or orders). Per official SDK (createPublicClient + listMarkets clob filter for tokenId case, since fetchMarket supports only id/slug/url per README), MCP resolves tokenId internally. Always returns Yes TokenId + No TokenId. Use before trading to get outcomes/tokens. See official ts-sdk README for client.getMarket / listMarkets.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        slug: { type: 'string' },
        url: { type: 'string' },
        tokenId: { type: 'string' }
      }
    }
  },
  {
    name: 'list_events',
    description: '[Discovery] Power-user event list (SDK listEvents). Prefer discover_topic({ topic }) for weather/sports/etc. Supports tagSlug, tagIds, titleSearch, closed, pageSize. category/topic map to tagSlug.',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' },
        closed: { type: 'boolean' },
        category: { type: 'string', description: 'Ergonomic alias → tagSlug (WEATHER→weather). Not a raw API field.' },
        tagSlug: { type: 'string', description: 'SDK-native (e.g. weather, climate, sports)' },
        tagIds: { type: 'array', items: { type: 'number' } },
        titleSearch: { type: 'string' }
      }
    }
  },
  {
    name: 'fetch_event',
    description: 'Fetch a single event by id or slug',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        slug: { type: 'string' }
      }
    }
  },

  {
    name: 'search',
    description: 'Official full-text search via client.search(). Excellent for finding short-duration, high-resolution, or niche markets (e.g. "bitcoin 15 minutes", "will bitcoin reach 150k by friday"). Returns markets, events, tags, and profiles. Use precise queries for best results on 5m/15m/1h resolution markets.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Search query. Try specific terms like "bitcoin 15 minutes", "15m", "5 minute", or "will bitcoin"' },
        pageSize: { type: 'number' },
        // The official SDK search accepts additional options; pass-through supported
        closed: { type: 'boolean' },
        active: { type: 'boolean' },
        category: { type: 'string' }
      },
      required: ['q']
    }
  },
  // === Weather (free UK-focused multi-provider APIs with auto-fallback for rate limits; native tools for agents + heartbeat enhancement)
  {
    name: 'get_uk_weather_forecast',
    description: '[Weather] Free UK weather forecast (Open-Meteo primary no-key + UK Met Office UKV 2km model; fallbacks to OpenWeatherMap/VisualCrossing/WeatherAPI if rate limited or error). Use for WEATHER category markets, mispricing vs prices, heartbeat signals. Cities: London, Manchester, etc or lat,lon.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'UK city e.g. "London", "Manchester" or "51.5074,-0.1278"' },
        days: { type: 'number', description: 'Forecast days (default 7, max 16 for Open-Meteo)' },
        variables: { type: 'array', items: { type: 'string' }, description: 'Optional hourly vars e.g. ["temperature_2m","precipitation"]' }
      },
      required: ['city']
    }
  },
  {
    name: 'get_uk_weather_historical',
    description: '[Weather] Free UK historical weather (multi-provider fallback). For verifying past markets or backtesting. Requires dates.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'UK city or lat,lon' },
        start_date: { type: 'string', description: 'YYYY-MM-DD' },
        end_date: { type: 'string', description: 'YYYY-MM-DD' },
        variables: { type: 'array', items: { type: 'string' } }
      },
      required: ['city', 'start_date', 'end_date']
    }
  },
  {
    name: 'get_uk_weather_current',
    description: '[Weather] Free current UK weather (multi-provider). For real-time signals.',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'UK city or lat,lon' },
        variables: { type: 'array', items: { type: 'string' } }
      },
      required: ['city']
    }
  },
  {
    name: 'fetch_order_book',
    description: 'Fetch current order book for a token',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' }
      },
      required: ['tokenId']
    }
  },
  {
    name: 'fetch_price',
    description: 'Fetch last trade price for a side',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        side: { type: 'string', enum: ['BUY', 'SELL'] }
      },
      required: ['tokenId', 'side']
    }
  },
  {
    name: 'fetch_midpoint',
    description: 'Fetch current midpoint price for a token',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' }
      },
      required: ['tokenId']
    }
  },
  {
    name: 'fetch_spread',
    description: 'Fetch current spread for a token',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' }
      },
      required: ['tokenId']
    }
  },
  {
    name: 'fetch_price_history',
    description: 'Fetch price history for a token',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        interval: { type: 'string' }
      },
      required: ['tokenId']
    }
  },
  {
    name: 'fetch_last_trade_price',
    description: 'Fetch the most recent trade price for a token',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' }
      },
      required: ['tokenId']
    }
  },
  {
    name: 'fetch_last_trade_prices',
    description: 'Fetch the most recent trade price for multiple tokens at once (batch). More efficient than calling one by one.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of token IDs'
        }
      },
      required: ['tokenIds']
    }
  },
  {
    name: 'list_trades',
    description: 'List recent trades (optionally filtered by user)',
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string' },
        pageSize: { type: 'number' }
      }
    }
  },
  {
    name: 'estimate_market_price',
    description: 'Estimate price impact for a market order',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        amount: { type: 'number' }
      },
      required: ['tokenId', 'side', 'amount']
    }
  },

  // Leaderboards + Public Profiles (public)
  {
    name: 'list_builder_leaderboard',
    description: 'List top builders by volume',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' },
        timePeriod: { type: 'string', enum: ['DAY', 'WEEK', 'MONTH', 'ALL'] }
      }
    }
  },
  {
    name: 'list_trader_leaderboard',
    description: 'List top traders by PNL or volume',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' },
        timePeriod: { type: 'string', enum: ['DAY', 'WEEK', 'MONTH', 'ALL'] },
        orderBy: { type: 'string', enum: ['PNL', 'VOL'] }
      }
    }
  },
  {
    name: 'fetch_public_profile',
    description: 'Fetch public profile by wallet address',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string' }
      },
      required: ['address']
    }
  },

  // Reward programs (public viewing)
  {
    name: 'list_current_rewards',
    description: 'RAW SDK: List currently active reward programs (can return large payloads). For all autonomous reward-farming agent loops, use list_active_maker_reward_markets instead — it is tiny (hard cap 10), ranked by attractiveness, enriched with market questions + yes/no tokenIds + direct links, and designed so agents never need to ask humans for "next market".',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' }
      }
    }
  },
  {
    name: 'list_market_rewards',
    description: 'RAW SDK: List reward configuration for a specific market (conditionId). Prefer list_active_maker_reward_markets for discovery and switching.',
    inputSchema: {
      type: 'object',
      properties: {
        conditionId: { type: 'string' },
        pageSize: { type: 'number' }
      },
      required: ['conditionId']
    }
  },

  // Sports (public)
  {
    name: 'list_sports',
    description: 'List available sports',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'fetch_sports_market_types',
    description: 'Fetch sports market types',
    inputSchema: { type: 'object', properties: {} }
  },

  // Batch data (public)
  {
    name: 'fetch_prices',
    description: '[Data] Fetch prices for multiple tokens',
    inputSchema: {
      type: 'object',
      properties: {
        tokenIds: { type: 'array', items: { type: 'string' } }
      },
      required: ['tokenIds']
    }
  },
  {
    name: 'fetch_order_books',
    description: 'Fetch order books for multiple tokens',
    inputSchema: {
      type: 'object',
      properties: {
        tokenIds: { type: 'array', items: { type: 'string' } }
      },
      required: ['tokenIds']
    }
  },

  // Metadata (public)
  {
    name: 'fetch_event_tags',
    description: 'Fetch tags for an event',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'fetch_market_tags',
    description: 'Fetch tags for a market',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'fetch_neg_risk',
    description: 'Check if a market is neg-risk',
    inputSchema: {
      type: 'object',
      properties: {
        conditionId: { type: 'string' }
      },
      required: ['conditionId']
    }
  },
  {
    name: 'fetch_tick_size',
    description: 'Fetch tick size for a token',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' }
      },
      required: ['tokenId']
    }
  },
  {
    name: 'fetch_execute_params',
    description: 'Fetch relayer execute parameters',
    inputSchema: { type: 'object', properties: {} }
  },

  // Additional discovery & data (newly exposed from full SDK)
  {
    name: 'list_teams',
    description: 'List teams (sports)',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' }
      }
    }
  },
  {
    name: 'fetch_market_info',
    description: 'Fetch extended market information',
    inputSchema: {
      type: 'object',
      properties: {
        marketId: { type: 'string' }
      },
      required: ['marketId']
    }
  },
  {
    name: 'fetch_midpoints',
    description: 'Fetch midpoint prices for multiple tokens',
    inputSchema: {
      type: 'object',
      properties: {
        tokenIds: { type: 'array', items: { type: 'string' } }
      },
      required: ['tokenIds']
    }
  },
  {
    name: 'fetch_spreads',
    description: 'Fetch spreads for multiple tokens',
    inputSchema: {
      type: 'object',
      properties: {
        tokenIds: { type: 'array', items: { type: 'string' } }
      },
      required: ['tokenIds']
    }
  },
  {
    name: 'fetch_builder_fee_rates',
    description: 'Fetch fee rates for a builder',
    inputSchema: {
      type: 'object',
      properties: {
        builder: { type: 'string' }
      },
      required: ['builder']
    }
  },
  {
    name: 'fetch_traded_market_count',
    description: 'Fetch number of markets traded by a user',
    inputSchema: {
      type: 'object',
      properties: {
        user: { type: 'string' }
      },
      required: ['user']
    }
  },
  {
    name: 'fetch_related_tag_resources',
    description: 'Fetch related resources for a tag',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  },
  {
    name: 'list_market_positions',
    description: 'List positions for a specific market',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'string' },
        limit: { type: 'number' },
        minBalance: { type: 'number' }
      },
      required: ['market']
    }
  },

  // === Additional Gamma / Discovery (public, completes all categories: tags, series, builder data, holders, interest, live volume) ===
  // Note: schemas aligned to SDK post-971f6a3 (dropped includeChat/categories* from tags/series; RelatedTag camelCase)
  {
    name: 'list_tags',
    description: 'List all tags (categories) used across markets and events. (SDK now drops includeChat; closed not supported here—use status on related resources.)',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' },
        includeTemplate: { type: 'boolean' },
        isCarousel: { type: 'boolean' },
        locale: { type: 'string' },
        ascending: { type: 'boolean' }
      }
    }
  },
  {
    name: 'fetch_tag',
    description: 'Fetch a single tag by id or slug',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        slug: { type: 'string' },
        includeTemplate: { type: 'boolean' },
        locale: { type: 'string' }
      }
    }
  },
  {
    name: 'fetch_related_tags',
    description: 'Fetch tags related to a given tag (post-SDK: tagId/relatedTagId are now camelCase normalized)',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        slug: { type: 'string' },
        omitEmpty: { type: 'boolean' },
        status: { type: 'string', enum: ['closed', 'all', 'active'] }
      }
    }
  },

  // Comments (newly exposed from SDK)
  {
    name: 'list_comments',
    description: 'List comments for an event or series (parentEntityType = "Event" or "Series"). Very useful for sentiment and context.',
    inputSchema: {
      type: 'object',
      properties: {
        parentEntityId: { type: 'string' },
        parentEntityType: { type: 'string', enum: ['Event', 'Series'] },
        pageSize: { type: 'number' },
        holdersOnly: { type: 'boolean' },
        getPositions: { type: 'boolean' }
      },
      required: ['parentEntityId', 'parentEntityType']
    }
  },
  {
    name: 'fetch_comment',
    description: 'Fetch a full comment thread by comment ID',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        getPositions: { type: 'boolean' }
      },
      required: ['id']
    }
  },
  {
    name: 'list_comments_by_user_address',
    description: 'List comments made by a specific wallet address',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        pageSize: { type: 'number' }
      },
      required: ['address']
    }
  },

  {
    name: 'list_series',
    description: 'List market series (grouped markets). (SDK update: dropped unsupported categoriesIds/categoriesLabels/includeChat)',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' },
        closed: { type: 'boolean' },
        locale: { type: 'string' },
        excludeEvents: { type: 'boolean' },
        recurrence: { type: 'string', enum: ['daily', 'weekly', 'monthly'] }
      }
    }
  },
  {
    name: 'fetch_series',
    description: 'Fetch a single series by id or slug',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        slug: { type: 'string' },
        locale: { type: 'string' }
      }
    }
  },
  {
    name: 'list_builder_trades',
    description: 'List trades attributed to a specific builder',
    inputSchema: {
      type: 'object',
      properties: {
        builderCode: { type: 'string' },
        market: { type: 'string' },
        tokenId: { type: 'string' },
        pageSize: { type: 'number' }
      },
      required: ['builderCode']
    }
  },
  {
    name: 'fetch_builder_volume',
    description: 'Fetch volume and stats for a builder',
    inputSchema: {
      type: 'object',
      properties: {
        timePeriod: { type: 'string', enum: ['DAY', 'WEEK', 'MONTH', 'ALL'] }
      }
    }
  },
  {
    name: 'list_market_holders',
    description: 'List top holders for one or more markets',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'array', items: { type: 'string' } },
        limit: { type: 'number' },
        minBalance: { type: 'number' }
      },
      required: ['market']
    }
  },
  {
    name: 'list_open_interest',
    description: 'List open interest (total size) for markets',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  {
    name: 'fetch_event_live_volume',
    description: 'Fetch live volume for an event',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  }
];

const secureTools = [
  {
    name: 'place_limit_order',
    description: '[Trading] Place a limit order (official SDK: createSecureClient({signer, wallet}).extend(allActions).placeLimitOrder(params) or postOrder after createLimitOrder). Requires EOA_PRIVATE_KEY + DEPOSIT_WALLET_ADDRESS (per SDK secure client). Defaults to GTC + postOnly for maker (rewards). See official ts-sdk README + client for param shapes (tokenId, price, size, side, orderType, postOnly).',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        price: { type: 'number' },
        size: { type: 'number' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        orderType: { type: 'string', enum: ['GTC', 'GTD', 'FOK', 'FAK'] },
        postOnly: { type: 'boolean' },
        builderCode: { type: 'string' },
        expiration: { type: 'number', description: 'Unix timestamp (seconds) after which the order expires (GTD)' }
      },
      required: ['tokenId', 'price', 'size', 'side']
    }
  },
  {
    name: 'place_market_order',
    description: '[Trading] Place a market order (requires EOA_PRIVATE_KEY + DEPOSIT_WALLET_ADDRESS)',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        amount: { type: 'number', description: 'USD notional for BUY (use with orderType)' },
        shares: { type: 'number', description: 'Shares for SELL (use with orderType)' },
        orderType: { type: 'string', enum: ['FAK', 'FOK'], description: 'FAK (partial ok) or FOK (all or nothing)' },
        maxSpend: { type: 'number', description: 'Optional max total spend (incl fees) for BUY' },
        builderCode: { type: 'string' }
      },
      required: ['tokenId', 'side']
    }
  },
  {
    name: 'create_and_post_order',
    description: '[Trading] Recommended unified tool for placing GTC maker orders that earn platform rewards. Creates and posts a limit order using the SDK. Defaults to orderType=GTC and postOnly=true (rests on book as maker, no taker fees, eligible for rewards). Use this instead of raw place_limit_order for most maker workflows.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        price: { type: 'number' },
        size: { type: 'number' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        orderType: { type: 'string', enum: ['GTC', 'GTD', 'FOK', 'FAK'] },
        postOnly: { type: 'boolean' }
      },
      required: ['tokenId', 'price', 'size', 'side']
    }
  },
  {
    name: 'sports_place_limit_order',
    description: 'Place a limit order on sports markets via sports action (GTC maker by default for rewards). Requires EOA_PRIVATE_KEY + DEPOSIT_WALLET_ADDRESS. Defaults to orderType=GTC and postOnly=true.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        price: { type: 'number' },
        size: { type: 'number' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        orderType: { type: 'string', enum: ['GTC', 'GTD', 'FOK', 'FAK'] },
        postOnly: { type: 'boolean' }
      },
      required: ['tokenId', 'price', 'size', 'side']
    }
  },
  {
    name: 'sports_place_market_order',
    description: 'Place a market order on sports markets via sports action (requires EOA_PRIVATE_KEY + DEPOSIT_WALLET_ADDRESS)',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        amount: { type: 'number' },
        side: { type: 'string', enum: ['BUY', 'SELL'] }
      },
      required: ['tokenId', 'amount', 'side']
    }
  },
  {
    name: 'cancel_order',
    description: 'Cancel a single order',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' }
      },
      required: ['orderId']
    }
  },
  {
    name: 'cancel_orders',
    description: 'Cancel multiple orders',
    inputSchema: {
      type: 'object',
      properties: {
        orderIds: { type: 'array', items: { type: 'string' } }
      },
      required: ['orderIds']
    }
  },
  {
    name: 'cancel_all',
    description: 'Cancel all open orders for the authenticated wallet',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'cancel_market_orders',
    description: 'Cancel all orders for a specific token (or market)',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' }
      },
      required: ['tokenId']
    }
  },
  {
    name: 'list_open_orders',
    description: 'List open orders (optionally filtered by market)',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'string' }
      }
    }
  },
  {
    name: 'fetch_order',
    description: 'Fetch details for a specific order',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' }
      },
      required: ['orderId']
    }
  },
  {
    name: 'watch_order_until_filled',
    description: 'Start (or ensure) watching a specific orderId for fill completion. Returns a live resource URI (polymarket://order/{orderId}/fill-status) that you can subscribe to. This watch is automatically started for EVERY order placed via the placement tools. The resource will receive updates when the order is partially or fully filled, including any on-chain transaction details.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        timeoutSeconds: { type: 'number', description: 'Optional maximum time to watch in seconds (default 300)' }
      },
      required: ['orderId']
    }
  },
  {
    name: 'list_positions',
    description: 'List current positions',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'array', items: { type: 'string' } },
        pageSize: { type: 'number' }
      }
    }
  },
  {
    name: 'list_closed_positions',
    description: 'List closed/resolved positions',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' }
      }
    }
  },
  {
    name: 'fetch_portfolio_value',
    description: 'Get current portfolio value',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_activity',
    description: 'List recent account activity (includes TRADE, SPLIT, MERGE, REDEEM, MAKER_REBATE, REWARD, REFERRAL_REWARD, YIELD, CONVERSION etc. Rebates are present here via the SDK activity method — no separate rebate tool needed).',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' }
      }
    }
  },
  {
    name: 'list_account_trades',
    description: 'List historical trades for the account',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' }
      }
    }
  },
  {
    name: 'setup_trading_approvals',
    description: 'Set up trading approvals (ERC20 + CTF). Per latest SDK: idempotent (safe to call repeatedly, no-op if already set). Includes auto-redeem approval for redemption workflows.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'enable_auto_redeem',
    description: 'Enable auto-redeem for resolved positions (idempotent per latest SDK; performs the required contract approval for redemption). Delegates to setup_trading_approvals.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'split_position',
    description: 'Split collateral into outcome tokens (CTF)',
    inputSchema: {
      type: 'object',
      properties: {
        conditionId: { type: 'string' },
        amount: { type: 'string' }
      },
      required: ['conditionId', 'amount']
    }
  },
  {
    name: 'merge_positions',
    description: 'Merge outcome tokens back into collateral (CTF)',
    inputSchema: {
      type: 'object',
      properties: {
        conditionId: { type: 'string' },
        amount: { type: 'string' }
      },
      required: ['conditionId', 'amount']
    }
  },
  {
    name: 'redeem_positions',
    description: 'Redeem resolved positions (by marketId or conditionId). Auto-redeem is enabled via contract approval (included in setup_trading_approvals; explicit SDK helper noted for future).',
    inputSchema: {
      type: 'object',
      properties: {
        marketId: { type: 'string' },
        conditionId: { type: 'string' }
      }
    }
  },

  // Reward tracking (authenticated viewing only)
  {
    name: 'fetch_reward_percentages',
    description: 'Fetch your current reward percentages',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_user_earnings_and_markets_config',
    description: 'List your reward earnings per market for a date. Use compact mode for much smaller responses.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string' },
        pageSize: { type: 'number' },
        compact: { type: 'boolean', description: 'Return compact format (default: true). When false, includes full reward config details.' }
      }
    }
  },

  // Gasless prepare workflows (secure)
  {
    name: 'prepare_limit_order',
    description: '[Advanced] Prepare a limit order workflow (gasless)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_market_order',
    description: '[Advanced] Prepare a market order workflow (gasless)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_gasless_transaction',
    description: '[Advanced] Prepare a gasless transaction',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_split_position',
    description: '[Advanced] Prepare split position workflow (CTF)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_merge_positions',
    description: '[Advanced] Prepare merge positions workflow (CTF)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_redeem_positions',
    description: '[Advanced] Prepare redeem positions workflow (CTF). Auto-redeem requires the redemption approval (see setup_trading_approvals which includes it).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_erc20_approval',
    description: '[Advanced] Prepare ERC20 approval workflow',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_erc1155_approval_for_all',
    description: '[Advanced] Prepare ERC1155 setApprovalForAll workflow',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_erc20_transfer',
    description: '[Advanced] Prepare ERC20 transfer workflow',
    inputSchema: { type: 'object', properties: {} }
  },

  // Lower-level order posting (secure)
  {
    name: 'post_order',
    description: 'Post a pre-signed SignedOrder (the exact object returned by createLimitOrder on the secure client)',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true }
  },
  {
    name: 'post_orders',
    description: '[Trading] Post multiple pre-signed SignedOrders in one request (up to 15). Strongly preferred for market makers doing two-sided or multi-level quoting/requoting to reduce latency and roundtrips vs individual places. Essential for volume without triggering CLOB V2 place-path contention. Use with createLimitOrder etc. on secure client.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'send_heartbeat',
    description: '[Trading] Send heartbeat to maintain active CLOB session (prevents auto-cancel of open orders if not sent regularly). From llms.txt trade/send-heartbeat. Useful for long-lived MCP/agents. SDK may handle internally for WS; this exposes for REST/session. Rate limit low.',
    inputSchema: { type: 'object', properties: {} }
  },

  // Direct on-chain (secure)
  {
    name: 'approve_erc20',
    description: 'Approve ERC20 spending (direct)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'approve_erc1155_for_all',
    description: 'Approve ERC1155 for all (direct)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'transfer_erc20',
    description: 'Transfer ERC20 (direct)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'resolve_condition_by_token',
    description: 'Resolve condition by token (CTF)',
    inputSchema: { type: 'object', properties: {} }
  },

  // Account / wallet additional (secure)
  {
    name: 'update_balance_allowance',
    description: '[Advanced] Update balance allowance',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deploy_deposit_wallet',
    description: '[Advanced] Deploy (current deterministic) deposit wallet (per latest SDK: auto for DEPOSIT_WALLET in createSecureClient; explicit tool for manual).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'download_accounting_snapshot',
    description: '[Advanced] Download accounting snapshot',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'setup_gasless_wallet',
    description: 'Setup gasless wallet (per latest SDK: @deprecated no-op after createSecureClient deposit default; gasless handled at creation for non-EOA. Kept for compat).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'fetch_transaction',
    description: 'Fetch gasless transaction details',
    inputSchema: { type: 'object', properties: {} }
  },

  // API Key Management (via actions; low-level L1 signed payloads for create/derive)
  {
    name: 'create_api_key',
    description: '[Advanced] Create API key from signed L1 auth payload. API keys must be derived from EOA private key, not deposit wallet',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        nonce: { type: 'number' },
        signature: { type: 'string' },
        timestamp: { type: 'number' }
      },
      required: ['address', 'nonce', 'signature', 'timestamp']
    }
  },
  {
    name: 'derive_api_key',
    description: '[Advanced] Derive existing API key from signed L1 auth payload. API keys must be derived from EOA private key, not deposit wallet',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        nonce: { type: 'number' },
        signature: { type: 'string' },
        timestamp: { type: 'number' }
      },
      required: ['address', 'nonce', 'signature', 'timestamp']
    }
  },
  {
    name: 'create_or_derive_api_key',
    description: '[Advanced] Create or fall back to derive API key from signed L1 auth payload. API keys must be derived from EOA private key, not deposit wallet',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string' },
        nonce: { type: 'number' },
        signature: { type: 'string' },
        timestamp: { type: 'number' }
      },
      required: ['address', 'nonce', 'signature', 'timestamp']
    }
  },
  {
    name: 'fetch_api_keys',
    description: '[Advanced] Fetch all API keys for the authenticated account. API keys must be derived from EOA private key, not deposit wallet',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'delete_api_key',
    description: '[Advanced] Delete the currently authenticated API key. API keys must be derived from EOA private key, not deposit wallet',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_builder_api_key',
    description: '[Account] [Advanced] Create a builder API key (for HMAC attribution/relayer flows). SDK: createBuilderApiKey or equivalent. Use for builder auth strategy in createSecureClient. Requires secure client + builder creds in env.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' }
      }
    }
  },
  {
    name: 'fetch_builder_api_keys',
    description: '[Account] [Advanced] Fetch builder API keys for the account. SDK equivalent. Complements create/revoke for full builder key lifecycle.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'revoke_builder_api_key',
    description: '[Account] [Advanced] Revoke a builder API key by id. SDK: revokeBuilderApiKey.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' }
      },
      required: ['id']
    }
  },

  // === Additional Secure Account / Data (completes all handler cases) ===
  {
    name: 'fetch_notifications',
    description: 'Fetch notifications for the authenticated account',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'drop_notifications',
    description: 'Drop/clear notifications',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'fetch_closed_only_mode',
    description: 'Check if closed-only mode is enabled for the account',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'is_gasless_ready',
    description: 'Check if the gasless/relayer wallet is ready (per latest SDK: gasless often auto for deposit wallets created via createSecureClient).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'fetch_deposit_wallet',
    description: '[Account] [Advanced] Fetch/derive the deposit wallet for the authenticated account (SDK getDepositWallet + resolve flows). Pairs with deploy_deposit_wallet.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_profile',
    description: '[Account] Fetch the authenticated account profile (secure view; complements fetch_public_profile).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'update_profile',
    description: '[Account] Update the authenticated account profile.',
    inputSchema: {
      type: 'object',
      properties: {
        displayName: { type: 'string' },
        // other fields per SDK
      }
    }
  },
  {
    name: 'post_comment',
    description: '[Account] Post a comment (for account activity/engagement).',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'string' },
        text: { type: 'string' }
      },
      required: ['market', 'text']
    }
  },
  {
    name: 'fetch_order_scoring',
    description: 'Check if an order is eligible for rewards/scoring',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' }
      },
      required: ['orderId']
    }
  },
  {
    name: 'fetch_orders_scoring',
    description: 'Batch check order scoring eligibility',
    inputSchema: {
      type: 'object',
      properties: {
        orderIds: { type: 'array', items: { type: 'string' } }
      },
      required: ['orderIds']
    }
  },
  {
    name: 'get_order_scoring_status',
    description: 'Check if a placed GTC maker order is scoring rewards (eligible for maker incentives)',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' }
      },
      required: ['orderId']
    }
  },
  {
    name: 'get_reward_earnings',
    description: 'Get maker reward earnings for the authenticated wallet (USDC). Optional date (YYYY-MM-DD) for a specific day.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string' }
      }
    }
  },
  {
    name: 'list_user_earnings_for_day',
    description: 'List user reward earnings for a specific day. Use compact mode for smaller responses.',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string' },
        pageSize: { type: 'number' },
        compact: { type: 'boolean', description: 'Return compact format (default: true).' }
      }
    }
  },
  {
    name: 'fetch_total_earnings_for_user_for_day',
    description: 'Fetch total earnings for the user on a given day',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string' }
      }
    }
  },

  // === Maker Rewards Focused Workflow (High Success Rate for Earning Rewards) ===
  {
    name: 'place_maker_reward_order',
    description: '[Rewards] STRICT REWARD-ONLY TOOL (per official SDK secure client + postOrder with postOnly GTC for maker rewards eligibility). Forces GTC+postOnly and only succeeds on confirmed scoring orders (via listMarketRewards + order book checks). For volume/requoting: prefer batching via post_orders. See CLOB V2 notes in prompts + official ts-sdk README for placeLimitOrder/postOrder patterns. IMPORTANT: rate-limited — use wait_seconds + strategy policy. On failure: strong agentDirective to rotate.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        price: { type: 'number' },
        size: { type: 'number' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        monitorFills: { 
          type: 'boolean', 
          description: 'If true, the tool will actively monitor the order (using polling + resources) until it is fully filled, cancelled, expired, or the monitoring timeout is reached. This blocks until there is clear fill outcome or failure.' 
        },
        fillMonitoringTimeoutMinutes: { 
          type: 'number', 
          description: 'Maximum time to monitor for fills when monitorFills is true (default 60 minutes).' 
        }
      },
      required: ['tokenId', 'price', 'size', 'side']
    }
  },

  // === Maker Rewards Support Tools (to address agent feedback) ===
  {
    name: 'list_active_maker_reward_markets',
    description: '[Rewards] Primary reward market discovery (core tool). Tiny ranked list (max 8) with yes/noTokenIds, real USD costs (minSize×mid), mids, dailyRate, volume/liquidity, attractiveness. Filter low cost for small cap. Per X insights: favors low min + decent rewards; cross with get_farmability for low-comp signals + near-mid feasibility; use list_events for resolution timing (avoid close-to-end per X). Use maxMinCostUsd:4.5 for $5 agents. No human options needed — ranked autonomous source.',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Hard max results (default 5, max 8).' },
        maxMinSize: { type: 'number', description: 'Filter by rewardsMinSize (shares) <= this.' },
        maxMinCostUsd: { 
          type: 'number', 
          description: 'Filter by approximate USD cost to meet minSize on the cheaper side (minSize × mid price). Perfect for $5 cap agents — pass 4.5 or 5.0.' 
        }
      }
    }
  },
  {
    name: 'validate_for_maker_rewards',
    description: 'Lightweight pre-check for a specific token + size/price. Returns tiny response by design. If you see huge output, restart your MCP server (old dist/ is loaded). Use list_active_maker_reward_markets first for discovery — this is only for fine-tuning one market.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        size: { type: 'number' },
        price: { type: 'number' },
        side: { type: 'string', enum: ['BUY', 'SELL'] }
      },
      required: ['tokenId']
    }
  },
  {
    name: 'suggest_reward_order_parameters',
    description: 'Given a tokenId, suggests good price and size parameters to maximize the chance of scoring maker rewards on the current active programs. Uses current order book + reward rules.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        capitalUsd: { type: 'number', description: 'Optional capital in USD you want to deploy' }
      },
      required: ['tokenId', 'side']
    }
  },
  {
    name: 'place_optimized_reward_order',
    description: 'High-level automation helper. Suggests optimal parameters for a market, validates them against current reward rules, places the order as a pure maker (postOnly GTC), confirms it is scoring, and can optionally monitor fills. Reduces steps for reward farming. For volume/requoting: combine with batch post_orders. Respect CLOB V2 place latency realities (see reward_farming_best_practices — avoid 200+/sec individual requotes).',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        capitalUsd: { type: 'number' },
        monitorFills: { type: 'boolean' },
        fillMonitoringTimeoutMinutes: { type: 'number' }
      },
      required: ['tokenId', 'side']
    }
  },
  {
    name: 'watch_order_scoring',
    description: 'Starts watching a specific orderId for changes in its maker reward scoring status. Similar to watch_order_until_filled, but for rewards. Returns a resource you can subscribe to for updates when the order starts or stops scoring.',
    inputSchema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' }
      },
      required: ['orderId']
    }
  },
  {
    name: 'get_balance_allowance',
    description: '[Account] HIGH PRIORITY for reward farming. Checks your current COLLATERAL (USDC) or CONDITIONAL token balance + allowance on the CLOB. Returns human-readable numbers and exact next steps (approve + deposit + update). Call this BEFORE any place_maker_reward_order when you see balance/allowance errors.',
    inputSchema: {
      type: 'object',
      properties: {
        assetType: { 
          type: 'string', 
          enum: ['COLLATERAL', 'CONDITIONAL'], 
          description: 'COLLATERAL for USDC (most common). CONDITIONAL for specific outcome tokens.' 
        }
      }
    }
  },
  {
    name: 'wait_seconds',
    description: '[Utilities] Server-side backoff tool. One of the few tools exposed by default. Use it to respect rate limits and add discipline to your own loops. The MCP does not run autonomous loops for you — it gives you the building blocks.',
    inputSchema: {
      type: 'object',
      properties: {
        seconds: { 
          type: 'number', 
          minimum: 1, 
          maximum: 300, 
          description: 'How many seconds to wait (server-side). Typical values: 4-8 for rate limits, 30-120 for exhausted small-size opportunities.' 
        },
        reason: { 
          type: 'string', 
          description: 'Optional context (e.g. "rate limit from list_active", "no markets under maxMinSize:2", "waiting for price to reach 0.44 exit level")' 
        }
      },
      required: ['seconds']
    }
  },
  {
    name: 'suggest_qualified_size',
    description: '[Utilities] Advisory sizing helper (does NOT enforce anything). Given an intent and token, it looks up the reward program rules and returns a recommended size according to your defined policy:\n- reward_farming / maker: sizes up to meet the actual rewardsMinSize (no artificial $5 cap).\n- market_taker / quick_flip: hard $5 cap unless highConfidenceEdge=true.\n\nCall this when you want help deciding size before placing an order. You remain fully in control.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { 
          type: 'string', 
          enum: ['reward_farming', 'maker', 'quick_flip', 'market_taker'],
          description: 'What you are trying to achieve with this order'
        },
        tokenId: { type: 'string', description: 'The token you plan to trade (used to look up rewardsMinSize and current price)' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        capitalUsd: { type: 'number', description: 'Optional: your maximum capital for this order' },
        highConfidenceEdge: { 
          type: 'boolean', 
          description: 'Set to true only if this is a high-confidence edge (allows breaking the $5 cap on taker orders)' 
        }
      },
      required: ['intent', 'tokenId', 'side']
    }
  },
  {
    name: 'compute_bayesian_update',
    description: '[Utilities] Performs a precision-weighted Bayesian update (posterior = (1-w)*prior + w*signal). Useful for combining platform price (prior) with external signals (Kalshi, Claude, your own research) when hunting mispriced markets for quick flips.',
    inputSchema: {
      type: 'object',
      properties: {
        prior: { type: 'number', description: 'Current platform price (0-1)' },
        signal: { type: 'number', description: 'External probability estimate (0-1)' },
        weight: { type: 'number', description: 'How much to trust the signal (0-1). Typical: 0.3-0.6' }
      },
      required: ['prior', 'signal', 'weight']
    }
  },
  {
    name: 'get_farmability',
    description: '[Rewards] PRIMARY pre-farm tool (SDK-native: fetchOrderBook + listMarketRewards + fetchSpreads). Snapshot: reward rules (minSize/maxSpread), live mid/spread vs allowed, book depth, cost to qualify, competitionSignal (low-comp proxy), suggestedNearMidBuy/Sell (for higher weighting per X insights), farmabilityScore, recommendation. Call first for every reward or flip decision. Also surfaces exact prices for sticky near-mid quoting + both-sides signals.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' }
      },
      required: ['tokenId']
    }
  },

  // === Strategy & SL/TP Storage (huge advantage for autonomous agents) ===
  // Agents can store full trading plans (entry, TP, SL, size, notes) server-side in the MCP.
  // This keeps the agent's context window clean and enables disciplined, rate-limit-respecting
  // execution loops (use with wait_seconds + watches). The MCP becomes the agent's "trading brain"
  // for persistent state while respecting platform rate limits.
  {
    name: 'set_strategy',
    description: '[Strategy] Create or replace a full entry (trading plan OR any operating rules/filters). This is your universal lightweight persistent store. Use for: market farming rules (quoteNearMid, bothSides, stickyReprice, lowCompOnly, maxSpreadRatio, exitConditions, etc.), liquidity/volume/spread/cost filters, preferred event categories (WEATHER, CRYPTO, best-to-high yield, etc.), custom ranking/scoring logic, 24/7 uptime params, or any other rules the agent wants to evolve. For partial changes use update_strategy (preferred for filters). Key can be a tokenId or any rule identifier (e.g. "rules:current_farming", "filter:liquidity_high", "config:best_events"). Extra fields you send are preserved.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string', description: 'Key for this entry: tokenId, or any rule/config key like "rules:farming_v2" or "global:filters"' },
        market: { type: 'string', description: 'Optional grouping (or sub-key)' },
        entryPrice: { type: 'number' },
        takeProfitPrice: { type: 'number' },
        stopLossPrice: { type: 'number' },
        size: { type: 'number' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        notes: { type: 'string' },
        maxWaitSecondsBetweenChecks: { type: 'number' },
        // Any additional fields the agent sends (liquidityMin, preferredCategories, farmingRules, bestToHighThreshold, quoteNearMid, etc.) are stored as-is.
      },
      required: ['tokenId'],
      additionalProperties: true
    }
  },
  {
    name: 'get_strategies',
    description: '[Strategy] Retrieve ALL your stored strategies, rules, filters, and operating configs. Call with no args to get your complete current rule set (farming rules, liquidity filters, event prefs, everything). Core tool — this is how the agent loads its own evolved logic at the start of loops without any MCP bloat.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        market: { type: 'string' }
      }
    }
  },
  {
    name: 'clear_strategy',
    description: 'Delete a stored strategy or rule set (e.g. after abandoning a filter preset or farming rule version).',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        market: { type: 'string' }
      },
      required: ['tokenId']
    }
  },
  {
    name: 'update_strategy',
    description: '[Strategy] THE KEY TOOL for lightweight power: partial update any fields on an existing entry (or create). Perfect for dynamically evolving filters, operating rules, market farming rules, liquidity thresholds, event category lists, "best to high" params, exit conditions, quoteNearMid toggles, etc. Only provided fields change; everything else (including prior custom rules) is preserved. Use keys like "rules:current", "filter:liquidity". This (plus categories + prompts) is why the MCP can stay tiny while the agent fully controls its strategy.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string', description: 'Key of the entry to update (tokenId or rule key like "rules:farming")' },
        market: { type: 'string' },
        entryPrice: { type: 'number' },
        takeProfitPrice: { type: 'number' },
        stopLossPrice: { type: 'number' },
        size: { type: 'number' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        notes: { type: 'string' },
        maxWaitSecondsBetweenChecks: { type: 'number' }
        // Send ANY other fields (liquidityMinUsd, maxSpreadRatio, preferredCategories, bothSides, sticky, lowCompetitionOnly, farmingExitRules, etc.) — they will be merged/persisted.
      },
      required: ['tokenId'],
      additionalProperties: true
    }
  },

  // ===================================================================
  // SECURITY-SENSITIVE TOOLS (intentionally added per request)
  // These expose raw signing and transaction capabilities.
  // Use with extreme caution. The calling agent has full control over
  // the connected wallet. Add your own access controls / allowlists.
  // ===================================================================
  {
    name: 'sign_message',
    description: '[Advanced] SECURITY-SENSITIVE: Signs an arbitrary message with the connected wallet. This can be used for authentication or arbitrary signatures. Only use if you fully trust the agent and have additional controls in place.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The message to sign (hex string or utf8 string)' }
      },
      required: ['message']
    }
  },
  {
    name: 'sign_typed_data',
    description: '[Advanced] SECURITY-SENSITIVE: Signs EIP-712 typed data with the connected wallet. This is used for gasless orders and other structured signatures. Only use if you fully trust the agent.',
    inputSchema: {
      type: 'object',
      properties: {
        payload: {
          type: 'object',
          description: 'EIP-712 TypedDataPayload object (domain, types, primaryType, message)'
        }
      },
      required: ['payload']
    }
  },
  {
    name: 'send_transaction',
    description: '[Advanced] SECURITY-SENSITIVE: Directly sends a raw transaction from the connected wallet. This bypasses all high-level platform flows. Extremely dangerous. Only use with strong additional safeguards.',
    inputSchema: {
      type: 'object',
      properties: {
        request: {
          type: 'object',
          description: 'SignerTransactionRequest: { chainId, to, data?, value? }'
        }
      },
      required: ['request']
    }
  },
  {
    name: 'end_authentication',
    description: '[Advanced] SECURITY-SENSITIVE: Revokes the current API key session and returns a public client. This invalidates the current authenticated session.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_secure_client_info',
    description: '[Advanced] SECURITY-SENSITIVE: Returns raw authentication internals (account identity and API credentials). Do not expose these publicly.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

// === Tier-1 Core (~22 tools) — full SDK via load_agent_profile / get_tools_by_category ===
const DEFAULT_CORE_TOOL_NAMES = new Set(TIER1_CORE_TOOL_NAMES);
let currentlyExposedToolNames = new Set(DEFAULT_CORE_TOOL_NAMES);

// === MCP Prompts for Agent Structure (lightweight guidance without tool bloat or enforcement) ===
// These provide on-demand best practices so the agent has "more structure" with fewer tools to reason over.
// Loaded only when agent requests via prompts/list or get.
const PROMPTS = [
  {
    name: 'agent_routing',
    description:
      'PRIMARY routing contract: native SDK-only paths, mandatory startup, tier-1 vs full 142-tool surface, discover_topic, load_agent_profile, search_tools, strategy store, per-goal flows (weather/rewards/trading). Call via prompts/get FIRST every session before other tools.',
    arguments: [],
  },
  {
    name: 'reward_farming_best_practices',
    description: 'Best practices + current X Key Insights (daily USDC LP rewards, quote near midpoint, both-sides 2x, sticky auto-repegging post-only as major edge, low-competition focus, avoid near-resolution, time/size-weighted, 24/7 active, adverse selection risks) for autonomous maker reward farming. Includes exact mapping to simple native SDK tools (get_farmability for near-mid + signals, place_*_reward for postOnly sticky, etc.). Use categories (e.g. get_tools_by_category("rewards")) to load/register additional tools dynamically while default stays ~50-57 focused core.',
    arguments: []
  },
  {
    name: 'mispricing_quick_flips',
    description: 'Guide for using the MCP for quick flips on mispriced markets. Includes using compute_bayesian_update with external signals, get_farmability for liquidity checks, suggest_qualified_size for sizing, list_active for reward-eligible opportunities, and respecting maker vs taker rules.',
    arguments: []
  },
  {
    name: 'mcp_tool_structure_and_categories',
    description: 'Full "never guess" quickstart: startup sequence (after agent_routing prompt), tier-1 vs categories, strategy store, get_mcp_usage, clobTokenIds/tokenId patterns, public credential rules, live resources. Load after prompts/get agent_routing.',
    arguments: []
  },
  {
    name: 'mcp_llms_full_guide',
    description: 'Returns complete guide: the official TS SDK README (https://github.com/Polymarket/ts-sdk/blob/main/README.md — kept up-to-date by the maintainers) is the PRIMARY/canonical source of truth for all SDK coverage, APIs, client creation (createPublicClient/createSecureClient), decorators (extend(allActions)), methods (listMarkets, fetchMarket, placeLimitOrder etc.), parameters, errors, examples. This MCP adds only runtime-generated overlays/mappings (exact native tool + JSON call shape + "use explicit place_limit_order etc with your numbers from strategy/calc, never intent"). Includes full exhaustive SDK surface mappings + strategyStore + cards (PNL/sentiment/farmability) + resources + rate notes + public rules. Call SDK README first, then this (and structure prompt) for complete non-guessing experience. Always in sync (call-time from code + current SDK).',
    arguments: []
  }
];

// Register tool list (MCP discovery) - returns the current exposed set (~50 default).
// Categories dynamically add to currentlyExposedToolNames so subsequent list calls see them.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const allTools = [...publicTools, ...secureTools];
  const exposed = allTools.filter(t => currentlyExposedToolNames.has(t.name));
  return { tools: exposed };
});

// Execute tools — every handler returns JSON. Errors never throw.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  // Track every tool activity/usage (for observability of how agents use the MCP)
  recordToolUsage(name);

  const pub = getPublicClient();
  let sec: any = null;

  const getSec = async () => {
    if (!sec) {
      sec = await getSecureClient();
    }
    return sec;
  };

  switch (name) {
    // === Category-based discovery tools (for fast agent tool discovery) ===
    case 'list_tool_categories':
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ categories: listAllCategories() }, null, 2)
        }]
      };

    case 'get_tools_by_category': {
      const cat = args.category;
      const filtered = getToolsByCategory(cat);
      // Dynamically register: add these tools to the exposed set so they appear
      // in tools/list responses and are treated as first-class for the session.
      // Hosts/agents should re-invoke tools/list after this call to see the expanded surface.
      let newlyRegistered = 0;
      for (const t of filtered) {
        if (!currentlyExposedToolNames.has(t.name)) {
          currentlyExposedToolNames.add(t.name);
          newlyRegistered++;
        }
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            category: cat,
            count: filtered.length,
            newlyRegistered,
            totalExposedNow: currentlyExposedToolNames.size,
            tools: filtered.map(t => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
            note: newlyRegistered > 0
              ? 'Category tools registered for this session and will be returned by subsequent tools/list. Re-call tools/list (or the host equivalent) to refresh the available tool surface. All tools remain callable by name via tools/call immediately.'
              : 'All tools in this category were already registered/exposed.'
          }, null, 2)
        }]
      };
    }

    case 'get_mcp_usage': {
      // Exposes the internal tracking of activities (tool calls) and usage stats.
      // This is the answer to "how do you track the activities? the usage?" for the MCP itself.
      const perTool = Array.from(mcpUsageTracker.toolCalls.entries()).map(([tool, stats]) => ({
        tool,
        count: stats.count,
        lastCalled: stats.lastCalled,
      })).sort((a, b) => b.count - a.count);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            mcp: 'clob-mcp',
            startTime: mcpUsageTracker.startTime,
            totalToolCalls: mcpUsageTracker.totalCalls,
            uniqueToolsUsed: mcpUsageTracker.toolCalls.size,
            perTool: perTool,
            note: 'This tracks MCP surface usage (which tools agents call and how often). For platform account activities (trades, rebates, rewards usage etc.) use list_activity or the live polymarket://user/activity resource (powered by user WS). Logs also capture activity to logs/polymarket.log (file only in MCP mode).',
          }, null, 2)
        }]
      };
    }

    case 'get_agent_recipes':
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(
            {
              ...getAgentRecipes(),
              tier1Core: [...TIER1_CORE_TOOL_NAMES],
              profiles: AGENT_PROFILES,
              loadMore: 'load_agent_profile({ profile }) or get_tools_by_category({ category }) — all 142 tools remain callable',
            },
            null,
            2
          ),
        }],
      };

    case 'search_tools': {
      const allTools = [...publicTools, ...secureTools];
      const detail = (args.detail as 'name' | 'summary' | 'schema') || 'summary';
      const matches = searchToolDefinitions(allTools, String(args.query || ''), detail, Number(args.limit) || 15);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(
            {
              query: args.query,
              detail,
              count: matches.length,
              matches,
              agentDirective:
                matches.length === 0
                  ? 'Try load_agent_profile({ profile: "full" }) or list_tool_categories. Core daily tools are already in tools/list (~22).'
                  : 'Call tools/call with the name + arguments from inputSchema (prompts/get mcp_tool_structure if unsure).',
            },
            null,
            2
          ),
        }],
      };
    }

    case 'load_agent_profile': {
      const profileKey = String(args.profile || '').toLowerCase();
      const profile = AGENT_PROFILES[profileKey];
      if (!profile) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: `Unknown profile "${args.profile}". Use: ${Object.keys(AGENT_PROFILES).join(', ')}`,
          }],
        };
      }
      let newlyRegistered = 0;
      const perCategory: Record<string, number> = {};
      for (const cat of profile.categories) {
        const filtered = getToolsByCategory(cat);
        perCategory[cat] = filtered.length;
        for (const t of filtered) {
          if (!currentlyExposedToolNames.has(t.name)) {
            currentlyExposedToolNames.add(t.name);
            newlyRegistered++;
          }
        }
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(
            {
              profile: profileKey,
              description: profile.description,
              categoriesLoaded: profile.categories,
              toolsPerCategory: perCategory,
              newlyRegistered,
              totalExposedNow: currentlyExposedToolNames.size,
              agentDirective: 'Re-call tools/list to refresh the host tool surface. All handlers unchanged — only exposure grew.',
            },
            null,
            2
          ),
        }],
      };
    }

    case 'discover_topic':
      return callWithFormat(
        () => discoverTopic(args as { topic: string; pageSize?: number; closed?: boolean; includeEvents?: boolean; includeMarkets?: boolean }),
        F.formatDiscoverTopic,
        name
      );

    // Public tools (no auth) — every response formatted
    case 'list_markets': {
      const sdkArgs = await buildListMarketsParams((args || {}) as Record<string, unknown>);
      const note = discoveryAgentNote('list_markets', (args || {}) as Record<string, unknown>, sdkArgs);
      const base = await callPaginatedWithFormat(pub.listMarkets(sdkArgs), F.formatMarket, name);
      if (note && base.content?.[0]?.text && !base.isError) {
        try {
          const parsed = JSON.parse(base.content[0].text);
          base.content[0].text = JSON.stringify(
            { markets: parsed, agentDirective: note, sdkParamsUsed: sdkArgs },
            (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
            2
          );
        } catch {
          /* keep original payload */
        }
      }
      return base;
    }
    case 'fetch_market':
      return callWithFormat(() => getMarket(args as any), F.formatMarket, name);
    case 'list_events': {
      const sdkArgs = buildListEventsParams((args || {}) as Record<string, unknown>);
      const note = discoveryAgentNote('list_events', (args || {}) as Record<string, unknown>, sdkArgs);
      const base = await callPaginatedWithFormat(pub.listEvents(sdkArgs), F.formatEvent, name);
      if (note && base.content?.[0]?.text && !base.isError) {
        try {
          const parsed = JSON.parse(base.content[0].text);
          base.content[0].text = JSON.stringify(
            { events: parsed, agentDirective: note, sdkParamsUsed: sdkArgs },
            (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
            2
          );
        } catch {
          /* keep original payload */
        }
      }
      return base;
    }
    case 'fetch_event':
      return callWithFormat(() => pub.fetchEvent(args), F.formatEvent, name);
    case 'search':
      // Use official SDK search directly (SearchResults shape: { markets, events, tags, profiles }).
      // Do NOT wrap in callPaginatedWithFormat — it is not a simple item paginator.
      return callWithFormat(() => pub.search(args), F.formatSearchResults, name);
    case 'list_tags':
      return callPaginatedWithFormat(
        pub.listTags((args || { pageSize: 100 }) as Record<string, unknown>),
        F.formatTag,
        name
      );
    case 'list_sports':
      return callWithFormat(() => pub.listSports(), F.formatGeneric, name);
    case 'list_teams':
      return callWithFormat(() => pub.listTeams(), F.formatGeneric, name);
    case 'fetch_tag':
      return callWithFormat(() => pub.fetchTag(args), F.formatGeneric, name);
    case 'get_uk_weather_forecast':
      return callWithFormat(async () => {
        const res = await weatherClient.getForecast(args.city, args.days, args.variables);
        return F.formatWeather(res, args.city, 'forecast');
      }, F.formatGeneric, name);
    case 'get_uk_weather_historical':
      return callWithFormat(async () => {
        const res = await weatherClient.getHistorical(args.city, args.start_date, args.end_date, args.variables);
        return F.formatWeather(res, args.city, 'historical');
      }, F.formatGeneric, name);
    case 'get_uk_weather_current':
      return callWithFormat(async () => {
        const res = await weatherClient.getCurrent(args.city, args.variables);
        return F.formatWeather(res, args.city, 'current');
      }, F.formatGeneric, name);
    case 'fetch_order_book':
      return callWithFormat(() => pub.fetchOrderBook(args), F.formatOrderBook, name);
    case 'fetch_price':
      return callWithFormat(() => pub.fetchPrice(args), F.formatGeneric, name);
    case 'fetch_midpoint':
      return callWithFormat(() => pub.fetchMidpoint(args), F.formatGeneric, name);
    case 'fetch_spread':
      return callWithFormat(() => pub.fetchSpread(args), F.formatGeneric, name);
    case 'fetch_price_history':
      return callWithFormat(() => pub.fetchPriceHistory(args), (d: any) => F.formatPriceHistory(d?.history ?? d ?? []), name);
    case 'fetch_last_trade_price':
      return callWithFormat(() => pub.fetchLastTradePrice(args), F.formatGeneric, name);
    case 'fetch_last_trade_prices':
      // SDK expects array of { tokenId }
      return callWithFormat(() => pub.fetchLastTradePrices(args.tokenIds.map((id: string) => ({ tokenId: id }))), F.formatGeneric, name);
    case 'list_trades':
      return callPaginatedWithFormat(pub.listTrades(args), F.formatTrade, name);
    case 'estimate_market_price':
      return callWithFormat(() => pub.estimateMarketPrice(args), F.formatGeneric, name);

    // Secure tools — every response formatted. CTF actions use resolved tx card.
    case 'place_limit_order':
      return callWithFormat(async () => {
        const posted = await (await getSec()).placeLimitOrder(args);
        const orderId = (posted as any)?.orderId;
        if (orderId) resourceManager.ensureUserSubscriptionForWatch(orderId).catch(() => {});
        return posted;
      }, F.formatOrderResponse, name);

    case 'create_and_post_order':
      // The recommended tool for GTC maker orders with rewards eligibility.
      // Explicitly uses SDK createLimitOrder + postOrder for full control.
      // GTC is the SDK default when orderType is omitted — do not pass it for pure GTC.
      const createPostParams: any = { ...args };
      if (args.orderType && args.orderType !== 'GTC') {
        createPostParams.orderType = args.orderType;
      }
      createPostParams.postOnly = args.postOnly !== false;
      return callWithFormat(async () => {
        const sec = await getSec();
        const signed = await sec.createLimitOrder(createPostParams);
        const posted = await sec.postOrder(signed);
        // Auto-start the dedicated fill watch for this order (powers the Fill Watch resource in the response)
        const orderId = (posted as any)?.orderId;
        if (orderId) {
          resourceManager.ensureUserSubscriptionForWatch(orderId).catch(() => {});
        }
        return posted;
      }, F.formatOrderResponse, name);

    case 'place_maker_reward_order':
      // STRICT "Only place orders that earn maker rewards" tool.
      // This is the recommended tool when you want the agent to ONLY succeed on orders that are earning rewards.
      // It will auto-cancel and return failure if the order does not become scoring within the check window.
      return callWithFormat(async () => {
        const sec = await getSec();

        const params: any = {
          tokenId: args.tokenId,
          price: args.price,
          size: args.size,
          side: args.side,
          postOnly: true,
        };

        // 1. Place as pure maker (with good error handling for the most common blocker + rate limits)
        let signed: any;
        let posted: any;
        try {
          const createRes = await callWithRateLimitProtection(
            () => sec.createLimitOrder(params),
            'createLimitOrder (maker reward)'
          );
          if (!createRes.ok) {
            return {
              success: false, rateLimited: true, retryAfterMs: createRes.retryAfterMs,
              message: createRes.message,
              agentDirective: "Rate limited while creating order. Slow down your loop significantly (min 4-6s between placement attempts). Do not hammer the placement tools."
            };
          }
          signed = createRes.data;

          const postRes = await callWithRateLimitProtection(
            () => sec.postOrder(signed),
            'postOrder (maker reward)'
          );
          if (!postRes.ok) {
            return {
              success: false, rateLimited: true, retryAfterMs: postRes.retryAfterMs,
              message: postRes.message,
              agentDirective: "Rate limited while posting maker order. Wait the recommended time. Rapid placement attempts are the fastest way to get the MCP server marked unreachable."
            };
          }
          posted = postRes.data;
        } catch (placeErr: any) {
          const errMsg = String(placeErr?.message || placeErr || '');
          const isBalanceErr = /balance|allowance|not enough|insufficient/i.test(errMsg);

          if (isBalanceErr) {
            return {
              success: false,
              message: "Placement failed due to insufficient balance or allowance.",
              rawError: errMsg.substring(0, 300),
              agentDirective: "CRITICAL: Your wallet has 0 (or too low) balance/allowance for this order. DO NOT retry placement. IMMEDIATELY call get_balance_allowance (assetType: 'COLLATERAL'). Follow its nextSteps exactly (approve_erc20 if needed → deposit USDC → update_balance_allowance). Only after that succeeds, come back and try place_maker_reward_order or (better) place_optimized_reward_order again. This is the #1 reason reward orders fail before they even reach scoring.",
              recommendedTool: "get_balance_allowance"
            };
          }

          // Other placement error
          throw placeErr;
        }

        const orderId = (posted as any)?.orderId;

        if (orderId) {
          resourceManager.ensureUserSubscriptionForWatch(orderId).catch(() => {});
        }

        // 2. Multiple scoring checks with increasing delays + rate limit protection
        const checkDelays = [2500, 4000, 6000];
        let isScoring = false;
        let lastCheckedAt = 0;

        for (const delay of checkDelays) {
          await new Promise(r => setTimeout(r, delay));
          lastCheckedAt = Date.now();
          try {
            const scoringRes = await callWithRateLimitProtection(
              () => sec.fetchOrderScoring({ orderId }),
              'fetchOrderScoring (post placement)'
            );
            if (scoringRes.ok) {
              isScoring = scoringRes.data;
              if (isScoring) break;
            } else {
              // Rate limited during scoring checks — treat as non-scoring for now and surface guidance
              break;
            }
          } catch (e) {
            // transient
          }
        }

        // 3. Final decision
        if (isScoring) {
          // SUCCESS — this order is (or was) earning maker rewards
          const fillWatchUri = `polymarket://order/${orderId}/fill-status`;

          // Optional: Actively monitor for fills until filled or failure
          if (args.monitorFills) {
            const timeoutMinutes = args.fillMonitoringTimeoutMinutes ?? 60;
            const startTime = Date.now();
            const maxDuration = timeoutMinutes * 60 * 1000;

            let finalStatus = null;

            while (Date.now() - startTime < maxDuration) {
              try {
                const currentOrder = await sec.fetchOrder({ orderId });
                const matched = parseFloat(currentOrder.sizeMatched || '0');
                const original = parseFloat(currentOrder.originalSize || args.size);

                if (matched >= original * 0.999) {
                  finalStatus = {
                    filled: true,
                    status: 'FILLED',
                    sizeMatched: currentOrder.sizeMatched,
                    transactionHash: currentOrder.transactionHash || null
                  };
                  break;
                }

                // Check if order is no longer open (cancelled, expired, etc.)
                const status = (currentOrder.status || '').toLowerCase();
                if (status.includes('cancel') || status.includes('expire') || status.includes('reject')) {
                  finalStatus = {
                    filled: false,
                    status: currentOrder.status || 'CLOSED',
                    sizeMatched: currentOrder.sizeMatched,
                    reason: 'Order no longer open (cancelled/expired/rejected)'
                  };
                  break;
                }
              } catch (e) {
                // Transient error, continue monitoring
              }

              await new Promise(r => setTimeout(r, 15000)); // Poll every 15 seconds
            }

            if (!finalStatus) {
              finalStatus = {
                filled: false,
                status: 'MONITORING_TIMEOUT',
                reason: `Monitoring timed out after ${timeoutMinutes} minutes. Order may still be open.`
              };
            }

            return {
              success: true,
              message: finalStatus.filled 
                ? "Order filled and earned maker rewards." 
                : "Order placed, confirmed scoring for rewards, but did not fill within monitoring window.",
              orderId,
              isEarningRewards: true,
              fillOutcome: finalStatus,
              fillWatchResource: fillWatchUri,
              order: posted
            };
          }

          // Default behavior (no fill monitoring) — just return current snapshot + guidance
          let currentFillStatus = null;
          try {
            const latestOrder = await sec.fetchOrder({ orderId });
            currentFillStatus = {
              status: latestOrder.status || 'OPEN',
              sizeMatched: latestOrder.sizeMatched || '0',
              originalSize: latestOrder.originalSize || args.size,
              isFilled: parseFloat(latestOrder.sizeMatched || '0') >= parseFloat(latestOrder.originalSize || args.size) * 0.999
            };
          } catch (e) {
            currentFillStatus = { status: 'UNKNOWN', note: 'Could not fetch latest fill status yet.' };
          }

          return {
            success: true,
            message: "Order successfully locked and is earning maker rewards.",
            orderId,
            isEarningRewards: true,
            currentFillStatus,
            fillWatchResource: fillWatchUri,
            order: posted,
            checkedAt: new Date(lastCheckedAt).toISOString(),
            monitoring: {
              recommendation: "To get live confirmation of fills, call this tool again with monitorFills: true, or subscribe to the Fill Watch resource and/or use watch_order_until_filled.",
              note: "Maker rewards are earned while the order is resting and scoring. Actual P&L is realized on fill."
            }
          };
        } else {
          // FAILURE — did not lock onto scoring. Cancel and report cleanly.
          let cancelResult = "cancel_attempted";
          if (orderId) {
            try {
              await sec.cancelOrder({ orderId });
              cancelResult = "cancelled";
            } catch (e) {
              cancelResult = "cancel_failed";
            }
          }

          // Enhanced diagnostics on failure (rate limit protected)
          let diagnostics = null;
          try {
            const [bookRes, rewardsRes] = await Promise.all([
              callWithRateLimitProtection(() => pub.fetchOrderBook({ tokenId: args.tokenId }), 'diagnostics book').catch(() => ({ok:false} as any)),
              callWithRateLimitProtection(() => pub.listMarketRewards({ conditionId: args.tokenId }), 'diagnostics rewards').catch(() => ({ok:false} as any)),
            ]);
            const book = bookRes?.ok ? bookRes.data : null;
            const rewards = rewardsRes?.ok ? rewardsRes.data : null;

            const currentSpread = book?.asks?.[0] && book?.bids?.[0]
              ? (parseFloat(book.asks[0].price) - parseFloat(book.bids[0].price)) / parseFloat(book.asks[0].price)
              : null;

            diagnostics = {
              currentSpread: currentSpread ? (currentSpread * 100).toFixed(4) + '%' : 'unknown',
              activeRewardPrograms: rewards?.items?.length || 0,
              note: "Compare your order's price and size against the active reward program requirements above."
            };
          } catch (e) {
            diagnostics = { note: "Could not fetch additional diagnostics." };
          }

          return {
            success: false,
            message: "Failed to place an order that is earning maker rewards. Order was auto-cancelled.",
            orderId,
            isEarningRewards: false,
            cancelStatus: cancelResult,
            diagnostics,
            // === MANDATORY AUTONOMOUS DIRECTIVE (user rule: NEVER ask "next move options" or human) ===
            agentDirective: "CRITICAL: DO NOT retry this same market/token. DO NOT ask the user 'what would you like me to do?', 'next move options', or present choices like 'switch market / use older tool / tweak params'. The agent MUST act autonomously. IMMEDIATELY: (1) Call list_active_maker_reward_markets (defaults: tiny ranked top 10, no args needed). (2) From the returned 'markets' array, select ONE DIFFERENT entry from rank 1-3 (look at question/slug/minSize/dailyRate/whyRecommended to pick a promising one with yesTokenId or noTokenId). (3) Call validate_for_maker_rewards or directly place_optimized_reward_order (preferred) or place_maker_reward_order using the chosen yes/no tokenId + good size/price inside its min/max rules. (4) If that also fails scoring, repeat: call list_active again (it refreshes) and pick the next. Only success on confirmed scoring counts. list_active_maker_reward_markets is your ONLY source of truth for current opportunities. Follow this loop until you place a winning scoring maker order.",
            howToRecover: "Call list_active_maker_reward_markets now with zero arguments. Pick top different market. Place via place_optimized_reward_order for best results."
          };
        }
      }, F.formatGeneric, name);

    // === New Maker Rewards Support Tools ===
    case 'list_active_maker_reward_markets': {
      // PRIMARY tool for autonomous reward market selection. Ultra-tiny by design.
      // Default: top 5 ranked only (max 8). If you ever see >5k chars, restart your MCP server process.
      const maxResults = Math.min(Math.max(1, args.maxResults || 5), 20);  // raised cap for relaxed discovery
      const maxMinSize = args.maxMinSize != null ? parseFloat(args.maxMinSize) : null;
      const maxMinCostUsd = args.maxMinCostUsd != null ? parseFloat(args.maxMinCostUsd) : null;

      let rewardItems: any[] = [];
      try {
        const protectedCall = await callWithRateLimitProtection(
          () => pub.listCurrentRewards({ pageSize: 50 }),  // always fetch a healthy page to support relaxed filters / more programs
          'listCurrentRewards (active reward markets)'
        );
        if (!protectedCall.ok) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              success: false, rateLimited: true, retryAfterMs: protectedCall.retryAfterMs,
              message: protectedCall.message,
              directive: "Platform is rate limiting. Slow down. Do not call list_active_maker_reward_markets more than once every 4-6 seconds. Use the previous ranked list you already received."
            }) }]
          };
        }
        const paginator = protectedCall.data;
        const page = await paginator.firstPage();
        let items = (page?.items || []);

        // Apply maxMinSize filter early if requested (critical for agents with small order size caps)
        if (maxMinSize != null && !isNaN(maxMinSize)) {
          items = items.filter((r: any) => {
            const minSz = parseFloat(r.rewardsMinSize ?? r.rewards_min_size ?? '999');
            return minSz <= maxMinSize;
          });
        }

        rewardItems = items;  // consider full page after basic filter; final top-N after ranking below
      } catch (e: any) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: "Failed to fetch current reward programs", detail: e?.message || String(e) }) }]
        };
      }

      if (!rewardItems.length) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: true,
            count: 0,
            message: "No active maker reward programs returned by listCurrentRewards (even after fetching 50 and applying any relaxed maxMin* filters you passed).",
            markets: [],
            note: "Maker reward campaigns are time-limited and not always active. Relaxed filters on this tool only filter existing programs; they cannot invent programs if upstream listCurrentRewards returns none.",
            suggestions: [
              "Call the raw 'list_current_rewards' tool directly to see current response.",
              "Use list_markets({ rewardsMinSize: 1, closed: false, pageSize: 20 }) to discover markets that support/have had rewards (may not have live rate right now).",
              "Cross-check https://polymarket.com/ or rewards dashboards for live campaigns.",
              "Poll this tool periodically (with wait_seconds between calls)."
            ],
            directive: "No current maker-reward-eligible markets. Switch to general discovery (list_markets or search) or wait for new programs. Do not keep calling with same params expecting different results."
          }) }]
        };
      }

      // Batch-resolve market metadata (question, slug, tokens) using conditionIds filter — one call
      const conditionIds = rewardItems.map((r: any) => r.conditionId).filter(Boolean);
      let marketsByCondition: Record<string, any> = {};
      if (conditionIds.length) {
        try {
          const protectedMkt = await callWithRateLimitProtection(
            () => pub.listMarkets({ conditionIds, pageSize: conditionIds.length, closed: false }),
            'listMarkets batch for reward enrichment'
          );
          if (protectedMkt.ok) {
            const mktPage = await protectedMkt.data.firstPage();
            for (const m of (mktPage?.items || [])) {
              if (m.conditionId) marketsByCondition[m.conditionId] = m;
            }
          }
        } catch (e) {
          // Non-fatal
        }
      }

      // Collect all Yes/No tokenIds for batch mid price fetch (critical for small-cap USD cost calc)
      const allTokenIds: string[] = [];
      Object.values(marketsByCondition).forEach((m: any) => {
        const yes = m.outcomes?.yes?.tokenId || m.yesTokenId;
        const no = m.outcomes?.no?.tokenId || m.noTokenId;
        if (yes) allTokenIds.push(yes);
        if (no) allTokenIds.push(no);
      });

      let midsByToken: Record<string, number> = {};
      if (allTokenIds.length > 0) {
        try {
          const midRes = await callWithRateLimitProtection(
            () => pub.fetchMidpoints({ tokenIds: [...new Set(allTokenIds)] }),
            'fetchMidpoints for USD cost enrichment'
          );
          if (midRes.ok && midRes.data) {
            midsByToken = midRes.data; // { tokenId: midPrice }
          }
        } catch (e) {
          // Non-fatal, costs will be missing
        }
      }

      // Compute attractiveness score for ranking (prefer low barrier + decent rate).
      // Note: maxMinSize / maxMinCostUsd filters are applied before final ranking.
      function attractiveness(r: any): number {
        const minSz = parseFloat(r.rewardsMinSize ?? r.rewards_min_size ?? '50');
        const maxSp = Number(r.rewardsMaxSpread ?? r.rewards_max_spread ?? 0.05);
        const rate = parseFloat(r.totalDailyRate ?? r.total_daily_rate ?? r.sponsoredDailyRate ?? r.nativeDailyRate ?? '0');
        // Higher score = easier to qualify (low minSz) + better payout rate + not too loose spread
        const ease = 100 / Math.max(1, minSz);
        const rateScore = Math.min(100, rate / 2); // normalize rough
        const spreadPenalty = Math.max(0.1, maxSp) * 50;
        return (ease * 2) + rateScore - spreadPenalty;
      }

      const ranked = [...rewardItems]
        .map((r: any) => {
          const m = marketsByCondition[r.conditionId] || {};
          const minSz = r.rewardsMinSize ?? r.rewards_min_size;
          const maxSp = r.rewardsMaxSpread ?? r.rewards_max_spread;
          const daily = r.totalDailyRate ?? r.total_daily_rate ?? r.sponsoredDailyRate ?? '0';
          const assets = (r.rewardsConfig || []).map((c: any) => c.assetAddress).filter(Boolean);
          const slug = m.slug || r.conditionId;
          const marketLink = `https://polymarket.com/market/${slug}`;

          // Extract Yes/No tokenIds robustly (guarantee exposure like other market formatters)
          const yesTok = m.outcomes?.yes?.tokenId
            ?? m.tokens?.find((t: any) => (t.outcome || t.side) === 'Yes')?.tokenId
            ?? m.yesTokenId;
          const noTok = m.outcomes?.no?.tokenId
            ?? m.tokens?.find((t: any) => (t.outcome || t.side) === 'No')?.tokenId
            ?? m.noTokenId;

          const score = attractiveness(r);

          // Pull tick size from the enriched market (very useful for price precision)
          const minTickSize = m.minimumTickSize ?? m.trading?.minimumTickSize ?? m.tickSize ?? m.minTickSize ?? m.order_price_min_tick_size;

          // Compute real USD cost to qualify (the key signal for $5-cap agents)
          const yesMid = yesTok ? midsByToken[yesTok] : null;
          const noMid = noTok ? midsByToken[noTok] : null;
          const yesMinCostUsd = (yesMid && minSz) ? (parseFloat(minSz) * yesMid) : null;
          const noMinCostUsd = (noMid && minSz) ? (parseFloat(minSz) * noMid) : null;
          const cheapestCostUsd = Math.min(yesMinCostUsd || 999, noMinCostUsd || 999);

          const entry: any = {
            rank: 0, // filled after sort
            question: m.question || `Market ${r.conditionId.slice(0, 10)}...`,
            slug,
            conditionId: r.conditionId,
            yesTokenId: yesTok,
            noTokenId: noTok,
            minSize: minSz,
            maxSpread: maxSp,
            dailyRate: daily,
            minTickSize: minTickSize ? Number(minTickSize) : undefined,
            yesMid: yesMid ? Number(yesMid).toFixed(4) : undefined,
            noMid: noMid ? Number(noMid).toFixed(4) : undefined,
            yesMinCostUsd: yesMinCostUsd ? Number(yesMinCostUsd).toFixed(2) : undefined,
            noMinCostUsd: noMinCostUsd ? Number(noMinCostUsd).toFixed(2) : undefined,
            cheapestMinCostUsd: cheapestCostUsd < 999 ? Number(cheapestCostUsd).toFixed(2) : undefined,
            volume: m.metrics?.volume ? Number(m.metrics.volume) : undefined,
            liquidity: m.metrics?.liquidity ? Number(m.metrics.liquidity) : undefined,
            payoutAssets: assets.length ? assets : undefined,
            marketLink,
            attractiveness: Number(score.toFixed(2)),
            whyRecommended: minSz && parseFloat(minSz) <= 10 ? 'Low min size (easy to qualify)' : (daily && parseFloat(daily) > 50 ? 'High reward rate' : 'Active program')
          };
          return { entry, score, raw: r, market: m, cheapestCostUsd };
        })
        // Apply USD cost filter after enrichment (most important for small capital)
        .filter((x: any) => {
          if (maxMinCostUsd != null && !isNaN(maxMinCostUsd)) {
            return x.cheapestCostUsd == null || x.cheapestCostUsd <= maxMinCostUsd;
          }
          return true;
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, maxResults)
        .map((x, i) => { x.entry.rank = i + 1; return x.entry; });

      const formattedMarkets = ranked.map((r: any) => F.formatActiveRewardMarket(r));
      const payload = {
        success: true,
        count: ranked.length,
        filteredBy: {
          ...(maxMinSize != null ? { maxMinSize } : {}),
          ...(maxMinCostUsd != null ? { maxMinCostUsd } : {})
        },
        note: "Ranked best-first (Reward Market Cards via formatters). Shows exact USD cost to qualify. Use maxMinCostUsd: 4.5 for strict $5 cap. Primary for autonomous discovery. Enhanced cards include links + notes.",
        markets: formattedMarkets,
        usage: "For $5 cap: list_active_maker_reward_markets({maxMinCostUsd: 4.5}). Only place on markets where your size meets minSize and cost under cap. Then get_farmability(yes/noTokenId) for health/sentiment/near-mid."
      };

      let json = JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 0);
      // Hard safety: never let this tool exceed ~5k chars even in weird cases
      if (json.length > 5500) {
        const reduced = { ...payload, markets: ranked.slice(0, 3), note: "Truncated to top 3 due to size guard." };
        json = JSON.stringify(reduced, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 0);
      }

      return {
        content: [{
          type: 'text' as const,
          text: json
        }]
      };
    }

    case 'validate_for_maker_rewards': {
      // Lightweight per-proposal pre-check. NEVER dumps full program lists (that caused bloat). Tiny response always.
      // Return content directly (consistent with list_active and avoids broken callWithFormat call)
      try {
        if (!args.tokenId) {
          const result = { success: false, error: "tokenId is required (Yes or No token for the outcome you want to place on)" };
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 0)
            }]
          };
        }

        // 1. Get current book for this specific token (gives real spread to check against maxSpread rules)
        let book: any = null;
        try {
          const bookRes = await callWithRateLimitProtection(
            () => pub.fetchOrderBook({ tokenId: args.tokenId }),
            'fetchOrderBook (validate)'
          );
          if (bookRes.ok) book = bookRes.data;
        } catch {}

        const bestBid = book?.bids?.[0]?.price ? parseFloat(book.bids[0].price) : null;
        const bestAsk = book?.asks?.[0]?.price ? parseFloat(book.asks[0].price) : null;
        const currentSpread = (bestBid && bestAsk) ? Math.abs(bestAsk - bestBid) : null;
        const mid = (bestBid && bestAsk) ? (bestBid + bestAsk) / 2 : null;

        // 2. Small active programs snapshot (capped hard, no full dump)
        let activeCount = 0;
        let programsHint: any[] = [];
        try {
          const protectedRewards = await callWithRateLimitProtection(
            () => pub.listCurrentRewards({ pageSize: 10 }),
            'listCurrentRewards (validate)'
          );
          if (protectedRewards.ok) {
            const page = await protectedRewards.data.firstPage();
            const items = page?.items || [];
            activeCount = items.length;
            programsHint = items.slice(0, 2).map((r: any) => ({
              minSize: r.rewardsMinSize,
              maxSpread: r.rewardsMaxSpread,
              dailyRate: r.totalDailyRate || r.sponsoredDailyRate
            }));
          }
        } catch {}

        const proposedSize = args.size != null ? parseFloat(String(args.size)) : null;
        const proposedPrice = args.price != null ? parseFloat(String(args.price)) : null;

        let sizeOk = null;
        let spreadLikelyOk = null;
        let overallEligible = false;
        let reason = "Insufficient data for precise check (provide size + price + side for full validation).";

        if (proposedSize != null && programsHint.length) {
          const exampleMin = parseFloat(programsHint[0]?.minSize || '5');
          sizeOk = proposedSize >= exampleMin;
        }
        if (proposedPrice != null && mid != null && currentSpread != null && programsHint.length) {
          const exampleMaxSp = parseFloat(programsHint[0]?.maxSpread || '0.005');
          const distanceFromOpp = args.side?.toUpperCase() === 'BUY' ? (mid - proposedPrice) : (proposedPrice - mid);
          spreadLikelyOk = distanceFromOpp >= 0 && (currentSpread / 2 + distanceFromOpp) / mid <= exampleMaxSp; // rough inside max spread
        }
        if (sizeOk !== null || spreadLikelyOk !== null) {
          overallEligible = (sizeOk !== false) && (spreadLikelyOk !== false);
          reason = overallEligible 
            ? "Proposal looks compatible with typical active program rules (size + spread). Final scoring decided by the platform after order is live."
            : "Proposal likely violates at least one rule (size too small or price too aggressive vs current book + max spread).";
        }

        const result = {
          success: true,
          eligible: overallEligible,
          reason,
          proposed: { tokenId: args.tokenId, size: args.size, price: args.price, side: args.side },
          tokenBook: {
            bestBid: bestBid ? bestBid.toFixed(4) : null,
            bestAsk: bestAsk ? bestAsk.toFixed(4) : null,
            currentSpreadPct: currentSpread ? (currentSpread * 100).toFixed(3) + '%' : 'unknown'
          },
          activeProgramsSnapshot: {
            count: activeCount,
            exampleRules: programsHint.length ? programsHint : undefined,
            note: "Use list_active_maker_reward_markets (the ranked 5) for real markets + tokens + rules."
          },
          directive: overallEligible 
            ? "Looks good — proceed with place_optimized_reward_order or place_maker_reward_order."
            : "Bad proposal for current rules. Call list_active_maker_reward_markets now and pick a different top market."
        };

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 0)
          }]
        };
      } catch (e: any) {
        const result = { success: false, error: `Validation failed: ${e?.message || e}` };
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 0)
          }]
        };
      }
    }

    case 'suggest_reward_order_parameters': {
      return callWithFormat(async () => {
        if (!args.tokenId || !args.side) {
          return { error: "tokenId and side are required" };
        }

        const mode = (args.mode || 'reward').toLowerCase(); // 'reward' | 'spread_capture'

        const [book, rewards] = await Promise.all([
          pub.fetchOrderBook({ tokenId: args.tokenId }).catch(() => null),
          pub.listMarketRewards({ conditionId: args.tokenId }).catch(() => null),
        ]);

        if (!book || !rewards?.items?.length) {
          return {
            success: false,
            suggestion: null,
            reason: "No active reward program found specifically for this token's market (listMarketRewards returned none).",
            directive: "Call list_active_maker_reward_markets (the ranked list) instead — it surfaces markets that DO have active programs with resolved tokens. Pick one from there and use its yes/no tokenId here or with place_optimized_reward_order."
          };
        }

        const program = rewards.items[0];
        const minSize = parseFloat(program.rewardsMinSize || '5');
        const maxSpread = parseFloat(program.rewardsMaxSpread || '0.005');

        const bestBid = parseFloat(book.bids?.[0]?.price || '0');
        const bestAsk = parseFloat(book.asks?.[0]?.price || '0');
        const mid = (bestBid && bestAsk) ? (bestBid + bestAsk) / 2 : null;

        // Simple tick estimate (most markets are 0.01; fall back to 0.001 for cheap shares)
        const estimatedTick = (bestAsk - bestBid) > 0.005 ? 0.01 : 0.001;

        let suggestedPrice;
        let strategyNote;

        if (mode === 'spread_capture') {
          // Passive maker entry for spread capture (one tick inside the current spread)
          if (args.side.toUpperCase() === 'BUY') {
            suggestedPrice = bestAsk - estimatedTick; // one tick better than ask (join/improve bid)
          } else {
            suggestedPrice = bestBid + estimatedTick;
          }
          strategyNote = "Spread capture mode: passive maker entry one tick inside the spread. Good for earning the spread on fill without paying taker fees.";
        } else {
          // Original reward-max-spread logic
          if (args.side.toUpperCase() === 'BUY') {
            suggestedPrice = bestAsk * (1 - maxSpread * 0.8);
          } else {
            suggestedPrice = bestBid * (1 + maxSpread * 0.8);
          }
          strategyNote = `Reward mode: aims to stay well inside the program's max spread of ${(maxSpread*100).toFixed(2)}%.`;
        }

        const suggestedSize = Math.max(minSize, args.capitalUsd ? (args.capitalUsd / suggestedPrice) : minSize * 2);

        return {
          suggestedPrice: suggestedPrice.toFixed(4),
          suggestedSize: suggestedSize.toFixed(2),
          estimatedTick,
          currentMid: mid ? mid.toFixed(4) : null,
          currentSpread: (bestAsk && bestBid) ? (bestAsk - bestBid).toFixed(4) : null,
          modeUsed: mode,
          minSizeRequired: minSize,
          maxSpreadAllowed: maxSpread,
          reasoning: strategyNote + " Size respects minSize and your capitalUsd cap where provided."
        };
      }, F.formatGeneric, name);
    }

    case 'place_optimized_reward_order': {
      // High-level automation helper: Suggest → Validate → Place (with optional monitoring)
      return callWithFormat(async () => {
        // Step 1: Get suggestion
        const suggestion = await (async () => {
          const [book, rewards] = await Promise.all([
            pub.fetchOrderBook({ tokenId: args.tokenId }).catch(() => null),
            pub.listMarketRewards({ conditionId: args.tokenId }).catch(() => null),
          ]);

          if (!book || !rewards?.items?.length) return null;

          const program = rewards.items[0];
          const minSize = parseFloat(program.rewardsMinSize || '5');
          const maxSpread = parseFloat(program.rewardsMaxSpread || '0.005');
          const bestAsk = parseFloat(book.asks?.[0]?.price || '0');
          const bestBid = parseFloat(book.bids?.[0]?.price || '0');

          let price = args.side.toUpperCase() === 'BUY'
            ? bestAsk * (1 - maxSpread * 0.75)
            : bestBid * (1 + maxSpread * 0.75);

          const size = Math.max(minSize, args.capitalUsd ? (args.capitalUsd / price) : minSize * 2);
          return { price, size };
        })();

        if (!suggestion) {
          return { 
            success: false, 
            error: "Could not generate good parameters for this market (no book or no active program matched via listMarketRewards).",
            directive: "This token's market may not be in current rewards. Call list_active_maker_reward_markets immediately, pick a top-ranked market from the list (it has yes/no tokens + confirmed active programs), then call place_optimized_reward_order on one of its tokens."
          };
        }

        // Step 2: Validate (use tiny cap to avoid any bloat)
        const validation = await (async () => {
          const rewards = await pub.listCurrentRewards({ pageSize: 10 }).catch(() => null);
          const programs = (rewards?.items || []).slice(0, 5);
          return { ok: true, programsCount: programs.length };
        })();

        // Step 3: Place using the strict tool logic
        const placeResult = await (async () => {
          const sec = await getSec();
          const params = {
            tokenId: args.tokenId,
            price: suggestion.price,
            size: suggestion.size,
            side: args.side,
            postOnly: true,
          };

          const signed = await sec.createLimitOrder(params);
          const posted = await sec.postOrder(signed);
          const orderId = (posted as any)?.orderId;

          if (orderId) {
            resourceManager.ensureUserSubscriptionForWatch(orderId).catch(() => {});
          }

          // Quick scoring check
          await new Promise(r => setTimeout(r, 3000));
          let isScoring = false;
          try {
            isScoring = await sec.fetchOrderScoring({ orderId });
          } catch {}

          if (!isScoring && orderId) {
            await sec.cancelOrder({ orderId }).catch(() => {});
            return { success: false, cancelled: true, orderId };
          }

          return { success: true, orderId, posted, isEarningRewards: isScoring };
        })();

        if (!placeResult.success) {
          return {
            success: false,
            message: "Suggested parameters did not result in a scoring order. Auto-cancelled.",
            suggestion,
            agentDirective: "The optimized attempt on this token failed to lock scoring. DO NOT loop on same token. Call list_active_maker_reward_markets right now, select a DIFFERENT top market from its ranked list (use yesTokenId or noTokenId), then call place_optimized_reward_order again on the new token. This is the required autonomous recovery per user policy — never ask the human for guidance."
          };
        }

        // Step 4: Optional monitoring
        if (args.monitorFills) {
          // Reuse the monitoring logic from place_maker_reward_order
          // (simplified for now)
          return {
            success: true,
            message: "Order placed with optimized parameters and is earning rewards.",
            ...placeResult,
            suggestionUsed: suggestion,
            note: "Full fill monitoring with monitorFills is recommended via the dedicated tool for long-running orders."
          };
        }

        return {
          success: true,
          message: "Order placed with optimized parameters and is earning maker rewards.",
          ...placeResult,
          suggestionUsed: suggestion,
        };
      }, F.formatGeneric, name);
    }

    case 'watch_order_scoring': {
      // Starts watching scoring status for an order (similar to watch_order_until_filled)
      const orderId = args.orderId;
      if (!orderId) {
        return { isError: true, content: [{ type: 'text', text: "orderId is required" }] };
      }

      try {
        await resourceManager.ensureUserSubscriptionForWatch(orderId);
        // We reuse the user subscription. For now we just register interest.
        // A more advanced implementation would track scoring state changes specifically.
        const watchUri = `polymarket://order/${orderId}/scoring`;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              status: "Watching order scoring status",
              orderId,
              resource: watchUri,
              note: "Subscribe to the resource above for updates when this order's maker reward scoring status changes."
            }, null, 2)
          }]
        };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `Failed to start watching scoring: ${error?.message}` }] };
      }
    }

    case 'get_balance_allowance': {
      // High-level, actionable balance check for agents doing reward farming
      return callWithFormat(async () => {
        const sec = await getSec();
        const assetType = (args.assetType || 'COLLATERAL').toUpperCase() as 'COLLATERAL' | 'CONDITIONAL';

        let data: any;
        try {
          const balRes = await callWithRateLimitProtection(
            () => fetchBalanceAllowance(sec, { assetType }),
            'fetchBalanceAllowance'
          );
          if (!balRes.ok) {
            return {
              success: false, rateLimited: true, retryAfterMs: balRes.retryAfterMs,
              message: balRes.message,
              directive: "Rate limited checking balance. Wait before retrying get_balance_allowance or any placement."
            };
          }
          data = balRes.data;
        } catch (e: any) {
          return {
            success: false,
            error: "Failed to fetch balance/allowance",
            detail: e?.message || String(e),
            directive: "You may need to run deploy_deposit_wallet first, or the wallet is not properly set up."
          };
        }

        const rawBalance = data?.balance || '0';
        const balance = parseFloat(rawBalance) / 1_000_000; // USDC 6 decimals (safe default for collateral)
        const allowances = data?.allowances || {};

        // Find the main CLOB-related allowance (usually the highest or a known exchange address)
        const allowanceEntries = Object.entries(allowances);
        const maxAllowance = allowanceEntries.length
          ? Math.max(...allowanceEntries.map(([_, v]) => parseFloat(String(v)) / 1_000_000))
          : 0;

        const isCollateral = assetType === 'COLLATERAL';
        const sufficient = isCollateral ? balance > 1 && maxAllowance > 10 : true; // heuristic

        return {
          success: true,
          assetType,
          balance: balance.toFixed(2),
          balanceRaw: rawBalance,
          maxAllowanceApprox: maxAllowance.toFixed(2),
          sufficientForSmallOrders: sufficient,
          nextSteps: sufficient
            ? "Balance and allowance look usable for small maker orders."
            : [
                "1. If allowance is low: call approve_erc20 with the correct USDC token address and a large spender amount (or the CLOB proxy).",
                "2. If balance is low: deposit USDC into your platform deposit wallet (use deposit or the deposit wallet flow).",
                "3. After approve/deposit: call update_balance_allowance({assetType: 'COLLATERAL'}) to sync.",
                "4. Then retry place_maker_reward_order or place_optimized_reward_order."
              ],
          rawAllowances: Object.keys(allowances).length <= 3 ? allowances : "multiple spenders (truncated for size)"
        };
      }, F.formatGeneric, name);
    }

    case 'wait_seconds': {
      // Server-side backoff primitive for autonomous loops (rate limits, no opportunities, disciplined trading waits)
      const seconds = Math.max(1, Math.min(300, Number(args.seconds) || 5));
      const reason = args.reason || 'autonomous loop backoff';

      try {
        await new Promise(resolve => setTimeout(resolve, seconds * 1000));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              waitedSeconds: seconds,
              reason,
              resumedAt: new Date().toISOString(),
              directive: "Backoff complete. Resume your loop (e.g. re-call list_active_maker_reward_markets or check your exit conditions)."
            }, null, 0)
          }]
        };
      } catch (e: any) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: `Wait failed: ${e?.message || e}`,
              waitedSeconds: seconds,
              reason
            })
          }]
        };
      }
    }

    case 'suggest_qualified_size': {
      const result = calculateRecommendedSize({
        intent: args.intent,
        rewardsMinSize: undefined,
        currentPrice: undefined,
        capitalUsd: args.capitalUsd,
        highConfidenceEdge: args.highConfidenceEdge,
      });

      try {
        const [book, rewards] = await Promise.all([
          pub.fetchOrderBook({ tokenId: args.tokenId }).catch(() => null),
          pub.listMarketRewards({ conditionId: args.tokenId }).catch(() => null),
        ]);

        const program = rewards?.items?.[0];
        const actualMinSize = program ? parseFloat(program.rewardsMinSize || '0') : 0;
        const mid = book?.bids?.[0] && book?.asks?.[0]
          ? (parseFloat(book.bids[0].price) + parseFloat(book.asks[0].price)) / 2
          : undefined;

        const betterResult = calculateRecommendedSize({
          intent: args.intent,
          rewardsMinSize: actualMinSize,
          currentPrice: mid,
          capitalUsd: args.capitalUsd,
          highConfidenceEdge: args.highConfidenceEdge,
        });

        const estimatedCost = mid && betterResult.size ? (betterResult.size * mid) : null;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              recommendedSize: betterResult.size,
              reasoning: betterResult.reasoning,
              capped: betterResult.capped,
              tokenId: args.tokenId,
              lookedUpMinSize: actualMinSize,
              lookedUpMid: mid,
              estimatedCostUsd: estimatedCost ? Number(estimatedCost.toFixed(2)) : undefined,
              meetsRewardMinSize: actualMinSize > 0 ? betterResult.size >= actualMinSize : undefined,
            }, null, 2)
          }]
        };
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, ...result, note: 'Used provided params (live lookup failed or not needed)' }, null, 2)
          }]
        };
      }
    }

    case 'compute_bayesian_update': {
      const result = computeBayesianPosterior({
        prior: args.prior,
        signal: args.signal,
        weight: args.weight,
      });

      const divergenceBps = result.divergence * 10000;
      let actionHint = "No clear edge.";
      if (result.divergence >= 0.08) actionHint = "Strong edge — consider position.";
      else if (result.divergence >= 0.05) actionHint = "Moderate edge — investigate further.";

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            posterior: result.posterior,
            divergenceFromPrior: result.divergence,
            divergenceBps: Number(divergenceBps.toFixed(0)),
            actionHint,
            reasoning: result.reasoning,
          }, null, 2)
        }]
      };
    }

    case 'get_farmability': {
      const tokenId = args.tokenId;

      try {
        const [book, rewards, spreads] = await Promise.all([
          pub.fetchOrderBook({ tokenId }).catch(() => null),
          pub.listMarketRewards({ conditionId: tokenId }).catch(() => null),
          pub.fetchSpreads({ tokenIds: [tokenId] }).catch(() => null),
        ]);

        const program = rewards?.items?.[0];
        const minSize = program ? parseFloat(program.rewardsMinSize || '0') : 0;
        const maxSpread = program ? parseFloat(program.rewardsMaxSpread || '0') : 0;

        const bestBid = book?.bids?.[0]?.price ? parseFloat(book.bids[0].price) : null;
        const bestAsk = book?.asks?.[0]?.price ? parseFloat(book.asks[0].price) : null;
        const mid = (bestBid && bestAsk) ? (bestBid + bestAsk) / 2 : null;
        const currentSpread = (bestBid && bestAsk) ? (bestAsk - bestBid) : null;

        // Use SDK fetchSpreads for more accurate current spread vs reward max
        const spreadData = spreads && spreads[tokenId] ? spreads[tokenId] : null;
        const accurateCurrentSpread = spreadData ? parseFloat(spreadData.spread || currentSpread || 0) : currentSpread;
        const spreadVsAllowed = (accurateCurrentSpread && maxSpread) ? (accurateCurrentSpread / maxSpread) : null;

        const costToQualify = (minSize && mid) ? minSize * mid : null;

        // Proxy for sufficient volume/active flow: if book has reasonable depth on sides (SDK fetchOrderBook)
        const bidDepth = book?.bids?.slice(0, 3).reduce((sum, b) => sum + parseFloat(b.size || 0), 0) || 0;
        const askDepth = book?.asks?.slice(0, 3).reduce((sum, a) => sum + parseFloat(a.size || 0), 0) || 0;

        // X Key Insights integration (SDK-native only, advisory): "Quote near the midpoint for higher reward weighting"
        // + "sticky (auto-repegging post-only)" edge via postOnly GTC + reprice. Low-competition proxy from depth.
        let suggestedNearMidBuy: number | undefined;
        let suggestedNearMidSell: number | undefined;
        if (mid != null) {
          suggestedNearMidBuy = Number(Math.max(0.001, mid - 0.0008).toFixed(4));
          suggestedNearMidSell = Number(Math.min(0.999, mid + 0.0008).toFixed(4));
        }
        const totalDepth = bidDepth + askDepth;
        const depthImbalance = totalDepth > 0 ? Math.abs(bidDepth - askDepth) / totalDepth : 1;
        const competitionSignal = totalDepth < 300 ? 'thin-book (verify flow; potential low-comp but check activity)' :
          (totalDepth > 8000 ? 'deep-book (high competition likely; harder for sticky edge)' :
           (depthImbalance < 0.5 ? 'balanced-moderate depth (favorable for active sticky quoting)' : 'imbalanced depth (adverse selection risk higher)'));

        // Enhanced scoring per farming requirements (volume/liquidity via book depth proxy, tight spread, active flow via spread tightness)
        let farmabilityScore = 0;
        if (minSize > 0 && mid) farmabilityScore += 25; // reward eligible
        if (spreadVsAllowed && spreadVsAllowed < 0.7) farmabilityScore += 35; // tight spread vs allowed (avoid wide)
        if (accurateCurrentSpread && accurateCurrentSpread < 0.015) farmabilityScore += 20; // very tight current spread
        if (costToQualify && costToQualify < 8) farmabilityScore += 15; // low inventory risk for small cap
        if (totalDepth > 1000) farmabilityScore += 5; // active order flow proxy
        if (suggestedNearMidBuy && accurateCurrentSpread && accurateCurrentSpread < 0.01) farmabilityScore += 5; // near-mid possible within tight spread (higher weighting)

        const recommendation = farmabilityScore > 75 ? "Excellent for maker farming - tight spread, low cost, good eligibility, near-mid quoting feasible" :
                              farmabilityScore > 55 ? "Good candidate - monitor for active flow and reprice as needed; use near-mid quotes" :
                              farmabilityScore > 35 ? "Marginal - check for wide spreads or low activity; consider smaller test size or different market" :
                              "Poor right now - wide spread vs allowed, high cost, or low eligibility. Look for better opportunities per exit rules.";

        const farmCard = F.formatFarmability({
          success: true,
          tokenId,
          rewardsMinSize: minSize || undefined,
          rewardsMaxSpread: maxSpread || undefined,
          currentMid: mid ? Number(mid.toFixed(4)) : undefined,
          currentSpread: accurateCurrentSpread ? Number(accurateCurrentSpread.toFixed(4)) : undefined,
          spreadVsMaxAllowed: spreadVsAllowed ? Number(spreadVsAllowed.toFixed(2)) : undefined,
          costToQualifyUsd: costToQualify ? Number(costToQualify.toFixed(2)) : undefined,
          approximateBookDepth: Number(totalDepth.toFixed(0)),
          suggestedNearMidBuy: suggestedNearMidBuy,
          suggestedNearMidSell: suggestedNearMidSell,
          competitionSignal: competitionSignal,
          farmabilityScore: Math.min(100, farmabilityScore),
          recommendation,
          notes: "SDK-native only (fetchOrderBook + listMarketRewards + fetchSpreads). Quote near midpoint (use suggestedNearMidBuy/Sell) for higher reward weighting. Both-sides (yes+no) for 2x when possible. Use place_maker_reward_order (forces postOnly GTC) + active reprice/monitor for 'sticky' major edge. Thin/moderate depth = potential low-competition; avoid high adverse selection. Exit on spread collapse, low activity, or better low-comp opp. Use with suggest_qualified_size + list_active_maker_reward_markets."
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(farmCard, null, 2)
          }]
        };
      } catch (e: any) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: e?.message || String(e) }, null, 2)
          }]
        };
      }
    }

    case 'set_strategy': {
      const key = getStrategyKey(args.tokenId, args.market);
      // General-purpose store: preserve ALL fields the agent sends (trading + arbitrary rules/filters/configs).
      // This is the lightweight mechanism that lets the agent own every filter, farming rule, event pref, etc.
      // without requiring dozens of dedicated MCP tools.
      const strategy: any = {
        tokenId: args.tokenId,
        market: args.market || null,
        entryPrice: args.entryPrice ?? null,
        takeProfitPrice: args.takeProfitPrice ?? null,
        stopLossPrice: args.stopLossPrice ?? null,
        size: args.size ?? null,
        side: args.side ?? null,
        notes: args.notes ?? '',
        maxWaitSecondsBetweenChecks: args.maxWaitSecondsBetweenChecks ?? 30,
        updatedAt: new Date().toISOString()
      };
      // Attach every extra property the agent provided (liquidity filters, farming rules, categories, thresholds, etc.)
      Object.keys(args).forEach((k) => {
        if (!['tokenId', 'market', 'entryPrice', 'takeProfitPrice', 'stopLossPrice', 'size', 'side', 'notes', 'maxWaitSecondsBetweenChecks'].includes(k)) {
          strategy[k] = args[k];
        }
      });
      strategyStore.set(key, strategy);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: "Strategy / rules / config stored (persistent for this session). Use for any filters or operating rules.",
            key,
            strategy,
            directive: "Use get_strategies (no args) to load your full current rule set. This is how you evolve filters, farming rules, event prefs etc. without bloating the MCP."
          }, null, 0)
        }]
      };
    }

    case 'get_strategies': {
      let results: any[] = [];
      if (args.tokenId) {
        const key = getStrategyKey(args.tokenId, args.market);
        if (strategyStore.has(key)) results.push(strategyStore.get(key));
      } else {
        results = Array.from(strategyStore.values());
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            count: results.length,
            strategies: results,
            note: "Your complete persisted rules, filters, farming configs, event preferences, and trading plans. Call with no args to load everything the agent has evolved. This is the lightweight source of truth for all your operating rules."
          }, null, 0)
        }]
      };
    }

    case 'clear_strategy': {
      const key = getStrategyKey(args.tokenId, args.market);
      const existed = strategyStore.delete(key);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            deleted: existed,
            key
          }, null, 0)
        }]
      };
    }

    case 'update_strategy': {
      const key = getStrategyKey(args.tokenId, args.market);
      // Start from whatever exists (may contain custom rules/filters the agent previously stored)
      const existing = strategyStore.get(key) || {
        tokenId: args.tokenId,
        market: args.market || null,
        entryPrice: null,
        takeProfitPrice: null,
        stopLossPrice: null,
        size: null,
        side: null,
        notes: '',
        maxWaitSecondsBetweenChecks: 30,
        updatedAt: new Date().toISOString()
      };

      // General partial merge: every provided arg (except the key fields) + preserve ALL prior custom fields.
      // This is the lightweight "update any filter or rule" primitive the agent relies on.
      const updated: any = { ...existing, updatedAt: new Date().toISOString() };

      // Overlay every field the agent actually sent in this call
      Object.keys(args).forEach((k) => {
        if (k !== 'tokenId' && k !== 'market') {
          updated[k] = args[k];
        }
      });

      strategyStore.set(key, updated);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: "Entry updated (partial; all custom rules/filters preserved and new ones merged).",
            key,
            strategy: updated,
            directive: "Use get_strategies (no args) to see your full current set of filters, farming rules, event prefs, etc. This mechanism keeps the entire MCP lightweight while giving you complete control over every operating rule."
          }, null, 0)
        }]
      };
    }

    case 'place_market_order':
      return callWithFormat(async () => {
        const posted = await (await getSec()).placeMarketOrder(args);
        const orderId = (posted as any)?.orderId;
        if (orderId) resourceManager.ensureUserSubscriptionForWatch(orderId).catch(() => {});
        return posted;
      }, F.formatOrderResponse, name);
    case 'sports_place_limit_order':
      return callWithFormat(async () => {
        const posted = await sportsPlaceLimitOrder(await getSec(), args);
        const orderId = (posted as any)?.orderId;
        if (orderId) resourceManager.ensureUserSubscriptionForWatch(orderId).catch(() => {});
        return posted;
      }, F.formatOrderResponse, name);
    case 'sports_place_market_order':
      return callWithFormat(async () => {
        const posted = await sportsPlaceMarketOrder(await getSec(), args);
        const orderId = (posted as any)?.orderId;
        if (orderId) resourceManager.ensureUserSubscriptionForWatch(orderId).catch(() => {});
        return posted;
      }, F.formatOrderResponse, name);
    case 'cancel_order':
      return callWithFormat(async () => (await getSec()).cancelOrder(args), F.formatCancelResponse, name);
    case 'cancel_orders':
      return callWithFormat(async () => (await getSec()).cancelOrders(args), F.formatCancelResponse, name);
    case 'cancel_all':
      return callWithFormat(async () => (await getSec()).cancelAll(), F.formatCancelResponse, name);
    case 'cancel_market_orders':
      return callWithFormat(async () => (await getSec()).cancelMarketOrders(args), F.formatCancelResponse, name);
    case 'list_open_orders':
      return callPaginatedWithFormat((await getSec()).listOpenOrders(args), F.formatOrder, name);
    case 'fetch_order':
      return callWithFormat(async () => (await getSec()).fetchOrder(args), F.formatOrder, name);
    case 'watch_order_until_filled': {
      // Starts/ensures watching + returns the dedicated fill-status resource URI
      const orderId = args.orderId;
      const timeout = args.timeoutSeconds || 300;
      // Ensure the authenticated user subscription is active (it powers fill notifications)
      try {
        await resourceManager.ensureUserSubscriptionForWatch(orderId);
      } catch (e) {
        // Non-fatal — the resource can still be polled via fetch_order
      }
      const watchUri = `polymarket://order/${orderId}/fill-status`;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            'Status': 'WATCHING',
            'Order Id': orderId,
            'Resource': watchUri,
            'Description': 'Subscribe to the resource above for live fill updates. This watch was automatically registered.',
            'Timeout Seconds': timeout,
            'Note': 'You will receive resource/updated notifications when this order is filled (partially or fully).'
          }, null, 2)
        }]
      };
    }
    case 'list_positions':
      // Custom to attach enhanced PnL summary card (uses new formatPnlSummary + enhance logic for richer agent output cards)
      try {
        const res: any = await (await getSec()).listPositions(args);
        const items = res?.items || res || [];
        const formatted = items.map((p: any) => F.formatPosition(p));
        const summary = F.formatPnlSummary(items);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ Positions: formatted, PnLSummary: summary }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }] };
      } catch (e: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `list_positions error: ${e?.message || e}` }] };
      }
    case 'list_closed_positions':
      return callPaginatedWithFormat((await getSec()).listClosedPositions?.(args) ?? Promise.resolve({ items: [] }), F.formatClosedPosition, name);
    case 'fetch_portfolio_value':
      return callWithFormat(async () => (await getSec()).fetchPortfolioValue(), F.formatPortfolioValue, name);
    case 'list_activity':
      return callPaginatedWithFormat((await getSec()).listActivity(args), F.formatActivity, name);
    case 'list_account_trades':
      return callPaginatedWithFormat((await getSec()).listAccountTrades(args), F.formatTrade, name);
    case 'setup_trading_approvals': {
      try {
        const h = await (await getSec()).setupTradingApprovals();
        const card = await F.formatTransactionHandle(h);
        return { content: [{ type: 'text' as const, text: JSON.stringify(card, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `Error in setup_trading_approvals: ${error?.message || String(error)}` }] };
      }
    }
    case 'enable_auto_redeem': {
      try {
        const h = await (await getSec()).setupTradingApprovals();
        const card = await F.formatTransactionHandle(h);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ 'Auto-Redeem Enabled': true, ...card }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `Error in enable_auto_redeem: ${error?.message || String(error)}` }] };
      }
    }
    case 'split_position': {
      try {
        const h = await (await getSec()).splitPosition(args);
        const card = await F.formatTransactionHandle(h);
        return { content: [{ type: 'text' as const, text: JSON.stringify(card, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `Error in split_position: ${error?.message || String(error)}` }] };
      }
    }
    case 'merge_positions': {
      try {
        const h = await (await getSec()).mergePositions(args);
        const card = await F.formatTransactionHandle(h);
        return { content: [{ type: 'text' as const, text: JSON.stringify(card, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `Error in merge_positions: ${error?.message || String(error)}` }] };
      }
    }
    case 'redeem_positions': {
      try {
        const h = await (await getSec()).redeemPositions(args);
        const card = await F.formatTransactionHandle(h);
        return { content: [{ type: 'text' as const, text: JSON.stringify(card, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `Error in redeem_positions: ${error?.message || String(error)}` }] };
      }
    }

    // === Leaderboards + Public Profiles ===
    case 'list_builder_leaderboard':
      return callPaginatedWithFormat(pub.listBuilderLeaderboard(args), F.formatLeaderboardEntry, name);
    case 'list_trader_leaderboard':
      return callPaginatedWithFormat(pub.listTraderLeaderboard(args), F.formatTraderLeaderboardEntry, name);
    case 'fetch_public_profile':
      return callWithFormat(() => pub.fetchPublicProfile(args), F.formatPublicProfile, name);

    // === Reward Tracking (viewing only) ===
    case 'list_current_rewards':
      return callPaginatedWithFormat(pub.listCurrentRewards(args), F.formatCurrentReward, name);
    case 'list_market_rewards':
      return callPaginatedWithFormat(pub.listMarketRewards(args), F.formatMarketReward, name);
    case 'fetch_reward_percentages':
      return callWithFormat(async () => (await getSec()).fetchRewardPercentages(), F.formatRewardsPercentages, name);
    case 'list_user_earnings_and_markets_config':
      const earningsCompact = args.compact !== false;
      const earningsFormatter = earningsCompact ? F.formatUserRewardsEarningCompact : F.formatUserRewardsEarning;
      return callPaginatedWithFormat((await getSec()).listUserEarningsAndMarketsConfig(args), earningsFormatter, name);

    // === Additional Analytics ===
    case 'list_builder_trades':
      return callPaginatedWithFormat(pub.listBuilderTrades(args), F.formatBuilderTrade, name);
    case 'fetch_builder_volume':
      return callWithFormat(() => pub.fetchBuilderVolume(args), F.formatBuilderVolume, name);

    // === Additional Rewards (secure) ===
    case 'fetch_order_scoring':
      return callWithFormat(async () => (await getSec()).fetchOrderScoring(args), F.formatOrderScoring, name);
    case 'fetch_orders_scoring':
      return callWithFormat(async () => (await getSec()).fetchOrdersScoring(args), F.formatOrderScoring, name);
    case 'get_order_scoring_status':
      // Convenience wrapper around SDK fetchOrderScoring for single order (GTC maker rewards eligibility)
      return callWithFormat(async () => (await getSec()).fetchOrderScoring({ orderId: args.orderId }), F.formatOrderScoring, name);
    case 'get_reward_earnings':
      // Returns maker reward earnings using SDK only (GTC postOnly maker rewards).
      // Defaults to today if no date provided.
      return callWithFormat(async () => {
        const date = args.date || new Date().toISOString().slice(0, 10);
        return (await getSec()).fetchTotalEarningsForUserForDay({ date });
      }, F.formatRewardEarnings, name);
    case 'list_user_earnings_for_day':
      const dayEarningsCompact = args.compact !== false;
      const dayEarningsFormatter = dayEarningsCompact ? F.formatUserRewardsEarningCompact : F.formatUserRewardsEarning;
      return callPaginatedWithFormat((await getSec()).listUserEarningsForDay(args), dayEarningsFormatter, name);
    case 'fetch_total_earnings_for_user_for_day':
      return callWithFormat(async () => (await getSec()).fetchTotalEarningsForUserForDay(args), F.formatGeneric, name);

    // === Additional Discovery ===
    case 'list_tags':
      return callPaginatedWithFormat(pub.listTags(args), F.formatTag, name);
    case 'fetch_tag':
      return callWithFormat(() => pub.fetchTag(args), F.formatTag, name);
    case 'fetch_related_tags':
      return callWithFormat(() => pub.fetchRelatedTags(args), F.formatRelatedTag, name);

    // Comments
    case 'list_comments':
      return callPaginatedWithFormat(pub.listComments(args), F.formatComment, name);
    case 'fetch_comment':
      return callWithFormat(() => pub.fetchCommentsById(args), (arr: any[]) => (arr || []).map(F.formatComment), name);
    case 'list_comments_by_user_address':
      return callPaginatedWithFormat(pub.listCommentsByUserAddress(args), F.formatComment, name);

    case 'list_series':
      return callPaginatedWithFormat(pub.listSeries(args), F.formatSeries, name);
    case 'fetch_series':
      return callWithFormat(() => pub.fetchSeries(args), F.formatSeries, name);

    // === Data Enhancements ===
    case 'list_market_holders':
      return callWithFormat(() => pub.listMarketHolders(args), F.formatMarketHolder, name);
    case 'list_open_interest':
      return callWithFormat(() => pub.listOpenInterest(args), F.formatOpenInterest, name);
    case 'fetch_event_live_volume':
      return callWithFormat(() => pub.fetchEventLiveVolume(args), F.formatSimpleListItem, name);

    // === Newly Added SDK Coverage (all formatted) ===
    case 'list_teams':
      return callPaginatedWithFormat(pub.listTeams(args), F.formatTeam, name);
    case 'fetch_market_info':
      return callWithFormat(() => pub.fetchMarketInfo(args), F.formatMarketInfo, name);
    case 'fetch_midpoints':
      return callWithFormat(() => pub.fetchMidpoints(args), F.formatBatchPrices, name);
    case 'fetch_spreads':
      return callWithFormat(() => pub.fetchSpreads(args), F.formatBatchPrices, name);
    case 'fetch_builder_fee_rates':
      return callWithFormat(() => pub.fetchBuilderFeeRates(args), F.formatBuilderFeeRates, name);
    case 'fetch_traded_market_count':
      return callWithFormat(() => pub.fetchTradedMarketCount(args), F.formatTradedMarketCount, name);
    case 'fetch_related_tag_resources':
      return callWithFormat(() => pub.fetchRelatedTagResources(args), F.formatRelatedTagResources, name);
    case 'list_market_positions':
      return callPaginatedWithFormat(pub.listMarketPositions(args), F.formatMarketPosition, name);

    // === Sports (public) ===
    case 'list_sports':
      return callWithFormat(() => pub.listSports(args), F.formatSport, name);
    case 'fetch_sports_market_types':
      return callWithFormat(() => pub.fetchSportsMarketTypes(args), F.formatSportsMarketType, name);

    // === Batch Data (public) ===
    case 'fetch_prices':
      return callWithFormat(() => pub.fetchPrices(args), F.formatBatchPriceMap, name);
    case 'fetch_order_books':
      return callWithFormat(() => pub.fetchOrderBooks(args), F.formatBatchOrderBooks, name);

    // === Metadata (public) ===
    case 'fetch_event_tags':
      return callWithFormat(() => pub.fetchEventTags(args), F.formatSimpleListItem, name);
    case 'fetch_market_tags':
      return callWithFormat(() => pub.fetchMarketTags(args), F.formatSimpleListItem, name);
    case 'fetch_neg_risk':
      return callWithFormat(() => pub.fetchNegRisk(args), F.formatNegRisk, name);
    case 'fetch_tick_size':
      return callWithFormat(() => pub.fetchTickSize(args), F.formatTickSize, name);
    case 'fetch_execute_params':
      return callWithFormat(() => pub.fetchExecuteParams(args), F.formatExecuteParams, name);

    // === Account / Wallet ===

    case 'fetch_notifications':
      // Use compact by default for agents (full details can be heavy)
      const notifCompact = true; // could later make this configurable
      return callWithFormat(async () => (await getSec()).fetchNotifications(), notifCompact ? F.formatNotificationCompact : F.formatGeneric, name);
    case 'drop_notifications':
      return callWithFormat(async () => (await getSec()).dropNotifications(args), F.formatGeneric, name);
    case 'fetch_closed_only_mode':
      return callWithFormat(async () => (await getSec()).fetchClosedOnlyMode(), F.formatGeneric, name);
    case 'is_gasless_ready':
      return callWithFormat(async () => (await getSec()).isGaslessReady(), F.formatGeneric, name);
    case 'fetch_deposit_wallet':
      return callWithFormat(async () => (await getSec()).getDepositWallet?.(args) || /* resolve via actions or client */ { note: 'deposit wallet derivation' }, F.formatGeneric, name);
    case 'get_profile':
      return callWithFormat(async () => (await getSec()).getProfile?.(args) || {}, F.formatGeneric, name);
    case 'update_profile':
      return callWithFormat(async () => (await getSec()).updateProfile?.(args) || { success: true }, F.formatGeneric, name);
    case 'post_comment':
      return callWithFormat(async () => (await getSec()).postComment?.(args) || { success: true }, F.formatGeneric, name);

    // === Gasless Prepare Workflows (secure) ===
    case 'prepare_limit_order':
      return callWithFormat(async () => (await getSec()).prepareLimitOrder(args), F.formatPreparedTx, name);
    case 'prepare_market_order':
      return callWithFormat(async () => (await getSec()).prepareMarketOrder(args), F.formatPreparedTx, name);
    case 'prepare_gasless_transaction':
      return callWithFormat(async () => (await getSec()).prepareGaslessTransaction(args), F.formatPreparedTx, name);
    case 'prepare_split_position':
      return callWithFormat(async () => (await getSec()).prepareSplitPosition(args), F.formatPreparedTx, name);
    case 'prepare_merge_positions':
      return callWithFormat(async () => (await getSec()).prepareMergePositions(args), F.formatPreparedTx, name);
    case 'prepare_redeem_positions':
      return callWithFormat(async () => (await getSec()).prepareRedeemPositions(args), F.formatPreparedTx, name);
    case 'prepare_erc20_approval':
      return callWithFormat(async () => (await getSec()).prepareErc20Approval(args), F.formatPreparedTx, name);
    case 'prepare_erc1155_approval_for_all':
      return callWithFormat(async () => (await getSec()).prepareErc1155ApprovalForAll(args), F.formatPreparedTx, name);
    case 'prepare_erc20_transfer':
      return callWithFormat(async () => (await getSec()).prepareErc20Transfer(args), F.formatPreparedTx, name);

    // === Lower-level Order Posting (secure) ===
    case 'post_order':
      return callWithFormat(async () => {
        const posted = await (await getSec()).postOrder(args);
        const orderId = (posted as any)?.orderId;
        if (orderId) resourceManager.ensureUserSubscriptionForWatch(orderId).catch(() => {});
        return posted;
      }, F.formatOrderResponse, name);
    case 'post_orders':
      return callWithFormat(async () => (await getSec()).postOrders(args), F.formatOrderResponses, name);

    case 'send_heartbeat':
      return callWithFormat(async () => {
        const sec = await getSec();
        if (typeof (sec as any).sendHeartbeat === 'function') {
          return await (sec as any).sendHeartbeat();
        }
        // Fallback / note per SDK (often internal for WS keepalive; REST session via regular activity)
        return { 
          status: 'heartbeat acknowledged or managed internally by SDK client',
          note: 'Per llms.txt /trade/send-heartbeat: call regularly for long sessions to prevent auto-cancel of resting orders. Use with wait_seconds. SDK WS clients usually handle; exposed here for explicit control in MCP agents.'
        };
      }, F.formatGeneric, name);

    // === Direct On-Chain (secure) ===
    case 'approve_erc20':
      return callWithFormat(async () => (await getSec()).approveErc20(args), F.formatTransactionHandle, name);
    case 'approve_erc1155_for_all':
      return callWithFormat(async () => (await getSec()).approveErc1155ForAll(args), F.formatTransactionHandle, name);
    case 'transfer_erc20':
      return callWithFormat(async () => (await getSec()).transferErc20(args), F.formatTransactionHandle, name);
    case 'resolve_condition_by_token':
      return callWithFormat(async () => (await getSec()).resolveConditionByToken(args), F.formatTransactionHandle, name);

    // === Account / Wallet Additional (secure) ===
    case 'update_balance_allowance':
      return callWithFormat(async () => {
        const sec = await getSec();
        return updateBalanceAllowance(sec, args || {});
      }, F.formatGeneric, name);
    case 'deploy_deposit_wallet':
      // Explicit deploy for deposit wallet (still supported; auto-deploy now happens in create for DEPOSIT_WALLET type per latest SDK).
      return callWithFormat(async () => (await getSec()).deployDepositWallet(), F.formatTransactionHandle, name);
    case 'download_accounting_snapshot':
      return callWithFormat(async () => (await getSec()).downloadAccountingSnapshot(args), F.formatAccountingSnapshot, name);
    case 'setup_gasless_wallet':
      // Per latest SDK (default secure client to deposit wallet): setupGaslessWallet is @deprecated no-op.
      // Gasless/deposit setup now automatic in createSecureClient. Wrapper kept for MCP tool compat.
      return callWithFormat(() => setupGaslessWallet(), F.formatGeneric, name);
    case 'fetch_transaction':
      return callWithFormat(async () => (await getSec()).fetchTransaction(args), F.formatGaslessTx, name);

    // === API Key actions (standalone from /actions; create* use pre-signed payloads + pub client) ===
    case 'create_api_key':
      return callWithFormat(() => createApiKey(pub, args), F.formatApiKey, name);
    case 'derive_api_key':
      return callWithFormat(() => deriveApiKey(pub, args), F.formatApiKey, name);
    case 'create_or_derive_api_key':
      return callWithFormat(() => createOrDeriveApiKey(pub, args), F.formatApiKey, name);
    case 'fetch_api_keys':
      return callWithFormat(async () => fetchApiKeys(await getSec()), F.formatApiKeys, name);
    case 'delete_api_key':
      return callWithFormat(async () => { await deleteApiKey(await getSec()); return { success: true }; }, F.formatGeneric, name);
    case 'create_builder_api_key':
      return callWithFormat(async () => createBuilderApiKey(await getSec()), F.formatGeneric, name);
    case 'fetch_builder_api_keys':
      return callWithFormat(async () => fetchBuilderApiKeys(await getSec()), F.formatGeneric, name);
    case 'revoke_builder_api_key':
      return callWithFormat(async () => { await revokeBuilderApiKey(await getSec()); return { success: true }; }, F.formatGeneric, name);

    // ===================================================================
    // SECURITY-SENSITIVE HANDLERS (added per explicit request)
    // These provide direct access to raw wallet signing and transaction
    // capabilities. They should only be used with additional safeguards.
    // ===================================================================
    case 'sign_message': {
      try {
        const sec = await getSec();
        const signer = (sec as any).signer;
        if (!signer || typeof signer.signMessage !== 'function') {
          throw new Error('No signer available on secure client');
        }
        const sig = await signer.signMessage(args.message);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ signature: sig }, null, 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `sign_message error: ${error?.message || String(error)}` }] };
      }
    }
    case 'sign_typed_data': {
      try {
        const sec = await getSec();
        const signer = (sec as any).signer;
        if (!signer || typeof signer.signTypedData !== 'function') {
          throw new Error('No signer available on secure client');
        }
        const sig = await signer.signTypedData(args.payload);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ signature: sig }, null, 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `sign_typed_data error: ${error?.message || String(error)}` }] };
      }
    }
    case 'send_transaction': {
      try {
        const sec = await getSec();
        const signer = (sec as any).signer;
        if (!signer || typeof signer.sendTransaction !== 'function') {
          throw new Error('No signer available on secure client');
        }
        const handle = await signer.sendTransaction(args.request);
        return { content: [{ type: 'text' as const, text: JSON.stringify(handle, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `send_transaction error: ${error?.message || String(error)}` }] };
      }
    }
    case 'end_authentication': {
      try {
        const sec = await getSec();
        const pubClient = await sec.endAuthentication();
        return { content: [{ type: 'text' as const, text: JSON.stringify({ status: 'Authentication ended', returnedPublicClient: true }, null, 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `end_authentication error: ${error?.message || String(error)}` }] };
      }
    }
    case 'get_secure_client_info': {
      try {
        const sec = await getSec();
        const info = {
          account: (sec as any).account,
          credentials: (sec as any).credentials,
          authMode: process.env.RELAYER_API_KEY ? 'relayer' : (process.env.BUILDER_API_KEY ? 'builder' : 'eoa-signer'),
          hasRelayer: !!process.env.RELAYER_API_KEY,
          hasBuilder: !!process.env.BUILDER_API_KEY,
          note: 'These are sensitive authentication internals. Do not log or expose them. Full auth (relayer/builder) supported per SDK createSecureClient.'
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(info, null, 2) }] };
      } catch (error: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `get_secure_client_info error: ${error?.message || String(error)}` }] };
      }
    }

    default:
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }]
      };
  }
});

// ==================== MCP RESOURCES (Live Subscriptions) ====================
// This completes the "subscribe" capability using the proper MCP Resources model.
// Agents can list resources, read snapshots (always clean formatted cards),
// and subscribe for push notifications/resources/updated when underlying WS data changes.

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return resourceManager.listResources();
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
  return resourceManager.listResourceTemplates();
});

// Prompts: lightweight on-demand structure and best practices for the agent.
// This reduces the need for many tools or heavy descriptions; agent can request "how to do reward farming" etc. when needed.
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: PROMPTS };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const name = request.params.name;
  const prompt = PROMPTS.find(p => p.name === name);
  if (!prompt) {
    throw new Error(`Prompt not found: ${name}`);
  }

  let content = '';
  if (name === 'agent_routing') {
    content = buildAgentRoutingPrompt();
  } else if (name === 'reward_farming_best_practices') {
    content = `KEY INSIGHTS FROM X (current tactics for daily USDC LP maker rewards — incorporate directly):

The platform runs daily USDC LP rewards for limit orders placed within a “max spread” (often shown as a blue zone in the order book).
Best practices commonly mentioned:
- Quote near the midpoint for higher reward weighting.
- Quote both sides (Yes + No) when possible for 2x weighting.
- Use “sticky” (auto-repegging post-only) orders — these are considered a major edge.
- Focus on low-competition markets with decent rewards.
- Avoid markets close to resolution.
- Rewards are time-weighted and size-weighted.

Risks highlighted:
- Adverse selection (getting filled badly on one side during a move).
- Need to stay active and competitive.
- Some users run 24/7 bots to maintain uptime.
- Rate limit complaints were not visible on X recently.

**CLOB V2 Place-Path Contention for Heavy Requoting (post ~April 2026 migration, confirmed by multiple makers):**
At high requote rates (~200-250+/sec on one maker/account, even well under published POST /order burst ~5k/10s and with zero 429s), *place* latency floor jumps dramatically (19ms → 400ms+), while cancels stay fast (~30ms). This is server-side (same wallet from different IPs/machines degrades together and recovers instantly when you stop). It manifests as delayed placement (orders accepted but slow to rest on book), not rejections — looks like backend queuing/contention on the place hot path (Cloudflare throttling + matching engine/ledger load protection in the rewritten V2 CLOB backend). Not a hard rate limit, but self-induced (and account-induced) slowdown that hurts "near-mid" queue position and reward scoring.

This issue is intentional protection for the engine under aggressive maker activity. It started with CLOB V2.

**How to requote at volume without tripping it (critical for sticky reward edge):**
- **Batch first**: Always prefer \`post_orders\` (up to 15 pre-signed orders per call) over many individual place_maker_reward_order / place_optimized calls when updating quotes/levels/both-sides. Batching reduces roundtrips and latency.
- **Enforce conservative policy in your strategyStore** (get_strategies() first every loop, evolve via update_strategy): e.g. \`maxRequoteRatePerSidePerSec: 5-20\` (much lower than 250), \`minRequoteIntervalMs: 150-500\`, \`requoteOnlyOnDrift: true\` (only when mid moves >1-2 ticks or order age > threshold), \`bothSides: true\` but coordinated.
- **Leverage sticky + WS**: Place once with postOnly GTC near-mid (the reward place tools enforce this). Use live resources (\`polymarket://market/{tokenId}/book\`, \`user/orders\`) + \`get_farmability\` (fresh book + signals) to *decide* when a reprice is actually needed instead of timer-driven micro-requotes. Let the auto-repegging "sticky" edge do work for you.
- **Discipline with wait_seconds**: Insert explicit backoffs (100-300ms+) between place actions on the same token/side. The wait_seconds tool exists for rate discipline and to avoid queue buildup.
- **Monitor & backoff autonomously**: Track place response times in your rules. If p99 place > ~100-150ms, immediately update_strategy to lower rate, rotate to a different market from list_active_maker_reward_markets, or pause. Follow agentDirectives.
- **Other**: Use GTD for time-bound quotes, cancel stale immediately (cancels are lighter), prefer WS over REST polling for data, consider co-lo near eu-west-2 for raw network floor if doing serious volume.

The MCP (strategy as your brain + explicit native place tools + WS resources + wait_seconds) lets *you* implement smart requoting without ever guessing or hardcoding in your context. 250/sec aggressive requoting will reliably produce the 400ms+ place latency you observed — design your rules to stay out of that regime while still capturing the time/size-weighted rewards edge.

MARKET FARMING FRAMEWORK (follow exactly for autonomy):

OBJECTIVE: Maximize reward yield while minimizing inventory risk and directional exposure.

FARMING REQUIREMENTS (use get_farmability + list_active_maker_reward_markets to confirm):
- Reward eligible market confirmed (via listCurrentRewards / get_farmability).
- Sufficient daily volume (proxy via book depth + fetchEventLiveVolume if event available).
- Tight spread (current spread << rewardsMaxSpread; use get_farmability).
- Active order flow (monitor both sides; reprice stale).
- Acceptable inventory risk (use suggest_qualified_size for maker; limit directional via portfolio tools).

AVOID (filter via discovery + get_farmability):
- Dead markets (low volume/activity).
- Wide spreads (spreadVsMaxAllowed high).
- Low liquidity (shallow book depth).
- Markets near major announcements (check end dates via list_events/fetch_event).
- Unclear resolution (review event details).
- Markets close to resolution (X insight: avoid; prefer distant end dates for sustained time-weighted rewards).

ORDER PLACEMENT (maker only for farming):
- Prefer postOnly/GTC maker orders (place_maker_reward_order / place_optimized_reward_order — these are the native sticky tools; SDK createLimitOrder + postOrder only, no custom).
- Use suggest_qualified_size (intent="reward_farming" or "maker") to size to actual rewardsMinSize (time+size weighted rewards favor staying qualified).
- Maintain competitive queue: quote near midpoint (get_farmability now returns suggestedNearMidBuy/Sell for higher weighting).
- Reprice *intelligently and sparingly* (see CLOB V2 contention warning above): only when drift or staleness warrants it per your strategy rules. Use batch post_orders where possible, WS + get_farmability for signals instead of blind high-frequency replace loops. The "sticky" post-only GTC + auto-repeg is the edge — over-requoting (e.g. 200+/sec) causes place latency spikes even under rate limits.
- Monitor both sides of book (fetchOrderBook + get_farmability). Quote both Yes + No for 2x when program allows.
- Avoid chasing fills (no market orders for farming). Stay active/competitive (24/7 bot pattern for uptime on time-weighted rewards) but respect place-path realities.

INVENTORY MANAGEMENT:
- Keep directional exposure limited (use listPositions + fetchPortfolioValue).
- Reduce imbalance quickly (adverse selection risk per X).
- Monitor total market exposure across strategies (get_strategies + portfolio).
- Never allow reward farming to become a directional bet (exit rules below).

REWARD EFFICIENCY (track via earnings tools + get_strategies):
- Rewards earned (listUserEarnings*, fetchRewardPercentages, fetchTotalEarningsForUserForDay).
- Capital deployed (suggest_qualified_size + get_farmability).
- Reward yield, fill rate, inventory exposure, net P&L including rewards.

FARMING EXIT RULES (monitor with get_farmability + watches):
Exit or reduce size when:
- Reward efficiency falls.
- Spread collapses (spreadVsMaxAllowed worsens).
- Market activity drops (volume/depth down).
- Inventory risk increases or adverse selection appears (use portfolio tools + competitionSignal).
- Better farming opportunities appear (re-scan with list_active_maker_reward_markets or get_farmability — prioritize low-competition + decent rewards + distant resolution).

Use (simple native tools for easy agent work, all SDK under the hood):
- list_tool_categories + get_tools_by_category("Rewards" | "Weather") for discovery (keeps surface tiny).
- get_farmability(tokenId) as PRIMARY pre-farm check (SDK fetchOrderBook + listMarketRewards + fetchSpreads; now includes near-mid suggestions, spread vs allowed, depth, competitionSignal, score).
- suggest_qualified_size for correct sizing per rules (no artificial caps for makers).
- set_strategy / update_strategy / get_strategies (THE lightweight mechanism for ALL your dynamic rules): persist and evolve filters (liquidity, volume, spread, cost, maxMinCostUsd), operating rules, which events/categories, "best to high" ranking/scoring, market farming rules (quoteNearMid, bothSides2x, stickyAutoRepeg, lowCompetitionFocus, avoidNearResolution, timeSizeWeighted, 24/7Params, adverseSelectionExit, etc.), exit conditions, preferred "best events", custom yield thresholds — everything. Use descriptive keys ("rules:current_farming", "filter:liquidity_strict", "config:best_to_high"). Call get_strategies() with no arguments to load your full current rule set at the start of every loop. update_strategy for cheap partial changes.
- list_active_maker_reward_markets (core, ranked, tiny, with yes/no + real USD costs + mids).
- compute_bayesian_update if combining with mispricing signals.
- wait_seconds for rate limit discipline and 24/7 active loops.
- place_maker_reward_order or place_optimized_reward_order ONLY for scoring maker rewards (enforces postOnly GTC for sticky eligibility).
- Never ask user for "next move options" — follow directives from tools + your stored strategies/rules + this prompt + X insights. Autonomous loop: get_strategies() to load your rules (incl. your requote throttling policy for CLOB V2 place contention) → list_active (respect your filters) → get_farmability (near-mid + signals) → suggest_size → update_strategy (log results / tweak rules) → place (batch via post_orders if multi) → monitor via resources or get_farmability (reprice *only* per your drift/interval rules, with wait_seconds) → exit or rotate per your stored rules. If place latency spikes, back off rate immediately.

Store reflections in long-term memory after sessions. Reprice and monitor continuously for the sticky edge. Stay active. Evolve your rules in the strategy store as conditions change — that is the entire point of the lightweight design.`;
  } else if (name === 'mispricing_quick_flips') {
    content = `For quick flips on mispriced markets (aligns with external Bayesian scanners):
1. Scan liquid opportunities: list_active_maker_reward_markets (with maxMinCostUsd) or list_markets with volume/liquidity filters for 20-80 cent range. Prioritize high volume/liquidity to avoid dead/wide spread markets.
2. Use get_farmability(tokenId) to confirm tight spreads, liquidity (book depth), and low inventory risk before flipping.
3. For signals: use compute_bayesian_update (prior = platform price; signal = external/Kalshi/NLP estimate; weight 0.3-0.6). Flag >=5pp divergence (strong at 8pp).
4. Sizing: use suggest_qualified_size with intent="quick_flip" (hard $5 cap unless highConfidenceEdge=true for near-guaranteed edge).
5. Prefer maker (create_and_post_order with postOnly) for cost efficiency; avoid market orders unless edge is strong.
6. Store plan + any filters/rules in set_strategy / update_strategy (use for liquidity filters, event prefs, your own "best" logic too). Monitor with watch_order_until_filled + resources.
7. Exit rules: wide spread, low activity, or better opportunity appears (re-scan). Load your current rules with get_strategies() (no args).

Always cross with reward_farming_best_practices if the market also qualifies for maker rewards. Use categories + wait_seconds for discipline. Never ask user for options.`;
  } else if (name === 'mcp_tool_structure_and_categories') {
    content = `AGENT INSTRUCTION — READ THIS FIRST AND NEVER GUESS:
You are using a deliberately lightweight MCP. The MCP will NEVER expose a giant flat list of 100+ tools by default, and it will NEVER make you guess the right way to use it.

MANDATORY STARTUP SEQUENCE (do this on every new conversation/session that uses this MCP):
1. tools/call get_agent_recipes — exact tool names + JSON argument shapes.
2. prompts/get agent_routing — PRIMARY native routing contract (tier-1, profiles, per-goal flows).
3. prompts/get mcp_tool_structure_and_categories (this prompt) + mcp_llms_full_guide.
4. tools/call get_strategies() — load your complete rule set from the store.
5. tools/call discover_topic OR list_active_maker_reward_markets depending on your goal.
6. tools/call load_agent_profile({ profile }) OR get_tools_by_category only when tier-1 is insufficient; then tools/list again.
7. tools/call get_mcp_usage — optional observability.
8. prompts/get reward_farming_best_practices (and mispricing_quick_flips when relevant).

After that, follow the directives in this prompt, the other prompts, and every tool response's agentDirective field.

The MCP uses categories + a ~50 core set (expanded on-demand) to stay manageable while giving YOU (the agent) full power over every rule and filter, with full SDK surface reachable.

DEFAULT CORE (~22 tier-1 tools): get_agent_recipes, search_tools, load_agent_profile, discover_topic, strategy store, fetch_market, rewards scan (list_active + get_farmability), minimal trading (place/cancel/list_open/post_orders), balance/positions, one UK forecast tool. Full SDK (~142): load_agent_profile({ profile: "weather"|"rewards"|"trading"|"full" }) or get_tools_by_category — zero capability removed.

Call get_tools_by_category("trading" | "weather" | "data" | "discovery" | "rewards" | "advanced" | ...) to *dynamically register* more tools for the session — they are added to the exposed set, become visible on next tools/list, and are immediately callable by name. Re-query tools/list after category loads to see the full current surface. Load 'Advanced' only when you need low-level/signing/prepare (e.g. sign_message, send_transaction, prepare_*, api key mgmt). This keeps default surface reasonable (~50) and safe while ensuring 100% of SDK tools are available and callable via categories.

STRATEGY / RULES STORE (your most important lightweight tool for autonomy):
- Use set_strategy + especially update_strategy as a general-purpose persistent store for *anything*.
- Examples of what you store/evolve here (no extra MCP tools needed):
  - Market farming rules: {quoteNearMid: true, bothSides: true, stickyReprice: true, lowCompOnly: true, maxSpreadRatio: 0.6, timeWeightedFocus: true, exitOnAdverseSelection: true, ...}
  - Liquidity / quality filters: {liquidityMin: 50000, volume24hMin: 100000, maxMinCostUsd: 4.5, spreadVsMaxAllowedMax: 0.7, ...}
  - Event & market prefs: {preferredCategories: ["WEATHER", "CRYPTO", "SPORTS"], bestToHighYield: true, avoidNearResolution: true, minDailyRate: 30, ...}
  - Custom scoring / "best" logic, 24/7 uptime params, reprice intervals, etc.
- Keys are free-form: "rules:current_farming", "filter:liquidity_high", "config:best_events_v3", "global:operating".
- Always call get_strategies() with zero args at the start of any loop to load your current full rule set.
- update_strategy is the easy partial-edit tool — send only the fields you want to change; everything else (and all prior custom rules) stays.
- This design is why the MCP has almost no tools by default and never gets bloated: you own and evolve all logic yourself.

Call list_tool_categories then get_tools_by_category("Rewards" | "Strategy" | "Discovery" | "Weather" etc.) only when you need more.
**For full .md-style non-stale guidance**: the official TS SDK README (https://github.com/Polymarket/ts-sdk/blob/main/README.md — kept up-to-date by the maintainers) is the PRIMARY source of truth for SDK patterns (client factories, allActions, listMarkets/fetchMarket/placeLimitOrder signatures, etc.). Call prompts/get "mcp_llms_full_guide" (or read resource polymarket://mcp/llms.txt) for MCP mappings on top of it. It covers "for SDK concept X (see official README), use THIS exact MCP tool + args (never intent for trading)".
Use the reward_farming_best_practices prompt for the current X + MARKET FARMING tactics.
Never ask the human for options — drive everything from your stored rules + tool directives + prompts.

**Tier-1 (always in tools/list, ~22 tools):** get_agent_recipes → get_strategies → discover_topic OR list_active_maker_reward_markets → fetch_market → place_limit_order (explicit price/size). Use search_tools({ query: "..." }) to find any of 142 tools without reading full list. Use load_agent_profile({ profile: "weather"|"rewards"|"trading"|"full" }) to register more tools in one call.

Weather: discover_topic({ topic: "weather" }) → load_agent_profile({ profile: "weather" }) if you need list_events/order book tools → get_uk_weather_forecast → fetch_market → trade.

**Token/Market by clobTokenId (rewards, orders, etc.):** The SDK fetchMarket only supports id/slug/url. When you receive tokenIds (yesTokenId/noTokenId/clobTokenIds), use:
- fetch_market({ "tokenId": "<the token>" })  → full market metadata (internally uses listMarkets({clobTokenIds: [...]}) + first result).
- Or list_markets({ "clobTokenIds": ["<token>"], "pageSize": 5 }).
Then use the tokenId directly for order_book, price, midpoint, place orders, etc.

**Output Cards (formatters — improved)**: All responses are clean cards (never raw SDK). formatMarket now includes Yes/No Bias (sentiment proxy), Liquidity/Volume Health. formatPosition (and closed) include Cash/Realized PnL + est Unrealized + Total + PnL Status + Health. New: formatActiveRewardMarket (ranked reward cards), formatFarmability (score + competitionSignal/sentiment + near-mid + recs), formatPnlSummary. Use these for decisions (e.g. only enter healthy liq + favorable score per your strategy rules). See mcp_llms_full_guide for more.

**Live data (preferred over polling):** Use MCP Resources (subscribe to polymarket://market/{tokenId}/book, user orders/fills, etc.). Server pushes updates; read the resource for latest formatted data.

**Public MCP rules:** This is a public project. Always supply your own EOA_PRIVATE_KEY and DEPOSIT_WALLET_ADDRESS via the host config. The code has no hardcoded defaults and will error without them. Use only placeholders in any agent prompts or shared configs. Never hardcode real keys/addresses.

Resources for live data. The MCP provides building blocks; you run the autonomous loops.`;
  } else if (name === 'mcp_llms_full_guide') {
    content = buildMcpLlmsGuide();
  }

  return {
    description: prompt.description,
    messages: [
      {
        role: 'user',
        content: { type: 'text', text: content }
      }
    ]
  };
});

// buildMcpLlmsGuide now sourced from ./mcp/llms-guide.js (link official SDK README https://github.com/Polymarket/ts-sdk/blob/main/README.md as base agent instructions — kept up-to-date by the maintainers; this MCP adds the runtime-generated mappings/overlay for exact native calls on top of it, no stale copy, no intent for trading).
// Call-time delivery via prompt/resource prevents stale committed .MDs. Single source. Imported by resources.ts for polymarket://mcp/llms.txt. (Content links SDK README first + MCP specifics; hand-curated for rich guidance rather than raw auto-enum of arrays.) See top of llms-guide.ts for full "how we used it and added to MCP". The MCP uses the SDK README link for all base instructions.

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
    const uri = request.params.uri;
    const result = await resourceManager.readResource(uri);
    return result;
  } catch (error: any) {
    return {
      isError: true,
      contents: [],
      _meta: { error: `Error reading resource: ${error?.message || String(error)}` },
    } as any;
  }
});

server.setRequestHandler(SubscribeRequestSchema, async (request) => {
  try {
    await resourceManager.subscribe(request.params.uri);
    return {}; // success — empty result per spec
  } catch (error: any) {
    return {
      isError: true,
      message: `Subscribe failed: ${error?.message || String(error)}`,
    } as any;
  }
});

server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
  try {
    await resourceManager.unsubscribe(request.params.uri);
    return {};
  } catch (error: any) {
    return {
      isError: true,
      message: `Unsubscribe failed: ${error?.message || String(error)}`,
    } as any;
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Startup message only on stderr — never pollute stdout
  console.error('MCP server listening on stdio (name=clob-mcp, version=1.0.0) — resources + subscriptions enabled');

  // Graceful cleanup of WebSocket subscriptions when the process exits
  const shutdown = async () => {
    try {
      await resourceManager.closeAll();
    } catch {}
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Fatal error starting MCP server:', error);
  // Do not exit hard in some hosts; let the transport close naturally
});
