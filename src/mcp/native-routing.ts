/**
 * Built-in routing on every native tool response.
 * Host agents follow routing.nextTools — no extra meta calls required when enabled.
 */

import type { CycleStep } from '../automation/agent-cycle.js';
import { COMPACT_TOOL_DESCRIPTIONS } from './compact-tools.js';
import {
  buildIntentRoute,
  MCP_TO_SDK_METHOD,
  type AgentIntent,
} from './intent-routing.js';
import {
  getIntentSession,
  inferIntentFromStrategies,
  readRoutingConfig,
  touchIntentSession,
  type McpRoutingConfig,
} from './intent-context.js';

export const SDK_README_URL = 'https://github.com/Polymarket/ts-sdk/blob/main/README.md';

export type NativeToolRouting = {
  routingEnabled: boolean;
  autonomousAssist: boolean;
  activeIntent: AgentIntent | null;
  tool: string;
  toolPurpose: string;
  sdkMethod: string | null;
  sdkReadme: string;
  sdkReadmeTool: 'fetch_sdk_readme';
  tradingRule: string;
  nextTools: CycleStep[];
  loopPlan?: CycleStep[];
  agentDirective: string;
  configure: { tool: 'configure_agent_routing'; hint: string };
};

const TRADING_RULE =
  'Routing names native MCP tools only. You must pass explicit numeric price, size, and side on place_* — never trade-by-intent.';

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
};

function extractTokenId(
  args: Record<string, unknown>,
  payload: Record<string, unknown> | null
): string | undefined {
  const fromArgs = args.tokenId || args.market || args.slug;
  if (fromArgs) return String(fromArgs);
  if (!payload) return undefined;
  if (typeof payload.tokenId === 'string') return payload.tokenId;
  const markets = payload.markets as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(markets) && markets[0]) {
    const m = markets[0];
    return (
      (m.yesTokenId as string) ||
      (m['Yes Token Id'] as string) ||
      (m.noTokenId as string) ||
      undefined
    );
  }
  const outcomes = payload.outcomes as { yes?: { tokenId?: string } } | undefined;
  if (outcomes?.yes?.tokenId) return outcomes.yes.tokenId;
  return undefined;
}

function toolPurpose(name: string): string {
  return (
    COMPACT_TOOL_DESCRIPTIONS[name] ||
    `[Tool] Native SDK-backed handler. See fetch_sdk_readme + get_agent_recipes for schema.`
  );
}

function sdkMethodFor(tool: string): string | null {
  return MCP_TO_SDK_METHOD[tool] ?? null;
}

function pushStep(
  steps: CycleStep[],
  tool: string,
  arguments_: Record<string, unknown>,
  why: string,
  order: { n: number }
) {
  steps.push({ order: order.n++, tool, arguments: arguments_, why });
}

