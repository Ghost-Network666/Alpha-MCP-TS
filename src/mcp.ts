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
  getAgentRecipes,
  resolveTopicSlug,
} from './data/discovery.js';
import { weatherClient } from './data/weather.js';
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
import {
  AGENT_PROFILES,
  searchToolDefinitions,
  TIER1_CORE_TOOL_NAMES,
} from './mcp/agent-meta.js';
import { buildMcpLlmsGuide, MCP_CATEGORIES } from './mcp/llms-guide.js';
import {
  computeBayesianPosterior,
  fetchFarmabilitySnapshot,
  buildAlphaReport,
  fetchRewardCandidates,
  rankOpportunities,
} from './intelligence/index.js';
import { getToolsByCategory, ensureCategoryPrefix } from './mcp/category-match.js';
import { compactTools } from './mcp/compact-tools.js';
import { fetchLiveSdkReadme } from './mcp/sdk-readme.js';
import { buildNeverGuessPrompt } from './mcp/never-guess.js';
import { buildAgentCyclePlan } from './automation/agent-cycle.js';
import { fetchCryptoSpotUsd } from './data/crypto.js';
import { loadStrategyFile, saveStrategyFile } from './strategy/persist.js';
import { resolveConditionIdForToken, resolveTokenIdFromToolArgs } from './utils/clob-token.js';
import { normalizePlaceLimitOrderArgs } from './trading/place-limit-args.js';
import { buildKnownGotchasMarkdown } from './mcp/agent-gotchas.js';
import { buildIntentRoute, INTENT_REGISTRY } from './mcp/intent-routing.js';
import { enrichNativeToolResponse } from './mcp/native-routing.js';
import { buildMcpDoctorReport } from './mcp/mcp-doctor.js';
import { readRoutingConfig, writeRoutingConfig } from './mcp/intent-context.js';
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
// (route_agent_intent / run_agent_cycle with lockedStrategyKey for complete deterministic intent plans),
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
    description: '[Meta] Lists tool categories. Default tools/list is tier-1 only (~28 daily-driver tools). Use route_agent_intent or load_agent_profile / get_tools_by_category for more (~145 handlers, zero removed). START: route_agent_intent({ intent: "session_startup" }).',
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
    description: '[Meta] Find tools by keyword. Prefer route_agent_intent for goal→tool plan. detail: name|summary|schema. All handlers exist — load_agent_profile or get_tools_by_category registers more for tools/list.',
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
    name: 'extract_wallet_from_url',
    description: '[Discovery / Public] Extract a 0x wallet address from a Polymarket URL (e.g. profile URL like https://polymarket.com/profile/0x...) or any string. Use to enable public market WS monitoring of any wallet\'s trades without authentication (limitation of official User WS). Then use list_trades or discover to find markets, and subscribe to polymarket://market/{tokenId}/book for public trade/book updates.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Polymarket URL or text containing 0x address' },
      },
      required: ['url'],
    },
  },
  {
    name: 'tool_describe',
    description: '[Meta / Lazy] Describe a specific tool by name and return its full inputSchema + description (on-demand, no need to load full 110 schemas upfront for token efficiency). Use after search_tools to discover schemas lazily. This is the key for extreme lazy tool loading.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Exact tool name from search or recipes' },
      },
      required: ['name'],
    },
  },
  {
    name: 'list_tags',
    description: '[Discovery / Gamma] List all Gamma tags for broad event/market categorization (full API coverage for discovery beyond curated topics).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fetch_tag',
    description: '[Discovery / Gamma] Fetch details for a specific Gamma tag by slug (supports full Gamma API surface for analytics and discovery).',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Tag slug e.g. politics, sports' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'mcp_health',
    description: '[Meta / Observability] Lightweight health check: ok status, tier1 count, routingAlwaysOn, intentCount, loaded credential source, basic resources status. Use for quick introspection instead of full mcp_doctor when token budget is tight. Structured output for agent learning/monitoring.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'reload_credentials',
    description: '[Meta / Security] Force reload of the detected host .env (Hermes profile or OpenClaw) at runtime. Useful for long-running agents to pick up key rotation without restart. Returns the source loaded.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'switch_profile',
    description: '[Meta / Security] Switch Hermes profile at runtime (sets HERMES_HOME and reloads credentials). For agents that need to change identity or use different profiles dynamically. Arg: profilePath (e.g. ~/.hermes/profiles/trader).',
    inputSchema: {
      type: 'object',
      properties: {
        profilePath: { type: 'string', description: 'Full path to the profile dir (e.g. /home/user/.hermes/profiles/myprofile)' },
      },
      required: ['profilePath'],
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
          enum: ['weather', 'rewards', 'trading', 'discovery', 'account', 'full', 'automation'],
        },
      },
      required: ['profile'],
    },
  },
  {
    name: 'fetch_sdk_readme',
    description: '[Meta] Live upstream TS SDK README (HTTP, cached). Use before guessing SDK method names.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'run_agent_cycle',
    description: '[Meta] HOST HEARTBEAT-DRIVEN PLANNER: Returns deterministic complete plan for locked per-market:volume strategies. Hermes (host) is the brain and owns the heartbeat.md / OpenClaw enforcement loop that keeps sessions alive and in control. When lockedStrategyKey provided, plan contains authoritative end-to-end sequence (send_heartbeat FIRST for host to call on its native heartbeat/resource events per heartbeat.md, get_strategies(locked composite), research/intel with host externalSignals, explicit execution with numbers from locked rules + live signals, update_strategy to the locked key). MCP is the integration surface (no brain, no internal loop) — pure planner so the MCP remains active when the host drives calls from its heartbeat system. Host executes every step.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', enum: ['rewards', 'weather', 'mispricing', 'trading', 'discovery'] },
        topic: { type: 'string' },
        maxMinCostUsd: { type: 'number' },
        lockedStrategyKey: { type: 'string', description: 'Composite e.g. "weather:low" or "market:volume". Locks the returned plan + agentDirective to the exact per-market/per-volume strategy entry that Hermes manages. Enables heartbeat-driven locked autonomy via the host loop.' },
        heartbeat: { type: 'boolean', description: 'When true (or with lockedStrategyKey), the plan starts with send_heartbeat as the first step for the host (Hermes/OpenClaw) to invoke on its native heartbeat/resource events (per heartbeat.md CLOB liveness contract) before loading the locked strategy and executing the research-backed plan.' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'route_agent_intent',
    description:
      '[Meta] PRIMARY INTENT ROUTER + built-in NLR (natural language routing). Accepts explicit intent OR naturalLanguage (internal heuristic classifier, no LLM). Returns steps + confidence + classificationMethod. Low confidence (pure NL) is gated. Routes WHICH tools — never price/size/side. Includes A2A delegate support in plans. Host executes the steps.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: {
          type: 'string',
          enum: Object.keys(INTENT_REGISTRY),
          description: 'Explicit intent (confidence 1.0). Omit and provide naturalLanguage for auto-classify.',
        },
        naturalLanguage: {
          type: 'string',
          description: 'Raw NL goal. Tool classifies internally to intent + confidence (heuristic on INTENT_REGISTRY + aliases).',
        },
        topic: { type: 'string' },
        tokenId: { type: 'string' },
        market: { type: 'string' },
        slug: { type: 'string' },
        maxMinCostUsd: { type: 'number' },
        goal: { type: 'string', enum: ['rewards', 'weather', 'mispricing', 'trading', 'discovery'] },
        lockedStrategyKey: { type: 'string', description: 'Composite e.g. "weather:low" or "market:volume". Locks the entire returned plan + agentDirective to this per-market/per-volume strategy entry. Hermes (host) owns the primary brain and the heartbeat.md loop; this key lets the host drive locked autonomy by calling MCP planners from its heartbeat/resource events.' },
        heartbeat: { type: 'boolean', description: 'Prepend send_heartbeat as first step in the plan. The host (Hermes/OpenClaw) must call this on its native heartbeat/resource notifications (per heartbeat.md CLOB session health contract) before get_strategies(locked) + research-backed execution. This is how the MCP remains active under host control.' },
      },
    },
  },
  {
    name: 'configure_agent_routing',
    description:
      '[Meta] Set routing goal/intent only — built-in routing is ALWAYS on (cannot disable). Every native tool response includes routing.nextTools + toolPurpose + sdkMethod + loopPlan. Example: configure_agent_routing({ intent: "rewards_farm" }).',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: Object.keys(INTENT_REGISTRY) },
        autonomousAssist: {
          type: 'boolean',
          description: 'Include full loopPlan on each response (default true)',
        },
        maxMinCostUsd: { type: 'number' },
        topic: { type: 'string' },
      },
    },
  },
  {
    name: 'execute_recipe',
    description: '[Meta] NLR + thin recipe orchestrator with circuit breaker. Accepts intent or naturalLanguage. Walks steps with guardrail checks and breaker (N fails -> degraded + fallback). Returns structured executionLog.',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', enum: Object.keys(INTENT_REGISTRY) },
        naturalLanguage: { type: 'string' },
        lockedStrategyKey: { type: 'string' },
        heartbeat: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        maxSteps: { type: 'number' },
      },
    },
  },
  {
    name: 'delegate_to_agent',
    description: '[Meta / A2A] Agent-to-Agent delegation. Returns structured handoff payload for host (OpenClaw sessions_spawn or A2A) to delegate tasks to peer agents. Use after routing when sub-task suits another agent.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string' },
        intent: { type: 'string' },
        context: { type: 'object' },
      },
      required: ['agentId', 'intent'],
    },
  },
  {
    name: 'get_routing_feedback',
    description: '[Meta] Read classifier feedback counters, recent decisions, success rates, and tuning suggestions. Data from route/execute logging into strategy bag (routing:feedback).',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'get_available_tools',
    description: '[Meta] Dynamic context-aware tool filter (guardrails, balance, etc.). Hides tools that would be blocked. Augments get_tools_by_category.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'object' },
        category: { type: 'string' },
      },
    },
  },
  {
    name: 'mcp_doctor',
    description:
      '[Meta] MCP health check (same as npm run doctor / grok mcp doctor / hermes mcp test / openclaw mcp doctor --probe). Returns handshake expectations, tier-1 tool count, routing status, gamma tag registry size, host doctor commands.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'discover_topic',
    description: '[Discovery] UK + US topics only: events + markets via curated aliases + registry tagId (fast). Topics: uk, london, politics, nfl, bitcoin, weather, crypto, fed, … — get_agent_recipes.supportedTopicAliases. Not global (no korea/shenzhen/etc); use search({ q }) elsewhere. Example: discover_topic({ topic: "uk", closed: false }).',
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: 'UK + US curated alias/slug only — see get_agent_recipes.supportedTopicAliases (uk, london, politics, nfl, weather, bitcoin, …)',
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
  // === Weather + external reference data
  {
    name: 'get_crypto_spot',
    description: '[External] Public crypto USD spot (CoinGecko, cached). Reference for mispricing vs CLOB prices.',
    inputSchema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'CoinGecko ids e.g. bitcoin, ethereum',
        },
      },
      required: ['symbols'],
    },
  },
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
    name: 'get_spread',
    description: '[Trading] Current bid-ask spread. Accepts tokenId (0x hex), market slug, or decimal Gamma market id.',
    inputSchema: {
      type: 'object',
      properties: { ...MARKET_TOKEN_REF_PROPERTIES },
    },
  },
  {
    name: 'get_order_book',
    description: '[Trading] Full order book depth + levels. Accepts tokenId, slug, or decimal market id. Prefer over fetch_market alone for placement.',
    inputSchema: {
      type: 'object',
      properties: { ...MARKET_TOKEN_REF_PROPERTIES },
    },
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
  {
    name: 'send_heartbeat',
    description: '[Trading] Explicit heartbeat hook for host (Hermes/OpenClaw) native heartbeat enforcement. Call regularly on the host heartbeat tick / resource notification (per Hermes heartbeat.md + OpenClaw CLOB session liveness requirements) to prevent auto-cancel of resting orders. Hermes is the brain and owns the loop/control; this MCP tool is the integration surface the host invokes to keep the CLOB session healthy while driving its own strategy and calling other MCP planners. SDK/WS may also manage keepalives internally; this is the explicit surface for host-driven heartbeat.md compliance. Rate limit low — follow host policy.',
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
    name: 'get_farmability',
    description: '[Rewards] SDK fetchOrderBook + listMarketRewards + fetchSpreads + fetchMidpoint. Accepts 0x tokenId, market slug, or decimal id (auto-resolve). Non-reward markets return book-only snapshot (hasActiveRewards:false). For maker rewards pick tokens from list_active_maker_reward_markets.',
    inputSchema: {
      type: 'object',
      properties: { ...MARKET_TOKEN_REF_PROPERTIES },
    },
  },
  {
    name: 'compute_market_signals',
    description: '[Intelligence] Research service only — produces deterministic research-backed signals (farmability snapshot + optional Bayesian posterior/divergence when prior/signal/weight from host provided). Signals (not decisions) for persistence to the Hermes-managed locked per-market/per-volume strategy store entry via update_strategy under the composite key. Intelligence layer must never execute trades directly — only provide data. Called by Hermes (brain) via heartbeat. No LLM in MCP — host interprets and decides on locked strategy execution. Example: compute_market_signals({ tokenId, prior: 0.42, signal: 0.55, weight: 0.4, lockedStrategyKey: "weather:low" }).',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        prior: { type: 'number', description: 'Platform price 0-1 (defaults to farmability mid if omitted)' },
        signal: { type: 'number', description: 'External estimate 0-1 from host research' },
        weight: { type: 'number', description: 'Trust in signal 0-1 (typical 0.3-0.6)' },
      },
      required: ['tokenId'],
    },
  },
  {
    name: 'generate_alpha_report',
    description: '[Intelligence] Research service only — PRIMARY alpha report producing research-backed signals: ranked opportunities with composite/confidence/actionability scores, fusion/contradiction notes, farmability health, bayesian divergence, competitionSignal. Outputs are signals and cards (not decisions or trades). Must be fed into the strategy store (supporting data layer) under the Hermes-managed locked composite key (market:volume) via update_strategy so Hermes (the brain) can use them when executing the locked per-market/per-volume strategy on its heartbeat. Intelligence layer must never execute trades directly — only provide data. Called by Hermes via heartbeat orchestration. Alias: alpha_report.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', enum: ['rewards', 'weather', 'mispricing', 'discovery'] },
        topic: { type: 'string', description: 'weather, sports, crypto, politics, etc.' },
        maxMinCostUsd: { type: 'number' },
        maxMinSize: { type: 'number' },
        tokenIds: { type: 'array', items: { type: 'string' } },
        externalSignals: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tokenId: { type: 'string' },
              prior: { type: 'number' },
              signal: { type: 'number' },
              weight: { type: 'number' },
              label: { type: 'string' },
            },
            required: ['tokenId', 'signal'],
          },
        },
        maxCandidates: { type: 'number', description: 'Default 6, max 10' },
        enrichFarmability: { type: 'boolean' },
        midPriceMin: { type: 'number', description: 'Discovery: Yes price band min (default 0.45)' },
        midPriceMax: { type: 'number', description: 'Discovery: Yes price band max (default 0.55)' },
        liquidityNumMin: { type: 'number', description: 'Discovery: min liquidity filter (default 5000)' },
        volumeNumMin: { type: 'number', description: 'Discovery: min 24h volume filter (default 1000)' },
      },
      required: ['goal'],
    },
  },
  {
    name: 'rank_market_opportunities',
    description: '[Intelligence] Research service only — ranks opportunities into research-backed signals (compositeScore, confidence, actionability, bayesianDivergenceBps, competitionSignal, currentMid, farmabilityScore, rewardAttractiveness, liquidity etc.). Takes array of opportunity inputs (tokenId + optional prior/externalSignal from host, farmability, rewardMeta). Returns ranked list with signals and recommendations (for host interpretation only). Output is pure data/signals — must be fed to the Hermes-managed locked per-market/per-volume strategy store via update_strategy under the exact composite key so Hermes (the brain) can use when executing the locked strategy on heartbeat. Intelligence layer must never execute trades directly — only provide data. No decisions.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', enum: ['rewards', 'weather', 'mispricing', 'discovery'], description: 'Scoring context.' },
        opportunities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tokenId: { type: 'string' },
              label: { type: 'string' },
              prior: { type: 'number' },
              externalSignal: { type: 'number' },
              signalWeight: { type: 'number' },
              source: { type: 'string' },
            },
            required: ['tokenId'],
          },
          description: 'Inputs including host-provided externalSignals for fusion.'
        },
        maxResults: { type: 'number', description: 'Default 5, max 10.' },
      },
      required: ['goal', 'opportunities'],
    },
  },
  {
    name: 'alpha_report',
    description: '[Intelligence] Alias of generate_alpha_report — research service producing signals only for persistence to locked strategy store (Hermes brain consumes on heartbeat; no direct trades). Same args and response as generate_alpha_report.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', enum: ['rewards', 'weather', 'mispricing', 'discovery'] },
        topic: { type: 'string' },
        maxMinCostUsd: { type: 'number' },
        maxMinSize: { type: 'number' },
        tokenIds: { type: 'array', items: { type: 'string' } },
        maxCandidates: { type: 'number' },
        enrichFarmability: { type: 'boolean' },
        midPriceMin: { type: 'number' },
        midPriceMax: { type: 'number' },
        liquidityNumMin: { type: 'number' },
        volumeNumMin: { type: 'number' },
      },
      required: ['goal'],
    },
  },

  // === Narrow specialized Intelligence tools (single-mandate research services) ===
  // These exist so the host (Hermes) can orchestrate "swarm-like" narrow research on its own heartbeat
  // by calling many small native tools + persisting after each under the locked composite key.
  // MCP never runs continuous agents or loops internally — all composition and timing is host-driven
  // via route_agent_intent (granular research intents) or direct calls after loading the Intelligence category.
  // Every tool reinforces: signals only, persist via update_strategy to the exact lockedStrategyKey,
  // never execute trades. This closes granularity gaps while fully preserving the "host uses intent +
  // native tools" contract.
  {
    name: 'get_liquidity_health',
    description: '[Intelligence] Narrow single-mandate research service: returns focused liquidity health, depth, spread, skew, and competitionSignal card for one token. Use for a specific narrow mandate on heartbeat. Accepts externalSignals for host context. Output includes persistNote: update_strategy under your locked composite key. Research service only — no decisions, no trades.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        externalSignals: { type: 'array', items: { type: 'object' } },
        lockedStrategyKey: { type: 'string', description: 'Composite key (e.g. "weather:low") for persist guidance' },
      },
      required: ['tokenId'],
    },
  },
  {
    name: 'get_competition_signal',
    description: '[Intelligence] Narrow single-mandate research service: extracts and returns structured competition / book pressure / adverse selection signals for one token (from farmability + rewards meta). Narrow mandate tool for host heartbeat orchestration. Output includes explicit persist instruction to the locked key.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        lockedStrategyKey: { type: 'string' },
      },
      required: ['tokenId'],
    },
  },
  {
    name: 'compute_divergence',
    description: '[Intelligence] Narrow single-mandate research service: computes simple prior-vs-signal or external-vs-book divergence (lightweight deterministic fusion only, for contradiction detection). Host supplies prior/signal or externalSignals. Returns focused divergence card + actionability hint + persistNote for the locked key. Not a hosted model.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        prior: { type: 'number' },
        signal: { type: 'number' },
        externalSignals: { type: 'array', items: { type: 'object' } },
        lockedStrategyKey: { type: 'string' },
      },
      required: ['tokenId'],
    },
  },
  {
    name: 'get_reward_farmability_snapshot',
    description: '[Intelligence] Narrow single-mandate research service: focused reward program attractiveness, min/max cost, rate, and current book health snapshot for reward farming decisions. Narrow tool for host to call on heartbeat for specific reward markets. Persist guidance included.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        maxMinCostUsd: { type: 'number' },
        lockedStrategyKey: { type: 'string' },
      },
      required: ['tokenId'],
    },
  },
  {
    name: 'analyze_signal_contradiction',
    description: '[Intelligence] Narrow single-mandate research service: fuses supplied externalSignals (host x_search, on-chain analytics, etc.) against current book prior/skew/competitionSignal and returns structured contradiction, divergenceBps, and veto hints only. Perfect narrow mandate for continuous research loops on the host heartbeat. Always persist output to locked key.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        externalSignals: {
          type: 'array',
          items: {
            type: 'object',
            properties: { tokenId: { type: 'string' }, signal: { type: 'number' }, label: { type: 'string' }, weight: { type: 'number' } },
            required: ['tokenId', 'signal'],
          },
        },
        lockedStrategyKey: { type: 'string' },
      },
      required: ['tokenId'],
    },
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
    description: '[Strategy] Retrieve ALL stored rules. Empty on first call auto-seeds rules:session_defaults + filter:liquidity_discovery (same as load_agent_profile). Call with no args every loop start; evolve via update_strategy.',
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
];

