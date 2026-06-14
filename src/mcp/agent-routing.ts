/**
 * Call-time agent routing prompt — native SDK paths + complete exposure ladder.
 */

import { buildKnownGotchasMarkdown } from './agent-gotchas.js';
import { AGENT_PROFILES, TIER1_CORE_TOOL_NAMES } from './agent-meta.js';

export function buildAgentRoutingPrompt(): string {
  const profiles = Object.entries(AGENT_PROFILES)
    .map(([k, v]) => `  - ${k}: load_agent_profile({ profile: "${k}" }) — ${v.description}`)
    .join('\n');

  const tier1 = TIER1_CORE_TOOL_NAMES.map((t) => `  - ${t}`).join('\n');

  return `AGENT ROUTING — NATIVE MCP (READ FIRST, NEVER GUESS)

## Native contract (NL routing layer removed)
- SDK only (@polymarket/client). No direct HTTP. Formatted cards only.
- No server-side NL parsing, no route_agent_intent, no proprietary routing layer or central agentDirective injection on responses.
- Agents use tools/list to discover the full surface (tier-1 core + categories via load/get_tools_by_category + get_agent_recipes for examples), then tools/call with the exact tool name and arguments. The agent (LLM) decides which tool to call and in what order based on the list and descriptions.
- Obey guidance in responses where helpful. Do NOT ask the human for option menus.

## Mandatory startup (every session)
1. consult mcp_llms_full_guide prompt (links canonical SDK README URL)
2. prompts/get never_guess_contract + agent_routing
3. Call get_agent_recipes + get_strategies
4. Use tools/list (or load_agent_profile / get_tools_by_category / search_tools for discovery), then tools/call directly by name+args. Re-call tools/list after loading more surface.

## Discovery (PRIMARY now)
- tools/list — current exposed (tier-1 by default)
- get_agent_recipes — registry + direct call examples + gotchas
- search_tools({ query }) — find by name/desc
- load_agent_profile({ profile: "full" }) or get_tools_by_category — expand
- tools/list again after expansion

Profiles:
${profiles}

## Tier-1 tools (pure SDK + supporting meta for list)
${tier1}

## Token lookup
fetch_market({ tokenId }) — listMarkets clob filter internally.

## Live data
polymarket://market/{tokenId}/book, polymarket://user/orders

${buildKnownGotchasMarkdown()}

Base SDK: https://github.com/Polymarket/ts-sdk/blob/main/README.md
`;
}
