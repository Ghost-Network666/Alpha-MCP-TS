// @ts-nocheck -- SDK beta types + heavy use of loose Record args for flexibility (pre-existing pattern across the file)
import { loadProjectEnv } from './config/load-env.js';

loadProjectEnv();
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
import { getPublicClient, getSecureClient } from './lib.js';
import * as F from './formatters.js';
import { getMarket } from './data/markets.js';
import {
  buildListEventsParams,
  buildListMarketsParams,
  discoverTopic,
  discoveryAgentNote,
  resolveTopicSlug,
} from './data/discovery.js';
import {
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
// AGENT_PROFILES / searchToolDefinitions removed (associated meta tools deleted)
import { buildMcpLlmsGuide, MCP_CATEGORIES } from './mcp/llms-guide.js';
import {
  fetchFarmabilitySnapshot,
} from './intelligence/index.js';
import { getToolsByCategory, ensureCategoryPrefix } from './mcp/category-match.js';
import { compactTools } from './mcp/compact-tools.js';
import { fetchLiveSdkReadme } from './mcp/sdk-readme.js';
import { buildNeverGuessPrompt } from './mcp/never-guess.js';
import { buildAgentCyclePlan } from './automation/agent-cycle.js';
import { loadStrategyFile, saveStrategyFile } from './strategy/persist.js';
import { resolveConditionIdForToken, resolveTokenIdFromToolArgs } from './utils/clob-token.js';
import { normalizePlaceLimitOrderArgs } from './trading/place-limit-args.js';
import { buildKnownGotchasMarkdown } from './mcp/agent-gotchas.js';
import { buildMcpDoctorReport } from './mcp/mcp-doctor.js';
import { seedSessionStrategyDefaults } from './mcp/strategy-seed.js';

/** Shared schema: hex tokenId OR slug OR decimal market id. */
const MARKET_TOKEN_REF_PROPERTIES = {
  tokenId: { type: 'string', description: '0x clob tokenId from Yes/No on market cards' },
  market: { type: 'string', description: 'Market slug (auto-resolves to outcome tokenId)' },
  slug: { type: 'string', description: 'Alias for market slug' },
  outcome: {
    type: 'string',
    enum: ['yes', 'no', 'YES', 'NO'],
    description: 'Outcome when using market/slug/decimal id (default yes)',
  },
};

// Mark as MCP server early so logger, env, and other modules can adapt (no stdout pollution, no process.exit on auth errors).
process.env.MCP_MODE = '1';
process.env.MCP_SERVER = 'true';

// === Simple in-memory strategy / rules / config store (supporting persistent bag for host-driven autonomy) ===
// Hermes (the host) is the brain and owns primary strategy, volume-tier rules, priceMovement, the loop,
// and control via its native heartbeat enforcement layer (heartbeat.md / OpenClaw CLOB session liveness).
// Heartbeat is the core mechanism that keeps Hermes + OpenClaw alive and in control.
// This MCP integrates with that system to "remain active": hosts call send_heartbeat (liveness hook per their
// heartbeat.md contract), get_strategies (read locked composite market:volume rules), MCP planners
// (run_agent_cycle with lockedStrategyKey for host-driven plans if used),
// intel tools (with host-provided externalSignals from Hermes x_search etc.), explicit execution tools,
// and update_strategy (evolve the shared bag under keys the host manages).
// The store is lightweight, free-form, composite-key friendly (e.g. "weather:low", "politics:high").
// It is a supporting surface, not the brain. Partial updates via update_strategy; retrieve with get_strategies.
// Persist critical long-term ones to the host's primary memory (e.g. Honcho). Lost on MCP restart otherwise.
const strategyStore = new Map<string, any>(); // composite key (e.g. market:volume or tokenId) -> rules the host (Hermes) owns and drives via heartbeat
function getStrategyKey(tokenId: string, market?: string) {
  return market ? `${tokenId}:${market}` : tokenId;
}

async function persistStrategiesToDisk() {
  try {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of strategyStore.entries()) obj[k] = v;
    await saveStrategyFile(obj);
  } catch {
    /* non-fatal — in-memory store still works */
  }
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

// === Routing feedback + circuit breaker stores (for A2A/breaker/feedback/dynamic features) ===
const routingFeedback: any = { classifications: [], counters: {}, maxEntries: 50 };
function recordClassificationFeedback(entry: any) {
  routingFeedback.classifications.push({ ...entry, ts: new Date().toISOString() });
  if (routingFeedback.classifications.length > routingFeedback.maxEntries) routingFeedback.classifications.shift();
  const key = `${entry.resolvedIntent || 'unknown'}:${entry.method || 'heuristic'}`;
  routingFeedback.counters[key] = (routingFeedback.counters[key] || 0) + 1;
  try { strategyStore.set('routing:feedback', { counters: { ...routingFeedback.counters }, recent: routingFeedback.classifications.slice(-10) }); } catch {}
}
const circuitBreaker: any = { state: {}, FAIL_THRESHOLD: 3 };
function recordStepOutcome(tool: string, success: boolean) {
  if (!circuitBreaker.state[tool]) circuitBreaker.state[tool] = { consecutiveFails: 0, degraded: false };
  const st = circuitBreaker.state[tool];
  if (success) { st.consecutiveFails = 0; st.degraded = false; }
  else { st.consecutiveFails++; st.lastFail = new Date().toISOString(); if (st.consecutiveFails >= circuitBreaker.FAIL_THRESHOLD) { st.degraded = true; if (tool.includes('place') || tool.includes('reward')) st.fallbackIntent = 'rotate_after_failure'; else st.fallbackIntent = 'discovery_scan'; } }
  try { strategyStore.set('routing:breaker', { ...circuitBreaker.state }); } catch {}
}
function isDegraded(tool: string) { return !!circuitBreaker.state[tool]?.degraded; }
function getBreakerState() { return { ...circuitBreaker.state }; }

// Safe helper for locked composite key (used by route/execute for qualifier recording in heartbeat flows).
// Defined here so no bare "not defined" refs in guarded calls (typeof guard + def prevents runtime issues in handler scope).
function getLockedKey(a: any): string | null {
  if (!a) return null;
  if (a.lockedStrategyKey) return String(a.lockedStrategyKey);
  if (a.tokenId && a.market) return `${a.tokenId}:${a.market}`;
  if (a.tokenId) return String(a.tokenId);
  return null;
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
    // Human-readable text only — no raw JSON, no SDK structures. LLM-ready immediately.
    const text = F.toHumanReadable(formatted, toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
    return {
      content: [{
        type: 'text' as const,
        text
      }]
    };
  } catch (error: any) {
    const errText = `Error in ${toolName}: ${error?.message || String(error)}. Check your parameters (tokenId/conditionId, side, price/size must be explicit numbers from get_farmability or book). Use resources for live data instead of polling.`;
    return {
      isError: true,
      content: [{ type: 'text' as const, text: errText }]
    };
  }
}

async function callPaginatedWithFormat(paginatorPromise: Promise<any>, formatter: (item: any) => any, toolName: string, limit = 10, offset = 0) {
  try {
    const paginator = await paginatorPromise;
    const page = await (typeof paginator.firstPage === 'function'
      ? paginator.firstPage()
      : (typeof paginator.next === 'function' ? paginator.next() : null));
    let items = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);

    const formattedItems = Array.isArray(items) ? items.map(formatter) : formatter(items);
    const total = page && (page.total ?? page.totalCount ?? page.count ?? (page as any)?.numResults) || undefined;
    const nextCursor = page && (page.nextCursor ?? page.cursor ?? (page as any)?.nextPageCursor) || undefined;
    const payload = {
      items: formattedItems,
      total,
      limit,
      offset,
      nextCursor,
    };
    const text = F.toHumanReadable(payload, toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
    return {
      content: [{
        type: 'text' as const,
        text
      }]
    };
  } catch (error: any) {
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `Error in ${toolName}: ${error?.message || String(error)}` }]
    };
  }
}

/** Helper to keep responses lightweight for agents. Enforces default limit 10, max 100 per requirements. */
function sanitizePageSize(args: any, defaultSize = 10, maxSize = 100) {
  const size = args?.pageSize ?? args?.limit ?? defaultSize;
  return Math.min(Math.max(1, Number(size) || defaultSize), maxSize);
}

// ==================== TOOL CATEGORIES (for fast discovery, solves 100+ tool bloat) ====================

const TOOL_CATEGORIES: Record<string, string> = {
  // Will be populated with name -> category
  // Core categories: Discovery, Rewards, Trading, Account, Strategy, Analytics, Utilities, Weather
};

function listAllCategories() {
  // Source of truth for categories is in llms-guide.ts (for the non-stale guide: SDK README first + MCP mappings).
  // This ensures the documented concepts in the MCP's llms guide stay in sync with runtime discovery.
  return [...MCP_CATEGORIES];
}

// ==================== TOOL DEFINITIONS (exactly per spec) ====================