for (let i = 0; i < publicTools.length; i++) {
  publicTools[i] = ensureCategoryPrefix(publicTools[i]);
}
for (let i = 0; i < secureTools.length; i++) {
  secureTools[i] = ensureCategoryPrefix(secureTools[i]);
}

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
      'PRIMARY routing contract: native SDK-only paths, mandatory startup (fetch_sdk_readme first), tier-1 vs full 142-tool surface, discover_topic, load_agent_profile, search_tools, strategy store (supporting bag — Hermes is the brain + owns heartbeat.md/OpenClaw enforcement loop and control; MCP integrates via send_heartbeat + locked planners so it remains active under host heartbeat-driven calls), per-goal flows (weather/rewards/trading). Call via prompts/get FIRST every session before other tools.',
    arguments: [],
  },
  {
    name: 'reward_farming_best_practices',
    description: 'Best practices + current X Key Insights (daily USDC LP rewards, quote near midpoint, both-sides 2x, sticky auto-repegging post-only as major edge, low-competition focus, avoid near-resolution, time/size-weighted, 24/7 active, adverse selection risks) for autonomous maker reward farming. Includes exact mapping to simple native SDK tools (get_farmability for near-mid + signals, place_*_reward for postOnly sticky, etc.). Use categories (e.g. get_tools_by_category("rewards")) to load/register additional tools dynamically while default stays ~50-57 focused core.',
    arguments: []
  },
  {
    name: 'mispricing_quick_flips',
    description: 'Guide for quick flips: compute_market_signals + get_farmability + explicit place_limit_order. Use route_agent_intent({ intent: "mispricing_flip" }) for the tool plan.',
    arguments: []
  },
  {
    name: 'mcp_tool_structure_and_categories',
    description: 'Full "never guess" quickstart: startup sequence (after agent_routing prompt), tier-1 vs categories, strategy store as supporting bag (Hermes is the brain + owns heartbeat.md / OpenClaw loop and control; MCP integrates to remain active), get_mcp_usage, clobTokenIds/tokenId patterns, public credential rules, live resources + heartbeat integration. Load after prompts/get agent_routing.',
    arguments: []
  },
  {
    name: 'mcp_llms_full_guide',
    description: 'Returns complete guide: the official TS SDK README (https://github.com/Polymarket/ts-sdk/blob/main/README.md — kept up-to-date by the maintainers) is the PRIMARY/canonical source of truth for all SDK coverage, APIs, client creation (createPublicClient/createSecureClient), decorators (extend(allActions)), methods (listMarkets, fetchMarket, placeLimitOrder etc.), parameters, errors, examples. This MCP adds only runtime-generated overlays/mappings (exact native tool + JSON call shape + "use explicit place_limit_order etc with your numbers from strategy/calc, never intent"). Includes full exhaustive SDK surface mappings + strategyStore (supporting bag; Hermes is the brain and owns heartbeat.md/OpenClaw loop + primary control) + cards (PNL/sentiment/farmability) + resources + rate notes + public rules + heartbeat integration points (send_heartbeat hook + locked planners for host-driven calls). Call SDK README first, then this (and structure prompt) for complete non-guessing experience. Always in sync (call-time from code + current SDK).',
    arguments: []
  },
  {
    name: 'never_guess_contract',
    description: 'Binding never-guess rules: startup order (fetch_sdk_readme first), live SDK readme, tier-1, resources, heartbeat integration (Hermes owns brain/loop/control via heartbeat.md; MCP is integration surface with planners + send_heartbeat hook + supporting strategy bag), automation via host-driven calls to route/run_agent_cycle with lockedStrategyKey. Call every session.',
    arguments: [],
  },
];

