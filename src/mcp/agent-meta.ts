/** Tier-1 default surface: daily-driver tools only. Full handlers via categories (see TOOL_COUNT). */

/** Minimal daily surface — full handlers via route_agent_intent + load_agent_profile / categories. */
export const TIER1_CORE_TOOL_NAMES: readonly string[] = [
  'get_agent_recipes',
  'fetch_sdk_readme',
  'route_agent_intent',
  'list_tool_categories',
  'get_tools_by_category',
  'get_mcp_usage',
  'search_tools',
  'load_agent_profile',
  'discover_topic',
  'fetch_market',
  'get_strategies',
  'set_strategy',
  'update_strategy',
  'clear_strategy',
  'wait_seconds',
  'get_balance_allowance',
  'list_positions',
  'list_active_maker_reward_markets',
  'get_farmability',
  'suggest_qualified_size',
  'get_spread',
  'get_order_book',
  'place_limit_order',
  'place_optimized_reward_order',
  'cancel_order',
  'list_open_orders',
  'post_orders',
  'get_uk_weather_forecast',
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