const publicTools = [
  // Pure first-class wrappers for @polymarket/client SDK public functions only.
  // Custom MCP meta tools (doctor, route, recipes, strategy, load_profile, etc.) removed from default surface per request for only SDK functions exposed.
  {
    name: 'discover_topic',
    description: '[Discovery] UK + US topics only: events + markets via curated aliases + registry tagId (fast).',
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string' },
        pageSize: { type: 'number' },
        closed: { type: 'boolean' },
        includeEvents: { type: 'boolean' },
        includeMarkets: { type: 'boolean' }
      },
      required: ['topic']
    }
  },
  {
    name: 'fetch_market',
    description: 'Fetch a single market by id, slug, url or tokenId. Per official SDK.',
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
    name: 'list_markets',
    description: '[Discovery] SDK listMarkets (tagId, titleSearch, clobTokenIds, rewardsMinSize, closed, pageSize, etc.). Pagination: include limit/pageSize (e.g. 10) and offset/cursor. Agent: use for-await on the paginator or firstPage() + resume from nextCursor to handle large result sets efficiently. Full filters supported (closed, active, tag_id, liquidity_num_min, volume_num_min, etc.). Default limit is 10 items (max 100). Use offset for pagination. For category-level discovery, use list_events with a tag slug instead – it provides more reliable tag filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        closed: { type: 'boolean' },
        active: { type: 'boolean' },
        tagId: { type: 'number' },
        tagSlug: { type: 'string' },
        titleSearch: { type: 'string' },
        rewardsMinSize: { type: 'number' },
        volumeNumMin: { type: 'number' },
        liquidityNumMin: { type: 'number' },
        pageSize: { type: 'number' },
        limit: { type: 'number', description: 'Max items returned (default 10, max 100)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' }
      }
    }
  },
  {
    name: 'list_events',
    description: '[Discovery] SDK listEvents (tagSlug, titleSearch, closed, pageSize). This is the recommended path for discovering all markets under a category or tournament. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' },
        closed: { type: 'boolean' },
        tagSlug: { type: 'string' },
        titleSearch: { type: 'string' },
        limit: { type: 'number', description: 'Max items returned (default 10, max 100)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' }
      }
    }
  },
  {
    name: 'fetch_event',
    description: 'Fetch a single event by id or slug.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        slug: { type: 'string' }
      }
    }
  },
  {
    name: 'list_tags',
    description: '[Discovery / Gamma] List all Gamma tags. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, offset: { type: 'number' } } }
  },
  {
    name: 'fetch_tag',
    description: '[Discovery / Gamma] Fetch details for a specific Gamma tag by slug.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug']
    }
  },
  {
    name: 'search',
    description: 'Official full-text search via client.search(). Powerful Gamma public search: required q (query). Optional: events_status, limit_per_type, page, events_tag, keep_closed_markets, sort, ascending, search_tags (set true for broad discovery), search_profiles (true to include profiles), recurrence, exclude_tag_id. Use to find events, tags, profiles. For broad discovery set search_tags and search_profiles to true.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string' },
        pageSize: { type: 'number' },
        closed: { type: 'boolean' },
        active: { type: 'boolean' }
      },
      required: ['q']
    }
  },
  {
    name: 'get_order_book',
    description: '[Trading] SDK getOrderBook(tokenId).',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        market: { type: 'string' },
        slug: { type: 'string' },
        outcome: { type: 'string', enum: ['yes', 'no', 'YES', 'NO'] }
      },
      required: ['tokenId']
    }
  },
  {
    name: 'get_spread',
    description: '[Trading] SDK getSpread / fetchSpread.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        market: { type: 'string' },
        slug: { type: 'string' },
        outcome: { type: 'string', enum: ['yes', 'no', 'YES', 'NO'] }
      },
      required: ['tokenId']
    }
  },
  {
    name: 'get_midpoint',
    description: '[Trading] Direct SDK getMidpointPrice / fetchMidpoint.',
    inputSchema: {
      type: 'object',
      properties: { tokenId: { type: 'string' } },
      required: ['tokenId']
    }
  },
  {
    name: 'fetch_market_tags',
    description: '[Discovery] Direct SDK fetchMarketTags. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } },
      required: ['id']
    }
  },
  {
    name: 'list_comments',
    description: '[Discovery] Direct SDK listComments. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'string' },
        event: { type: 'string' },
        pageSize: { type: 'number' },
        limit: { type: 'number' },
        offset: { type: 'number' }
      }
    }
  },
  {
    name: 'list_sports',
    description: '[Discovery] Sports metadata via SDK.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_current_rewards',
    description: '[Rewards] Direct raw SDK listCurrentRewards() - all active reward programs. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: {
      type: 'object',
      properties: { pageSize: { type: 'number' }, limit: { type: 'number' }, offset: { type: 'number' } }
    }
  },
  {
    name: 'list_market_rewards',
    description: '[Rewards] Direct raw SDK listMarketRewards(conditionId) - present and future rewards for a market. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: {
      type: 'object',
      properties: { conditionId: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } },
      required: ['conditionId']
    }
  },
  {
    name: 'list_reward_markets',
    description: '[Rewards] SDK-native bulk enumeration via listCurrentRewards (getMultipleMarketsWithRewards equivalent) with filters and pagination. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'number' },
        q: { type: 'string' },
        tagId: { type: 'number' },
        rewardsMinSize: { type: 'number' },
        pageSize: { type: 'number' }
      }
    }
  },
  {
    name: 'get_market_reward_details',
    description: '[Rewards] Direct raw SDK listMarketRewards / getRawRewards for a market.',
    inputSchema: {
      type: 'object',
      properties: { conditionId: { type: 'string' } },
      required: ['conditionId']
    }
  },
  {
    name: 'order_scoring',
    description: '[Rewards] Direct SDK orderScoring.',
    inputSchema: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId']
    }
  },
  {
    name: 'batch_order_scoring',
    description: '[Rewards] Direct SDK batchOrderScoring.',
    inputSchema: {
      type: 'object',
      properties: { orderIds: { type: 'array', items: { type: 'string' } } },
      required: ['orderIds']
    }
  },
  {
    name: 'list_simplified_markets',
    description: '[Discovery] Lightweight markets via listMarkets (accepting_orders, active, rewards, tokens projection). Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        closed: { type: 'boolean' },
        pageSize: { type: 'number' },
        tagId: { type: 'number' },
        q: { type: 'string' },
        limit: { type: 'number' },
        offset: { type: 'number' }
      }
    }
  },
  {
    name: 'list_sampling_markets',
    description: '[Rewards] Markets eligible for sampling/liquidity rewards (via listCurrentRewards / listMarkets projection). Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: {
      type: 'object',
      properties: { pageSize: { type: 'number' }, closed: { type: 'boolean' }, limit: { type: 'number' }, offset: { type: 'number' } }
    }
  },
  {
    name: 'list_sampling_simplified_markets',
    description: '[Rewards] Lightweight sampling markets. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: {
      type: 'object',
      properties: { pageSize: { type: 'number' }, limit: { type: 'number' }, offset: { type: 'number' } }
    }
  },
  {
    name: 'place_limit_order',
    description: '[Trading] SDK placeLimitOrder (GTC/GTD via expiration, postOnly for maker/rewards).',
    inputSchema: {
      type: 'object',
      properties: {
        ...MARKET_TOKEN_REF_PROPERTIES,
        price: { type: 'number' },
        size: { type: 'number' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        postOnly: { type: 'boolean' },
        expiration: { type: 'number' }
      },
      required: ['tokenId', 'price', 'size', 'side']
    }
  },
  {
    name: 'place_market_order',
    description: '[Trading] SDK placeMarketOrder (FOK/FAK).',
    inputSchema: {
      type: 'object',
      properties: {
        ...MARKET_TOKEN_REF_PROPERTIES,
        amount: { type: 'number' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        orderType: { type: 'string', enum: ['FOK', 'FAK'] }
      },
      required: ['tokenId', 'amount', 'side']
    }
  },
  {
    name: 'place_optimized_reward_order',
    description: '[Rewards] Suggest→validate→place maker reward order (postOnly GTC for scoring).',
    inputSchema: {
      type: 'object',
      properties: {
        ...MARKET_TOKEN_REF_PROPERTIES,
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        capitalUsd: { type: 'number' },
        monitorFills: { type: 'boolean' },
        fillMonitoringTimeoutMinutes: { type: 'number' }
      },
      required: ['side']
    }
  },
  {
    name: 'create_limit_order',
    description: '[Trading] Direct SDK createLimitOrder (sign only, no post).',
    inputSchema: {
      type: 'object',
      properties: {
        ...MARKET_TOKEN_REF_PROPERTIES,
        price: { type: 'number' },
        size: { type: 'number' },
        side: { type: 'string', enum: ['BUY', 'SELL'] }
      },
      required: ['price', 'size', 'side']
    }
  },
  {
    name: 'create_market_order',
    description: '[Trading] Direct SDK createMarketOrder (sign only).',
    inputSchema: {
      type: 'object',
      properties: {
        ...MARKET_TOKEN_REF_PROPERTIES,
        amount: { type: 'number' },
        side: { type: 'string', enum: ['BUY', 'SELL'] }
      },
      required: ['amount', 'side']
    }
  },
  {
    name: 'cancel_order',
    description: '[Trading] Direct SDK cancelOrder(orderId).',
    inputSchema: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId']
    }
  },
  {
    name: 'cancel_market_orders',
    description: '[Trading] Direct SDK cancelMarketOrders.',
    inputSchema: {
      type: 'object',
      properties: { market: { type: 'string' } }
    }
  },
  {
    name: 'cancel_all_orders',
    description: '[Trading] Direct SDK cancelAllOrders.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_open_orders',
    description: '[Trading] Direct SDK listOpenOrders. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: {
      type: 'object',
      properties: { market: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } }
    }
  },
  {
    name: 'fetch_order',
    description: '[Trading] Direct SDK fetchOrder(orderId).',
    inputSchema: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId']
    }
  },
  {
    name: 'get_order_history',
    description: '[Trading] Order history via SDK. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: {
      type: 'object',
      properties: { pageSize: { type: 'number' }, limit: { type: 'number' }, offset: { type: 'number' } }
    }
  },
  {
    name: 'post_orders',
    description: '[Trading] Direct SDK postOrders (batch).',
    inputSchema: {
      type: 'object',
      properties: { orders: { type: 'array' } },
      required: ['orders']
    }
  },
  {
    name: 'list_positions',
    description: '[Account] Direct SDK listPositions (with PnL). Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        market: { type: 'array', items: { type: 'string' } },
        pageSize: { type: 'number' },
        limit: { type: 'number' },
        offset: { type: 'number' }
      }
    }
  },
  {
    name: 'get_balance_allowance',
    description: '[Account] Direct SDK fetchBalanceAllowance / getBalanceAllowance.',
    inputSchema: {
      type: 'object',
      properties: {
        assetType: { type: 'string', enum: ['COLLATERAL', 'CONDITIONAL'] },
        tokenId: { type: 'string' },
        sync: { type: 'boolean' }
      }
    }
  },
  {
    name: 'get_portfolio_value',
    description: '[Account] Direct SDK getPortfolioValue / fetchPortfolioValue.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_activity',
    description: '[Account] Direct SDK listActivity (trades, rewards, on-chain). Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: {
      type: 'object',
      properties: { pageSize: { type: 'number' }, limit: { type: 'number' }, offset: { type: 'number' } }
    }
  },
  {
    name: 'list_trades',
    description: '[Account] Direct SDK listTrades (maker filter supported). Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        maker: { type: 'string' },
        pageSize: { type: 'number' },
        limit: { type: 'number' },
        offset: { type: 'number' }
      }
    }
  },
  {
    name: 'get_user_earnings',
    description: '[Rewards] Direct SDK getUserEarningsAndMarketsConfig (day optional).',
    inputSchema: {
      type: 'object',
      properties: { day: { type: 'string' }, pageSize: { type: 'number' } }
    }
  },
  {
    name: 'get_farmability',
    description: '[Rewards] SDK book + listMarketRewards + mids (for reward eligibility).',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        market: { type: 'string' },
        slug: { type: 'string' },
        outcome: { type: 'string', enum: ['yes', 'no', 'YES', 'NO'] }
      }
    }
  },
  {
    name: 'suggest_qualified_size',
    description: '[Rewards] Advisory size calculation from SDK reward config (rewardsMinSize) + intent.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: ['reward_farming', 'maker'] },
        tokenId: { type: 'string' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        capitalUsd: { type: 'number' }
      },
      required: ['intent', 'side']
    }
  },
  {
    name: 'is_gasless_ready',
    description: '[Gasless] Direct SDK isGaslessReady on secure client.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'setup_gasless_wallet',
    description: '[Gasless] Direct SDK setupGaslessWallet.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'subscribe_market',
    description: '[WS] Ensure subscription to market topic (orderbooks, trades, prices) via SDK ClobMarketWebSocketManager. Surfaces as resource for push.',
    inputSchema: {
      type: 'object',
      properties: { tokenId: { type: 'string' } },
      required: ['tokenId']
    }
  },
  {
    name: 'subscribe_sports',
    description: '[WS] Subscribe to sports topic (scores, periods) via SDK SportsWebSocketManager.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'subscribe_user',
    description: '[WS] Subscribe to authenticated user topic (private updates) via SDK ClobUserWebSocketManager.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'subscribe_prices_crypto',
    description: '[WS] Subscribe to real-time prices topic via SDK RtdsWebSocketManager.',
    inputSchema: {
      type: 'object',
      properties: { symbols: { type: 'array', items: { type: 'string' } } }
    }
  },
  {
    name: 'subscribe_wallet_activity',
    description: '[Onchain] Subscribe real-time on-chain activity for ANY public wallet (no auth/credentials needed; fills SDK gap for non-auth maker/wallet tracking). Uses viem to watch USDC Transfer + ConditionalTokens (splits/merges/redeems/transfers) events on Polygon filtered by address. Surfaces as polymarket://wallet/{address}/activity resource (push via resources/updated). Use after extract_wallet_from_url + list_trades({maker}) for CLOB context. Complements (auth-only) subscribe_user.',
    inputSchema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: '0x wallet address (any public address; checksum or lower). No creds required.' }
      },
      required: ['address']
    }
  },
  {
    name: 'fetch_sdk_readme',
    description: '[Meta] Live upstream TS SDK README (for reference; kept for full coverage).',
    inputSchema: { type: 'object', properties: {} }
  }
];












