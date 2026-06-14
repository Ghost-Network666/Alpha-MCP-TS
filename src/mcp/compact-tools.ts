import type { ToolDef } from './agent-meta.js';

const MAX_DESC = 180;

/** Short tool descriptions for tier-1 tools/list (full text in get_tools_by_category). */
export const COMPACT_TOOL_DESCRIPTIONS: Record<string, string> = {
  get_agent_recipes: '[Meta] Startup JSON recipes + knownGotchas + tool registry for direct discovery.',
  // route_agent_intent and proprietary NL routing layer removed; agents use tools/list + tools/call directly.
  mcp_doctor: '[Meta] Health check + host doctor commands (Grok/Hermes/OpenClaw).',
  search_tools: '[Meta] Find tools by keyword (detail: name|summary|schema).',
  load_agent_profile: '[Meta] Register profile bundle; re-call tools/list.',
  list_tool_categories: '[Meta] List categories for get_tools_by_category.',
  get_tools_by_category: '[Meta] Register one category; re-call tools/list.',
  get_mcp_usage: '[Meta] MCP tool-call stats this session.',
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
  get_balance_allowance: '[Account] USDC (COLLATERAL) or outcome token (CONDITIONAL + tokenId) balance.',
  list_positions: '[Account] Open positions with PnL cards.',
  list_active_maker_reward_markets: '[Rewards] PRIMARY enriched reward market scan.',
  list_reward_markets: '[Rewards] SDK-native bulk (listCurrentRewards) enumeration of markets with active rewards. Full configs: rewards_min_size etc. Supports search/tag/numeric filters, 100/page.',
  get_market_reward_details: '[Rewards] Raw per-market rewards config (present/future) via listMarketRewards.',
  list_simplified_markets: '[Discovery] Lightweight markets (accepting_orders, active, rewards, tokens) via listMarkets.',
  list_sampling_markets: '[Rewards] Markets eligible for sampling/liquidity rewards.',
  list_sampling_simplified_markets: '[Rewards] Lightweight sampling markets.',
  get_user_earnings: '[Rewards] User earnings + percentages per market for day (via activity/rewards).',
  get_farmability: '[Rewards] SDK book+rewards+mid. slug/decimal ok; non-reward=book-only.',
  subscribe_market: '[WS] Subscribe to market topic for orderbooks, trades, prices (returns resource URI or starts push).',
  subscribe_sports: '[WS] Subscribe to sports scores and periods.',
  subscribe_user: '[WS] Subscribe to authenticated user updates (orders, fills).',
  subscribe_prices_crypto: '[WS] Subscribe to real-time crypto prices (Binance etc).',
  is_gasless_ready: '[Gasless] Check if gasless wallet is ready.',
  setup_gasless_wallet: '[Gasless] Setup gasless wallet (idempotent per SDK).',
  list_current_rewards: '[Rewards] Raw SDK listCurrentRewards - all active reward programs.',
  list_market_rewards: '[Rewards] Raw listMarketRewards for a market (present/future).',
  order_scoring: '[Rewards] Check single order scoring eligibility.',
  batch_order_scoring: '[Rewards] Batch order scoring.',
  get_portfolio_value: '[Account] SDK getPortfolioValue.',
  list_activity: '[Account] SDK listActivity - trades, rewards, on-chain.',
  list_trades: '[Account] Historical trades.',
  create_limit_order: '[Trading] createLimitOrder (sign only, no post).',
  create_market_order: '[Trading] createMarketOrder (sign only).',
  cancel_market_orders: '[Trading] Cancel all orders for a market.',
  cancel_all_orders: '[Trading] Cancel all user orders.',
  fetch_order: '[Trading] fetchOrder by ID.',
  get_order_history: '[Trading] Order history.',
  list_comments: '[Discovery] listComments for market/event.',
  fetch_market_tags: '[Discovery] fetchMarketTags.',
  list_sports: '[Discovery] Sports metadata.',
  get_order_book: '[Trading] getOrderBook (already core, confirmed).',
  get_midpoint: '[Trading] getMidpointPrice.',
  fetch_event: '[Discovery] fetchEvent.',

  suggest_qualified_size: '[Utilities] Advisory size from intent (not auto-place).',
  get_spread: '[Trading] Bid-ask spread. tokenId | slug | decimal id.',
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