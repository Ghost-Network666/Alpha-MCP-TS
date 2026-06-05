/**
 * Call-time agent routing prompt — native SDK paths + complete exposure ladder.
 */

import { buildKnownGotchasMarkdown } from './agent-gotchas.js';
import { INTENT_REGISTRY } from './intent-routing.js';
import { AGENT_PROFILES, TIER1_CORE_TOOL_NAMES } from './agent-meta.js';

export function buildAgentRoutingPrompt(): string {
  const profiles = Object.entries(AGENT_PROFILES)
    .map(([k, v]) => `  - ${k}: load_agent_profile({ profile: "${k}" }) — ${v.description}`)
    .join('\n');

  const tier1 = TIER1_CORE_TOOL_NAMES.map((t) => `  - ${t}`).join('\n');
  const intents = Object.entries(INTENT_REGISTRY)
    .map(([k, v]) => `  - ${k}: ${v.summary}`)
    .join('\n');

  return `AGENT ROUTING — NATIVE MCP (READ FIRST, NEVER GUESS)

## Native contract
- SDK only (@polymarket/client). No direct HTTP. Formatted cards only.
- **route_agent_intent** maps host LLM *goals* → tool steps. It does NOT place trades by intent — you still pass explicit price/size/side.
- Obey every agentDirective. Do NOT ask the human for option menus.

## Mandatory startup (every session)
1. tools/call route_agent_intent({ intent: "session_startup" }) — fetch_sdk_readme → recipes → strategies
2. Confirm SDK README methods match routed tools (sdkAlignment in route response; never invent args)
3. prompts/get never_guess_contract + agent_routing + mcp_tool_structure_and_categories
4. tools/call route_agent_intent({ intent: "<goal>" }) — native tools only, in step order
5. Re-call tools/list after any load_agent_profile step

## Intent routing (PRIMARY)
Call route_agent_intent({ intent: "<name>", topic?, tokenId?, maxMinCostUsd? }) then execute each step in order.
${intents}

Trading rule: intent picks tools only. place_limit_order / place_optimized_reward_order need YOUR numeric price, size, side.

## Exposure ladder (~145 handlers)
| Step | Tool |
|------|------|
| Default | tools/list — tier-1 (~${TIER1_CORE_TOOL_NAMES.length} tools) |
| Route | route_agent_intent({ intent }) |
| Find | search_tools({ query }) |
| Bundle | load_agent_profile({ profile }) |
| Category | get_tools_by_category({ category }) |
| Refresh | tools/list again |

Profiles:
${profiles}

## Tier-1 tools
${tier1}

## Legacy goal → intent
- rewards → route_agent_intent({ intent: "rewards_farm" })
- weather → route_agent_intent({ intent: "weather_alpha", topic: "weather" })
- mispricing → route_agent_intent({ intent: "mispricing_flip" })
- trading → route_agent_intent({ intent: "trading_monitor" })
- discovery → route_agent_intent({ intent: "discovery_scan", topic: "..." })
run_agent_cycle({ goal }) still works — prefer route_agent_intent.

## Token lookup
fetch_market({ tokenId }) — listMarkets clob filter internally.

## Live data
polymarket://market/{tokenId}/book, polymarket://user/orders

${buildKnownGotchasMarkdown()}

Base SDK: https://github.com/Polymarket/ts-sdk/blob/main/README.md
`;
}