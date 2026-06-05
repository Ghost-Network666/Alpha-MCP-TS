import type { ToolDef } from './agent-meta.js';

const MAX_DESC = 180;

/** Short tool descriptions for tier-1 tools/list (full text in get_tools_by_category). */
export const COMPACT_TOOL_DESCRIPTIONS: Record<string, string> = {
  get_agent_recipes: '[Meta] Startup JSON recipes + knownGotchas + intent registry.',
  route_agent_intent: '[Meta] PRIMARY: intent → ordered tools/call steps (not trade-by-intent).',
  search_tools: '[Meta] Find tools by keyword (detail: name|summary|schema).',
  load_agent_profile: '[Meta] Register profile bundle; re-call tools/list.',
  list_tool_categories: '[Meta] List categories for get_tools_by_category.',
  get_tools_by_category: '[Meta] Register one category; re-call tools/list.',
  get_mcp_usage: '[Meta] MCP tool-call stats this session.',
  fetch_sdk_readme: '[Meta] Live upstream TS SDK README text.',
  run_agent_cycle: '[Meta] Legacy goal enum → intent route plan.',
  discover_topic: '[Discovery] Topic → events + markets + tokenIds.',
  fetch_market: '[Discovery] Market by id/slug/url/tokenId.',
  generate_alpha_report: '[Intelligence] Liquid mid-price scan + confidence scores.',
  alpha_report: '[Intelligence] Alias of generate_alpha_report.',
  get_strategies: '[Strategy] Load rules; auto-seeds defaults if empty.',
  set_strategy: '[Strategy] Store full rule set under key.',
  update_strategy: '[Strategy] Partial merge into strategy key.',
  clear_strategy: '[Strategy] Delete one strategy key.',
  wait_seconds: '[Utilities] Server-side backoff (rate discipline).',
  get_balance_allowance: '[Account] USDC/conditional balance + allowance.',
  list_positions: '[Account] Open positions with PnL cards.',
  list_active_maker_reward_markets: '[Rewards] PRIMARY enriched reward market scan.',
  get_farmability: '[Rewards] SDK book+rewards+mid. slug/decimal ok; non-reward=book-only.',
  suggest_qualified_size: '[Utilities] Advisory size from intent (not auto-place).',
  get_spread: '[Trading] Bid-ask spread. tokenId | slug | decimal id.',
  get_order_book: '[Trading] Book depth. tokenId | slug | decimal id.',
  place_limit_order: '[Trading] SDK limit: no orderType on wire. GTD=expiration. FOK/FAK→place_market_order.',
  place_optimized_reward_order: '[Rewards] Suggest→validate→place maker reward order.',
  cancel_order: '[Trading] Cancel one order by orderId.',
  list_open_orders: '[Trading] List resting orders.',
  post_orders: '[Trading] Batch post up to 15 orders.',
  get_uk_weather_forecast: '[Weather] UK forecast (multi-provider fallback).',
  get_crypto_spot: '[External] Crypto spot USD reference prices.',
  compute_market_signals: '[Intelligence] Farmability + optional Bayesian blend.',
};

export function compactTool(tool: ToolDef): ToolDef {
  const short = COMPACT_TOOL_DESCRIPTIONS[tool.name];
  if (short) return { ...tool, description: short };

  const desc = tool.description || '';
  const prefix = desc.match(/^\[[^\]]+\]/)?.[0] || '';
  const body = desc.replace(/^\[[^\]]+\]\s*/, '').trim();
  const firstSentence = body.split(/(?<=[.!?])\s+/)[0] || body;
  let compact = prefix ? `${prefix} ${firstSentence}` : firstSentence;
  if (compact.length > MAX_DESC) compact = compact.slice(0, MAX_DESC - 3) + '...';
  return { ...tool, description: compact };
}

export function compactTools(tools: ToolDef[]): ToolDef[] {
  return tools.map(compactTool);
}