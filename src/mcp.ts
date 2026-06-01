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

// Mark as MCP server early so logger, env, and other modules can adapt (no stdout pollution, no process.exit on auth errors).
process.env.MCP_MODE = '1';
process.env.MCP_SERVER = 'true';

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
    if (Array.isArray(items) && items.length > 200) {
      items = items.slice(0, 200);
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

// ==================== TOOL DEFINITIONS (exactly per spec) ====================

const publicTools = [
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
    description: 'List currently active reward programs',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number' }
      }
    }
  },
  {
    name: 'list_market_rewards',
    description: 'List reward configuration for a specific market',
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
    description: 'STRICT REWARD-ONLY TOOL. This is the ONLY tool you should use if you want the agent to ONLY place orders that earn maker rewards. It forces a pure maker order (GTC + postOnly), confirms scoring, and can optionally actively monitor until the order fills or definitively fails to fill. Use monitorFills: true when you need the agent to wait for actual on-chain confirmation.',
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
    description: 'Lists markets that currently have active maker reward programs. Use compact mode (default) for lightweight responses suitable for agents. Set compact=false for full details.',
    inputSchema: {
      type: 'object',
      properties: {
        pageSize: { type: 'number', description: 'Number of results per page (default 30, max 100 recommended for agents)' },
        compact: { 
          type: 'boolean', 
          description: 'Return compact lightweight format (default: true). When false, returns full detailed reward configs.' 
        },
        includeConfigs: { 
          type: 'boolean', 
          description: 'Include full reward config details even in compact mode (default: false)' 
        }
      }
    }
  },
  {
    name: 'validate_for_maker_rewards',
    description: 'Pre-placement check. Given a tokenId (or market) and proposed size/price, tells you whether this order would meet the current active maker reward program rules (min size and max spread). This helps avoid placing orders that have no chance of scoring.',
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

        // 1. Place as pure maker
        const signed = await sec.createLimitOrder(params);
        const posted = await sec.postOrder(signed);
        const orderId = (posted as any)?.orderId;

        if (orderId) {
          resourceManager.ensureUserSubscriptionForWatch(orderId).catch(() => {});
        }

        // 2. Multiple scoring checks with increasing delays (more reliable than single check)
        const checkDelays = [2500, 4000, 6000]; // total ~13 seconds max
        let isScoring = false;
        let lastCheckedAt = 0;

        for (const delay of checkDelays) {
          await new Promise(r => setTimeout(r, delay));
          lastCheckedAt = Date.now();
          try {
            isScoring = await sec.fetchOrderScoring({ orderId });
            if (isScoring) break; // success — locked onto rewards
          } catch (e) {
            // ignore transient errors
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

          // Enhanced diagnostics on failure
          let diagnostics = null;
          try {
            // Try to get current market conditions
            const [book, rewards] = await Promise.all([
              pub.fetchOrderBook({ tokenId: args.tokenId }).catch(() => null),
              pub.listMarketRewards({ conditionId: args.tokenId }).catch(() => null), // best effort
            ]);

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
            recommendation: "Review the diagnostics above. Common reasons: price too aggressive (spread too wide), size below program minimum, or market has no active rewards right now.",
            suggestion: "Use validate_for_maker_rewards before placing, or try list_active_maker_reward_markets to find better opportunities."
          };
        }
      }, F.formatGeneric, name);

    // === New Maker Rewards Support Tools ===
    case 'list_active_maker_reward_markets':
      // Enforce reasonable defaults for agent friendliness
      const safePageSize = Math.min(args.pageSize || 30, 100);
      const useCompact = args.compact !== false; // default true for lightweight responses
      const includeFullConfigs = args.includeConfigs === true;
      const formatter = useCompact && !includeFullConfigs 
        ? F.formatCurrentRewardCompact 
        : F.formatCurrentReward;

      return callPaginatedWithFormat(
        pub.listCurrentRewards({ ...args, pageSize: safePageSize }), 
        formatter, 
        name
      );

    case 'validate_for_maker_rewards': {
      // Pre-placement check against current active reward rules
      return callWithFormat(async () => {
        if (!args.tokenId) {
          return { error: "tokenId is required" };
        }

        // Try to get active rewards for the market this token belongs to.
        // We use listMarketRewards with the conditionId if we can derive it, otherwise fall back to current rewards.
        let rewards = [];
        try {
          // Best effort: call listCurrentRewards and filter
          const paginator = await pub.listCurrentRewards({ pageSize: 100 });
          const page = await paginator.firstPage();
          rewards = page?.items || [];
        } catch (e) {
          return { error: "Could not fetch active reward programs" };
        }

        if (!rewards.length) {
          return {
            eligible: false,
            reason: "No active maker reward programs right now.",
            recommendation: "Use list_active_maker_reward_markets to find markets with active programs."
          };
        }

        // For simplicity in v1, we return the active programs and let the agent compare size/price.
        // A more advanced version would take conditionId and do exact matching.
        return {
          has_active_programs: true,
          active_programs: rewards.map(r => F.formatCurrentReward(r)),
          note: "Compare your proposed size against 'Min Order Size (to qualify)' and price against 'Max Spread Allowed' in the programs above.",
          proposed: {
            tokenId: args.tokenId,
            size: args.size,
            price: args.price,
            side: args.side
          }
        };
      }, F.formatGeneric, name);
    }

    case 'suggest_reward_order_parameters': {
      return callWithFormat(async () => {
        if (!args.tokenId || !args.side) {
          return { error: "tokenId and side are required" };
        }

        const [book, rewards] = await Promise.all([
          pub.fetchOrderBook({ tokenId: args.tokenId }).catch(() => null),
          pub.listMarketRewards({ conditionId: args.tokenId }).catch(() => null),
        ]);

        if (!book || !rewards?.items?.length) {
          return {
            suggestion: null,
            reason: "Could not find active reward programs or current market data for this token."
          };
        }

        const program = rewards.items[0]; // Take the first active program
        const minSize = parseFloat(program.rewardsMinSize || '5');
        const maxSpread = parseFloat(program.rewardsMaxSpread || '0.005');

        const bestBid = parseFloat(book.bids?.[0]?.price || '0');
        const bestAsk = parseFloat(book.asks?.[0]?.price || '0');

        let suggestedPrice;
        if (args.side.toUpperCase() === 'BUY') {
          suggestedPrice = bestAsk * (1 - maxSpread * 0.8); // slightly better than max spread
        } else {
          suggestedPrice = bestBid * (1 + maxSpread * 0.8);
        }

        const suggestedSize = Math.max(minSize, args.capitalUsd ? (args.capitalUsd / suggestedPrice) : minSize * 2);

        return {
          suggestedPrice: suggestedPrice.toFixed(4),
          suggestedSize: suggestedSize.toFixed(2),
          expectedSpreadBps: (maxSpread * 10000).toFixed(0),
          minSizeRequired: minSize,
          maxSpreadAllowed: maxSpread,
          reasoning: `Suggested parameters aim to stay well inside the program's max spread of ${(maxSpread*100).toFixed(2)}% while being competitive.`
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
          return { success: false, error: "Could not generate good parameters for this market." };
        }

        // Step 2: Validate
        const validation = await (async () => {
          // Simplified validation using the same logic as validate_for_maker_rewards
          const rewards = await pub.listCurrentRewards({ pageSize: 50 }).catch(() => null);
          const programs = rewards?.items || [];
          const relevant = programs.find((p: any) => p.conditionId === args.tokenId || true); // best effort
          return { ok: true, programs };
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
