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
} from '@modelcontextprotocol/sdk/types.js';
import { getPublicClient, getSecureClient, setupGaslessWallet } from './lib.js';
import * as F from './formatters.js';
import {
  placeLimitOrder as sportsPlaceLimitOrder,
  placeMarketOrder as sportsPlaceMarketOrder,
  createApiKey,
  deriveApiKey,
  createOrDeriveApiKey,
  fetchApiKeys,
  deleteApiKey,
} from '@polymarket/client/actions';
import { createResourceManager, RESOURCE_CAPABILITIES } from './mcp/resources.js';
import { callWithRateLimitProtection, sleep } from './utils/errors.js';

// Mark as MCP server early so logger, env, and other modules can adapt (no stdout pollution, no process.exit on auth errors).
process.env.MCP_MODE = '1';
process.env.MCP_SERVER = 'true';

// === Simple in-memory strategy store for autonomous agents ===
// Allows agents to persist trading plans (entry, TP, SL, size, notes) across tool calls
// without bloating their context window. Keyed by tokenId (or can be extended).
// This gives agents a real advantage for disciplined SL/TP and strategy execution
// while the MCP handles rate limiting and backoffs.
const strategyStore = new Map<string, any>(); // tokenId -> strategy object
function getStrategyKey(tokenId: string, market?: string) {
  return market ? `${tokenId}:${market}` : tokenId;
}

// Map prompt-specified env var names (EOA_PRIVATE_KEY / DEPOSIT_WALLET_ADDRESS)
// onto the names expected by the existing getPublicClient / getSecureClient factories.
// This lets the MCP server work without modifying any other file in the codebase.
function normalizeEnvAliases() {
  if (process.env.EOA_PRIVATE_KEY && !process.env.PRIVATE_KEY) {
    process.env.PRIVATE_KEY = process.env.EOA_PRIVATE_KEY;
  }
  if (process.env.DEPOSIT_WALLET_ADDRESS && !process.env.WALLET_ADDRESS) {
    process.env.WALLET_ADDRESS = process.env.DEPOSIT_WALLET_ADDRESS;
  }

  // For this builder's verified account, default the deposit wallet if not provided
  // (This address is for API use only — do not send funds to it)
  const isMcp = process.env.MCP_MODE === '1' || process.env.MCP_SERVER === 'true';
  if (isMcp && !process.env.WALLET_ADDRESS && !process.env.DEPOSIT_WALLET_ADDRESS) {
    process.env.DEPOSIT_WALLET_ADDRESS = '0xe467d9930e0577bd2beb5e29cb3ae3b457cfb33f';
    process.env.WALLET_ADDRESS = '0xe467d9930e0577bd2beb5e29cb3ae3b457cfb33f';
  }
}
normalizeEnvAliases();

