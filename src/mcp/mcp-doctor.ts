/**
 * MCP health check — same checks as host "doctor" CLIs (Grok/Hermes/OpenClaw).
 * Callable as tier-1 tool mcp_doctor or npm run doctor.
 */

import { TIER1_CORE_TOOL_NAMES } from './agent-meta.js';
import { GAMMA_TAG_BY_SLUG } from '../data/gamma-tag-registry.js';

export type McpDoctorReport = {
  ok: boolean;
  server: string;
  protocolVersion: string;
  handshake: 'ok' | 'failed';
  tier1ToolCount: number;
  tier1Tools: string[];
  gammaTagCount: number;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  hostDoctorCommands: {
    grok: string;
    hermes: string;
    openclaw: string;
  };
  agentDirective: string;
  // Note: proprietary NL routing (route_agent_intent + intent classification + central agentDirective injection) removed.
  // Agents use standard tools/list + tools/call directly. Guidance via prompts, get_agent_recipes, mcp_doctor.
  v2Alignment?: string;
  intelligenceRole?: string;
  endToEndNote?: string;
};

export function buildMcpDoctorReport(
  store: Map<string, unknown>,
  opts: { toolsListed: number; handshakeOk: boolean }
): McpDoctorReport {
  const checks: McpDoctorReport['checks'] = [];
  const tier1 = [...TIER1_CORE_TOOL_NAMES];

  checks.push({
    name: 'handshake',
    ok: opts.handshakeOk,
    detail: opts.handshakeOk ? 'initialize OK' : 'initialize failed — rebuild and restart host',
  });
  checks.push({
    name: 'tier1_surface',
    ok: opts.toolsListed >= tier1.length - 2,
    detail: `tools/list returned ${opts.toolsListed} (expected ~${tier1.length})`,
  });
  checks.push({
    name: 'mcp_doctor_tool',
    ok: tier1.includes('mcp_doctor'),
    detail: 'mcp_doctor in tier-1 for in-session health',
  });
  checks.push({
    name: 'gamma_tags',
    ok: Object.keys(GAMMA_TAG_BY_SLUG).length >= 40,
    detail: `${Object.keys(GAMMA_TAG_BY_SLUG).length} static tag slugs → tagId`,
  });

  const ok = checks.every((c) => c.ok);
  return {
    ok,
    server: 'alphamcp / clob-mcp',
    protocolVersion: '2024-11-05',
    handshake: opts.handshakeOk ? 'ok' : 'failed',
    tier1ToolCount: opts.toolsListed,
    tier1Tools: tier1,
    gammaTagCount: Object.keys(GAMMA_TAG_BY_SLUG).length,
    checks,
    hostDoctorCommands: {
      grok: 'grok mcp doctor alphamcp',
      hermes: 'hermes mcp test <server_name>   # e.g. polymarket — live handshake + tool list',
      openclaw: 'openclaw mcp doctor <server_name> --probe',
    },
    v2Alignment: 'CLOB V2 (Apr 2026): batch via post_orders (up to 15), higher limits, new fields (min_order_size/tick_size/neg_risk in books/markets), pUSD collateral, V2 signing. Use WS resources + get_farmability for decisions; policy in strategyStore; send_heartbeat for host heartbeat.md liveness.',
    intelligenceRole: 'The MCP Intelligence layer stays inside the MCP as a research service that Hermes (the brain) calls via heartbeat. Tools like generate_alpha_report, rank_market_opportunities, and compute_market_signals remain native. Their job is to produce research-backed signals (not decisions). These signals are fed into the strategy store (supporting data layer) so Hermes can use them when executing the locked per-market/per-volume strategy. The Intelligence layer must never execute trades directly — only provide data. MCP does not host models or a model under MCP (per host direct use by Hermes/OpenClaw).\n\nUnlike common categories of current prediction market intelligence systems, on-chain analytics platforms, and autonomous trading agents (Simple alpha reports / ranking engines; Bayesian signal blending; Basic regime detection; External data scraping + LLM summarization), the MCP deliberately provides only deterministic SDK + host-externalSignals-fused signals and simple ranking/health/competition/farmability cards. Lightweight helpers such as computeBayesianPosterior (for contradiction detection in the signals card only) are present; these are not hosted models or blending engines. Any complex modeling, regime detection, or LLM summarization is performed by Hermes (the brain) or supplied upstream via externalSignals.\n\nNarrow specialized research tools (get_liquidity_health, get_competition_signal, compute_divergence, get_reward_farmability_snapshot, analyze_signal_contradiction, and granular research_* intents) exist so the host can orchestrate many narrow mandates on its heartbeat, persisting after each under the locked key. The host (not the MCP) runs the "swarm" via native tools + intent routing. See get_agent_recipes (intelligenceLayerRole + narrowResearchMandates + endToEndProductionAutonomousExample) for the full contract.\n\nTHE TOOL THAT LOCKS THE AGENT IS TOGGLEABLE (off by default, host-controlled): route_agent_intent({ intent: "enable_locked_autonomy", lockedStrategyKey: "market:volume" }) sets strategyLock:true on that composite via update_strategy. Use "disable_locked_autonomy" (or direct update_strategy) to turn it off. heartbeat_locked_autonomy plans inspect the flag after get_strategies(locked); only when true do they emit the hard "LOCKED TO this key ONLY... STAY LOCKED... narrow research sequence only for this key" directive + restriction. When false (default), the key is still excellent for targeted narrow research/signals/price-movement on the host heartbeat, but the brain retains full routing freedom. This is the explicit native surface Hermes/OpenClaw uses to arm/disarm strict per-tick pinning.',
    agentDirective: ok
      ? 'MCP healthy. NL routing layer removed. Use tools/list to discover, tools/call by exact name+args (agent/LLM decides from the list). See AGENTS.md, prompts/get mcp_llms_full_guide, get_agent_recipes for guidance. All other tools (SDK discovery, orders, rewards, WS, account) intact.'
      : 'MCP unhealthy — run host doctor command from hostDoctorCommands, npm run build, restart host.',
  };
}