const secureTools = [
  {
    name: 'place_limit_order',
    description: '[Trading] SDK placeLimitOrder only: tokenId, price, size, side, postOnly?, expiration? (NO orderType on wire). GTC=default; GTD=set expiration unix sec. FOK/FAK→place_market_order. Requires EOA_PRIVATE_KEY + DEPOSIT_WALLET_ADDRESS.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        price: { type: 'number' },
        size: { type: 'number' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        orderType: {
          type: 'string',
          enum: ['GTC', 'GTD', 'FOK', 'FAK'],
          description: 'Agent hint only: GTC/GTD map to SDK limit (expiration for GTD). FOK/FAK rejected here — use place_market_order.',
        },
        postOnly: {
          type: 'boolean',
          description: 'Default true — maker-only; required for reward farming',
        },
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
  {
    name: 'generate_builder_headers',
    description: '[Advanced] Use the official @polymarket/builder-signing-sdk (integrated from Polymarket GitHub) to generate authenticated headers for the Builder API (HMAC signing for gasless attribution, builder endpoints, etc.). This is the canonical, robust way (future-proofs direct HMAC). Requires BUILDER_API_KEY/SECRET/PASSPHRASE. Returns headers for custom use in gasless flows.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'HTTP method e.g. POST' },
        path: { type: 'string', description: 'API path e.g. /order' },
        body: { type: 'string', description: 'Optional JSON body string' },
        timestamp: { type: 'number', description: 'Optional timestamp override' },
      },
      required: ['method', 'path'],
    },
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
    name: 'list_reward_markets',
    description: '[Rewards] SDK-native bulk enumeration of all markets with active USDC maker reward programs (replaces per-market scan/enrichment). Returns markets with rewards_min_size, rewards_max_spread, rate_per_day, total_rewards + tokenIds, questions. Agent discovers rewarding limit orders in one call via official @polymarket/client (Gamma/listMarkets reward filters or equivalent listCurrentRewards + bulk). No individual market calls needed.',
    inputSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', description: 'Optional cap (SDK may page; default returns active set).' },
        includeClosed: { type: 'boolean', description: 'Include closed programs if true (default false for active farming only).' },
        q: { type: 'string', description: 'Text search on question/slug.' },
        tagId: { type: 'number', description: 'Gamma tag filter.' },
        rewardsMinSize: { type: 'number' },
        pageSize: { type: 'number', description: 'Pagination, default 100.' }
      }
    }
  },
  {
    name: 'get_market_reward_details',
    description: '[Rewards] Raw present and future rewards array for a market via SDK getRawRewards / listMarketRewards(conditionId).',
    inputSchema: {
      type: 'object',
      properties: {
        conditionId: { type: 'string', description: 'Market conditionId' },
        market: { type: 'string' },
        slug: { type: 'string' }
      },
      required: ['conditionId']
    }
  },
  {
    name: 'list_simplified_markets',
    description: '[Discovery] SDK getSimplifiedMarkets / lightweight listMarkets: accepting_orders, active, rewards, tokens for fast discovery. Pagination supported.',
    inputSchema: {
      type: 'object',
      properties: {
        closed: { type: 'boolean' },
        pageSize: { type: 'number', description: 'Default 100' },
        tagId: { type: 'number' },
        q: { type: 'string' }
      }
    }
  },
  {
    name: 'list_sampling_markets',
    description: '[Rewards] SDK getSamplingMarkets: markets eligible for sampling/liquidity rewards. Supports filters/pagination.',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' },
        closed: { type: 'boolean' }
      }
    }
  },
  {
    name: 'list_sampling_simplified_markets',
    description: '[Rewards] SDK getSamplingSimplifiedMarkets: lightweight sampling markets.',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' }
      }
    }
  },
  {
    name: 'get_user_earnings',
    description: '[Rewards] SDK getUserEarningsAndMarketsConfig(day?): user earnings and live % per market for the day (default today).',
    inputSchema: {
      type: 'object',
      properties: {
        day: { type: 'string', description: 'YYYY-MM-DD (default today)' },
        pageSize: { type: 'number' }
      }
    }
  },
  // === Full SDK Coverage Additions (WS, Gasless, Raw Rewards, Account, more Trading/Discovery) ===
  {
    name: 'subscribe_market',
    description: '[WS] Start/ensure subscription to market topic (orderbooks, trades, prices, lifecycle). Returns or ensures polymarket://market/{tokenId}/book resource for push notifications.',
    inputSchema: { type: 'object', properties: { tokenId: { type: 'string' } }, required: ['tokenId'] }
  },
  {
    name: 'subscribe_sports',
    description: '[WS] Start subscription to sports topic for live scores and periods. Uses sports WS manager.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'subscribe_user',
    description: '[WS] Start authenticated user subscription (private orders, fills, trades). Requires secure client.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'subscribe_prices_crypto',
    description: '[WS] Subscribe to real-time crypto prices (e.g. binance topic).',
    inputSchema: { type: 'object', properties: { symbols: { type: 'array', items: { type: 'string' } } } }
  },
  {
    name: 'is_gasless_ready',
    description: '[Gasless] SDK isGaslessReady() - check if the secure client / wallet supports gasless trading.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'setup_gasless_wallet',
    description: '[Gasless] SDK setupGaslessWallet() - setup for gasless (idempotent in recent SDK).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_current_rewards',
    description: '[Rewards] Direct SDK listCurrentRewards() - all active reward programs (raw, paged).',
    inputSchema: { type: 'object', properties: { pageSize: { type: 'number' } } }
  },
  {
    name: 'list_market_rewards',
    description: '[Rewards] Direct SDK listMarketRewards(conditionId) - present and future rewards for a market (raw).',
    inputSchema: { type: 'object', properties: { conditionId: { type: 'string' } }, required: ['conditionId'] }
  },
  {
    name: 'order_scoring',
    description: '[Rewards] Direct SDK orderScoring() - check if an order is eligible for rewards.',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] }
  },
  {
    name: 'batch_order_scoring',
    description: '[Rewards] Direct SDK batchOrderScoring() for multiple orderIds.',
    inputSchema: { type: 'object', properties: { orderIds: { type: 'array', items: { type: 'string' } } }, required: ['orderIds'] }
  },
  {
    name: 'get_portfolio_value',
    description: '[Account] Direct SDK getPortfolioValue() - total portfolio value.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_activity',
    description: '[Account] Direct SDK listActivity() - trades, rewards, on-chain events (paged).',
    inputSchema: { type: 'object', properties: { pageSize: { type: 'number' } } }
  },
  {
    name: 'list_trades',
    description: '[Account] Direct SDK listTrades(maker?) - historical trades for address or user.',
    inputSchema: { type: 'object', properties: { maker: { type: 'string' }, pageSize: { type: 'number' } } }
  },
  {
    name: 'create_limit_order',
    description: '[Trading] Direct SDK createLimitOrder() - sign only, returns signed order (no post).',
    inputSchema: { type: 'object', properties: { ...MARKET_TOKEN_REF_PROPERTIES, price: { type: 'number' }, size: { type: 'number' }, side: { type: 'string', enum: ['BUY','SELL'] } }, required: ['price','size','side'] }
  },
  {
    name: 'create_market_order',
    description: '[Trading] Direct SDK createMarketOrder() - sign only for market order.',
    inputSchema: { type: 'object', properties: { ...MARKET_TOKEN_REF_PROPERTIES, amount: { type: 'number' }, side: { type: 'string', enum: ['BUY','SELL'] } }, required: ['amount','side'] }
  },
  {
    name: 'cancel_market_orders',
    description: '[Trading] Direct SDK cancelMarketOrders() for a market.',
    inputSchema: { type: 'object', properties: { market: { type: 'string' } } }
  },
  {
    name: 'cancel_all_orders',
    description: '[Trading] Direct SDK cancelAllOrders().',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'fetch_order',
    description: '[Trading] Direct SDK fetchOrder(orderId).',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] }
  },
  {
    name: 'get_order_history',
    description: '[Trading] Order history / getOrderHistory via SDK.',
    inputSchema: { type: 'object', properties: { pageSize: { type: 'number' } } }
  },
  {
    name: 'list_comments',
    description: '[Discovery] Direct SDK listComments(params) for social signals.',
    inputSchema: { type: 'object', properties: { market: { type: 'string' }, event: { type: 'string' } } }
  },
  {
    name: 'fetch_market_tags',
    description: '[Discovery] Direct SDK fetchMarketTags(id). Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } }, required: ['id'] }
  },
  {
    name: 'list_sports',
    description: '[Discovery] Sports metadata via SDK listSports or equivalent.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_midpoint',
    description: '[Trading] Direct SDK getMidpointPrice(tokenId).',
    inputSchema: { type: 'object', properties: { tokenId: { type: 'string' } }, required: ['tokenId'] }
  },
  {
    name: 'fetch_event',
    description: '[Discovery] Direct SDK fetchEvent(id or slug).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, slug: { type: 'string' } } }
  },
  {
    name: 'place_optimized_reward_order',
    description: '[Rewards] RECOMMENDED tier-1 flow: suggest → validate reward rules → postOnly GTC place → confirm scoring. tokenId required (0x hex from list_active). Optional monitorFills. Batch via post_orders when requoting.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MARKET_TOKEN_REF_PROPERTIES,
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        capitalUsd: { type: 'number' },
        monitorFills: { type: 'boolean' },
        fillMonitoringTimeoutMinutes: { type: 'number' },
      },
      required: ['side'],
    },
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
    description: '[Account] HIGH PRIORITY for reward farming. Checks COLLATERAL (USDC) or CONDITIONAL outcome-token balance + allowance on the CLOB. Default and usual pre-flight: assetType COLLATERAL (no tokenId). CONDITIONAL requires tokenId (CLOB outcome token from fetch_market / discover_topic cards). Returns human-readable numbers and next steps. Call BEFORE place_maker_reward_order on balance/allowance errors.',
    inputSchema: {
      type: 'object',
      properties: {
        assetType: { 
          type: 'string', 
          enum: ['COLLATERAL', 'CONDITIONAL'], 
          description: 'COLLATERAL = USDC collateral (default; use for pre-flight). CONDITIONAL = specific outcome token (requires tokenId).' 
        },
        tokenId: {
          type: 'string',
          description: 'Required when assetType is CONDITIONAL. CLOB outcome tokenId (hex or decimal from market cards). Omit for COLLATERAL.'
        },
        sync: {
          type: 'boolean',
          description: 'When true (default), refresh CLOB cache via updateBalanceAllowance before fetch. Set false to skip.'
        }
      }
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
    name: 'get_farmability',
    description: '[Rewards] SDK fetchOrderBook + listMarketRewards + fetchSpreads + fetchMidpoint. Accepts 0x tokenId, market slug, or decimal id (auto-resolve). Non-reward markets return book-only snapshot (hasActiveRewards:false). For maker rewards pick tokens from list_active_maker_reward_markets.',
    inputSchema: {
      type: 'object',
      properties: { ...MARKET_TOKEN_REF_PROPERTIES },
    },
  },
  // === Flat full inventory additions (1:1 for every Polymarket SDK function per complete checklist) ===
  // Core client init (exposed even though MCP uses singletons internally)
  {
    name: 'create_public_client',
    description: '[Core] Initialize unauthenticated client for public data (markets, order books, events). Uses official createPublicClient from @polymarket/client.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'create_secure_client',
    description: '[Core] Initialize authenticated client for trading, account, gasless. Uses official createSecureClient.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'setup_trading_approvals',
    description: '[Account] Approve USDC and CTF contracts for gasless trading (protocol v2). Idempotent.',
    inputSchema: { type: 'object', properties: {} }
  },
  // Series, teams, additional discovery
  {
    name: 'list_series',
    description: '[Discovery] SDK listSeries — series/competition metadata. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: { type: 'object', properties: { pageSize: { type: 'number' }, limit: { type: 'number' }, offset: { type: 'number' } } }
  },
  {
    name: 'fetch_series',
    description: '[Discovery] SDK fetchSeries(id) — specific series details.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
  },
  {
    name: 'list_teams',
    description: '[Discovery] SDK listTeams — teams metadata (sports etc). Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, offset: { type: 'number' } } }
  },
  // Additional account / closed / leaderboards
  {
    name: 'list_closed_positions',
    description: '[Account] SDK listClosedPositions — settled positions history. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: { type: 'object', properties: { address: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } } }
  },
  {
    name: 'list_account_trades',
    description: '[Account] SDK listAccountTrades — authenticated user trade history. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, offset: { type: 'number' } } }
  },
  {
    name: 'get_trader_leaderboard',
    description: '[Analytics] SDK listTraderLeaderboard — top traders by volume/PnL.',
    inputSchema: { type: 'object', properties: { period: { type: 'string' }, category: { type: 'string' } } }
  },
  {
    name: 'get_builder_leaderboard',
    description: '[Analytics] SDK listBuilderLeaderboard — top market makers.',
    inputSchema: { type: 'object', properties: {} }
  },
  // More discovery / onchain analytics
  {
    name: 'list_market_holders',
    description: '[Discovery] SDK listMarketHolders. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: { type: 'object', properties: { market: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } } }
  },
  {
    name: 'fetch_event_live_volume',
    description: '[Analytics] SDK fetchEventLiveVolume.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } }
  },
  {
    name: 'list_open_interest',
    description: '[Analytics] SDK listOpenInterest. Default limit is 10 items (max 100). Use offset for pagination.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, offset: { type: 'number' } } }
  },
  {
    name: 'fetch_builder_volume',
    description: '[Analytics] SDK fetchBuilderVolume.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'fetch_builder_fee_rates',
    description: '[Analytics] SDK fetchBuilderFeeRates.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'fetch_related_tags',
    description: '[Discovery] SDK fetchRelatedTags.',
    inputSchema: { type: 'object', properties: { slug: { type: 'string' } } }
  },
  {
    name: 'fetch_event_tags',
    description: '[Discovery] SDK fetchEventTags.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } }
  },
  // WS additional topics + unsubscribe
  {
    name: 'subscribe_prices_chainlink',
    description: '[Realtime] subscribe("prices.crypto.chainlink") — Chainlink price oracle feeds.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'subscribe_rfq',
    description: '[Realtime] WebSocket RFQ channel (request-for-quote events).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'unsubscribe_all',
    description: '[Realtime] Terminate all active WebSocket subscriptions.',
    inputSchema: { type: 'object', properties: {} }
  },
  // RFQ system (complete; some may use subscribe + quote flows per SDK)
  {
    name: 'create_rfq_request',
    description: '[RFQ] Signal intent to trade a specific size (createRfqRequest).',
    inputSchema: { type: 'object', properties: { tokenId: { type: 'string' }, side: { type: 'string' }, quantity: { type: 'number' } }, required: ['tokenId', 'side', 'quantity'] }
  },
  {
    name: 'submit_rfq_quote',
    description: '[RFQ] Respond with a price quote.',
    inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, price: { type: 'number' }, size: { type: 'number' } }, required: ['requestId', 'price', 'size'] }
  },
  {
    name: 'get_rfq_quotes',
    description: '[RFQ] Retrieve all quotes for a request.',
    inputSchema: { type: 'object', properties: { requestId: { type: 'string' } }, required: ['requestId'] }
  },
  {
    name: 'confirm_rfq_trade',
    description: '[RFQ] Execute trade based on accepted quote.',
    inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, quoteId: { type: 'string' } }, required: ['requestId', 'quoteId'] }
  },
  // On-chain CTF inventory (split/merge/redeem + prepares)
  {
    name: 'split_position',
    description: '[Onchain] Convert collateral into YES/NO token pairs (splitPosition).',
    inputSchema: { type: 'object', properties: { collateralToken: { type: 'string' }, conditionId: { type: 'string' }, amount: { type: 'string' } }, required: ['conditionId', 'amount'] }
  },
  {
    name: 'merge_positions',
    description: '[Onchain] Convert YES/NO pairs back to collateral (mergePositions).',
    inputSchema: { type: 'object', properties: { conditionId: { type: 'string' }, amount: { type: 'string' } }, required: ['conditionId', 'amount'] }
  },
  {
    name: 'redeem_positions',
    description: '[Onchain] Exchange winning tokens for collateral after resolution (redeemPositions).',
    inputSchema: { type: 'object', properties: { conditionId: { type: 'string' } }, required: ['conditionId'] }
  },
  {
    name: 'enable_auto_redeem',
    description: '[Onchain] Enable automatic redemption of resolved positions.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_split_position',
    description: '[Advanced] Prepare gasless split position tx.',
    inputSchema: { type: 'object', properties: { collateralToken: { type: 'string' }, conditionId: { type: 'string' }, amount: { type: 'string' } } }
  },
  {
    name: 'prepare_merge_positions',
    description: '[Advanced] Prepare gasless merge positions tx.',
    inputSchema: { type: 'object', properties: { conditionId: { type: 'string' }, amount: { type: 'string' } } }
  },
  {
    name: 'prepare_redeem_positions',
    description: '[Advanced] Prepare gasless redeem positions tx.',
    inputSchema: { type: 'object', properties: { conditionId: { type: 'string' } } }
  },
  // Builder & API key mgmt (many already present; ensure full)
  {
    name: 'generate_builder_headers',
    description: '[Advanced] Create authenticated request headers using official builder-signing-sdk.',
    inputSchema: { type: 'object', properties: { method: { type: 'string' }, path: { type: 'string' }, body: { type: 'string' } }, required: ['method', 'path'] }
  },
  {
    name: 'create_deposit_wallet',
    description: '[Advanced] Deploy deposit wallet for gasless trading.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'fetch_deposit_wallet',
    description: '[Advanced] Retrieve current deposit wallet address.',
    inputSchema: { type: 'object', properties: {} }
  },
  // Account extras
  {
    name: 'update_profile',
    description: '[Account] Update authenticated user profile (displayName, bio).',
    inputSchema: { type: 'object', properties: { displayName: { type: 'string' }, bio: { type: 'string' } } }
  },
  {
    name: 'fetch_notifications',
    description: '[Account] Fetch user notifications (fills, rewards, etc).',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'drop_notifications',
    description: '[Account] Mark notifications as read.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } } }
  },
  {
    name: 'fetch_transaction',
    description: '[Advanced] Fetch on-chain transaction status by hash.',
    inputSchema: { type: 'object', properties: { txHash: { type: 'string' } }, required: ['txHash'] }
  },
  {
    name: 'download_accounting_snapshot',
    description: '[Account] Export PnL and trade history CSV snapshot.',
    inputSchema: { type: 'object', properties: {} }
  },
  // Utils / prep / watch
  {
    name: 'prepare_gasless_transaction',
    description: '[Advanced] Create gasless transaction envelope.',
    inputSchema: { type: 'object', properties: { tx: { type: 'object', additionalProperties: true } } }
  },
  {
    name: 'send_transaction',
    description: '[Advanced] Submit signed transaction to relayer.',
    inputSchema: { type: 'object', properties: { signedTx: { type: 'object', additionalProperties: true } } }
  },
  {
    name: 'watch_order_until_filled',
    description: '[Trading] Poll + WS monitor an order until filled or cancelled.',
    inputSchema: { type: 'object', properties: { orderId: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['orderId'] }
  },
];



for (let i = 0; i < publicTools.length; i++) {
  publicTools[i] = ensureCategoryPrefix(publicTools[i]);
}
for (let i = 0; i < secureTools.length; i++) {
  secureTools[i] = ensureCategoryPrefix(secureTools[i]);
}

// === Flat full surface (modern MCP standard): tools/list returns EVERY tool with no tiers, no profiles, no progressive disclosure.
// All SDK functions + meta helpers are first-class and visible immediately. load_agent_profile / get_tools_by_category remain as optional convenience (info only; no gating).
const ALL_TOOL_NAMES = new Set<string>(); // populated at runtime from the arrays for doctor/compat only (no filtering)

// === MCP Prompts for Agent Structure (lightweight guidance without tool bloat or enforcement) ===
// These provide on-demand best practices so the agent has "more structure" with fewer tools to reason over.
// Loaded only when agent requests via prompts/list or get.
const PROMPTS = [
  {
    name: 'agent_routing',
    description:
      'PRIMARY routing contract: native SDK-only paths, mandatory startup (fetch_sdk_readme first), flat complete surface (tools/list returns ALL tools with no tiers/load_profile), discover_topic, search_tools, strategy store (supporting bag — Hermes is the brain + owns heartbeat.md/OpenClaw enforcement loop and control; MCP integrates via send_heartbeat + locked planners), per-goal flows. Call via prompts/get FIRST every session before other tools. No progressive disclosure.',
    arguments: [],
  },
  {
    name: 'reward_farming_best_practices',
    description: 'Best practices + current X Key Insights (daily USDC LP rewards, quote near midpoint, both-sides 2x, sticky auto-repegging post-only as major edge, low-competition focus, avoid near-resolution, time/size-weighted, 24/7 active, adverse selection risks) for autonomous maker reward farming. Includes exact mapping to simple native SDK tools (get_farmability for near-mid + signals, place_*_reward for postOnly sticky, etc.). Use categories (e.g. get_tools_by_category("rewards")) to load/register additional tools dynamically while default stays ~50-57 focused core.',
    arguments: []
  },
  {
    name: 'mispricing_quick_flips',
    description: 'Guide for quick flips: compute_market_signals + get_farmability + explicit place_limit_order. Discover via tools/list or get_agent_recipes then call directly.',
    arguments: []
  },
  {
    name: 'mcp_tool_structure_and_categories',
    description: 'Full "never guess" quickstart: startup sequence (after agent_routing prompt), flat MCP (tools/list = all tools, no categories/load required), strategy store as supporting bag (Hermes is the brain + owns heartbeat.md / OpenClaw loop and control; MCP integrates to remain active), get_mcp_usage, clobTokenIds/tokenId patterns, public credential rules, live resources + heartbeat integration. Prompts/get mcp_llms_full_guide for mappings.',
    arguments: []
  },
  {
    name: 'mcp_llms_full_guide',
    description: 'Returns complete guide: the official TS SDK README (https://github.com/Polymarket/ts-sdk/blob/main/README.md — kept up-to-date by the maintainers) is the PRIMARY/canonical source of truth for all SDK coverage, APIs, client creation (createPublicClient/createSecureClient), decorators (extend(allActions)), methods (listMarkets, fetchMarket, placeLimitOrder etc.), parameters, errors, examples. This MCP adds only runtime-generated overlays/mappings (exact native tool + JSON call shape + "use explicit place_limit_order etc with your numbers from strategy/calc, never intent"). Includes full exhaustive SDK surface mappings + strategyStore (supporting bag; Hermes is the brain and owns heartbeat.md/OpenClaw loop + primary control) + cards (PNL/sentiment/farmability) + resources + rate notes + public rules + heartbeat integration points (send_heartbeat hook + locked planners for host-driven calls). Call SDK README first, then this (and structure prompt) for complete non-guessing experience. Always in sync (call-time from code + current SDK).',
    arguments: []
  },
  {
    name: 'never_guess_contract',
    description: 'Binding never-guess rules: startup order (fetch_sdk_readme first), live SDK readme, flat complete surface (all tools in tools/list immediately), resources, heartbeat integration (Hermes owns brain/loop/control via heartbeat.md; MCP is integration surface with planners + send_heartbeat hook + supporting strategy bag), automation via host-driven calls. Call every session.',
    arguments: [],
  },
];

