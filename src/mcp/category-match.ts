/** Category matching: [Prefix] first, tight keywords second — avoids Meta/Analytics pollution. */

import type { ToolDef } from './agent-meta.js';

export const TOOL_COUNT = 145;

/** Tools missing [Category] prefix — applied at load time in mcp.ts */
export const CATEGORY_PREFIX_BY_TOOL: Record<string, string> = {
  setup_trading_approvals: 'Account',

  is_gasless_ready: 'Account',
  fetch_closed_only_mode: 'Account',
  list_account_trades: 'Account',
  approve_erc20: 'Advanced',
  approve_erc1155_for_all: 'Advanced',
  transfer_erc20: 'Advanced',
  fetch_transaction: 'Advanced',
  resolve_condition_by_token: 'Discovery',
  fetch_event: 'Discovery',
  fetch_sports_market_types: 'Discovery',
  list_sports: 'Discovery',
  list_teams: 'Discovery',
  fetch_market_info: 'Analytics',
  fetch_neg_risk: 'Analytics',
  list_trades: 'Analytics',
  fetch_total_earnings_for_user_for_day: 'Rewards',
  split_position: 'Trading',
  merge_positions: 'Trading',
  redeem_positions: 'Trading',
};

export function ensureCategoryPrefix(tool: ToolDef): ToolDef {
  const cat = CATEGORY_PREFIX_BY_TOOL[tool.name];
  if (!cat || !tool.description) return tool;
  if (/^\[[^\]]+\]/i.test(tool.description)) return tool;
  return { ...tool, description: `[${cat}] ${tool.description}` };
}

export function getToolsByCategory(
  tools: ToolDef[],
  category: string
): ToolDef[] {
  const catLower = category.toLowerCase();

  return tools.filter((t) => {
    const desc = t.description || '';
    const bracket = desc.match(/^\[([^\]]+)\]/i)?.[1]?.toLowerCase();
    if (bracket) {
      if (catLower === bracket) return true;
      if (catLower === 'data' && bracket === 'analytics') return true;
      return false;
    }

    const n = t.name;
    if (catLower === 'intelligence' && /alpha_report|generate_alpha|market_signals|route_agent_intent/.test(n)) return true;
    if (catLower === 'external' && /crypto_spot|uk_weather|get_weather/.test(n)) return true;
    if (catLower === 'rewards' && /list_active_maker|farmability|maker_reward|optimized_reward/.test(n)) return true;
    if (catLower === 'trading' && /place_limit|place_market|cancel_|post_order|split_position|merge_position|redeem_position|get_order_book|get_spread/.test(n)) return true;
    if (catLower === 'discovery' && /discover_topic|fetch_market|list_market|list_event|fetch_event|search|list_tag|list_sport/.test(n)) return true;
    if (catLower === 'account' && /balance|allowance|portfolio|position|notification|setup_trading|gasless_ready|closed_only/.test(n)) return true;
    if (catLower === 'advanced' && /approve_|transfer_erc|prepare_|sign_|send_transaction|deploy_|api_key|heartbeat/.test(n)) return true;
    if (catLower === 'utilities' && /wait_seconds|suggest_qualified/.test(n)) return true;
    if (catLower === 'meta' && /list_tool_categories|get_tools_by_category|get_mcp_usage|get_agent_recipes|search_tools|load_agent_profile|fetch_sdk_readme|run_agent_cycle|route_agent_intent/.test(n)) return true;
    if (catLower === 'resources' && /watch_order|send_heartbeat/.test(n)) return true;
    return false;
  });
}