/**
 * In-process session context for native-tool routing (Hermes / OpenClaw / Grok).
 * SDK-only execution — routing only names tools + argument skeletons.
 */

import type { CycleGoal } from '../automation/agent-cycle.js';
import type { AgentIntent } from './intent-routing.js';

export const MCP_ROUTING_KEY = 'mcp:routing';

export type McpRoutingConfig = {
  enabled: boolean;
  activeIntent?: AgentIntent;
  /** When true, attach full intent loopPlan on every tool response (agent still executes each call). */
  autonomousAssist?: boolean;
  maxMinCostUsd?: number;
  topic?: string;
  updatedAt?: string;
};

export type IntentSessionContext = {
  lastTool?: string;
  lastTokenId?: string;
  lastIntent?: AgentIntent;
};

const session: IntentSessionContext = {};

export function getIntentSession(): IntentSessionContext {
  return session;
}

export function touchIntentSession(tool: string, tokenId?: string, intent?: AgentIntent) {
  session.lastTool = tool;
  if (tokenId) session.lastTokenId = tokenId;
  if (intent) session.lastIntent = intent;
}

export function readRoutingConfig(store: Map<string, unknown>): McpRoutingConfig {
  const raw = store.get(MCP_ROUTING_KEY);
  if (!raw || typeof raw !== 'object') {
    return { enabled: false };
  }
  const o = raw as McpRoutingConfig;
  return {
    enabled: Boolean(o.enabled),
    activeIntent: o.activeIntent,
    autonomousAssist: Boolean(o.autonomousAssist),
    maxMinCostUsd: o.maxMinCostUsd,
    topic: o.topic,
    updatedAt: o.updatedAt,
  };
}

export function writeRoutingConfig(
  store: Map<string, unknown>,
  patch: Partial<McpRoutingConfig>
): McpRoutingConfig {
  const prev = readRoutingConfig(store);
  const next: McpRoutingConfig = {
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  store.set(MCP_ROUTING_KEY, next);
  if (next.activeIntent) session.lastIntent = next.activeIntent;
  return next;
}

/** Infer intent from strategy keys when mcp:routing has no activeIntent. */
export function inferIntentFromStrategies(store: Map<string, unknown>): AgentIntent | null {
  const cfg = readRoutingConfig(store);
  if (cfg.activeIntent) return cfg.activeIntent;
  if (store.has('rules:current_farming')) return 'rewards_farm';
  const sessionDefaults = store.get('rules:session_defaults') as { preferredTopics?: string[] } | undefined;
  const topic = sessionDefaults?.preferredTopics?.[0];
  if (topic === 'weather') return 'weather_alpha';
  if (topic === 'rewards') return 'rewards_farm';
  return null;
}

export function goalFromIntent(intent: AgentIntent): CycleGoal | undefined {
  const map: Partial<Record<AgentIntent, CycleGoal>> = {
    rewards_farm: 'rewards',
    weather_alpha: 'weather',
    mispricing_flip: 'mispricing',
    trading_monitor: 'trading',
    discovery_scan: 'discovery',
    alpha_scan: 'discovery',
    rotate_after_failure: 'rewards',
  };
  return map[intent];
}