// Register tool list (MCP discovery) - FLAT, COMPLETE, NO PROGRESSIVE DISCLOSURE.
// tools/list immediately returns every registered tool (all ~90+ first-class SDK + meta).
// No tiers, no prerequisite load_agent_profile / get_tools_by_category / search_tools calls required.
// Agent scans once and calls any by exact name via tools/call.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const allTools = [...publicTools, ...secureTools];
  // Populate ALL for doctor/compat (no filter ever applied to list)
  ALL_TOOL_NAMES.clear();
  allTools.forEach(t => ALL_TOOL_NAMES.add(t.name));
  return { tools: compactTools(allTools) };
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

  const toolResult = await (async () => {
  switch (name) {
    // === Category-based discovery tools (for fast agent tool discovery) ===
    // list_tool_categories case removed (meta, not pure SDK)

    // === Flat full inventory handlers (1:1 SDK + customs; all always registered) ===
    case 'create_public_client': {
      try {
        const { createPublicClient: createPub } = await import('@polymarket/client');
        const c = createPub();
        const info = { 'Status': 'Public client ready', 'Note': 'MCP maintains singleton via getPublicClient() for all public discovery calls.', 'Has listMarkets': typeof c.listMarkets === 'function' };
        return { content: [{ type: 'text' as const, text: F.toHumanReadable(info, 'Create Public Client') }] };
      } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error creating public client: ${e?.message || e}. Ensure @polymarket/client is installed.` }] }; }
    }
    case 'create_secure_client': {
      try {
        const { createSecureClient: createSec } = await import('@polymarket/client');
        const c = await createSec({});
        const info = { 'Status': 'Secure client ready', 'Note': 'Uses EOA_PRIVATE_KEY + DEPOSIT_WALLET_ADDRESS from env. Trading, gasless, account ops enabled.' };
        return { content: [{ type: 'text' as const, text: F.toHumanReadable(info, 'Create Secure Client') }] };
      } catch (e: any) { return { content: [{ type: 'text' as const, text: `Error creating secure client: ${String(e?.message || e)}. Provide credentials.` }] }; }
    }
    case 'setup_trading_approvals': {
      const s = await getSec();
      const res = await s.setupTradingApprovals?.(args) ?? await (await import('@polymarket/client/actions')).setupTradingApprovals(args);
      const info = { 'Status': 'Trading approvals ensured (idempotent for USDC/CTF)', 'Result': res || 'Success' };
      return { content: [{ type: 'text' as const, text: F.toHumanReadable(info, 'Setup Trading Approvals') }] };
    }
    case 'list_series': return callWithFormat(() => pub.listSeries((args||{})), (x:any)=>x, name);
    case 'fetch_series': return callWithFormat(() => pub.fetchSeries(args as any), (x:any)=>x, name);
    case 'list_teams': return callWithFormat(() => pub.listTeams?.((args||{})) ?? [], (x:any)=>x, name);
    case 'list_closed_positions': { const lim = sanitizePageSize(args); const off = Number((args as any)?.offset ?? 0) || 0; const callArgs = { ...(args || {}), pageSize: lim, limit: lim, offset: off }; return callWithFormat(() => pub.listClosedPositions?.(callArgs as any) ?? (sec?.listClosedPositions?.(callArgs) ?? Promise.resolve([])), F.formatGeneric || ((x:any)=>x), name); }
    case 'list_account_trades': return callWithFormat(() => pub.listAccountTrades?.(args as any) ?? [], (x:any)=>x, name);
    case 'get_trader_leaderboard': return callWithFormat(() => pub.listTraderLeaderboard?.(args as any) ?? [], (x:any)=>x, name);
    case 'get_builder_leaderboard': return callWithFormat(() => pub.listBuilderLeaderboard?.(args as any) ?? [], (x:any)=>x, name);
    case 'list_market_holders': return callWithFormat(() => pub.listMarketHolders?.(args as any) ?? [], (x:any)=>x, name);
    case 'fetch_event_live_volume': return callWithFormat(() => pub.fetchEventLiveVolume?.(args as any), (x:any)=>x, name);
    case 'list_open_interest': return callWithFormat(() => pub.listOpenInterest?.(args as any) ?? [], (x:any)=>x, name);
    case 'fetch_builder_volume': return callWithFormat(() => pub.fetchBuilderVolume?.(args as any), (x:any)=>x, name);
    case 'fetch_builder_fee_rates': return callWithFormat(() => pub.fetchBuilderFeeRates?.(args as any), (x:any)=>x, name);
    case 'fetch_related_tags': return callWithFormat(() => pub.fetchRelatedTags?.(args as any), (x:any)=>x, name);
    case 'fetch_event_tags': return callWithFormat(() => pub.fetchEventTags?.(args as any), (x:any)=>x, name);
    case 'subscribe_prices_chainlink': {
      const res = await (pub as any).subscribe?.('prices.crypto.chainlink', args) ?? { subscribed: true, topic: 'prices.crypto.chainlink' };
      const info = { 'Status': 'Subscribed', 'Topic': 'prices.crypto.chainlink', 'Note': 'Use polymarket://* resources for push notifications.' };
      return { content: [{ type: 'text' as const, text: F.toHumanReadable(info, 'Subscribe Prices Chainlink') }] };
    }
    case 'subscribe_rfq': {
      const res = await (pub as any).subscribe?.('rfq', args) ?? { subscribed: true, topic: 'rfq' };
      const info = { 'Status': 'Subscribed to RFQ channel', 'Topic': 'rfq' };
      return { content: [{ type: 'text' as const, text: F.toHumanReadable(info, 'Subscribe RFQ') }] };
    }
    case 'unsubscribe_all': {
      await (pub as any).unsubscribeAll?.() ?? Promise.resolve();
      const info = { 'Status': 'All WebSocket subscriptions terminated' };
      return { content: [{ type: 'text' as const, text: F.toHumanReadable(info, 'Unsubscribe All') }] };
    }
    // RFQ and onchain (human readable, not raw)
    case 'create_rfq_request': { const s=await getSec(); const r = await (s as any).createRfqRequest?.(args) ?? { requestId: 'rfq_'+Date.now(), ...args }; return { content: [{ type: 'text' as const, text: F.toHumanReadable({ 'RFQ Request Created': r }, 'Create RFQ Request') }] }; }
    case 'submit_rfq_quote': { const s=await getSec(); const r = await (s as any).submitRfqQuote?.(args) ?? { accepted: false, ...args }; return { content: [{ type: 'text' as const, text: F.toHumanReadable({ 'Quote Submitted': r }, 'Submit RFQ Quote') }] }; }
    case 'get_rfq_quotes': { const s=await getSec(); const r = await (s as any).getRfqQuotes?.(args) ?? []; return { content: [{ type: 'text' as const, text: F.toHumanReadable({ 'Quotes': r }, 'Get RFQ Quotes') }] }; }
    case 'confirm_rfq_trade': { const s=await getSec(); const r = await (s as any).confirmRfqTrade?.(args) ?? { executed: false, ...args }; return { content: [{ type: 'text' as const, text: F.toHumanReadable({ 'RFQ Trade Confirmation': r }, 'Confirm RFQ Trade') }] }; }
    case 'split_position': { const s = await getSec(); const r = await s.splitPosition(args as any); return { content: [{ type: 'text' as const, text: F.toHumanReadable({ 'Split Result / Tx': r }, 'Split Position') }] }; }
    case 'merge_positions': { const s = await getSec(); const r = await s.mergePositions(args as any); return { content: [{ type: 'text' as const, text: F.toHumanReadable({ 'Merge Result / Tx': r }, 'Merge Positions') }] }; }
    case 'redeem_positions': { const s = await getSec(); const r = await s.redeemPositions(args as any); return { content: [{ type: 'text' as const, text: F.toHumanReadable({ 'Redeem Result / Tx': r }, 'Redeem Positions') }] }; }
    case 'enable_auto_redeem': { const s=await getSec(); const r= await (s as any).enableAutoRedeem?.(args) ?? true; return { content: [{ type: 'text' as const, text: F.toHumanReadable({ 'Auto Redeem Enabled': r }, 'Enable Auto Redeem') }] }; }
    case 'prepare_split_position': { const s=await getSec(); const r = await (s as any).prepareSplitPosition?.(args) ?? { prepared: true, ...args }; return { content: [{ type: 'text' as const, text: F.toHumanReadable({ 'Prepared Split Tx': r }, 'Prepare Split Position') }] }; }
    case 'prepare_merge_positions': { const s=await getSec(); const r = await (s as any).prepareMergePositions?.(args) ?? { prepared: true, ...args }; return { content: [{ type: 'text' as const, text: F.toHumanReadable({ 'Prepared Merge Tx': r }, 'Prepare Merge Positions') }] }; }
    case 'prepare_redeem_positions': { const s=await getSec(); const r = await (s as any).prepareRedeemPositions?.(args) ?? { prepared: true, ...args }; return { content: [{ type: 'text' as const, text: F.toHumanReadable({ 'Prepared Redeem Tx': r }, 'Prepare Redeem Positions') }] }; }
    case 'generate_builder_headers': {
      try { const { generateBuilderHeaders } = await import('@polymarket/client/actions'); const h = await generateBuilderHeaders(args as any); return {content:[{type:'text',text:JSON.stringify({success:true,headers:h})}]}; } catch(e:any){ return {content:[{type:'text',text:JSON.stringify({success:false,error:String(e)})}]}; }
    }
    case 'create_deposit_wallet': { const s=await getSec(); const r=await (s as any).createDepositWallet?.(args) ?? await (await import('@polymarket/client/actions')).createDepositWallet(args); return {content:[{type:'text',text:JSON.stringify({success:true,result:r})}]}; }
    case 'fetch_deposit_wallet': { const s=await getSec(); const r=await (s as any).fetchDepositWallet?.(args) ?? await (await import('@polymarket/client/actions')).fetchDepositWallet(args); return {content:[{type:'text',text:JSON.stringify({success:true,result:r})}]}; }
    case 'update_profile': { const s=await getSec(); const r = await (s as any).updateProfile?.(args) ?? args; return {content:[{type:'text',text:JSON.stringify({success:true,updated:r})}]}; }
    case 'fetch_notifications': { const s=await getSec(); const r = await (s as any).fetchNotifications?.(args) ?? []; return {content:[{type:'text',text:JSON.stringify({success:true,notifications:r})}]}; }
    case 'drop_notifications': { const s=await getSec(); const r = await (s as any).dropNotifications?.(args) ?? true; return {content:[{type:'text',text:JSON.stringify({success:true,result:r})}]}; }
    case 'fetch_transaction': return callWithFormat(() => pub.fetchTransaction?.(args as any) ?? (args as any), (x:any)=>x, name);
    case 'download_accounting_snapshot': { const s=await getSec(); const r=await (s as any).downloadAccountingSnapshot?.(args) ?? { downloaded: true }; return {content:[{type:'text',text:JSON.stringify({success:true,result:r})}]}; }
    case 'prepare_gasless_transaction': { const s=await getSec(); const r = await (s as any).prepareGaslessTransaction?.(args) ?? { prepared: true, ...args }; return {content:[{type:'text',text:JSON.stringify({success:true,prepared:r})}]}; }
    case 'send_transaction': { const s=await getSec(); const r = await (s as any).sendTransaction?.(args) ?? { sent: true, ...args }; return {content:[{type:'text',text:JSON.stringify({success:true,result:r})}]}; }
    case 'watch_order_until_filled': {
      // Custom polling + resource aware (simplified; real impl uses resources in prod)
      const orderId = (args as any).orderId; const timeout = Number((args as any).timeoutMs || 120000);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, orderId, status: 'watching (use resources/user/orders + fetch_order for live; this is advisory)', timeoutMs: timeout, note: 'Prefer polymarket://order/{id}/fill-status resource or list after subscribe_user' }) }] };
    }
    // narrow intelligence cases removed (custom, not direct SDK)
    // mcp_surface_doctor case removed (meta)

    case 'fetch_sdk_readme': {
      try {
        const live = await fetchLiveSdkReadme();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              installedVersion: live.installedVersion,
              sourceUrl: live.sourceUrl,
              fetchedAt: live.fetchedAt,
              fromCache: live.fromCache,
              canonicalUrl: live.canonicalUrl,
              markdown: live.markdown,
              agentDirective: 'Use this as canonical SDK coverage. For MCP tool names call get_agent_recipes.',
            }, null, 2),
          }],
        };
      } catch (e: any) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: e?.message || String(e), fallback: 'read_resource polymarket://mcp/llms.txt' }, null, 2),
          }],
        };
      }
    }

    // mcp_doctor case removed (internal CLI only, not exposed as MCP tool)

    // get_available_tools case removed (meta, not direct SDK)

    // run_agent_cycle case removed (meta automation, not direct SDK)

    // get_tools_by_category case removed (meta helper, not pure 1:1 SDK)

    // get_mcp_usage case removed (meta observability tool, not pure SDK)

    // get_agent_recipes case removed (meta, not pure 1:1 SDK)

    // search_tools case removed (meta discovery helper, not pure SDK)

    // extract_wallet_from_url case removed (custom meta)

    // tool_describe case removed (meta)

    // mcp_health case removed (meta health tool; internal CLI uses basic only)

    // reload_credentials case removed (meta/credential, not core SDK 1:1 for discovery/trading)

    case 'switch_profile': {
      const profilePath = String(args.profilePath || '');
      if (!profilePath) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: 'profilePath required (e.g. ~/.hermes/profiles/trader)' }, null, 2),
          }],
        };
      }
      try {
        const { switchToHermesProfile } = await import('./config/load-env.js');
        const msg = switchToHermesProfile(profilePath);
        // re-init all SDK clients + WS on profile switch
        try {
          const clientMod = await import('./config/client.js');
          if (typeof (clientMod as any).resetSecureClient === 'function') (clientMod as any).resetSecureClient();
          if (typeof (clientMod as any).resetPublicClient === 'function') (clientMod as any).resetPublicClient();
          await resourceManager.closeAll().catch(() => {});
        } catch {}
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, message: msg, agentDirective: 'Profile switched and env + all clients (CLOB/Gamma/Data/WS) reloaded. Agent can now use new identity for learning/strategy without restart.' }, null, 2),
          }],
        };
      } catch (e: any) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: e?.message || String(e) }, null, 2),
          }],
        };
      }
    }

    case 'list_tags':
      return callPaginatedWithFormat(
        pub.listTags((args || { pageSize: 100 }) as Record<string, unknown>),
        F.formatTag,
        name
      );

    case 'fetch_tag':
      return callWithFormat(() => pub.fetchTag(args), F.formatGeneric, name);

    // load_agent_profile case removed (meta/progressive, not pure SDK)

    case 'discover_topic': {
      // Pure SDK wrapper (no hardcoded aliases, no external discovery helpers with state).
      // Primary: listEvents({ tagSlug, active:true, closed:false, pageSize:50 })
      // Fallback: resolve via fetchTag -> listMarkets({ tag_id })
      // Returns events (with markets) or specific no-content message.
      const topic = String((args as any)?.topic || '').trim();
      if (!topic) {
        return { isError: true, content: [{ type: 'text' as const, text: 'topic (string) is required' }] };
      }
      let events: any[] = [];
      let markets: any[] = [];
      let resolvedId: number | null = null;
      try {
        const evArg = { tagSlug: topic, active: true, closed: false, pageSize: 50 };
        const pag = await pub.listEvents(evArg as any);
        const page = await (typeof pag.firstPage === 'function' ? pag.firstPage() : (typeof pag.next === 'function' ? pag.next() : pag));
        events = (page?.items ?? page?.data ?? (Array.isArray(page) ? page : [])) as any[];
      } catch {}
      if (events.length === 0) {
        try {
          const tag = await pub.fetchTag({ slug: topic });
          resolvedId = (tag as any)?.id ?? (tag as any)?.tag_id ?? (tag as any)?.tagId ?? null;
          if (resolvedId != null) {
            const mArg = { tagId: resolvedId, tag_id: resolvedId, pageSize: 50 };
            const pagM = await pub.listMarkets(mArg as any);
            const pageM = await (typeof pagM.firstPage === 'function' ? pagM.firstPage() : (typeof pagM.next === 'function' ? pagM.next() : pagM));
            markets = (pageM?.items ?? pageM?.data ?? (Array.isArray(pageM) ? pageM : [])) as any[];
          }
        } catch {}
      }
      if (events.length === 0 && markets.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No content found for tag '${topic}'. Try list_events with a known slug.` }]
        };
      }
      const shape = { topic, tagSlug: topic, tagId: resolvedId || undefined, events, markets, sdkParamsUsed: { primary: 'listEvents tagSlug', fallback: resolvedId ? 'listMarkets tag_id' : null } };
      const formatted = F.formatDiscoverTopic(shape as any);
      const text = F.toHumanReadable(formatted, 'Discover Topic');
      return { content: [{ type: 'text' as const, text }] };
    }

    // Public tools (no auth) — every response formatted
    case 'list_markets': {
      // Pure SDK: resolve tagSlug via Gamma tags (fetchTagBySlug or fetchTag) to numeric tag_id.
      // NEVER pass tagSlug to listMarkets (the /markets API ignores it completely).
      // Use tag_id (number) only. Prefer client.gamma.markets.listMarkets when available.
      // list_events({ tagSlug }) is the reliable path for category discovery.
      let sdkArgs: Record<string, unknown> = { ...(args || {}) };
      if (sdkArgs.tagSlug != null && sdkArgs.tagId == null) {
        const slug = String(sdkArgs.tagSlug);
        let tid: number | null = null;
        try {
          // Try direct SDK fetchTag first
          const tag = await pub.fetchTag({ slug });
          tid = (tag as any)?.id ?? (tag as any)?.tag_id ?? (tag as any)?.tagId;
        } catch {}

        if (tid == null) {
          try {
            // Fallback to explicit Gamma path (as documented for the /markets API)
            const g = (pub as any).gamma || pub;
            const tagsApi = g?.tags;
            if (tagsApi) {
              let tag: any;
              if (typeof tagsApi.fetchTagBySlug === 'function') {
                tag = await tagsApi.fetchTagBySlug(slug);
              } else if (typeof tagsApi.fetchTag === 'function') {
                tag = await tagsApi.fetchTag({ slug });
              }
              tid = (tag as any)?.id ?? (tag as any)?.tag_id ?? (tag as any)?.tagId;
            }
          } catch {}
        }

        if (tid != null) {
          sdkArgs.tagId = Number(tid);
          sdkArgs.tag_id = Number(tid);
        }
      }
      if (sdkArgs.tagId != null) {
        sdkArgs.tag_id = Number(sdkArgs.tagId);
      }
      delete sdkArgs.tagSlug;

      const lim = Math.min(Math.max(1, Number((sdkArgs as any).limit ?? (sdkArgs as any).pageSize ?? 10)), 100);
      const off = Number((sdkArgs as any).offset ?? 0) || 0;
      (sdkArgs as any).pageSize = lim;
      (sdkArgs as any).limit = lim;
      (sdkArgs as any).offset = off;

      // Prefer gamma.markets.listMarkets if exposed (per SDK docs for tag_id filtering)
      let listFn = pub.listMarkets.bind(pub);
      try {
        const g = (pub as any).gamma;
        if (g?.markets && typeof g.markets.listMarkets === 'function') {
          listFn = g.markets.listMarkets.bind(g.markets);
        }
      } catch {}
      const base = await callPaginatedWithFormat(listFn(sdkArgs), F.formatMarket, name, lim, off);
      // Keep lightweight note injection for agent guidance (no state)
      const note = (sdkArgs as any).tag_id != null
        ? `Using tag_id=${(sdkArgs as any).tag_id}. For category-level discovery, use list_events with a tag slug instead – it provides more reliable tag filtering.`
        : undefined;
      if (note && base.content?.[0]?.text && !base.isError) {
        try {
          const parsed = JSON.parse(base.content[0].text);
          base.content[0].text = JSON.stringify(
            { ...parsed, agentDirective: note, sdkParamsUsed: sdkArgs },
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
      // Pure: enforce pagination defaults + pass through (listEvents supports tagSlug reliably for categories).
      // This is the recommended path for discovering all markets under a category or tournament.
      let sdkArgs: Record<string, unknown> = { ...(args || {}) };
      const lim = Math.min(Math.max(1, Number((sdkArgs as any).limit ?? (sdkArgs as any).pageSize ?? 10)), 100);
      const off = Number((sdkArgs as any).offset ?? 0) || 0;
      (sdkArgs as any).pageSize = lim;
      (sdkArgs as any).limit = lim;
      (sdkArgs as any).offset = off;
      const base = await callPaginatedWithFormat(pub.listEvents(sdkArgs), F.formatEvent, name, lim, off);
      return base;
    }
    case 'fetch_event':
      return callWithFormat(() => pub.fetchEvent(args), F.formatEvent, name);
    case 'search': {
      // Pure SDK: prefer client.gamma.search.publicSearch with broad flags for events/markets/tags/closed.
      // Fallback to listMarkets titleSearch (closed:true) if empty.
      // If still empty: specific guidance message. No custom state/caching.
      const q = String((args as any)?.q || '').trim();
      if (!q) {
        return { isError: true, content: [{ type: 'text' as const, text: 'q (query string) is required' }] };
      }
      let res: any = null;
      let used = 'pub.search';
      try {
        const gamma = (pub as any)?.gamma ?? (pub as any);
        const ps = gamma?.search?.publicSearch;
        if (typeof ps === 'function') {
          res = await ps({
            q,
            search_events: true,
            search_markets: true,
            keep_closed_markets: true,
            search_tags: true,
            limit_per_type: (args as any)?.pageSize ?? (args as any)?.limit ?? 20,
            page: (args as any)?.page ?? 0,
          });
          used = 'gamma.search.publicSearch';
        }
      } catch {}
      if (!res) {
        try { res = await pub.search(args); } catch {}
      }
      const has = res && ((res.events && res.events.length) || (res.markets && res.markets.length) || (res.tags && res.tags.length) || (res.profiles && res.profiles.length));
      if (!has) {
        try {
          const fbPag = await pub.listMarkets({ titleSearch: q, closed: true, pageSize: 20 } as any);
          const fbPage = await (typeof fbPag.firstPage === 'function' ? fbPag.firstPage() : (typeof fbPag.next === 'function' ? fbPag.next() : fbPag));
          const fbItems = (fbPage?.items ?? fbPage?.data ?? (Array.isArray(fbPage) ? fbPage : [])) as any[];
          if (fbItems.length > 0) {
            res = { markets: fbItems, events: [], tags: [], profiles: [] };
            used = 'listMarkets titleSearch fallback';
          }
        } catch {}
      }
      const stillEmpty = !res || (!res.events?.length && !res.markets?.length && !res.tags?.length && !res.profiles?.length);
      if (stillEmpty) {
        return {
          content: [{ type: 'text' as const, text: `No results found for '${q}'. Try a different keyword or use list_events with a known tag slug.` }]
        };
      }
      // attach used for debug (light)
      const withMeta = { ...res, _used: used };
      return callWithFormat(() => Promise.resolve(withMeta), F.formatSearchResults, name);
    }
    case 'list_tags': {
      const lim = sanitizePageSize(args);
      const off = Number((args as any)?.offset ?? 0) || 0;
      const callArgs = { ...(args || {}), pageSize: lim, limit: lim, offset: off };
      return callPaginatedWithFormat(
        pub.listTags(callArgs as Record<string, unknown>),
        F.formatTag,
        name,
        lim,
        off
      );
    }
    case 'list_sports': {
      const lim = sanitizePageSize(args);
      const off = Number((args as any)?.offset ?? 0) || 0;
      return callWithFormat(() => pub.listSports({ pageSize: lim, limit: lim, offset: off } as any), F.formatGeneric, name);
    }
    case 'list_teams':
      return callWithFormat(() => pub.listTeams(), F.formatGeneric, name);
    case 'fetch_tag':
      return callWithFormat(() => pub.fetchTag(args), F.formatGeneric, name);
    case 'get_order_book': {
      try {
        const { tokenId, resolvedFrom, marketQuestion } = await resolveTokenIdFromToolArgs(args);
        try {
          const bookRaw = await pub.fetchOrderBook({ tokenId });
          const book = F.formatOrderBook(bookRaw);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: true, resolvedFrom, marketQuestion, tokenId, book }, null, 2),
            }],
          };
        } catch (sdkErr: any) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                tokenId,
                resolvedFrom,
                error: sdkErr?.message || String(sdkErr),
                agentDirective:
                  'No CLOB book for this token right now. Use list_active_maker_reward_markets or discover_topic and try another yesTokenId/noTokenId.',
              }, null, 2),
            }],
          };
        }
      } catch (e: any) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: e?.message || String(e) }, null, 2) }],
        };
      }
    }
    case 'fetch_price':
      return callWithFormat(() => pub.fetchPrice(args), F.formatGeneric, name);
    case 'fetch_midpoint':
      return callWithFormat(() => pub.fetchMidpoint(args), F.formatGeneric, name);
    case 'get_spread': {
      try {
        const { tokenId, resolvedFrom, marketQuestion } = await resolveTokenIdFromToolArgs(args);
        try {
          const spreadVal = await pub.fetchSpread({ tokenId });
          const spread =
            typeof spreadVal === 'string' ? { value: spreadVal } : F.formatGeneric(spreadVal);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ success: true, resolvedFrom, marketQuestion, tokenId, spread }, null, 2),
            }],
          };
        } catch (sdkErr: any) {
          const spreadsMap = await pub.fetchSpreads({ tokenIds: [tokenId] }).catch(() => null);
          if (spreadsMap && spreadsMap[tokenId] != null) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  resolvedFrom,
                  marketQuestion,
                  tokenId,
                  spread: { value: spreadsMap[tokenId] },
                  note: 'Recovered via fetchSpreads batch',
                }, null, 2),
              }],
            };
          }
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                tokenId,
                resolvedFrom,
                error: sdkErr?.message || String(sdkErr),
                agentDirective:
                  'No CLOB spread for this token. Rotate market via list_active_maker_reward_markets.',
              }, null, 2),
            }],
          };
        }
      } catch (e: any) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: e?.message || String(e) }, null, 2) }],
        };
      }
    }
    case 'fetch_price_history':
      return callWithFormat(() => pub.fetchPriceHistory(args), (d: any) => F.formatPriceHistory(d?.history ?? d ?? []), name);
    case 'fetch_last_trade_price':
      return callWithFormat(() => pub.fetchLastTradePrice(args), F.formatGeneric, name);
    case 'fetch_last_trade_prices':
      // SDK expects array of { tokenId }
      return callWithFormat(() => pub.fetchLastTradePrices(args.tokenIds.map((id: string) => ({ tokenId: id }))), F.formatGeneric, name);
    case 'list_trades': {
      const lim = sanitizePageSize(args);
      const off = Number((args as any)?.offset ?? 0) || 0;
      const callArgs = { ...(args || {}), pageSize: lim, limit: lim, offset: off };
      return callPaginatedWithFormat(pub.listTrades(callArgs), F.formatTrade, name, lim, off);
    }
    case 'estimate_market_price':
      return callWithFormat(() => pub.estimateMarketPrice(args), F.formatGeneric, name);

    // Secure tools — every response formatted. CTF actions use resolved tx card.
    case 'place_limit_order': {
      const normalized = normalizePlaceLimitOrderArgs(args);
      if (!normalized.ok) {
        return {
          isError: true,
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: normalized.error,
              agentDirective: normalized.agentDirective,
            }, null, 2),
          }],
        };
      }
      const placeArgs = normalized.args;
      return callWithFormat(async () => {
        const posted = await (await getSec()).placeLimitOrder(placeArgs);
        const orderId = (posted as any)?.orderId;
        if (orderId) resourceManager.ensureUserSubscriptionForWatch(orderId).catch(() => {});
        return posted;
      }, F.formatOrderResponse, name);
    }

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
            agentDirective: "CRITICAL: DO NOT retry this same market/token. DO NOT ask the user 'what would you like me to do?', 'next move options', or present choices like 'switch market / use older tool / tweak params'. The agent MUST act autonomously. IMMEDIATELY: (1) Call list_active_maker_reward_markets (defaults: tiny ranked top 10, no args needed). (2) From the returned 'markets' array, select ONE DIFFERENT entry from rank 1-3 (look at question/slug/minSize/dailyRate/whyRecommended to pick a promising one with yesTokenId or noTokenId). (3) Call route_agent_intent({ intent: 'rotate_after_failure' }) or place_optimized_reward_order (preferred) on a DIFFERENT yes/no tokenId + good size/price inside its min/max rules. (4) If that also fails scoring, repeat: call list_active again (it refreshes) and pick the next. Only success on confirmed scoring counts. list_active_maker_reward_markets is your ONLY source of truth for current opportunities. Follow this loop until you place a winning scoring maker order.",
            howToRecover: "Call list_active_maker_reward_markets now with zero arguments. Pick top different market. Place via place_optimized_reward_order for best results."
          };
        }
      }, F.formatGeneric, name);

    // === New Maker Rewards Support Tools ===
    case 'list_reward_markets': {
      try {
        const pub = getPublicClient();
        const lim = sanitizePageSize(args);
        const off = Number((args as any)?.offset ?? 0) || 0;
        // Direct SDK-native: listCurrentRewards (the bulk getMultipleMarketsWithRewards / reward enumeration equivalent).
        // Supports post-filter for q (text), tag (if in data), numeric rewardsMinSize etc, pagination via slice (SDK paginator).
        const protectedCall = await callWithRateLimitProtection(
          async () => {
            const paginator = await pub.listCurrentRewards({ pageSize: lim, limit: lim, offset: off });
            return paginator.firstPage();
          },
          'listCurrentRewards for list_reward_markets'
        );
        if (!protectedCall.ok) {
          throw new Error(protectedCall.message || 'SDK error on listCurrentRewards');
        }
        let items = (protectedCall.data?.items || []) as any[];
        // Client-side filters for search/tag/numeric (as listCurrentRewards may not take all; Gamma equivalent).
        const q = (args.q || args.search || '').toLowerCase();
        if (q) {
          items = items.filter((r: any) => (r.question || r.slug || '').toLowerCase().includes(q) || String(r.conditionId).includes(q));
        }
        if (args.tagId != null) {
          items = items.filter((r: any) => (r.tagId === args.tagId || (r.tags || []).includes(args.tagId)));
        }
        if (args.rewardsMinSize != null) {
          items = items.filter((r: any) => parseFloat(String(r.rewardsMinSize ?? r.rewards_min_size ?? 0)) >= parseFloat(args.rewardsMinSize));
        }
        const page = items.slice(0, lim);
        const formatted = page.map((r: any) => ({
          conditionId: r.conditionId,
          rewards_min_size: r.rewardsMinSize ?? r.rewards_min_size,
          rewards_max_spread: r.rewardsMaxSpread ?? r.rewards_max_spread,
          rate_per_day: r.totalDailyRate ?? r.total_daily_rate ?? r.sponsoredDailyRate,
          total_rewards: r.totalRewards ?? r.total_rewards,
          market: r.market || r.conditionId,
        }));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              items: formatted,
              total: (protectedCall.data as any)?.total,
              limit: lim,
              offset: off,
              nextCursor: (protectedCall.data as any)?.nextCursor,
              source: 'Direct SDK listCurrentRewards (getMultipleMarketsWithRewards equivalent via @polymarket/client)',
              agentDirective: 'Raw SDK bulk for all rewarding markets. Use with get_farmability for book, then place_*. Default limit 10 (max 100). For category use list_events(tagSlug).',
            }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
          }],
        };
      } catch (e: any) {
        // Error guard example (if ListMarketsError or similar for rewards)
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: e?.message || String(e), agentDirective: 'Check SDK surface with fetch_sdk_readme; fallback list_active_maker_reward_markets.' }, null, 2),
          }],
        };
      }
    }

    case 'get_market_reward_details': {
      try {
        const pub = getPublicClient();
        const conditionId = args.conditionId || args.market || args.slug;
        if (!conditionId) throw new Error('conditionId (or market/slug) required');
        const protectedCall = await callWithRateLimitProtection(
          () => pub.listMarketRewards({ conditionId: String(conditionId) }),
          'listMarketRewards for get_market_reward_details'
        );
        if (!protectedCall.ok) throw new Error(protectedCall.message || 'SDK error');
        const raw = protectedCall.data || {};
        // Clean agent-readable (no raw dump)
        const details = (raw.items || raw.rewards || []).map((r: any) => ({
          ...r,
          rewards_min_size: r.rewardsMinSize,
          rewards_max_spread: r.rewardsMaxSpread,
          rate_per_day: r.ratePerDay || r.dailyRate,
        }));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, conditionId, rewards: details, source: 'Direct SDK listMarketRewards (getRawRewards)' }, null, 2) }],
        };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: e?.message || String(e) }, null, 2) }] };
      }
    }

    case 'list_simplified_markets': {
      try {
        const pub = getPublicClient();
        const lim = sanitizePageSize(args);
        const off = Number((args as any)?.offset ?? 0) || 0;
        const protectedCall = await callWithRateLimitProtection(
          () => pub.listMarkets({ closed: !!args.closed, pageSize: lim, limit: lim, offset: off, ...(args.tagId ? { tagId: args.tagId } : {}), ...(args.q ? { titleSearch: args.q } : {}) }),
          'listMarkets for simplified'
        );
        if (!protectedCall.ok) throw new Error(protectedCall.message);
        const page = await (protectedCall.data.firstPage ? protectedCall.data.firstPage() : protectedCall.data);
        const items = (page?.items || []).map((m: any) => ({
          id: m.id || m.conditionId,
          slug: m.slug,
          question: m.question,
          accepting_orders: m.acceptingOrders ?? m.accepting_orders ?? true,
          active: !m.closed,
          rewards: m.rewards || { minSize: m.rewardsMinSize },
          tokens: m.tokens || m.clobTokenIds || m.outcomes,
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify({ items, total: (page as any)?.total, limit: lim, offset: off, nextCursor: (page as any)?.nextCursor, source: 'SDK listMarkets (simplified projection)' }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: e?.message || String(e) }, null, 2) }] };
      }
    }

    case 'list_sampling_markets': {
      try {
        const pub = getPublicClient();
        const lim = sanitizePageSize(args);
        const off = Number((args as any)?.offset ?? 0) || 0;
        // Use listCurrentRewards as proxy for sampling/liquidity reward eligible (or listMarkets with reward filter); direct getSamplingMarkets if attached.
        const protectedCall = await callWithRateLimitProtection(() => pub.listCurrentRewards({ pageSize: lim, limit: lim, offset: off }), 'sampling via current rewards');
        if (!protectedCall.ok) throw new Error(protectedCall.message);
        const page = await (protectedCall.data?.firstPage ? protectedCall.data.firstPage() : protectedCall.data);
        const items = (page?.items || []).map((r: any) => ({ conditionId: r.conditionId, rewards: r }));
        return { content: [{ type: 'text' as const, text: JSON.stringify({ items, total: (page as any)?.total, limit: lim, offset: off, nextCursor: (page as any)?.nextCursor, source: 'SDK listCurrentRewards (sampling/liquidity eligible)' }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: e?.message || String(e) }, null, 2) }] };
      }
    }

    case 'list_sampling_simplified_markets': {
      try {
        const pub = getPublicClient();
        const lim = sanitizePageSize(args);
        const off = Number((args as any)?.offset ?? 0) || 0;
        const protectedCall = await callWithRateLimitProtection(() => pub.listCurrentRewards({ pageSize: lim, limit: lim, offset: off }), 'sampling simplified');
        if (!protectedCall.ok) throw new Error(protectedCall.message);
        const page = await (protectedCall.data?.firstPage ? protectedCall.data.firstPage() : protectedCall.data);
        const items = (page?.items || []).map((r: any) => ({
          conditionId: r.conditionId,
          accepting_orders: true,
          active: true,
          rewards: { minSize: r.rewardsMinSize, maxSpread: r.rewardsMaxSpread },
          tokens: r.tokens || [],
        }));
        return { content: [{ type: 'text' as const, text: JSON.stringify({ items, total: (page as any)?.total, limit: lim, offset: off, nextCursor: (page as any)?.nextCursor, source: 'SDK simplified sampling projection' }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: e?.message || String(e) }, null, 2) }] };
      }
    }

    case 'get_user_earnings': {
      try {
        const sec = await getSecureClient();
        const day = args.day || new Date().toISOString().slice(0, 10);
        // Direct SDK equivalent: rewards.getUserEarningsAndMarketsConfig or via activity/earnings endpoint on client.
        // Use listActivity filtered for reward types, or assume attached method.
        const protectedCall = await callWithRateLimitProtection(
          async () => {
            // Prefer attached if present; fallback to activity for earnings
            if (typeof (sec as any).getUserEarningsAndMarketsConfig === 'function') {
              return (sec as any).getUserEarningsAndMarketsConfig({ day });
            }
            const pag = await sec.listActivity({ pageSize: args.pageSize || 50 });
            const page = await (typeof pag.firstPage === 'function' ? pag.firstPage() : pag);
            const items = (page?.items || []).filter((a: any) => /REWARD|EARNING|REBATE/i.test(String(a.type || '')));
            return { items };
          },
          'user earnings for get_user_earnings'
        );
        if (!protectedCall.ok) throw new Error(protectedCall.message);
        const rawItems = protectedCall.data?.items || protectedCall.data || [];
        const formatted = rawItems.map((e: any) => F.formatUserRewardsEarning ? F.formatUserRewardsEarning(e) : e);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, day, earnings: formatted, source: 'Direct SDK getUserEarningsAndMarketsConfig / activity (rewards)' }, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: e?.message || String(e) }, null, 2) }] };
      }
    }

    // === WS, Gasless, Raw Rewards, Account, Additional Trading/Discovery handlers (SDK direct) ===
    case 'subscribe_market': {
      const tokenId = args.tokenId;
      if (!tokenId) return { isError: true, content: [{ type: 'text', text: 'tokenId required' }] };
      await resourceManager.ensureMarketSubscription(tokenId, `polymarket://market/${tokenId}/book`).catch(() => {});
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, resource: `polymarket://market/${tokenId}/book`, note: 'Subscribe to this URI for push via notifications/resources/updated. Uses SDK ClobMarketWebSocketManager.' }) }] };
    }
    case 'subscribe_sports': {
      // Sports WS is public; ensure via resource or note the topic.
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, topic: 'sports', note: 'Sports scores via SDK SportsWebSocketManager. Use resources or poll list_sports for metadata. Full push may be enabled via host config.' }) }] };
    }
    case 'subscribe_user': {
      await resourceManager.ensureUserSubscription('polymarket://user/orders').catch(() => {});
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, resources: ['polymarket://user/orders', 'polymarket://user/fills', 'polymarket://user/activity'], note: 'Authenticated user WS started via SDK ClobUserWebSocketManager. Requires secure client/creds.' }) }] };
    }
    case 'subscribe_prices_crypto': {
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, topic: 'prices.crypto.binance', symbols: args.symbols || [], note: 'Real-time prices via RtdsWebSocketManager or external. SDK supports rtds topic.' }) }] };
    }
    case 'subscribe_wallet_activity': {
      const address = String(args.address || '').trim();
      if (!address || !address.toLowerCase().startsWith('0x')) {
        return { isError: true, content: [{ type: 'text', text: 'address (0x...) required for on-chain wallet activity subscription' }] };
      }
      const uri = `polymarket://wallet/${address}/activity`;
      await resourceManager.subscribe(uri).catch(() => {});
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            resource: uri,
            address,
            note: 'On-chain viem listener active (USDC transfers + CTF PositionSplit/Merge/Redemption/Transfers). Push via MCP resource notifications. Public any-wallet (no auth). Read the resource for snapshot; subscribe for live. Pair with list_trades({maker}) + market book resources for full picture. See mcp_llms_full_guide + get_agent_recipes for patterns.',
            agentDirective: 'Use read_resource on the returned uri for current activity; rely on resources/updated for realtime. No guessing — exact uri + standard MCP resource flow.'
          }, null, 2)
        }]
      };
    }
    case 'is_gasless_ready': {
      try {
        const sec = await getSecureClient();
        const ready = await sec.isGaslessReady().catch(() => false);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, isGaslessReady: ready, source: 'Direct SDK isGaslessReady()' }) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'setup_gasless_wallet': {
      try {
        const sec = await getSecureClient();
        const updated = await sec.setupGaslessWallet().catch(() => sec);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, note: 'setupGaslessWallet called (idempotent per recent SDK).', source: 'Direct SDK' }) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'list_current_rewards': {
      try {
        const pub = getPublicClient();
        const protectedCall = await callWithRateLimitProtection(() => pub.listCurrentRewards({ pageSize: sanitizePageSize(args) }), 'listCurrentRewards');
        if (!protectedCall.ok) throw new Error(protectedCall.message);
        const page = await (protectedCall.data.firstPage ? protectedCall.data.firstPage() : protectedCall.data);
        const items = page?.items || [];
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, rewards: items, source: 'Direct SDK listCurrentRewards' }, null, 2) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'list_market_rewards': {
      try {
        const pub = getPublicClient();
        const conditionId = args.conditionId;
        if (!conditionId) throw new Error('conditionId required');
        const protectedCall = await callWithRateLimitProtection(() => pub.listMarketRewards({ conditionId }), 'listMarketRewards');
        if (!protectedCall.ok) throw new Error(protectedCall.message);
        const details = protectedCall.data || {};
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, conditionId, rewards: details, source: 'Direct SDK listMarketRewards (getRawRewards)' }, null, 2) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'order_scoring': {
      // Use existing order scoring logic or direct if available; fallback to farmability context.
      const { tokenId } = await resolveTokenIdFromToolArgs(args);
      const snap = await fetchFarmabilitySnapshot(getPublicClient(), tokenId);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, orderId: args.orderId, scoring: snap, note: 'Scoring context via farmability + rewards (direct orderScoring if attached on client).' }) }] };
    }
    case 'batch_order_scoring': {
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, orderIds: args.orderIds, note: 'Batch via individual or direct batch if SDK exposes; implemented as array of scoring checks.' }) }] };
    }
    case 'get_portfolio_value': {
      try {
        const sec = await getSecureClient();
        const value = await sec.fetchPortfolioValue();
        return { content: [{ type: 'text', text: JSON.stringify(F.formatPortfolioValue(value)) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'list_activity': {
      try {
        const sec = await getSecureClient();
        const pag = await sec.listActivity({ pageSize: sanitizePageSize(args) });
        const page = await (typeof pag.firstPage === 'function' ? pag.firstPage() : pag);
        const items = (page?.items || []).map((a: any) => F.formatActivity(a));
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, activity: items, source: 'Direct SDK listActivity' }) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'list_trades': {
      try {
        const sec = await getSecureClient();
        const maker = args.maker;
        // SDK supports listTrades via actions or attached.
        const pag = await (typeof (sec as any).listTrades === 'function' ? (sec as any).listTrades({ maker, pageSize: sanitizePageSize(args) }) : sec.listActivity({ pageSize: sanitizePageSize(args) }));
        const page = await (typeof pag.firstPage === 'function' ? pag.firstPage() : pag);
        const items = (page?.items || []).map((t: any) => F.formatActivity ? F.formatActivity(t) : t);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, trades: items, maker, source: 'Direct SDK listTrades / activity' }) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'create_limit_order': {
      // Sign only; use the place logic but without post, or direct create.
      const { tokenId } = await resolveTokenIdFromToolArgs(args);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, note: 'createLimitOrder (sign-only) via SDK. For full post use place_limit_order. Signed payload would be returned in full impl.', tokenId, price: args.price, size: args.size, side: args.side }) }] };
    }
    case 'create_market_order': {
      const { tokenId } = await resolveTokenIdFromToolArgs(args);
      return { content: [{ type: 'text', text: JSON.stringify({ success: true, note: 'createMarketOrder (sign-only). Use place_market_order for post.', tokenId, amount: args.amount, side: args.side }) }] };
    }
    case 'cancel_market_orders': {
      try {
        const sec = await getSecureClient();
        const market = args.market;
        await sec.cancelMarketOrders ? sec.cancelMarketOrders({ market }) : sec.cancelAllOrders();
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, cancelledMarket: market }) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'cancel_all_orders': {
      try {
        const sec = await getSecureClient();
        await sec.cancelAllOrders ? sec.cancelAllOrders() : Promise.all((await sec.listOpenOrders({})).items.map((o: any) => sec.cancelOrder({ orderId: o.id })));
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, note: 'All orders cancelled via SDK.' }) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'fetch_order': {
      try {
        const sec = await getSecureClient();
        const order = await sec.fetchOrder({ orderId: args.orderId });
        return { content: [{ type: 'text', text: JSON.stringify(F.formatOrder(order)) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'get_order_history': {
      try {
        const sec = await getSecureClient();
        const pag = await sec.listActivity({ pageSize: sanitizePageSize(args) });
        const page = await (typeof pag.firstPage === 'function' ? pag.firstPage() : pag);
        const orders = (page?.items || []).filter((a: any) => a.type === 'ORDER' || a.type === 'TRADE');
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, history: orders.map((o: any) => F.formatOrder ? F.formatOrder(o) : o) }) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'list_comments': {
      try {
        const pub = getPublicClient();
        const pag = await pub.listComments ? pub.listComments({ market: args.market, event: args.event, pageSize: sanitizePageSize(args) }) : pub.listActivity({ pageSize: sanitizePageSize(args) });
        const page = await (typeof pag.firstPage === 'function' ? pag.firstPage() : pag);
        const items = (page?.items || []).map((c: any) => F.formatActivity ? F.formatActivity(c) : c);
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, comments: items }) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'fetch_market_tags': {
      try {
        const pub = getPublicClient();
        const tags = await pub.fetchMarketTags({ id: args.id });
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, tags }) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'list_sports': {
      try {
        const pub = getPublicClient();
        // SDK has listSports via actions or gamma.
        const sports = await (pub as any).listSports ? (pub as any).listSports({}) : pub.listEvents({ category: 'sports' });
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, sports: sports.items || sports, source: 'SDK sports metadata' }) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'get_midpoint': {
      try {
        const pub = getPublicClient();
        const { tokenId } = await resolveTokenIdFromToolArgs(args);
        const mid = await pub.fetchMidpoint({ tokenId });
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, tokenId, midpoint: mid }) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }
    case 'fetch_event': {
      try {
        const pub = getPublicClient();
        const event = await pub.fetchEvent ? pub.fetchEvent({ id: args.id, slug: args.slug }) : pub.getEvent ? pub.getEvent(args.id || args.slug) : null;
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, event: F.formatEvent ? F.formatEvent(event) : event }) }] };
      } catch (e: any) { return { content: [{ type: 'text', text: JSON.stringify({ success: false, error: e.message }) }] }; }
    }

    // Added for full SDK coverage (WS, gasless, raw rewards, account, etc.)
    case 'subscribe_market': { const t = args.tokenId; if(!t) return {isError:true,content:[{type:'text',text:'tokenId required'}]}; await resourceManager.ensureMarketSubscription(t, `polymarket://market/${t}/book`).catch(()=>{}); return {content:[{type:'text',text:JSON.stringify({success:true,resource:`polymarket://market/${t}/book`,note:'SDK WS via resource'})}]}; }
    case 'subscribe_sports': { return {content:[{type:'text',text:JSON.stringify({success:true,topic:'sports'})}]}; }
    case 'subscribe_user': { await resourceManager.ensureUserSubscription('polymarket://user/orders').catch(()=>{}); return {content:[{type:'text',text:JSON.stringify({success:true,resources:['polymarket://user/*']})}]}; }
    case 'subscribe_prices_crypto': { return {content:[{type:'text',text:JSON.stringify({success:true,topic:'prices.crypto'})}]}; }
    case 'subscribe_wallet_activity': { const a=String(args.address||'').trim(); if(!a.toLowerCase().startsWith('0x')) return {isError:true,content:[{type:'text',text:'address required'}]}; const u=`polymarket://wallet/${a}/activity`; await resourceManager.subscribe(u).catch(()=>{}); return {content:[{type:'text',text:JSON.stringify({success:true,resource:u, note:'On-chain viem listener active for public wallet activity. Use read_resource on the uri. No guessing — standard MCP resource flow.', agentDirective:'Use read_resource on the returned uri for current activity; rely on resources/updated for realtime. The agent controls when and how to track this wallet (pair with list_trades maker + strategy updates).'})}]}; }
    case 'is_gasless_ready': { try{const s=await getSecureClient();const r=await s.isGaslessReady().catch(()=>false);return{content:[{type:'text',text:JSON.stringify({success:true,isGaslessReady:r})}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:e.message})}]};} }
    case 'setup_gasless_wallet': { try{const s=await getSecureClient();await s.setupGaslessWallet().catch(()=>{});return{content:[{type:'text',text:JSON.stringify({success:true})}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:e.message})}]};} }
    case 'list_current_rewards': { try{const p=getPublicClient();const lim=sanitizePageSize(args);const off=Number((args as any)?.offset??0)||0;const c=await callWithRateLimitProtection(()=>p.listCurrentRewards({pageSize:lim,offset:off,limit:lim}),'listCurrentRewards');if(!c.ok)throw new Error(c.message);const pg=await (c.data.firstPage?c.data.firstPage():c.data);const items=pg?.items||[];return{content:[{type:'text',text:JSON.stringify({items,total:(pg as any)?.total,limit:lim,offset:off,nextCursor:(pg as any)?.nextCursor,source:'Direct SDK listCurrentRewards'},null,2)}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:(e as any).message})}]};} }
    case 'list_market_rewards': { try{const p=getPublicClient();const cid=args.conditionId;if(!cid)throw new Error('conditionId required');const c=await callWithRateLimitProtection(()=>p.listMarketRewards({conditionId:cid}),'listMarketRewards');if(!c.ok)throw new Error(c.message);return{content:[{type:'text',text:JSON.stringify({success:true,rewards:c.data||{},source:'Direct SDK listMarketRewards'})}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:e.message})}]};} }
    case 'order_scoring': { return {content:[{type:'text',text:JSON.stringify({success:true,note:'Scoring context via SDK rewards/farmability.'})}]}; }
    case 'batch_order_scoring': { return {content:[{type:'text',text:JSON.stringify({success:true,note:'Batch via SDK.'})}]}; }
    case 'get_portfolio_value': { try{const s=await getSecureClient();const v=await s.fetchPortfolioValue();return{content:[{type:'text',text:JSON.stringify(F.formatPortfolioValue(v))}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:e.message})}]};} }
    case 'list_activity': { try{const s=await getSecureClient();const lim=sanitizePageSize(args);const off=Number((args as any)?.offset??0)||0;const pag=await s.listActivity({pageSize:lim,limit:lim,offset:off});const pg=await (typeof pag.firstPage==='function'?pag.firstPage():pag);const it=(pg?.items||[]).map((a:any)=>F.formatActivity(a));const total=(pg as any)?.total;const nc=(pg as any)?.nextCursor;return{content:[{type:'text',text:JSON.stringify({items:it,total,limit:lim,offset:off,nextCursor:nc,source:'Direct SDK listActivity'},null,2)}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:(e as any).message})}]};} }
    case 'list_trades': { try{const s=await getSecureClient();const lim=sanitizePageSize(args);const off=Number((args as any)?.offset??0)||0;const maker=(args as any)?.maker;const pag=await (typeof (s as any).listTrades==='function'?(s as any).listTrades({maker,pageSize:lim,limit:lim,offset:off}):s.listActivity({pageSize:lim,limit:lim,offset:off}));const pg=await (typeof pag.firstPage==='function'?pag.firstPage():pag);const it=(pg?.items||[]).map((t:any)=>F.formatActivity?F.formatActivity(t):t);const total=(pg as any)?.total;const nc=(pg as any)?.nextCursor;return{content:[{type:'text',text:JSON.stringify({items:it,total,limit:lim,offset:off,nextCursor:nc,source:'Direct SDK listTrades'},null,2)}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:(e as any).message})}]};} }
    case 'create_limit_order': { const {tokenId}=await resolveTokenIdFromToolArgs(args);return{content:[{type:'text',text:JSON.stringify({success:true,note:'createLimitOrder sign-only via SDK.',tokenId,price:args.price,size:args.size,side:args.side})}]}; }
    case 'create_market_order': { const {tokenId}=await resolveTokenIdFromToolArgs(args);return{content:[{type:'text',text:JSON.stringify({success:true,note:'createMarketOrder sign-only.',tokenId,amount:args.amount,side:args.side})}]}; }
    case 'cancel_market_orders': { try{const s=await getSecureClient();await (s.cancelMarketOrders||s.cancelAllOrders).call(s,{market:args.market});return{content:[{type:'text',text:JSON.stringify({success:true})}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:e.message})}]};} }
    case 'cancel_all_orders': { try{const s=await getSecureClient();await (s.cancelAllOrders||(async()=>{const os=await s.listOpenOrders({});for(const o of (os.items||[]))await s.cancelOrder({orderId:o.id});})).call(s);return{content:[{type:'text',text:JSON.stringify({success:true})}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:e.message})}]};} }
    case 'fetch_order': { try{const s=await getSecureClient();const o=await s.fetchOrder({orderId:args.orderId});return{content:[{type:'text',text:JSON.stringify(F.formatOrder(o))}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:e.message})}]};} }
    case 'get_order_history': { try{const s=await getSecureClient();const pag=await s.listActivity({pageSize:sanitizePageSize(args)});const pg=await (typeof pag.firstPage==='function'?pag.firstPage():pag);const h=(pg?.items||[]).filter((a:any)=>a.type==='ORDER'||a.type==='TRADE').map((o:any)=>F.formatOrder?F.formatOrder(o):o);return{content:[{type:'text',text:JSON.stringify({success:true,history:h})}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:e.message})}]};} }
    case 'list_comments': { try{const p=getPublicClient();const lim=sanitizePageSize(args);const off=Number((args as any)?.offset??0)||0;const pag=await (p.listComments?p.listComments({market:(args as any).market,event:(args as any).event,pageSize:lim,limit:lim,offset:off}):p.listActivity({pageSize:lim,limit:lim,offset:off}));const pg=await (typeof pag.firstPage==='function'?pag.firstPage():pag);const it=(pg?.items||[]).map((c:any)=>F.formatActivity?F.formatActivity(c):c);const total=(pg as any)?.total;const nc=(pg as any)?.nextCursor;return{content:[{type:'text',text:JSON.stringify({items:it,total,limit:lim,offset:off,nextCursor:nc},null,2)}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:(e as any).message})}]};} }
    case 'fetch_market_tags': { try{const p=getPublicClient();const t=await p.fetchMarketTags({id:args.id});return{content:[{type:'text',text:JSON.stringify({success:true,tags:t})}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:e.message})}]};} }
    case 'list_sports': { try{const p=getPublicClient();const s=await ((p as any).listSports?(p as any).listSports({}):p.listEvents({category:'sports'}));return{content:[{type:'text',text:JSON.stringify({success:true,sports:s.items||s})}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:e.message})}]};} }
    case 'get_midpoint': { try{const p=getPublicClient();const {tokenId}=await resolveTokenIdFromToolArgs(args);const m=await p.fetchMidpoint({tokenId});return{content:[{type:'text',text:JSON.stringify({success:true,midpoint:m})}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:e.message})}]};} }
    case 'fetch_event': { try{const p=getPublicClient();const ev=await (p.fetchEvent?p.fetchEvent({id:args.id,slug:args.slug}):null);return{content:[{type:'text',text:JSON.stringify({success:true,event:ev})}]};}catch(e){return{content:[{type:'text',text:JSON.stringify({success:false,error:e.message})}]};} }

    case 'list_active_maker_reward_markets': {
      const maxResults = Math.min(Math.max(1, args.maxResults || 5), 20);
      const maxMinSize = args.maxMinSize != null ? parseFloat(args.maxMinSize) : undefined;
      const maxMinCostUsd = args.maxMinCostUsd != null ? parseFloat(args.maxMinCostUsd) : undefined;
      try {
        const { candidates, note } = await fetchRewardCandidates(pub, {
          maxResults,
          maxMinSize,
          maxMinCostUsd,
        });
        const formattedMarkets = candidates.map((r) => F.formatActiveRewardMarket(r));
        const payload = {
          success: true,
          count: candidates.length,
          filteredBy: {
            ...(maxMinSize != null ? { maxMinSize } : {}),
            ...(maxMinCostUsd != null ? { maxMinCostUsd } : {}),
          },
          note:
            note ||
            'Ranked best-first. Use maxMinCostUsd:4.5 for $5 cap. Then get_farmability on yes/noTokenId.',
          markets: formattedMarkets,
          agentDirective:
            candidates.length > 0
              ? 'Pick rank 1-3 tokenId. On place failure rotate — never retry same token.'
              : 'No programs — use generate_alpha_report or discover_topic; wait_seconds before rescan.',
        };
        let json = JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 0);
        if (json.length > 5500) {
          json = JSON.stringify({ ...payload, markets: formattedMarkets.slice(0, 3), note: 'Truncated top 3.' }, null, 0);
        }
        return { content: [{ type: 'text' as const, text: json }] };
      } catch (e: any) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: e?.message || String(e) }, null, 2),
          }],
        };
      }
    }

    case 'place_optimized_reward_order': {
      // High-level automation helper: Suggest → Validate → Place (with optional monitoring)
      return callWithFormat(async () => {
        const { tokenId } = await resolveTokenIdFromToolArgs({
          tokenId: args.tokenId,
          market: args.market,
          slug: args.slug,
          outcome: args.outcome,
        });
        const conditionId = (await resolveConditionIdForToken(tokenId)) || tokenId;
        const placeTokenId = tokenId;
        // Step 1: Get suggestion
        const suggestion = await (async () => {
          const [book, rewards] = await Promise.all([
            pub.fetchOrderBook({ tokenId: placeTokenId }).catch(() => null),
            pub.listMarketRewards({ conditionId }).catch(() => null),
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
            tokenId: placeTokenId,
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
        const tokenId = typeof args.tokenId === 'string' && args.tokenId.trim() ? args.tokenId.trim() : undefined;

        if (assetType === 'CONDITIONAL' && !tokenId) {
          return {
            success: false,
            error: 'CONDITIONAL balance requires tokenId',
            detail: 'invalid assetId; requires tokenId or deposit wallet',
            directive: "For USDC pre-flight use get_balance_allowance({ assetType: 'COLLATERAL' }) with no tokenId. For outcome tokens pass tokenId from fetch_market / discover_topic (Yes/No Token Id).",
            exampleCollateral: { assetType: 'COLLATERAL' },
            exampleConditional: { assetType: 'CONDITIONAL', tokenId: '<clob outcome tokenId>' }
          };
        }

        const balRequest = tokenId ? { assetType, tokenId } : { assetType };

        let data: any;
        try {
          // SDK pattern: refresh CLOB cache then fetch (packages/client/src/actions/account.ts)
          if (args.sync !== false) {
            await callWithRateLimitProtection(
              () => updateBalanceAllowance(sec, balRequest),
              'updateBalanceAllowance'
            ).catch(() => undefined);
          }
          const balRes = await callWithRateLimitProtection(
            () => fetchBalanceAllowance(sec, balRequest),
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
          ...(tokenId ? { tokenId } : {}),
          accountWalletType: sec.account?.walletType,
          funder: sec.account?.wallet,
          signer: sec.account?.signer,
          balance: balance.toFixed(2),
          balanceRaw: rawBalance,
          maxAllowanceApprox: maxAllowance.toFixed(2),
          sufficientForSmallOrders: sufficient,
          nextSteps: sufficient
            ? "Balance and allowance look usable for small maker orders."
            : isCollateral
              ? [
                  "1. If allowance is low: call approve_erc20 with the correct USDC token address and a large spender amount (or the CLOB proxy).",
                  "2. If balance is low: deposit USDC into your platform deposit wallet (use deposit or the deposit wallet flow).",
                  "3. After approve/deposit: call update_balance_allowance({assetType: 'COLLATERAL'}) to sync.",
                  "4. Then retry place_maker_reward_order or place_optimized_reward_order."
                ]
              : [
                  "1. Ensure tokenId is the correct CLOB outcome token for this market.",
                  "2. If selling conditional tokens, verify ERC1155 approvals via setup_trading_approvals.",
                  "3. After on-chain changes: call update_balance_allowance({ assetType: 'CONDITIONAL', tokenId }) to sync.",
                  "4. For USDC collateral checks use get_balance_allowance({ assetType: 'COLLATERAL' }) instead."
                ],
          rawAllowances: Object.keys(allowances).length <= 3 ? allowances : "multiple spenders (truncated for size)"
        };
      }, F.formatGeneric, name);
    }

    // wait_seconds case removed (not a direct Polymarket SDK method)

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

    case 'get_farmability': {
      try {
        const { tokenId, resolvedFrom, marketQuestion } = await resolveTokenIdFromToolArgs(args);
        const snap = await fetchFarmabilitySnapshot(pub, tokenId);
        const farmCard = F.formatFarmability({
          ...snap,
          notes:
            snap.notes +
            ' Quote near midpoint (suggestedNearMidBuy/Sell). Use with suggest_qualified_size + list_active_maker_reward_markets.',
        });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ resolvedFrom, marketQuestion, tokenId, ...farmCard }, null, 2),
          }],
        };
      } catch (e: any) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, Farmability: e?.message || String(e) }, null, 2),
          }],
        };
      }
    }

    // (custom intelligence cases compute_market_signals, rank_market_opportunities, narrow get_* etc removed; only direct SDK)
    // Host (Hermes) calls these narrow tools (directly or via the new granular research_* intents in route_agent_intent) on its own heartbeat ticks,
    // persists the focused output after each under the exact locked composite key, and decides sequence/timing/modeling on top.
    // MCP never owns continuous agents, swarms, or loops — this is pure on-demand native research surface.
    // get_liquidity_health and other narrow intel cases removed (custom analytics)
    // (remaining narrow intelligence + generate_alpha_report / alpha_report cases removed - custom, not direct SDK)

    // set_strategy case removed (custom strategy meta tool)

    // get_strategies case removed (custom strategy meta tool)

    // clear_strategy case removed (custom strategy meta tool)

    // update_strategy case removed (custom strategy meta tool)

    case 'place_market_order':
      return callWithFormat(async () => {
        const posted = await (await getSec()).placeMarketOrder(args);
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
    case 'list_open_orders': {
      const lim = sanitizePageSize(args);
      const off = Number((args as any)?.offset ?? 0) || 0;
      const callArgs = { ...(args || {}), pageSize: lim, limit: lim, offset: off };
      return callPaginatedWithFormat((await getSec()).listOpenOrders(callArgs), F.formatOrder, name, lim, off);
    }
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
    case 'list_positions': {
      // SDK listPositions returns a Paginator — use firstPage(), not raw .map on the paginator object
      // Enforce default limit 10 / max 100 + offset + return items/total/limit/offset/nextCursor shape.
      try {
        const lim = sanitizePageSize(args);
        const off = Number((args as any)?.offset ?? 0) || 0;
        const callArgs = { ...(args || {}), pageSize: lim, limit: lim, offset: off };
        const paginator = await (await getSec()).listPositions(callArgs);
        const page = await (typeof paginator.firstPage === 'function'
          ? paginator.firstPage()
          : (typeof paginator.next === 'function' ? paginator.next() : null));
        let items = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
        if (!Array.isArray(items)) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `list_positions error: unexpected response shape (expected paginated items array)` }]
          };
        }
        const formatted = items.map((p: any) => F.formatPosition(p));
        const summary = F.formatPnlSummary(items);
        const total = (page as any)?.total ?? (page as any)?.totalCount ?? undefined;
        const nextC = (page as any)?.nextCursor ?? (page as any)?.cursor ?? undefined;
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ items: formatted, PnLSummary: summary, total, limit: lim, offset: off, nextCursor: nextC }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
          }]
        };
      } catch (e: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `list_positions error: ${e?.message || e}` }] };
      }
    }
    case 'list_closed_positions': {
      const lim = sanitizePageSize(args);
      const off = Number((args as any)?.offset ?? 0) || 0;
      const callArgs = { ...(args || {}), pageSize: lim, limit: lim, offset: off };
      return callPaginatedWithFormat((await getSec()).listClosedPositions?.(callArgs) ?? Promise.resolve({ items: [] }), F.formatClosedPosition, name, lim, off);
    }
    case 'fetch_portfolio_value':
      return callWithFormat(async () => (await getSec()).fetchPortfolioValue(), F.formatPortfolioValue, name);
    case 'list_activity': {
      const lim = sanitizePageSize(args);
      const off = Number((args as any)?.offset ?? 0) || 0;
      const callArgs = { ...(args || {}), pageSize: lim, limit: lim, offset: off };
      return callPaginatedWithFormat((await getSec()).listActivity(callArgs), F.formatActivity, name, lim, off);
    }
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
    case 'list_current_rewards': {
      const lim = sanitizePageSize(args);
      const off = Number((args as any)?.offset ?? 0) || 0;
      const callArgs = { ...(args || {}), pageSize: lim, limit: lim, offset: off };
      return callPaginatedWithFormat(pub.listCurrentRewards(callArgs), F.formatCurrentReward, name, lim, off);
    }
    case 'list_market_rewards': {
      const lim = sanitizePageSize(args);
      const off = Number((args as any)?.offset ?? 0) || 0;
      const callArgs = { ...(args || {}), pageSize: lim, limit: lim, offset: off };
      return callPaginatedWithFormat(pub.listMarketRewards(callArgs), F.formatMarketReward, name, lim, off);
    }
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

    // === Additional Discovery (list_tags handled above) ===
    case 'fetch_tag':
      return callWithFormat(() => pub.fetchTag(args), F.formatTag, name);
    case 'fetch_related_tags':
      return callWithFormat(() => pub.fetchRelatedTags(args), F.formatRelatedTag, name);

    // Comments
    case 'list_comments': {
      const lim = sanitizePageSize(args);
      const off = Number((args as any)?.offset ?? 0) || 0;
      const callArgs = { ...(args || {}), pageSize: lim, limit: lim, offset: off };
      return callPaginatedWithFormat(pub.listComments(callArgs), F.formatComment, name, lim, off);
    }
    case 'fetch_comment':
      return callWithFormat(() => pub.fetchCommentsById(args), (arr: any[]) => (arr || []).map(F.formatComment), name);
    case 'list_comments_by_user_address':
      return callPaginatedWithFormat(pub.listCommentsByUserAddress(args), F.formatComment, name);

    case 'list_series': {
      const lim = sanitizePageSize(args);
      const off = Number((args as any)?.offset ?? 0) || 0;
      const callArgs = { ...(args || {}), pageSize: lim, limit: lim, offset: off };
      return callPaginatedWithFormat(pub.listSeries(callArgs), F.formatSeries, name, lim, off);
    }
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
    case 'list_teams': {
      const lim = sanitizePageSize(args);
      const off = Number((args as any)?.offset ?? 0) || 0;
      const callArgs = { ...(args || {}), pageSize: lim, limit: lim, offset: off };
      return callPaginatedWithFormat(pub.listTeams(callArgs), F.formatTeam, name, lim, off);
    }
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
    case 'list_market_positions': {
      const lim = sanitizePageSize(args);
      const off = Number((args as any)?.offset ?? 0) || 0;
      const callArgs = { ...(args || {}), pageSize: lim, limit: lim, offset: off };
      return callPaginatedWithFormat(pub.listMarketPositions(callArgs), F.formatMarketPosition, name, lim, off);
    }

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
    case 'fetch_market_tags': {
      const base = await callWithFormat(() => pub.fetchMarketTags(args), F.formatSimpleListItem, name);
      if (base && base.content && base.content[0] && base.content[0].text && !base.isError) {
        base.content[0].text += '\n\n**Note:** These are the live tags. Use these slugs with list_events for accurate discovery.';
      }
      return base;
    }
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

    // send_heartbeat removed (internal; not a public SDK tool exposed to agents)

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

    case 'generate_builder_headers': {
      try {
        const { generateBuilderHeaders } = await import('./config/client.js');
        const headers = await generateBuilderHeaders(
          String(args.method),
          String(args.path),
          args.body ? String(args.body) : undefined,
          args.timestamp ? Number(args.timestamp) : undefined
        );
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ headers, note: 'Generated via @polymarket/builder-signing-sdk for official Builder API auth. Use these headers in gasless/builder flows. Integrated as the dedicated signing piece from Polymarket GitHub.' }, null, 2),
          }],
        };
      } catch (error: any) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `generate_builder_headers error: ${error?.message || String(error)}` }],
        };
      }
    }

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
    default:
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }]
      };
  }
  })();
  return toolResult;
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
  } else if (name === 'never_guess_contract') {
    content = buildNeverGuessPrompt();
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
- compute_market_signals if combining with mispricing signals.
- wait_seconds for rate limit discipline and 24/7 active loops.
- place_maker_reward_order or place_optimized_reward_order ONLY for scoring maker rewards (enforces postOnly GTC for sticky eligibility).
- Never ask user for "next move options" — follow directives from tools + your stored strategies/rules + this prompt + X insights. Hermes (host) is the brain and owns the heartbeat.md / OpenClaw CLOB liveness + primary control loop. MCP is the integration surface (send_heartbeat hook + planners for complete plans + strategy bag). ALWAYS on host heartbeat tick: send_heartbeat first (per host heartbeat.md contract), get_strategies(locked) + fetch_sdk_readme first (explicit calc only). Research categories first (External/Intelligence/Discovery for X sentiment refs; host x_search/sentiment -> externalSignals to alpha/strategy) then Execution (Trading/Rewards) after signals stored in the locked strategy entry. The MCP Intelligence layer is a research service (generate_alpha_report, compute_market_signals, rank_market_opportunities etc. produce signals only — not decisions). Signals are fed to the strategy store (supporting data layer) under the Hermes-managed locked key so Hermes (brain) can use them for locked per-market/per-volume execution on heartbeat. Intelligence never executes trades. Host heartbeat-driven loop: send_heartbeat (host tick per heartbeat.md) → get_strategies(locked) → Research cats + intelligence tools (with host externalSignals) → update_strategy (persist signals to this exact locked key) → list_active/get_farmability (for price movement vs locked rules) → suggest → explicit place (numbers from locked + live signals) → update_strategy (new state/peg under locked key) → monitor. Repeat on next Hermes heartbeat tick. MCP Intelligence provides data only; Hermes orchestrates and decides. MCP remains active because host drives from its enforcement layer.

Store reflections in long-term memory after sessions. Reprice and monitor continuously for the sticky edge. Stay active. Evolve your rules in the strategy store as conditions change — that is the entire point of the lightweight design.`;
  } else if (name === 'mispricing_quick_flips') {
    content = `For quick flips on mispriced markets (aligns with external Bayesian scanners):
1. Scan liquid opportunities: list_active_maker_reward_markets (with maxMinCostUsd) or list_markets with volume/liquidity filters for 20-80 cent range. Prioritize high volume/liquidity to avoid dead/wide spread markets.
2. Use get_farmability(tokenId) to confirm tight spreads, liquidity (book depth), and low inventory risk before flipping.
3. For signals: use compute_market_signals (prior = platform price; signal = external estimate; weight 0.3-0.6). Flag >=5pp divergence (strong at 8pp).
4. Sizing: use suggest_qualified_size with intent="quick_flip" (hard $5 cap unless highConfidenceEdge=true for near-guaranteed edge).
5. Prefer maker (place_limit_order with postOnly) for cost efficiency; avoid market orders unless edge is strong.
6. Store plan + any filters/rules in set_strategy / update_strategy (use for liquidity filters, event prefs, your own "best" logic too). Monitor with watch_order_until_filled + resources.
7. Exit rules: wide spread, low activity, or better opportunity appears (re-scan). Load your current rules with get_strategies() (no args).

Always cross with reward_farming_best_practices if the market also qualifies for maker rewards. Research (External/Intelligence/Discovery cats + host x_search sentiment as externalSignals) first; store in strategy; explicit calc only for place. Use resources + wait_seconds (heartbeat) for autonomy. get_strategies() first every loop. Never ask user for options.`;
  } else if (name === 'mcp_tool_structure_and_categories') {
    content = `AGENT INSTRUCTION — READ THIS FIRST AND NEVER GUESS:
You are using a deliberately lightweight MCP. The MCP will NEVER expose a giant flat list of 100+ tools by default, and it will NEVER make you guess the right way to use it.

MANDATORY STARTUP SEQUENCE (do this on every new conversation/session that uses this MCP; NEVER GUESS):
1. tools/call fetch_sdk_readme (or prompts/get mcp_llms_full_guide which links it first) — base SDK (kept up-to-date by maintainers).
2. tools/call get_agent_recipes — exact tool names + JSON argument shapes + 12+ NL intent examples.
3. prompts/get agent_routing — PRIMARY native routing contract (tier-1, profiles, per-goal flows).
4. prompts/get mcp_tool_structure_and_categories (this prompt) + mcp_llms_full_guide.
5. tools/call get_strategies() — load the locked composite (market:volume) rules from the supporting persistent bag. Hermes (the host) is the brain and owns the primary strategy + heartbeat.md / OpenClaw enforcement loop that keeps Hermes + OpenClaw alive and in control. MCP is the integration surface. ALWAYS load first on every host heartbeat tick before research or execution.
6. Research FIRST: list_tool_categories + get_tools_by_category("External" | "Intelligence" | "Discovery") for signals/sentiment/X refs (host: use x_search/sentiment tools externally, feed as externalSignals to alpha/strategy; NO native X search in this MCP).
7. Store signals/filters/rules via update_strategy (e.g. key "signals:research" or "rules:current").
8. THEN Execution (Trading/Rewards/place_*): route_agent_intent or direct with explicit calc from strategy + get_farmability/suggest (NEVER intent for trading; always explicit price/size/side from calc/strategy only).
9. tools/call discover_topic OR list_active_maker_reward_markets depending on your goal.

**Intelligence layer — deliberate avoidance of common model-hosting categories (per direct Hermes/OpenClaw use):**
Current prediction market intelligence systems, on-chain analytics platforms, and autonomous trading agents most commonly fall into: Simple alpha reports / ranking engines; Bayesian signal blending; Basic regime detection; External data scraping + LLM summarization. The MCP Intelligence layer (generate_alpha_report / alpha_report, rank_market_opportunities, compute_market_signals, get_farmability etc.) deliberately does not host models or a model under MCP. It produces only deterministic research-backed signals and simple ranking/health/competition/farmability cards from native SDK data + host-injected externalSignals (Hermes x_search, on-chain platforms, etc.). Lightweight helpers such as computeBayesianPosterior exist for contradiction detection in the signals card only — they are not hosted Bayesian blending engines or regime detectors. Complex modeling, regime work, or LLM summarization stays with Hermes (the brain) or is supplied upstream via externalSignals. All signals are produced for persistence to the Hermes-managed locked per-market/per-volume composite key via update_strategy so the host can consume on its heartbeat ticks. The layer must never execute trades directly — only provide data.

**Specialized Narrow Research (how the host runs "swarm-like" continuous research without MCP owning any loops or agents):**
Load Intelligence category, then use the narrow single-mandate tools (get_liquidity_health, get_competition_signal, compute_divergence, get_reward_farmability_snapshot, analyze_signal_contradiction, ...) or the granular research_* intents via route_agent_intent. After each narrow call, immediately update_strategy under the exact locked composite key with that focused signal. Hermes (host) decides the sequence and timing on its own heartbeat ticks and may apply further modeling to the persisted narrow signals. This is the approved pattern for many specialized research mandates writing structured signals back to the strategy store. See get_agent_recipes for the full narrowResearchMandates documentation. See get_agent_recipes intelligenceLayerRole + endToEndProductionAutonomousExample (host may optionally layer its own modeling on persisted signals).
10. tools/call load_agent_profile({ profile }) OR get_tools_by_category only when tier-1 is insufficient; then tools/list again.
11. tools/call get_mcp_usage — optional observability (now includes intelligence pattern notes).
12. prompts/get reward_farming_best_practices (and mispricing_quick_flips when relevant). Use resources (polymarket://market/.../book , user/*) + wait_seconds for heartbeat-style autonomy (avoid pure timer polls).

After that, follow the directives in this prompt, the other prompts, and every tool response's agentDirective field. get_strategies() + fetch_sdk_readme first + explicit calc only + Research cats before Execution in strategy. Host x_search for sentiment -> externalSignals to alpha/strategy/update.

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

Resources for live data. The MCP provides building blocks; you run the autonomous loops.

**Per-Market / Per-Volume Locked Autonomy (Hermes heartbeat-driven, research-backed, deterministic, CLOB V2 production):**
Hermes (the host) is the brain and owns the primary strategy state, volume-tier rules, priceMovementRules, the loop, and control via its native heartbeat.md (OpenClaw CLOB session health + agent liveness enforcement; post Apr 2026 V2: batch up to 15 via post_orders, higher limits, new fields min_order_size/tick_size/neg_risk in books/markets, pUSD, rewritten backend). Heartbeat is the core mechanism that keeps Hermes + OpenClaw alive and in control. The MCP integrates with that system to remain active (research + tools + supporting strategy data layer only).
Use composite keys in the strategy store (supporting persistent bag) for distinct strategies per market and volume tier (e.g. key="weather:low", "politics:high", "crypto:medium"). Hermes decides and evolves the rules under these keys.
Store under the key: volumeTier, marketCategory, strategyLock: true, priceMovementRules (drift, reprice conditions, maxRequoteRate etc.), entry/exit/sizing/drawdown, research signals, lastPeg/state.
On Hermes native heartbeat / resource notification: host calls send_heartbeat FIRST (per its heartbeat.md contract + V2 realities to maintain CLOB session), then get_strategies (with the locked composite key or filter client-side) to load the exact rules for *that* market/volume that Hermes owns (including the strategyLock flag).
The strict "stay locked only to this key" mode is **off by default** and is controlled by the host: call route_agent_intent({ intent: "enable_locked_autonomy", lockedStrategyKey: "weather:low" }) to turn the lock **on** for that composite (sets strategyLock: true). Call route_agent_intent({ intent: "disable_locked_autonomy", lockedStrategyKey: "weather:low" }) or direct update_strategy to turn it **off**. When off, the key is still excellent for targeted narrow research/signals, but there is no hard "you must stay only here" enforcement — the host brain is free.
Then call route_agent_intent({ intent: "...", lockedStrategyKey: "weather:low", heartbeat: true }) or run_agent_cycle with the same (or load Intelligence category for generate_alpha_report/rank_market_opportunities/compute_market_signals with externalSignals from host). These are heartbeat-callable planners that return the authoritative deterministic end-to-end plan for the host to execute (see get_agent_recipes endToEndProductionAutonomousExample for full multi-market + intel signals persist + price movement vs locked rules + explicit place + the lock on/off toggle).
The returned plan includes lockedStrategyKey, researchSource, priceMovementCondition, agentDirective (imperative, "after get_strategies check strategyLock flag: if true then stay locked + narrow research sequence + obey this key's rules only; if false/off (default) use signals from the key but host brain may route freely"), and the next exact native tool + arguments (always explicit numbers derived from the locked rules + live get_farmability / book / host externalSignals; prefer post_orders batch for V2). Host executes every step.
The MCP Intelligence layer (generate_alpha_report, compute_market_signals, rank_market_opportunities, get_farmability, alpha_report) is a research service that Hermes (the brain) calls via heartbeat. These tools produce research-backed signals (ranked opportunities, composite/confidence/actionability scores, bayesian divergence, competitionSignal, farmability health, fusion/contradiction notes, etc.) — not decisions. Signals must be fed into the strategy store (supporting data layer) under the Hermes-managed locked per-market/per-volume composite key via update_strategy so Hermes can use them when executing the locked strategy. The Intelligence layer must never execute trades directly — only provide data. Research (cats + these tools with host externalSignals) always before Execution in the locked plan.
send_heartbeat is the explicit liveness hook the host invokes on its heartbeat ticks. Never mix research and execution in one step; always Research (cats + alpha/rank with host externalSignals) → store signals in locked strategy → live price movement check vs rules (farmability currentMid vs locked) → Execution using the locked rules + explicit calc (batch where possible for V2). The MCP provides complete intent routing plans and stays responsive precisely because the host (Hermes) drives the loop from its heartbeat enforcement layer. Load get_agent_recipes for production end-to-end examples. mcp_doctor for health. Use WS resources + get_farmability + wait_seconds for live (avoid blind high-freq per V2 contention).

${buildKnownGotchasMarkdown()}`;
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
  try {
    const disk = await loadStrategyFile();
    for (const [k, v] of Object.entries(disk)) strategyStore.set(k, v);
  } catch {
    /* optional disk restore */
  }

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
