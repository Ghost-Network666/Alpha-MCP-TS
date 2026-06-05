/**
 * Deterministic intent → tool-plan routing for host LLMs.
 * Routes WHICH tools to call — never substitutes numeric trade params (no trading-by-intent).
 */

import type { CycleGoal, CycleStep } from '../automation/agent-cycle.js';

export type AgentIntent =
  | 'session_startup'
  | 'rewards_farm'
  | 'weather_alpha'
  | 'mispricing_flip'
  | 'trading_monitor'
  | 'discovery_scan'
  | 'check_orderbook'
  | 'check_spread'
  | 'check_farmability'
  | 'alpha_scan'
  | 'place_reward_maker'
  | 'place_limit_explicit'
  | 'rotate_after_failure';

export type IntentRouteRequest = {
  intent: AgentIntent;
  topic?: string;
  tokenId?: string;
  market?: string;
  slug?: string;
  maxMinCostUsd?: number;
  goal?: CycleGoal;
  strategies?: Record<string, unknown>;
};

/** MCP tool name → SDK README method (confirm via fetch_sdk_readme before first use). */
export const MCP_TO_SDK_METHOD: Record<string, string> = {
  place_limit_order: 'placeLimitOrder',
  place_optimized_reward_order: 'placeLimitOrder (postOnly GTC via MCP wrapper)',
  place_market_order: 'placeMarketOrder',
  get_order_book: 'getOrderBook',
  get_spread: 'getSpread',
  fetch_market: 'listMarkets({ clobTokenIds }) — fetchMarket has no tokenId',
  discover_topic: 'listEvents + listMarkets (tagSlug/tagId)',
  list_active_maker_reward_markets: 'listCurrentRewards + listMarkets enrichment',
  get_farmability: 'getOrderBook + listMarketRewards / mids',
  post_orders: 'postOrders',
};

export type IntentRoutePlan = {
  success: boolean;
  intent: AgentIntent;
  phase: 'route';
  steps: CycleStep[];
  profile?: string;
  prompts: string[];
  resources: string[];
  nextTools: string[];
  agentDirective: string;
  tradingRule: string;
  sdkAlignment: {
    readmeTool: string;
    readmeResource: string;
    rule: string;
    mcpToSdk: typeof MCP_TO_SDK_METHOD;
  };
  intentRegistry: typeof INTENT_REGISTRY;
  note: string;
};

export const INTENT_REGISTRY: Record<
  AgentIntent,
  { summary: string; profile?: string; primaryTools: string[] }
> = {
  session_startup: {
    summary: 'First calls every MCP session',
    primaryTools: [
      'get_agent_recipes',
      'get_strategies',
      'route_agent_intent',
      'load_agent_profile',
    ],
  },
  rewards_farm: {
    summary: 'Maker reward loop: scan → farmability → place',
    profile: 'rewards',
    primaryTools: [
      'generate_alpha_report',
      'list_active_maker_reward_markets',
      'get_farmability',
      'place_optimized_reward_order',
    ],
  },
  weather_alpha: {
    summary: 'Weather topic + forecast + explicit limit',
    profile: 'weather',
    primaryTools: ['discover_topic', 'get_uk_weather_forecast', 'alpha_report', 'place_limit_order'],
  },
  mispricing_flip: {
    summary: 'External signal vs platform price',
    profile: 'trading',
    primaryTools: ['compute_market_signals', 'get_farmability', 'place_limit_order'],
  },
  trading_monitor: {
    summary: 'Open orders, positions, balance',
    profile: 'trading',
    primaryTools: ['list_open_orders', 'list_positions', 'get_balance_allowance'],
  },
  discovery_scan: {
    summary: 'Topic/events/markets with tokenIds',
    profile: 'discovery',
    primaryTools: ['discover_topic', 'fetch_market', 'search'],
  },
  check_orderbook: {
    summary: 'CLOB depth (tier-1)',
    primaryTools: ['get_order_book'],
  },
  check_spread: {
    summary: 'Bid-ask spread (tier-1)',
    primaryTools: ['get_spread'],
  },
  check_farmability: {
    summary: 'Pre-trade reward/book snapshot',
    primaryTools: ['get_farmability'],
  },
  alpha_scan: {
    summary: 'Deterministic ranked report',
    primaryTools: ['generate_alpha_report', 'alpha_report'],
  },
  place_reward_maker: {
    summary: 'Post-only maker reward place',
    primaryTools: ['place_optimized_reward_order'],
  },
  place_limit_explicit: {
    summary: 'You supply price/size/side — SDK placeLimitOrder',
    primaryTools: ['place_limit_order'],
  },
  rotate_after_failure: {
    summary: 'Pick different market after failed place',
    primaryTools: ['list_active_maker_reward_markets', 'generate_alpha_report'],
  },
};