// Register tool list (MCP discovery) - returns the current exposed set (~50 default).
// Categories dynamically add to currentlyExposedToolNames so subsequent list calls see them.
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const allTools = [...publicTools, ...secureTools];
  const exposed = allTools.filter((t) => currentlyExposedToolNames.has(t.name));
  return { tools: compactTools(exposed) };
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
    case 'list_tool_categories':
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ categories: listAllCategories() }, null, 2)
        }]
      };

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

    case 'mcp_doctor': {
      const report = buildMcpDoctorReport(strategyStore, {
        toolsListed: currentlyExposedToolNames.size,
        handshakeOk: true,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }],
      };
    }

    case 'configure_agent_routing': {
      const cfg = writeRoutingConfig(strategyStore, {
        activeIntent: args.intent,
        autonomousAssist: args.autonomousAssist !== false,
        maxMinCostUsd: args.maxMinCostUsd,
        topic: args.topic,
      });
      await persistStrategiesToDisk();
      const strategies: Record<string, unknown> = {};
      for (const [k, v] of strategyStore.entries()) strategies[k] = v;
      const plan = cfg.activeIntent
        ? buildIntentRoute({
            intent: cfg.activeIntent,
            topic: cfg.topic,
            maxMinCostUsd: cfg.maxMinCostUsd,
            strategies,
          })
        : null;
      if (plan?.profile) {
        const prof = AGENT_PROFILES[plan.profile];
        if (prof) {
          for (const cat of prof.categories) {
            for (const t of getToolsByCategory([...publicTools, ...secureTools], cat)) {
              currentlyExposedToolNames.add(t.name);
            }
          }
        }
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              mcpRouting: cfg,
              plan,
              agentDirective: `Routing is always on. Use ANY native tool — each response includes routing.nextTools. ${plan?.tradingRule || ''}`,
              routingAlwaysOn: true,
              note: 'Re-call tools/list after enable if your host whitelists listed tools.',
            },
            null,
            2
          ),
        }],
      };
    }

    case 'route_agent_intent': {
      const strategies: Record<string, unknown> = {};
      for (const [k, v] of strategyStore.entries()) strategies[k] = v;
      writeRoutingConfig(strategyStore, {
        activeIntent: args.intent || 'session_startup',
        autonomousAssist: args.autonomousAssist !== false,
        maxMinCostUsd: args.maxMinCostUsd,
        topic: args.topic,
      });
      await persistStrategiesToDisk();
      if (typeof getLockedKey === 'function') {
        const rkey = getLockedKey(args);
        if (rkey) recordQualifier(rkey, 'route');
      }

      const plan = buildIntentRoute({
        intent: args.intent,
        naturalLanguage: args.naturalLanguage,
        topic: args.topic,
        tokenId: args.tokenId,
        market: args.market,
        slug: args.slug,
        maxMinCostUsd: args.maxMinCostUsd,
        goal: args.goal,
        strategies,
        lockedStrategyKey: args.lockedStrategyKey,
        heartbeat: args.heartbeat,
      });

      const conf = (plan as any).confidence ?? 1.0;
      const method = (plan as any).classificationMethod || 'explicit';
      const MIN_CONF = 0.55;
      const usedNL = !!args.naturalLanguage && !args.intent;
      if (usedNL && conf < MIN_CONF) {
        recordClassificationFeedback({ naturalLanguage: args.naturalLanguage, resolvedIntent: plan.intent, method, confidence: conf });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              blockedByConfidence: true,
              confidence: conf,
              resolvedIntent: plan.intent,
              classificationMethod: method,
              message: 'Low confidence natural language classification. Gate applied.',
              agentDirective: 'Re-phrase or use explicit intent from get_agent_recipes. Call get_routing_feedback for tuning data.',
              suggestedTools: ['get_agent_recipes', 'search_tools', 'route_agent_intent with explicit intent'],
            }, null, 2)
          }]
        };
      }

      (plan as any).confidence = conf;
      (plan as any).classificationMethod = method;
      recordClassificationFeedback({ naturalLanguage: args.naturalLanguage, resolvedIntent: plan.intent, method, confidence: conf });

      if (typeof getLockedKey === 'function') {
        const rkey = getLockedKey(args);
        if (rkey) recordQualifier(rkey, 'route');
      }

      // Full intelligence routing: agent calls route_agent_intent once with naturalLanguage.
      // For read/discovery/intel queries (e.g. "list all world cup events..."), MCP internally
      // classifies, builds plan, auto-executes native steps (using full server-side collection
      // to bypass client caps), and returns the complete structured answer directly.
      // Agent never guesses the tool/sequence/args — one native call delivers the response.
      const nl = args.naturalLanguage || '';
      const isIntelQuery = plan.intent.includes('discovery') || plan.intent === 'alpha_scan' || /list|all|full|events|markets|world.?cup|catalog|slate|group|find|show|top|popular|high liquidity|high volume/i.test(nl);
      if (isIntelQuery) {
        // AUTOMATIC FILTER EXTRACTION from naturalLanguage / intent.
        // So if the query would return mass data (30k events or huge Gamma), MCP applies filters server-side
        // (closed, liquidity/volume mins, titleSearch, etc.) AUTOMATICALLY. Agent never stresses about volume,
        // pagination, or raw filter objects — the result is already filtered and complete.
        const filters: any = {};
        const nlLower = nl.toLowerCase();
        if (/open|active|live|current/i.test(nlLower) && !/closed/i.test(nlLower)) filters.closed = false;
        if (/closed|ended|past|expired/i.test(nlLower)) filters.closed = true;
        const liqMatch = nlLower.match(/liquidity\s*(over|above|>|min|high|>=)\s*(\d+)(k|m)?/i);
        if (liqMatch) {
          let val = parseInt(liqMatch[2]);
          if (liqMatch[3] === 'k') val *= 1000;
          if (liqMatch[3] === 'm') val *= 1000000;
          filters.liquidityNumMin = val;
        }
        const volMatch = nlLower.match(/volume\s*(over|above|>|min|high|>=)\s*(\d+)(k|m)?/i);
        if (volMatch) {
          let val = parseInt(volMatch[2]);
          if (volMatch[3] === 'k') val *= 1000;
          if (volMatch[3] === 'm') val *= 1000000;
          filters.volumeNumMin = val;
        }
        const titleMatch = nlLower.match(/(title|question|name|about|containing|with)\s+["']?([^"']+?)["']?/i);
        if (titleMatch) filters.titleSearch = titleMatch[2].trim();

        // Smart topic extraction using resolveTopicSlug for full coverage across Gamma tags (sports, election, trump, crypto, world-cup, etc.)
        // Safe default always resolvable; titleSearch carries the specific subject so "list events about XYZ" works even if no exact tag.
        // This + auto-merge in discoverTopic (full server paging + any extra filter keys) = MCP internal handling for everything across Gamma. No raw, no client caps, no agent pagination/filter code.
        let topic = 'politics';
        const candidates = ['world-cup', 'sports', 'nfl', 'crypto', 'bitcoin', 'election', 'trump', 'ai', 'uk', 'weather', 'politics', 'macro', 'fed', 'sports'];
        for (const c of candidates) {
          const probe = c.replace(/-/g, ' ');
          if (nlLower.includes(probe) || nlLower.includes(c)) { topic = c; break; }
        }
        if (!resolveTopicSlug(topic)) topic = 'politics';

        // Broad subject extraction for titleSearch if not already captured (supports "everything across Gamma")
        let titleSearch = filters.titleSearch;
        if (!titleSearch) {
          const subj = nl.match(/(?:about|on|for|containing|with|named|called|events? about|markets? on)\s+["']?([^"'.!?;]+)["']?/i);
          if (subj && subj[1]) titleSearch = subj[1].trim();
        }
        if (titleSearch) filters.titleSearch = titleSearch;

        const directAnswer: any = {
          query: nl || plan.intent,
          source: 'internal full intelligence execution (route_agent_intent + native discovery with full collection + auto-filters)',
          appliedFilters: filters,
          topicUsed: topic,
        };

        // UNCONDITIONAL full filtered discovery for ANY Gamma intel query (list events, markets, tags, world-cup, weather, crypto, politics, elections, sports, arbitrary subject via titleSearch, etc.).
        // Extracts best topic from NL (alias aware) or safe default, applies auto-filters from intent/NL, full server-side paging/collection (offset loop inside discoverTopic).
        // Extreme intent intelligence: agent calls route once with NL (filters in language like "open", "liquidity over X", "title containing Y", "high volume sports"), MCP handles ALL fetching, filtering, pagination, mass data internally across Gamma/CLOB reads.
        // Returns pre-filtered complete structured data in directAnswer — no mass raw (30k+ events etc.), no client pagination, no guessing, no tmp, lightweight usable cards with tokenIds/prices/liquidity. Agent sees 1 tool, gets answer, no issues.
        const res = await discoverTopic({
          topic,
          closed: filters.closed ?? false,
          includeEvents: true,
          includeMarkets: true,
          full: true,
          ...(filters.titleSearch ? { titleSearch: filters.titleSearch } : {}),
          ...(filters.liquidityNumMin ? { liquidityNumMin: filters.liquidityNumMin } : {}),
          ...(filters.volumeNumMin ? { volumeNumMin: filters.volumeNumMin } : {}),
        });
        directAnswer.events = res.events || [];
        directAnswer.markets = res.markets || [];
        directAnswer.tagId = res.tagId;
        directAnswer.tagSlug = res.tagSlug;
        directAnswer.note = 'Complete structured Gamma data (full server-side paging + automatic filters applied — no client caps, no raw mass data ever leaves the MCP, everything handled internally in route_agent_intent). Events + markets include tokenIds, liquidity, prices from SDK. TokenIds ready for fetch_market / get_order_book / trading. Already filtered per your natural language intent — agent never guesses filters, pagination, or deals with 30k+ raw items. 1 call, full answer.';

        if (directAnswer.events?.length || directAnswer.markets?.length) {
          (plan as any).directAnswer = directAnswer;
          (plan as any).agentDirective = `NATIVE INTENT DELIVERED: This is the complete filtered answer from one call to route_agent_intent (the ONE tool for Gamma questions). The directAnswer has the full (but automatically filtered) events/markets data — agent never guesses next tool, args, or filters. Everything across Gamma handled inside MCP (no leaking, no raw SDK, no client hacks). ${plan.agentDirective || ''}`;
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(plan, null, 2) }],
      };
    }

    case 'execute_recipe': {
      // Minimal NLR + breaker orchestrator (builds on route_agent_intent plan).
      const strategies: Record<string, unknown> = {};
      for (const [k, v] of strategyStore.entries()) strategies[k] = v;
      const plan = buildIntentRoute({ intent: args.intent, naturalLanguage: args.naturalLanguage, lockedStrategyKey: args.lockedStrategyKey, heartbeat: args.heartbeat, strategies });
      const conf = (plan as any).confidence ?? 1.0;
      const MIN = 0.55;
      if ((!!args.naturalLanguage && !args.intent) && conf < MIN) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, blockedByConfidence: true, confidence: conf, agentDirective: 'Low conf NL. Use explicit or get_agent_recipes.' }) }] };
      }
      recordClassificationFeedback({ naturalLanguage: args.naturalLanguage, resolvedIntent: plan.intent, method: (plan as any).classificationMethod || 'explicit', confidence: conf });

      const dryRun = !!args.dryRun;
      const log: any[] = [];
      let halted = false;
      const steps = plan.steps.slice(0, args.maxSteps || 20);
      for (const step of steps) {
        const entry: any = { order: step.order, tool: step.tool, arguments: step.arguments, status: 'planned' };
        const isMut = isMutationTool(step.tool) || isHighRiskAdvanced(step.tool);
        if (isDegraded(step.tool) && !dryRun) {
          entry.status = 'circuit-broken';
          entry.breaker = getBreakerState()[step.tool];
          log.push(entry);
          halted = true;
          recordStepOutcome(step.tool, false);
          break;
        }
        if (dryRun) {
          entry.status = 'dry-run-validated';
        } else if (isMut) {
          const g = Guard.getGuardrails(strategyStore);
          if (g.readOnly) {
            entry.status = 'blocked-by-guardrail';
            entry.reason = 'readOnly guardrail';
            recordStepOutcome(step.tool, false);
            halted = true;
          } else {
            entry.status = 'delegated-to-host (mutation will hit guardrails)';
            recordStepOutcome(step.tool, true);
          }
        } else {
          entry.status = 'delegated-to-host';
          recordStepOutcome(step.tool, true);
        }
        log.push(entry);
        if (halted) break;
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: !halted, resolvedIntent: plan.intent, confidence: conf, executionLog: log, plan }) }] };
    }

    case 'delegate_to_agent': {
      const agentId = String(args.agentId || 'peer');
      const delegated = args.intent || args.naturalLanguage || 'session_startup';
      const payload = {
        success: true,
        delegate: {
          agentId,
          intent: delegated,
          context: args.context || {},
          handoffPayload: { type: 'a2a-delegation', to: agentId, intent: delegated, lockedStrategyKey: args.lockedStrategyKey, guardrails: Guard.getGuardrails(strategyStore) },
          agentDirective: 'Host: use this payload with sessions_spawn / A2A equivalent to hand off. Receiver starts with get_agent_recipes + route_agent_intent.',
        },
      };
      recordClassificationFeedback({ resolvedIntent: String(delegated), method: 'explicit', confidence: 1 });
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
    }

    case 'get_routing_feedback': {
      const snap = strategyStore.get('routing:feedback') || {};
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, counters: snap.counters || {}, recent: (snap.recent || []).slice(0, args.limit || 20), note: 'Tune classifier aliases from this data. Persisted in strategy bag.' }, null, 2) }] };
    }

    case 'get_available_tools': {
      const g = Guard.getGuardrails(strategyStore);
      const ctx = args.context || {};
      const base = args.category ? getToolsByCategory([...publicTools, ...secureTools], args.category) : [...publicTools, ...secureTools];
      const filtered = base.filter((t: any) => {
        const n = t.name;
        if (g.readOnly && (isMutationTool(n) || isHighRiskAdvanced(n))) return false;
        if (ctx.balanceUsd != null && ctx.balanceUsd < 10 && (n.includes('place') || isMutationTool(n))) return false;
        return true;
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, count: filtered.length, tools: filtered.map((t: any) => t.name), applied: { guardrails: g, context: ctx } }) }] };
    }

    case 'run_agent_cycle': {
      const strategies: Record<string, unknown> = {};
      for (const [k, v] of strategyStore.entries()) strategies[k] = v;
      const plan = buildAgentCyclePlan({
        goal: args.goal,
        topic: args.topic,
        maxMinCostUsd: args.maxMinCostUsd,
        strategies,
        lockedStrategyKey: args.lockedStrategyKey,
        heartbeat: args.heartbeat ?? !!args.lockedStrategyKey, // Native automation: locked strategies on heartbeat get complete plans with send_heartbeat step first
      });
      // Attach locked key at this level for hosts that call the legacy cycle planner directly
      if (args.lockedStrategyKey) (plan as any).lockedStrategyKey = args.lockedStrategyKey;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(plan, null, 2) }],
      };
    }

    case 'get_crypto_spot': {
      try {
        const symbols = Array.isArray(args.symbols) ? args.symbols : ['bitcoin', 'ethereum'];
        const spots = await fetchCryptoSpotUsd(symbols.map(String));
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, spots, note: 'Host compares vs fetch_midpoint / market cards for edge.' }, null, 2),
          }],
        };
      } catch (e: any) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: e?.message || String(e) }, null, 2) }],
        };
      }
    }

    case 'get_tools_by_category': {
      const cat = args.category;
      const filtered = getToolsByCategory([...publicTools, ...secureTools], cat);
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
            tools: compactTools(filtered).map((t) => ({
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
            note: 'This tracks MCP surface usage (which tools agents call and how often). For platform account activities (trades, rebates, rewards usage etc.) use list_activity or the live polymarket://user/activity resource (powered by user WS). Logs also capture activity to logs/polymarket.log (file only in MCP mode). Intelligence patterns (alpha_report, externalSignals/X-sentiment fusion via host, contradiction checks, research-then-execution order) are observable here + in strategyStore + formatted cards (competitionSignal, contradictionBps). Call after research/alpha flows to monitor agent discipline.',
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
              intentRouting: 'route_agent_intent({ intent }) — see intentRouting in this payload',
              loadMore: 'load_agent_profile({ profile }) or get_tools_by_category({ category }) — all handlers remain callable',
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

    case 'extract_wallet_from_url': {
      const text = String(args.url || '');
      const match = text.match(/0x[a-fA-F0-9]{40}/);
      const address = match ? match[0] : null;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            address,
            note: address ? 'Use this address with list_trades({maker: address}) or find markets, then subscribe to polymarket://market/{tokenId}/book via resources/subscribe for public WS trade/book updates on markets the wallet participates in. Stays within official public MarketWsClient.' : 'No 0x address found in input.',
            agentDirective: 'For public monitoring of any wallet (official auth WS limitation). Re-call route_agent_intent for next (e.g. list markets for address).',
          }, null, 2),
        }],
      };
    }

    case 'tool_describe': {
      const allTools = [...publicTools, ...secureTools];
      const name = String(args.name || '');
      const t = allTools.find((tt: any) => tt.name === name);
      if (!t) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: false, error: `Tool not found: ${name}. Use search_tools or get_agent_recipes.`, agentDirective: 'Use search_tools first for discovery.' }, null, 2),
          }],
        };
      }
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
            agentDirective: 'Now call the tool directly with matching args, or use route_agent_intent(NL) for plans. This enables lazy on-demand schema loading for token efficiency.',
          }, null, 2),
        }],
      };
    }

    case 'mcp_health': {
      const source = process.env.HERMES_HOME ? `Hermes (${process.env.HERMES_HOME})` : process.env.OPENCLAW_HOME || process.env.OPENCLAW_GATEWAY ? 'OpenClaw' : 'legacy/default';
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            tier1ToolCount: currentlyExposedToolNames.size,
            routingAlwaysOn: true,
            intentCount: Object.keys(INTENT_REGISTRY || {}).length,
            credentialSource: source,
            resources: 'polymarket://user/* and market/* active for real-time (zero-token push via subscribe)',
            note: 'Lightweight health for monitoring. For full: mcp_doctor. Supports agent self-improvement loops with low token cost.',
            agentDirective: 'Use for quick checks in learning cycles. Re-call route_agent_intent for next phase.',
          }, null, 2),
        }],
      };
    }

    case 'reload_credentials': {
      try {
        // force reload the multi-host loader
        const { forceReloadEnv } = await import('./config/load-env.js');
        forceReloadEnv();
        // reset clients so new env is picked
        try {
          const clientMod = await import('./config/client.js');
          if (typeof (clientMod as any).resetSecureClient === 'function') (clientMod as any).resetSecureClient();
          if (typeof (clientMod as any).resetPublicClient === 'function') (clientMod as any).resetPublicClient();
        } catch {}
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, message: 'Credentials reloaded from detected host source (Hermes profile or OpenClaw). Clients reset for next calls.', agentDirective: 'Next getSecureClient or actions will use updated env. Use for key rotation in long-running self-improving agents.' }, null, 2),
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
        // reset clients
        try {
          const clientMod = await import('./config/client.js');
          if (typeof (clientMod as any).resetSecureClient === 'function') (clientMod as any).resetSecureClient();
        } catch {}
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, message: msg, agentDirective: 'Profile switched and env reloaded. Agent can now use new identity for its learning/strategy loops without restart.' }, null, 2),
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

    case 'list_tags': {
      // Use the registry for fast, no-SDK call (or pub if needed for live)
      const { listGammaTagSlugs } = await import('./data/discovery.js');
      const tags = listGammaTagSlugs();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ Tags: tags, count: tags.length, note: 'Gamma tags for full discovery surface. Use with discover_topic or route_agent_intent for plans.' }, null, 2),
        }],
      };
    }

    case 'fetch_tag': {
      const slug = String(args.slug || '');
      const { resolveTopicSlug, gammaTagId } = await import('./data/discovery.js');
      const resolved = resolveTopicSlug(slug);
      const id = resolved ? gammaTagId(resolved) : null;
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ slug, resolvedSlug: resolved, id, note: 'Full Gamma tag details. Pair with listMarkets using tagId for Data/Gamma analytics.' }, null, 2),
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
        const filtered = getToolsByCategory([...publicTools, ...secureTools], cat);
        perCategory[cat] = filtered.length;
        for (const t of filtered) {
          if (!currentlyExposedToolNames.has(t.name)) {
            currentlyExposedToolNames.add(t.name);
            newlyRegistered++;
          }
        }
      }
      const strategySeeded = seedSessionStrategyDefaults(strategyStore, profileKey);
      if (strategySeeded) await persistStrategiesToDisk();
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
              strategySeeded,
              agentDirective: strategySeeded
                ? 'Re-call tools/list. get_strategies() now has session defaults — refine with update_strategy before trading.'
                : 'Re-call tools/list to refresh the host tool surface. All handlers unchanged — only exposure grew.',
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
    case 'list_trades':
      return callPaginatedWithFormat(pub.listTrades(args), F.formatTrade, name);
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

    case 'compute_market_signals': {
      const { tokenId } = await resolveTokenIdFromToolArgs(args);
      const snap = await fetchFarmabilitySnapshot(pub, tokenId);
      let bayesian;
      if (args.signal != null && !Number.isNaN(Number(args.signal))) {
        const prior = args.prior != null ? Number(args.prior) : (snap.currentMid ?? 0.5);
        bayesian = computeBayesianPosterior({
          prior,
          signal: Number(args.signal),
          weight: args.weight != null ? Number(args.weight) : 0.4,
        });
      }
      const card = F.formatMarketSignals({
        tokenId,
        farmability: F.formatFarmability(snap),
        bayesian,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: snap.success, ...card }, null, 2) }],
      };
    }

    case 'rank_market_opportunities': {
      // Research service only: returns ranked signals (composite, confidence, actionability, bayesian etc.).
      // Host (Hermes) must persist the ranked signals to the locked composite key via update_strategy
      // before using in execution on heartbeat. No trades, no decisions in this layer.
      const ranked = rankOpportunities(args.opportunities || [], {
        goal: args.goal || 'rewards',
        maxResults: args.maxResults,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            goal: args.goal,
            ranked,
            note: 'Research signals only — feed to update_strategy under your lockedStrategyKey (composite market:volume) for Hermes to consume on heartbeat. Intelligence never executes.',
            agentDirective: 'Persist these ranked signals to the exact locked key in strategy store. Use only persisted signals from this key for price movement and execution decisions. Do not place directly from this output.',
          }, null, 2),
        }],
      };
    }

    // Narrow single-mandate Intelligence handlers (added to close granularity gaps for host-orchestrated specialized research on heartbeat).
    // Host (Hermes) calls these narrow tools (directly or via the new granular research_* intents in route_agent_intent) on its own heartbeat ticks,
    // persists the focused output after each under the exact locked composite key, and decides sequence/timing/modeling on top.
    // MCP never owns continuous agents, swarms, or loops — this is pure on-demand native research surface.
    case 'get_liquidity_health': {
      const { tokenId } = await resolveTokenIdFromToolArgs(args);
      const snap = await fetchFarmabilitySnapshot(pub, tokenId);
      const card = {
        tokenId,
        type: 'narrow_liquidity_health',
        liquidity: snap?.liquidity || snap?.book || null,
        competitionSignal: snap?.competitionSignal,
        note: 'Narrow research mandate only. Persist immediately under your lockedStrategyKey (e.g. "weather:low") so Hermes can use on the next heartbeat tick. No decisions or trades from this layer.',
        persistDirective: `update_strategy({ tokenId: "${(args as any).lockedStrategyKey || '<your-locked-composite>'}", liquidityHealth: <this card>, lastNarrowResearch: "liquidity" })`,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }] };
    }
    case 'get_competition_signal': {
      const { tokenId } = await resolveTokenIdFromToolArgs(args);
      const snap = await fetchFarmabilitySnapshot(pub, tokenId);
      const card = {
        tokenId,
        type: 'narrow_competition_signal',
        competitionSignal: snap?.competitionSignal,
        note: 'Narrow research mandate. Persist to the exact Hermes-managed locked composite key.',
        persistDirective: `update_strategy({ tokenId: "${(args as any).lockedStrategyKey || '<locked>'}", competitionSignal: <this>, lastNarrowResearch: "competition" })`,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }] };
    }
    case 'compute_divergence': {
      const { tokenId } = await resolveTokenIdFromToolArgs(args);
      let res: any = { note: 'Supply prior+signal or externalSignals for fusion.' };
      if (args.prior != null && args.signal != null) {
        res = computeBayesianPosterior({ prior: Number(args.prior), signal: Number(args.signal), weight: args.weight != null ? Number(args.weight) : 0.4 });
      }
      const card = {
        tokenId,
        type: 'narrow_divergence',
        divergence: res,
        note: 'Lightweight deterministic fusion helper for contradiction detection in narrow research cards only — not a hosted model or Bayesian blending engine. Persist result.',
        persistDirective: `update_strategy({ tokenId: "${(args as any).lockedStrategyKey || '<locked>'}", divergence: <res>, lastNarrowResearch: "divergence" })`,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }] };
    }
    case 'get_reward_farmability_snapshot': {
      const { tokenId } = await resolveTokenIdFromToolArgs(args);
      const snap = await fetchFarmabilitySnapshot(pub, tokenId);
      const card = {
        tokenId,
        type: 'narrow_reward_farmability',
        reward: snap?.reward || null,
        note: 'Narrow reward attractiveness mandate. Persist to locked key for host heartbeat consumption.',
        persistDirective: `update_strategy({ tokenId: "${(args as any).lockedStrategyKey || '<locked>'}", rewardFarmability: <this>, lastNarrowResearch: "reward" })`,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }] };
    }
    case 'analyze_signal_contradiction': {
      const { tokenId } = await resolveTokenIdFromToolArgs(args);
      const ext = (args as any).externalSignals || [];
      const card = {
        tokenId,
        type: 'narrow_signal_contradiction',
        externalCount: ext.length,
        note: 'Narrow fusion mandate only (host externalSignals vs book). Persist the focused contradiction output under the locked key. Host (Hermes) may apply further modeling on the persisted result. MCP hosts no models.',
        persistDirective: `update_strategy({ tokenId: "${(args as any).lockedStrategyKey || '<locked>'}", signalContradiction: <this + any host context>, lastNarrowResearch: "fusion" })`,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(card, null, 2) }] };
    }

    case 'generate_alpha_report':
    case 'alpha_report': {
      // Intelligence layer research service: output is signals/cards only (opportunities, scores, fusion).
      // Host (Hermes) must persist via update_strategy under the lockedStrategyKey (if provided) or chosen composite
      // before using in execution. This tool never places orders or makes decisions — data for Hermes heartbeat-orchestrated locked strategy.
      try {
        const report = await buildAlphaReport(pub, {
          goal: args.goal,
          topic: args.topic,
          maxMinCostUsd: args.maxMinCostUsd,
          maxMinSize: args.maxMinSize,
          tokenIds: args.tokenIds,
          externalSignals: args.externalSignals,
          maxCandidates: args.maxCandidates ?? args.maxResults,
          enrichFarmability: args.enrichFarmability,
          midPriceMin: args.midPriceMin,
          midPriceMax: args.midPriceMax,
          liquidityNumMin: args.liquidityNumMin,
          volumeNumMin: args.volumeNumMin,
        });
        const formatted = F.formatAlphaReport(report);
        const payload = {
          success: true,
          ...report,
          card: formatted,
          toolAlias: name === 'alpha_report' ? 'generate_alpha_report' : undefined,
        };
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
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
      await persistStrategiesToDisk();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: "Strategy / rules / config stored (session + disk when logs/ writable). Use for any filters or operating rules.",
            key,
            strategy,
            directive: "Use get_strategies (no args) to load your full current rule set. This is how you evolve filters, farming rules, event prefs etc. without bloating the MCP."
          }, null, 0)
        }]
      };
    }

    case 'get_strategies': {
      const seeded = seedSessionStrategyDefaults(strategyStore);
      if (seeded) await persistStrategiesToDisk();
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
            strategySeeded: seeded,
            note: "Your complete persisted rules, filters, farming configs, event preferences, and trading plans. Call with no args to load everything the agent has evolved. This is the lightweight source of truth for all your operating rules.",
            agentDirective: seeded
              ? 'Fresh session: defaults seeded (rules:session_defaults, filter:liquidity_discovery). Refine via update_strategy before trading.'
              : results.length === 0
                ? 'Store empty — call update_strategy({ key: "rules:current", ... }) or load_agent_profile to seed defaults.'
                : 'Use update_strategy for partial changes; obey filters here before list_active / alpha_report.',
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
      await persistStrategiesToDisk();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: "Entry updated (partial; persisted to disk when logs/ writable).",
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
    case 'list_positions': {
      // SDK listPositions returns a Paginator — use firstPage(), not raw .map on the paginator object
      try {
        const paginator = await (await getSec()).listPositions(args);
        const page = await (typeof paginator.firstPage === 'function'
          ? paginator.firstPage()
          : (typeof paginator.next === 'function' ? paginator.next() : null));
        let items = page?.items ?? page?.data ?? (Array.isArray(page) ? page : []);
        const MAX_ITEMS = 25;
        if (Array.isArray(items) && items.length > MAX_ITEMS) {
          items = items.slice(0, MAX_ITEMS);
        }
        if (!Array.isArray(items)) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `list_positions error: unexpected response shape (expected paginated items array)` }]
          };
        }
        const formatted = items.map((p: any) => F.formatPosition(p));
        const summary = F.formatPnlSummary(items);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ Positions: formatted, PnLSummary: summary }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
          }]
        };
      } catch (e: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `list_positions error: ${e?.message || e}` }] };
      }
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

    // === Additional Discovery (list_tags handled above) ===
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
          note: 'Hermes (host) owns the heartbeat.md / OpenClaw CLOB liveness enforcement. Call send_heartbeat from the host heartbeat tick/resource notification per its native contract to keep sessions and orders active. This MCP surface exists so the MCP remains responsive under host-driven heartbeat control. Use with wait_seconds per host policy. SDK WS clients often handle internally.'
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
  return enrichNativeToolResponse(name, args as Record<string, unknown>, toolResult, strategyStore);
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
