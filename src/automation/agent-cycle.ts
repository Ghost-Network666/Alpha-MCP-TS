/**
 * Deterministic agent cycle planner — NO LLM, NO blocking loop in MCP.
 * (NL routing removed) — returns guidance to use direct tools/list + tools/call.
 */

export type CycleGoal = 'rewards' | 'weather' | 'mispricing' | 'trading' | 'discovery';

export type CycleStep = {
  order: number;
  tool: string;
  arguments: Record<string, unknown>;
  why: string;
};

export type AgentCyclePlan = {
  success: boolean;
  goal: CycleGoal;
  phase: string;
  steps: CycleStep[];
  agentDirective: string;
  nextTools: string[];
  resources: string[];
  prompts: string[];
  note: string;
  lockedStrategyKey?: string;
};

export function buildAgentCyclePlan(params: {
  goal: CycleGoal;
  strategies?: Record<string, unknown>;
  maxMinCostUsd?: number;
  topic?: string;
  lockedStrategyKey?: string;
  heartbeat?: boolean;
}): AgentCyclePlan {
  // NL routing removed. Provide a basic direct-call plan. Host/LLM chooses exact tools from tools/list.
  const steps: CycleStep[] = [
    { order: 1, tool: 'get_agent_recipes', arguments: {}, why: 'Discover available tools and call shapes.' },
    { order: 2, tool: 'get_strategies', arguments: params.lockedStrategyKey ? { tokenId: params.lockedStrategyKey } : {}, why: 'Load host rules.' },
    { order: 3, tool: 'discover_topic', arguments: { topic: params.topic || (params.goal === 'rewards' ? 'politics' : params.goal), full: true }, why: 'Direct discovery for the goal.' },
  ];

  return {
    success: true,
    goal: params.goal,
    phase: 'direct-call-guidance',
    steps,
    agentDirective: 'NL routing removed. Use tools/list (or load_agent_profile/get_tools_by_category) to see the surface, then tools/call the exact tools by name with args you choose. get_agent_recipes gives examples. Obey any per-tool guidance. No server-side plan generation.',
    nextTools: ['get_agent_recipes', 'discover_topic', 'list_reward_markets'],
    resources: ['polymarket://market/{tokenId}/book'],
    prompts: ['mcp_llms_full_guide', 'agent_routing'],
    note: 'Cycle planner simplified after removal of proprietary routing layer. Agent decides calls from the list.',
    lockedStrategyKey: params.lockedStrategyKey,
  };
}