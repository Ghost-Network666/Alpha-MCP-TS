/** Tier-1 default surface: daily-driver tools only. Full handlers via categories (see TOOL_COUNT). */

/** Minimal daily surface — full handlers via load_agent_profile / get_tools_by_category / direct tools/call. The agent decides tools from the list exposed by tools/list. */
export const TIER1_CORE_TOOL_NAMES: readonly string[] = [
  // Pure first-class wrappers for @polymarket/client SDK functions only.
  // No custom MCP meta, routing, doctor, strategy store, or enriched tools in the default surface.
  'discover_topic',
  'fetch_market',
  'list_markets',
  'list_events',
  'fetch_event',
  'list_tags',
  'fetch_tag',
  'search',
  'get_order_book',
  'get_spread',
  'get_midpoint',
  'fetch_market_tags',
  'list_comments',
  'list_sports',
  'list_current_rewards',
  'list_market_rewards',
  'list_reward_markets',
  'get_market_reward_details',
  'order_scoring',
  'batch_order_scoring',
  'list_simplified_markets',
  'list_sampling_markets',
  'list_sampling_simplified_markets',
  'place_limit_order',
  'place_market_order',
  'place_optimized_reward_order',
  'create_limit_order',
  'create_market_order',
  'cancel_order',
  'cancel_market_orders',
  'cancel_all_orders',
  'list_open_orders',
  'fetch_order',
  'get_order_history',
  'post_orders',
  'list_positions',
  'get_balance_allowance',
  'get_portfolio_value',
  'list_activity',
  'list_trades',
  'get_user_earnings',
  'get_farmability',
  'suggest_qualified_size',
  'is_gasless_ready',
  'setup_gasless_wallet',
  'subscribe_market',
  'subscribe_sports',
  'subscribe_user',
  'subscribe_prices_crypto',
  'fetch_sdk_readme',
];

/** One-call bundles: registers category tools for the session (no capability removed). */
export const AGENT_PROFILES: Record<string, { categories: string[]; description: string }> = {
  weather: {
    description: 'Topic discovery + UK forecast + trading + order book reads',
    categories: ['Weather', 'Discovery', 'Trading', 'Analytics'],
  },
  rewards: {
    description: 'Maker rewards scan, farmability, optimized place, full reward toolkit',
    categories: ['Intelligence', 'Rewards', 'Trading', 'Strategy'],
  },
  automation: {
    description: 'Cycle planner + alpha report + intelligence signals',
    categories: ['Meta', 'Intelligence', 'Strategy'],
  },
  trading: {
    description: 'Full trading + account positions + discovery',
    categories: ['Trading', 'Account', 'Discovery'],
  },
  discovery: {
    description: 'list_events/markets/search/tags and related discovery tools',
    categories: ['Discovery', 'Analytics'],
  },
  account: {
    description: 'Portfolio, activity, trades, profile',
    categories: ['Account', 'Analytics'],
  },
  full: {
    description: 'All categories except Advanced (load Advanced separately when needed)',
    categories: ['Intelligence', 'Rewards', 'Strategy', 'Account', 'Utilities', 'Discovery', 'Trading', 'Analytics', 'Weather'],
  },
};

export type ToolDef = {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown> };
};

export type SearchToolsDetail = 'name' | 'summary' | 'schema';

export function searchToolDefinitions(
  tools: ToolDef[],
  query: string,
  detail: SearchToolsDetail = 'summary',
  limit = 15
): Array<Record<string, unknown>> {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const scored = tools
    .map((t) => {
      const name = t.name.toLowerCase();
      const desc = (t.description || '').toLowerCase();
      let score = 0;
      if (name === q) score += 100;
      if (name.includes(q)) score += 50;
      if (desc.includes(q)) score += 20;
      for (const part of q.split(/\s+/)) {
        if (part && name.includes(part)) score += 10;
        if (part && desc.includes(part)) score += 5;
      }
      return { t, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map(({ t }) => {
    if (detail === 'name') return { name: t.name };
    if (detail === 'schema') {
      return { name: t.name, description: t.description, inputSchema: t.inputSchema };
    }
    const short = (t.description || '').split('.')[0].slice(0, 160);
    return { name: t.name, summary: short };
  });
}