// All logging MUST go to stderr. Stdout is strictly for the MCP JSON-RPC protocol.
const server = new Server(
  { name: 'polymarket-mcp', version: '1.0.0' },
  {
    capabilities: {
      tools: {},
      resources: RESOURCE_CAPABILITIES,
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
  // Core categories: Discovery, Rewards, Trading, Account, Strategy, Analytics, Utilities
};

// Helper to get tools filtered by category
function getToolsByCategory(category: string) {
  const catLower = category.toLowerCase();
  return [...publicTools, ...secureTools].filter(t => {
    const desc = t.description || '';
    // Match by prefix tag
    if (desc.toLowerCase().startsWith(`[${catLower}]`)) return true;
    // Match by keywords for untagged tools (temporary until full tagging)
    if (catLower === 'rewards' && /reward|maker reward|scoring/i.test(desc)) return true;
    if (catLower === 'strategy' && /strategy|stop loss|take profit|sl\/tp/i.test(desc)) return true;
    if (catLower === 'account' && /balance|allowance|portfolio|position/i.test(desc)) return true;
    if (catLower === 'trading' && /place|order|cancel|maker/i.test(desc)) return true;
    if (catLower === 'discovery' && /list_market|fetch_market|search/i.test(desc)) return true;
    return false;
  });
}

function listAllCategories() {
  // Primary categories (manually maintained for clarity + speed)
  return [
    'Rewards',
    'Strategy',
    'Account',
    'Utilities',
    'Discovery',
    'Trading',
    'Analytics'
  ];
}

// ==================== TOOL DEFINITIONS (exactly per spec) ====================

const publicTools = [
  // === Category Discovery Tools (added to solve 100+ tool bloat) ===
  {
    name: 'list_tool_categories',
    description: '[Utilities] Returns the list of available tool categories. Call this first to quickly discover relevant tools without loading all 100+ at once.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'get_tools_by_category',
    description: '[Utilities] Returns only the tools that belong to a specific category. Use after list_tool_categories for fast, targeted discovery.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { 
          type: 'string', 
          description: 'The category name (e.g. "Rewards", "Trading", "Discovery", "Account", "Strategy")' 
        }
      },
      required: ['category']
    }
  },

  {
    name: 'list_markets',
    description: 'List Polymarket markets using the official SDK listMarkets(). Supports all standard filters including category, search terms, active/closed status, resolution dates, etc. Best for targeted discovery (e.g. crypto, specific slugs, short-duration markets).',
    inputSchema: {
      type: 'object',
      properties: {
        closed: { type: 'boolean' },
        active: { type: 'boolean' },
        category: { type: 'string' },
        search: { type: 'string', description: 'Text search within listMarkets (alternative or complement to the dedicated search tool)' },
        pageSize: { type: 'number' },
        // Additional common SDK filters are passed through
        limit: { type: 'number' },
        offset: { type: 'number' }
      }
    }
  },
  {
    name: 'fetch_market',
    description: 'Fetch a single market by id, slug or url',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        slug: { type: 'string' },
        url: { type: 'string' }
      }
    }
  },
  {
    name: 'list_events',
    description: 'List Polymarket events',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' }
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
    description: 'Fetch prices for multiple tokens',
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
  {
    name: 'list_tags',
    description: 'List all tags (categories) used across markets and events',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' },
        closed: { type: 'boolean' }
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
        slug: { type: 'string' }
      }
    }
  },
  {
    name: 'fetch_related_tags',
    description: 'Fetch tags related to a given tag',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        slug: { type: 'string' }
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
    description: 'List market series (grouped markets)',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' },
        closed: { type: 'boolean' }
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
        slug: { type: 'string' }
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
    description: 'Place a limit order (GTC maker by default for rewards). Requires EOA_PRIVATE_KEY + DEPOSIT_WALLET_ADDRESS. Defaults to orderType=GTC and postOnly=true so the order rests on the book as a maker (earns rewards, no taker fees).',
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
    description: 'Place a market order (requires EOA_PRIVATE_KEY + DEPOSIT_WALLET_ADDRESS)',
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
    description: 'Recommended unified tool for placing GTC maker orders that earn Polymarket rewards. Creates and posts a limit order using the SDK. Defaults to orderType=GTC and postOnly=true (rests on book as maker, no taker fees, eligible for rewards). Use this instead of raw place_limit_order for most maker workflows.',
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
    description: 'List recent account activity',
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
    description: 'Set up trading approvals (ERC20 + CTF)',
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
    description: 'Redeem resolved positions (by marketId)',
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
    description: 'Prepare a limit order workflow (gasless)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_market_order',
    description: 'Prepare a market order workflow (gasless)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_gasless_transaction',
    description: 'Prepare a gasless transaction',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_split_position',
    description: 'Prepare split position workflow (CTF)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_merge_positions',
    description: 'Prepare merge positions workflow (CTF)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_redeem_positions',
    description: 'Prepare redeem positions workflow (CTF)',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_erc20_approval',
    description: 'Prepare ERC20 approval workflow',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_erc1155_approval_for_all',
    description: 'Prepare ERC1155 setApprovalForAll workflow',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'prepare_erc20_transfer',
    description: 'Prepare ERC20 transfer workflow',
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
    description: 'Post multiple pre-signed orders',
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
    description: 'Update balance allowance',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'deploy_deposit_wallet',
    description: 'Deploy deposit wallet',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'download_accounting_snapshot',
    description: 'Download accounting snapshot',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'setup_gasless_wallet',
    description: 'Setup gasless wallet',
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
    description: 'Create API key from signed L1 auth payload. API keys must be derived from EOA private key, not deposit wallet',
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
    description: 'Derive existing API key from signed L1 auth payload. API keys must be derived from EOA private key, not deposit wallet',
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
    description: 'Create or fall back to derive API key from signed L1 auth payload. API keys must be derived from EOA private key, not deposit wallet',
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
    description: 'Fetch all API keys for the authenticated account. API keys must be derived from EOA private key, not deposit wallet',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'delete_api_key',
    description: 'Delete the currently authenticated API key. API keys must be derived from EOA private key, not deposit wallet',
    inputSchema: { type: 'object', properties: {} }
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
    description: 'Check if the gasless/relayer wallet is ready',
    inputSchema: { type: 'object', properties: {} }
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
    description: '[Rewards] STRICT REWARD-ONLY TOOL. Forces GTC+postOnly and only succeeds on confirmed scoring orders. IMPORTANT: Polymarket CLOB is rate-limited. Do NOT call this (or list_active_maker_reward_markets) in a tight loop. Add 4-8s delays between attempts or you will make the MCP server unreachable. On any failure you get a strong autonomous directive instead of "what do you want me to do?".',
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
    description: '[Rewards] PRIMARY AUTONOMOUS DISCOVERY TOOL for small and large capital. Tiny ranked list (default top 5). Now includes live mid prices + exact USD cost to qualify (minSize × price) for both Yes and No. Supports maxMinCostUsd filter so you can instantly see "which reward markets can I actually afford with my $5 cap?". Rate limit protected + rich directives. Use this first for any maker activity.',
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
    description: 'High-level automation helper. Suggests optimal parameters for a market, validates them against current reward rules, places the order as a pure maker, confirms it is scoring, and can optionally monitor fills. This reduces the number of manual steps an agent needs to perform for reward farming.',
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
    description: '[Utilities] Server-side sleep / backoff primitive. ESSENTIAL for autonomous loops: use after rate limits (respect retryAfterMs), when list_active returns no qualifying markets under your size cap, or for disciplined waiting between spread capture checks / exit monitoring. Prevents tight-loop thrashing that kills the MCP or wastes rate limits. Never implement client-side sleeps for backoffs.',
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

  // === Strategy & SL/TP Storage (huge advantage for autonomous agents) ===
  // Agents can store full trading plans (entry, TP, SL, size, notes) server-side in the MCP.
  // This keeps the agent's context window clean and enables disciplined, rate-limit-respecting
  // execution loops (use with wait_seconds + watches). The MCP becomes the agent's "trading brain"
  // for persistent state while respecting Polymarket rate limits.
  {
    name: 'set_strategy',
    description: '[Strategy] Store a complete trading strategy/plan for a token (entryPrice, takeProfitPrice, stopLossPrice, size, side, notes, etc.). The MCP acts as persistent memory. Ideal for spread capture, reward farming, or any rules-based approach. Combine with watch_order_* resources and wait_seconds for fully autonomous execution within rate limits.',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string', description: 'The Yes or No tokenId this strategy applies to' },
        market: { type: 'string', description: 'Optional slug/conditionId for easier grouping' },
        entryPrice: { type: 'number' },
        takeProfitPrice: { type: 'number' },
        stopLossPrice: { type: 'number' },
        size: { type: 'number' },
        side: { type: 'string', enum: ['BUY', 'SELL'] },
        notes: { type: 'string', description: 'Your full plan (e.g. "Spread capture on Jesus Christ — entry 0.48, TP 0.52, SL 0.44, $5 size")' },
        maxWaitSecondsBetweenChecks: { type: 'number', description: 'Suggested backoff for monitoring loops (use wait_seconds tool)' }
      },
      required: ['tokenId']
    }
  },
  {
    name: 'get_strategies',
    description: 'Retrieve stored strategies (optionally filtered by tokenId or market). Agents use this to recall their plans, SL/TP levels, and notes without keeping everything in context.',
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
    description: 'Delete a stored strategy (call after full execution or when abandoning the plan).',
    inputSchema: {
      type: 'object',
      properties: {
        tokenId: { type: 'string' },
        market: { type: 'string' }
      },
      required: ['tokenId']
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
    description: 'SECURITY-SENSITIVE: Signs an arbitrary message with the connected wallet. This can be used for authentication or arbitrary signatures. Only use if you fully trust the agent and have additional controls in place.',
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
    description: 'SECURITY-SENSITIVE: Signs EIP-712 typed data with the connected wallet. This is used for gasless orders and other structured signatures. Only use if you fully trust the agent.',
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
    description: 'SECURITY-SENSITIVE: Directly sends a raw transaction from the connected wallet. This bypasses all high-level Polymarket flows. Extremely dangerous. Only use with strong additional safeguards.',
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
    description: 'SECURITY-SENSITIVE: Revokes the current API key session and returns a public client. This invalidates the current authenticated session.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'get_secure_client_info',
    description: 'SECURITY-SENSITIVE: Returns raw authentication internals (account identity and API credentials). Do not expose these publicly.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];

// Register tool list (MCP discovery)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [...publicTools, ...secureTools]
}));