const TRADING_RULE =
  'Intent routing picks tools only. Trading requires explicit numeric price, size, and side on place_limit_order / place_optimized_reward_order — never natural-language trade intent.';

function goalFromIntent(intent: AgentIntent, req: IntentRouteRequest): CycleGoal | undefined {
  if (req.goal) return req.goal;
  const map: Partial<Record<AgentIntent, CycleGoal>> = {
    rewards_farm: 'rewards',
    weather_alpha: 'weather',
    mispricing_flip: 'mispricing',
    trading_monitor: 'trading',
    discovery_scan: 'discovery',
    alpha_scan: 'discovery',
  };
  return map[intent];
}

export function buildIntentRoute(req: IntentRouteRequest): IntentRoutePlan {
  const intent = req.intent;
  const reg = INTENT_REGISTRY[intent];
  const steps: CycleStep[] = [];
  let order = 1;
  const tokenRef = req.tokenId
    ? { tokenId: req.tokenId }
    : req.market || req.slug
      ? { market: req.market || req.slug }
      : { tokenId: '<tokenId from prior card>' };

  const push = (tool: string, arguments_: Record<string, unknown>, why: string) => {
    steps.push({ order: order++, tool, arguments: arguments_, why });
  };

  if (intent === 'session_startup') {
    push('fetch_sdk_readme', {}, 'Canonical SDK method names — confirm every routed tool against this.');
    push('get_agent_recipes', {}, 'MCP tool shapes + intentRouting registry + knownGotchas.');
    push('get_strategies', {}, 'Load or auto-seed session rules.');
    push(
      'route_agent_intent',
      { intent: 'rewards_farm' },
      'Re-call with your real intent after reading SDK readme + recipes.'
    );
  } else if (intent === 'rewards_farm') {
    push('load_agent_profile', { profile: 'rewards' }, 'Register intelligence + reward tools; re-call tools/list.');
    push('get_strategies', {}, 'Farming rules first.');
    push(
      'generate_alpha_report',
      { goal: 'rewards', maxMinCostUsd: req.maxMinCostUsd ?? 10, maxCandidates: 5 },
      'Ranked reward opportunities.'
    );
    push('get_farmability', tokenRef, 'Book + reward eligibility.');
    push(
      'suggest_qualified_size',
      { intent: 'reward_farming', ...tokenRef, side: 'BUY' },
      'Advisory size only.'
    );
    push('get_balance_allowance', { assetType: 'COLLATERAL' }, 'USDC pre-flight.');
    push('place_optimized_reward_order', { ...tokenRef, side: 'BUY' }, 'Post-only maker place.');
    push('wait_seconds', { seconds: 5, reason: 'rate discipline' }, 'CLOB place-path backoff.');
  } else if (intent === 'weather_alpha') {
    push('load_agent_profile', { profile: 'weather' }, 'Register forecast + discovery + book tools.');
    const topic = req.topic || 'weather';
    push('discover_topic', { topic, closed: false, pageSize: 15 }, 'Events + markets + tokenIds.');
    push('get_uk_weather_forecast', { city: 'London', days: 5 }, 'External reference.');
    push(
      'generate_alpha_report',
      { goal: 'weather', topic, midPriceMin: 0.45, midPriceMax: 0.55, maxCandidates: 6 },
      'Mid-band liquid scan.'
    );
    push('get_order_book', tokenRef, 'Depth before quote.');
    push(
      'place_limit_order',
      { ...tokenRef, price: 0.5, size: 5, side: 'BUY' },
      'Replace with YOUR numbers from analysis.'
    );
  } else if (intent === 'mispricing_flip') {
    push('load_agent_profile', { profile: 'trading' }, 'Register signals + full trading toolkit.');
    push('compute_market_signals', { ...tokenRef, signal: 0.55, weight: 0.4 }, 'Host supplies signal.');
    push('get_farmability', tokenRef, 'Liquidity + spread health.');
    push(
      'place_limit_order',
      { ...tokenRef, price: 0.48, size: 5, side: 'BUY' },
      'Explicit limit from your edge.'
    );
  } else if (intent === 'trading_monitor') {
    push('list_open_orders', {}, 'Resting orders.');
    push('list_positions', {}, 'Exposure.');
    push('get_balance_allowance', { assetType: 'COLLATERAL' }, 'Collateral.');
  } else if (intent === 'discovery_scan') {
    push(
      'discover_topic',
      { topic: req.topic || 'crypto', closed: false, pageSize: 20 },
      'Primary discovery.'
    );
    push('fetch_market', tokenRef, 'Full market card.');
  } else if (intent === 'check_orderbook') {
    push('get_order_book', tokenRef, 'SDK fetchOrderBook via MCP.');
  } else if (intent === 'check_spread') {
    push('get_spread', tokenRef, 'SDK fetchSpread via MCP.');
  } else if (intent === 'check_farmability') {
    push('get_farmability', tokenRef, 'Reward + book snapshot.');
  } else if (intent === 'alpha_scan') {
    push('load_agent_profile', { profile: 'automation' }, 'Register alpha_report + intelligence tools.');
    push(
      'generate_alpha_report',
      {
        goal: req.goal || 'discovery',
        topic: req.topic,
        maxMinCostUsd: req.maxMinCostUsd,
        midPriceMin: 0.45,
        midPriceMax: 0.55,
        maxCandidates: 6,
      },
      'Deterministic scan + scores.'
    );
  } else if (intent === 'place_reward_maker') {
    push('get_farmability', tokenRef, 'Confirm before place.');
    push('place_optimized_reward_order', { ...tokenRef, side: 'BUY' }, 'Maker reward path.');
  } else if (intent === 'place_limit_explicit') {
    push('get_order_book', tokenRef, 'Quote reference.');
    push(
      'place_limit_order',
      { ...tokenRef, price: 0.5, size: 5, side: 'BUY' },
      'You MUST set price/size/side from strategy — placeholders only.'
    );
  } else if (intent === 'rotate_after_failure') {
    push(
      'list_active_maker_reward_markets',
      { maxMinCostUsd: req.maxMinCostUsd ?? 10 },
      'Fresh ranked markets.'
    );
    push(
      'generate_alpha_report',
      { goal: 'rewards', maxMinCostUsd: req.maxMinCostUsd ?? 10 },
      'Alternate pick — never retry same token blindly.'
    );
  }

  push('get_mcp_usage', {}, 'Session observability.');

  const goal = goalFromIntent(intent, req);
  const prompts = [
    'agent_routing',
    'never_guess_contract',
    'mcp_tool_structure_and_categories',
    goal === 'rewards' ? 'reward_farming_best_practices' : goal === 'mispricing' ? 'mispricing_quick_flips' : '',
  ].filter(Boolean);

  const resources = [
    'polymarket://sdk/readme',
    'polymarket://mcp/llms.txt',
    'polymarket://user/orders',
  ];
  if (req.tokenId) resources.push(`polymarket://market/${req.tokenId}/book`);

  const agentDirective =
    intent === 'rotate_after_failure'
      ? 'DO NOT retry the failed tokenId. Execute steps in order; pick a DIFFERENT market from list_active or alpha_report.'
      : intent === 'place_limit_explicit' || intent === 'place_reward_maker'
        ? 'Execute tools/call steps with YOUR numeric price/size. Intent does not place orders — you do.'
        : `Intent "${intent}": execute steps in order via tools/call. DO NOT ask the human for menus. ${TRADING_RULE}`;

  return {
    success: true,
    intent,
    phase: 'route',
    steps,
    profile: reg.profile,
    prompts,
    resources,
    nextTools: [...new Set(steps.map((s) => s.tool))],
    agentDirective,
    tradingRule: TRADING_RULE,
    sdkAlignment: {
      readmeTool: 'fetch_sdk_readme',
      readmeResource: 'polymarket://sdk/readme',
      rule:
        'Before the first tools/call on a routed step, confirm the SDK README method in mcpToSdk matches get_agent_recipes inputSchema — never invent parameters.',
      mcpToSdk: MCP_TO_SDK_METHOD,
    },
    intentRegistry: INTENT_REGISTRY,
    note: 'Deterministic routing only — host LLM runs each step in order. Re-call route_agent_intent when the goal changes.',
  };
}

/** Map legacy run_agent_cycle goal → default intent */
export function intentFromCycleGoal(goal: CycleGoal): AgentIntent {
  const m: Record<CycleGoal, AgentIntent> = {
    rewards: 'rewards_farm',
    weather: 'weather_alpha',
    mispricing: 'mispricing_flip',
    trading: 'trading_monitor',
    discovery: 'discovery_scan',
  };
  return m[goal] ?? 'discovery_scan';
}