/** Deterministic next 1–4 tools after this call. */
export function buildNextToolsForCall(
  toolName: string,
  args: Record<string, unknown>,
  payload: Record<string, unknown> | null,
  cfg: McpRoutingConfig,
  intent: AgentIntent | null
): CycleStep[] {
  const steps: CycleStep[] = [];
  let order = 1;
  const tokenId = extractTokenId(args, payload) || getIntentSession().lastTokenId;
  const tokenRef = tokenId ? { tokenId } : { tokenId: '<from prior card>' };
  const maxUsd = cfg.maxMinCostUsd ?? 10;

  const active = intent || cfg.activeIntent || 'discovery_scan';

  if (toolName === 'configure_agent_routing' || toolName === 'route_agent_intent') {
    return steps;
  }

  if (toolName === 'fetch_sdk_readme' || toolName === 'get_agent_recipes') {
    pushStep(
      steps,
      'configure_agent_routing',
      { enabled: true, intent: active, autonomousAssist: cfg.autonomousAssist ?? true },
      'Turn on built-in routing on every native tool response.',
      { n: order }
    );
    pushStep(steps, 'route_agent_intent', { intent: active }, 'Full batch plan (optional).', { n: order });
    return steps;
  }

  if (toolName === 'get_strategies' && !cfg.enabled) {
    pushStep(
      steps,
      'configure_agent_routing',
      { enabled: true, intent: 'rewards_farm', autonomousAssist: true },
      'Enable MCP routing assist — recommended for Hermes/OpenClaw.',
      { n: order }
    );
    return steps;
  }

  if (toolName === 'list_active_maker_reward_markets' || toolName === 'generate_alpha_report' || toolName === 'alpha_report') {
    const top = (payload?.markets as Array<Record<string, unknown>>)?.[0];
    const tid =
      (top?.yesTokenId as string) ||
      (top?.['Yes Token Id'] as string) ||
      tokenId;
    pushStep(steps, 'get_farmability', tid ? { tokenId: tid } : tokenRef, 'Book + reward snapshot before place.', {
      n: order,
    });
    pushStep(
      steps,
      'suggest_qualified_size',
      { intent: 'reward_farming', ...(tid ? { tokenId: tid } : tokenRef), side: 'BUY' },
      'Advisory size from reward rules.',
      { n: order }
    );
    pushStep(
      steps,
      'place_optimized_reward_order',
      { ...(tid ? { tokenId: tid } : tokenRef), side: 'BUY' },
      'Post-only maker — you confirm price/size from farmability.',
      { n: order }
    );
    return steps;
  }

  if (toolName === 'get_farmability') {
    const score = Number(payload?.farmabilityScore ?? payload?.['Farmability Score'] ?? 0);
    const ok = score >= 40 || payload?.success === true;
    if (!ok) {
      pushStep(
        steps,
        'list_active_maker_reward_markets',
        { maxMinCostUsd: maxUsd },
        'Low score — pick another market.',
        { n: order }
      );
      return steps;
    }
    pushStep(
      steps,
      'suggest_qualified_size',
      { intent: 'reward_farming', ...tokenRef, side: 'BUY' },
      'Size to qualify for rewards.',
      { n: order }
    );
    pushStep(steps, 'get_balance_allowance', { assetType: 'COLLATERAL' }, 'USDC pre-flight.', { n: order });
    pushStep(
      steps,
      'place_optimized_reward_order',
      { ...tokenRef, side: 'BUY' },
      'Place with YOUR price/size from book + strategy.',
      { n: order }
    );
    pushStep(steps, 'wait_seconds', { seconds: 5, reason: 'CLOB place-path backoff' }, 'Rate discipline.', {
      n: order,
    });
    return steps;
  }

  if (toolName === 'discover_topic') {
    pushStep(steps, 'fetch_market', tokenRef, 'Full card for chosen token.', { n: order });
    if (active === 'weather_alpha' || (args.topic as string)?.toString().toLowerCase().includes('weather')) {
      pushStep(steps, 'get_uk_weather_forecast', { city: 'London', days: 5 }, 'External reference.', { n: order });
    }
    pushStep(steps, 'get_order_book', tokenRef, 'Depth before quote.', { n: order });
    return steps;
  }

  if (toolName === 'fetch_market') {
    pushStep(steps, 'get_farmability', tokenRef, 'Liquidity + spread health.', { n: order });
    pushStep(steps, 'get_order_book', tokenRef, 'Live book.', { n: order });
    return steps;
  }

  if (toolName === 'get_order_book' || toolName === 'get_spread') {
    pushStep(steps, 'get_farmability', tokenRef, 'Reward + competition signals.', { n: order });
    pushStep(
      steps,
      'place_limit_order',
      { ...tokenRef, price: 0.5, size: 5, side: 'BUY' },
      'Replace price/size with your numbers.',
      { n: order }
    );
    return steps;
  }

  if (toolName === 'place_optimized_reward_order' || toolName === 'place_limit_order' || toolName === 'place_maker_reward_order') {
    const failed =
      payload?.success === false ||
      String(payload?.Status || payload?.status || '').includes('❌') ||
      String(payload?.agentDirective || '').includes('CRITICAL');
    if (failed) {
      pushStep(
        steps,
        'list_active_maker_reward_markets',
        { maxMinCostUsd: maxUsd },
        'Rotate — different market.',
        { n: order }
      );
      pushStep(steps, 'get_farmability', { tokenId: '<new yesTokenId>' }, 'Re-check new pick.', { n: order });
    } else {
      pushStep(steps, 'list_open_orders', {}, 'Confirm resting order.', { n: order });
      pushStep(steps, 'wait_seconds', { seconds: 5, reason: 'post-place monitor' }, 'Backoff.', { n: order });
    }
    return steps;
  }

  if (toolName === 'suggest_qualified_size') {
    pushStep(steps, 'place_optimized_reward_order', { ...tokenRef, side: 'BUY' }, 'Use suggested size + your price.', {
      n: order,
    });
    return steps;
  }

  if (cfg.enabled && active) {
    pushStep(steps, 'route_agent_intent', { intent: active }, 'Refresh full plan for this goal.', { n: order });
  }

  return steps.slice(0, 4);
}

