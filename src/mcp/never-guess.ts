import { TIER1_CORE_TOOL_NAMES } from './agent-meta.js';
import { buildKnownGotchasMarkdown } from './agent-gotchas.js';
import { MCP_CATEGORIES } from './llms-guide.js';

/** Authoritative never-guess contract (prompts/get). */
export function buildNeverGuessPrompt(): string {
  const tier1 = TIER1_CORE_TOOL_NAMES.map((t) => `  - ${t}`).join('\n');
  const cats = MCP_CATEGORIES.join(', ');

  return `NEVER GUESS CONTRACT — MANDATORY FOR EVERY SESSION

## 0. Absolute rules
- DO NOT ask the human for menus or "next steps".
- DO NOT invent tool names or JSON shapes.
- route_agent_intent routes WHICH tools — NOT trade size/price (use explicit numbers on place_*).
- Obey every agentDirective.

## 1. First calls (in order)
1. tools/call route_agent_intent({ intent: "session_startup" }) — includes fetch_sdk_readme + get_agent_recipes
2. tools/call fetch_sdk_readme — confirm SDK method names match routed MCP tools (see sdkAlignment.mcpToSdk)
3. prompts/get agent_routing + never_guess_contract + mcp_tool_structure_and_categories
4. tools/call route_agent_intent({ intent: "<your goal>" }) — execute EVERY returned step; load_agent_profile when plan says so
5. Re-call tools/list after load_agent_profile (hosts that whitelist tools/list)

## 2. Tier-1 tools
${tier1}

Full surface: get_tools_by_category or load_agent_profile. Categories: ${cats}.

## 3. Live docs
- polymarket://sdk/readme
- polymarket://mcp/llms.txt

## 4. Strategy brain
- get_strategies auto-seeds defaults if empty; update_strategy for changes

${buildKnownGotchasMarkdown()}

## 5. On reward failure
route_agent_intent({ intent: "rotate_after_failure" }) → pick DIFFERENT tokenId — never retry same.
`;
}