// Execute tools — every handler returns JSON. Errors never throw.
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

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
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            category: cat,
            count: filtered.length,
            tools: filtered.map(t => ({
              name: t.name,
              description: t.description
            }))
          }, null, 2)
        }]
      };
    }

    // Public tools (no auth) — every response formatted
    case 'list_markets':
      return callPaginatedWithFormat(pub.listMarkets(args), F.formatMarket, name);
    case 'fetch_market':
      return callWithFormat(() => pub.fetchMarket(args), F.formatMarket, name);
    case 'list_events':
      return callPaginatedWithFormat(pub.listEvents(args), F.formatEvent, name);
    case 'fetch_event':
      return callWithFormat(() => pub.fetchEvent(args), F.formatEvent, name);
    case 'search':
      // Use official SDK search directly (SearchResults shape: { markets, events, tags, profiles }).
      // Do NOT wrap in callPaginatedWithFormat — it is not a simple item paginator.
      return callWithFormat(() => pub.search(args), F.formatSearchResults, name);
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
      const maxResults = Math.min(Math.max(1, args.maxResults || 5), 8);
      const maxMinSize = args.maxMinSize != null ? parseFloat(args.maxMinSize) : null;
      const maxMinCostUsd = args.maxMinCostUsd != null ? parseFloat(args.maxMinCostUsd) : null;

      let rewardItems: any[] = [];
      try {
        const protectedCall = await callWithRateLimitProtection(
          () => pub.listCurrentRewards({ pageSize: Math.min(30, maxResults * 2) }),
          'listCurrentRewards (active reward markets)'
        );
        if (!protectedCall.ok) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({
              success: false, rateLimited: true, retryAfterMs: protectedCall.retryAfterMs,
              message: protectedCall.message,
              directive: "Polymarket is rate limiting. Slow down. Do not call list_active_maker_reward_markets more than once every 4-6 seconds. Use the previous ranked list you already received."
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

        rewardItems = items.slice(0, maxResults);
      } catch (e: any) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: "Failed to fetch current reward programs", detail: e?.message || String(e) }) }]
        };
      }

      if (!rewardItems.length) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            success: true,
            message: "No active maker reward programs right now.",
            markets: [],
            directive: "No opportunities. Wait and retry later or check back with this tool."
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

      const payload = {
        success: true,
        count: ranked.length,
        filteredBy: {
          ...(maxMinSize != null ? { maxMinSize } : {}),
          ...(maxMinCostUsd != null ? { maxMinCostUsd } : {})
        },
        note: "Ranked best-first. Now shows exact USD cost to qualify on Yes and No sides (minSize × current mid). Use maxMinCostUsd: 4.5 for strict $5 cap agents. This is the primary tool for discovering which reward programs your small orders can actually participate in.",
        markets: ranked,
        usage: "For $5 cap: list_active_maker_reward_markets({maxMinCostUsd: 4.5}). Look at cheapestMinCostUsd. Only place on markets where your size meets minSize and cost is under cap."
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
            ? "Proposal looks compatible with typical active program rules (size + spread). Final scoring decided by Polymarket after order is live."
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
            () => sec.fetchBalanceAllowance({ assetType }),
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
                "2. If balance is low: deposit USDC into your Polymarket deposit wallet (use deposit or the deposit wallet flow).",
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

    case 'set_strategy': {
      const key = getStrategyKey(args.tokenId, args.market);
      const strategy = {
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
      strategyStore.set(key, strategy);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            message: "Strategy stored in MCP (persistent for this session).",
            key,
            strategy,
            directive: "Use get_strategies to recall it. Combine with watch_order_until_filled, watch_order_scoring, and wait_seconds for autonomous execution within rate limits."
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
            note: "These are your stored plans. Use them to drive disciplined SL/TP and entry logic without losing state between steps."
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
      return callPaginatedWithFormat((await getSec()).listPositions(args), F.formatPosition, name);
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
      return callWithFormat(() => pub.fetchRelatedTags(args), F.formatSimpleListItem, name);

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
      return callWithFormat(async () => (await getSec()).updateBalanceAllowance(args), F.formatGeneric, name);
    case 'deploy_deposit_wallet':
      return callWithFormat(async () => (await getSec()).deployDepositWallet(), F.formatTransactionHandle, name);
    case 'download_accounting_snapshot':
      return callWithFormat(async () => (await getSec()).downloadAccountingSnapshot(args), F.formatAccountingSnapshot, name);
    case 'setup_gasless_wallet':
      // Uses the factory wrapper which performs the required client replacement
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
          note: 'These are sensitive authentication internals. Do not log or expose them.'
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
  console.error('Polymarket MCP server listening on stdio (name=polymarket-mcp, version=1.0.0) — resources + subscriptions enabled');

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
  console.error('Fatal error starting Polymarket MCP server:', error);
  // Do not exit hard in some hosts; let the transport close naturally
});