export function buildNativeRoutingBlock(
  toolName: string,
  args: Record<string, unknown>,
  payload: Record<string, unknown> | null,
  store: Map<string, unknown>
): NativeToolRouting {
  const cfg = readRoutingConfig(store);
  const intent = inferIntentFromStrategies(store) || cfg.activeIntent || null;
  const tokenId = extractTokenId(args, payload);
  touchIntentSession(toolName, tokenId, intent ?? undefined);

  const nextTools = buildNextToolsForCall(toolName, args, payload, cfg, intent);
  let loopPlan: CycleStep[] | undefined;
  if (cfg.enabled && cfg.autonomousAssist && intent) {
    const plan = buildIntentRoute({
      intent,
      topic: cfg.topic,
      tokenId: tokenId || getIntentSession().lastTokenId,
      maxMinCostUsd: cfg.maxMinCostUsd,
      strategies: Object.fromEntries(store.entries()),
    });
    loopPlan = plan.steps;
  }

  const enabled = cfg.enabled;
  const directive = enabled
    ? nextTools.length > 0
      ? `Routing ON: call nextTools[0] (${nextTools[0].tool}) with given arguments. ${TRADING_RULE}`
      : `Routing ON: call route_agent_intent({ intent: "${intent || 'session_startup'}" }) to refresh plan. ${TRADING_RULE}`
    : `Routing OFF: call configure_agent_routing({ enabled: true, intent: "rewards_farm", autonomousAssist: true }) to embed next-step routing on every native tool. ${TRADING_RULE}`;

  return {
    routingEnabled: enabled,
    autonomousAssist: Boolean(cfg.autonomousAssist),
    activeIntent: intent,
    tool: toolName,
    toolPurpose: toolPurpose(toolName),
    sdkMethod: sdkMethodFor(toolName),
    sdkReadme: SDK_README_URL,
    sdkReadmeTool: 'fetch_sdk_readme',
    tradingRule: TRADING_RULE,
    nextTools: enabled ? nextTools : nextTools.slice(0, 1),
    loopPlan: enabled && cfg.autonomousAssist ? loopPlan : undefined,
    agentDirective: directive,
    configure: {
      tool: 'configure_agent_routing',
      hint: 'configure_agent_routing({ enabled: true, intent, autonomousAssist: true }) — MCP handles routing; agent executes native tools.',
    },
  };
}

/** Merge routing into JSON tool payloads (all handlers). */
export function enrichNativeToolResponse(
  toolName: string,
  args: Record<string, unknown>,
  result: ToolResult,
  store: Map<string, unknown>
): ToolResult {
  if (toolName === 'configure_agent_routing') return result;
  const text = result?.content?.[0]?.text;
  if (!text || typeof text !== 'string') return result;

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const routing = buildNativeRoutingBlock(toolName, args, parsed, store);
    const merged = {
      ...parsed,
      routing,
      agentDirective:
        typeof parsed.agentDirective === 'string'
          ? `${parsed.agentDirective} | ${routing.agentDirective}`
          : routing.agentDirective,
    };
    return {
      ...result,
      content: [{ type: 'text', text: JSON.stringify(merged, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) }],
    };
  } catch {
    const routing = buildNativeRoutingBlock(toolName, args, null, store);
    return {
      ...result,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ raw: text.slice(0, 500), routing }, null, 2),
        },
      ],
    };
  }
}