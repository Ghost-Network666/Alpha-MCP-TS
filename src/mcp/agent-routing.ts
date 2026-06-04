/**
 * Call-time agent routing prompt — native SDK paths + complete exposure ladder.
 * Linked from prompts/get "agent_routing" and structure prompt startup.
 */

import { AGENT_PROFILES, TIER1_CORE_TOOL_NAMES } from './agent-meta.js';

export function buildAgentRoutingPrompt(): string {
  const profiles = Object.entries(AGENT_PROFILES)
    .map(([k, v]) => `  - ${k}: load_agent_profile({ profile: "${k}" }) — ${v.description}`)
    .join('\n');

  const tier1 = TIER1_CORE_TOOL_NAMES.map((t) => `  - ${t}`).join('\n');

  return `AGENT ROUTING — NATIVE MCP (READ FIRST, NEVER GUESS)

## Native contract
- Every tool uses official @polymarket/client only (createPublicClient / createSecureClient + .extend(allActions)).
- No direct HTTP to Gamma/CLOB. Responses are formatted cards, not raw SDK dumps.
- Trading: ALWAYS explicit place_limit_order({ tokenId, price, size, side }) — NEVER "intent" or vague trade requests.
- Obey every agentDirective in tool responses. Do NOT ask the human for options.

## Mandatory startup (every session)
1. tools/call get_agent_recipes — copy-paste JSON shapes for weather/rewards/startup.
2. prompts/get agent_routing (this document).
3. prompts/get mcp_tool_structure_and_categories + mcp_llms_full_guide.
4. tools/call get_strategies — load your full rule set (strategy store = your brain).
5. tools/call get_mcp_usage — optional observability.

## Exposure ladder (142 tools total, nothing removed)
| Step | Tool | Purpose |
|------|------|---------|
| Default | tools/list | Tier-1 only (~${TIER1_CORE_TOOL_NAMES.length} daily drivers) |
| Find | search_tools({ query, detail: "summary" }) | Locate any tool by keyword |
| Bundle | load_agent_profile({ profile }) | Register a workflow bundle in one call |
| Category | get_tools_by_category({ category }) | Register one category |
| Refresh | tools/list again | Host must see newly registered tools |

Profiles:
${profiles}

## Tier-1 tools (always callable)
${tier1}

## Routing by goal

### Weather / topic markets
discover_topic({ topic: "weather", closed: false, pageSize: 15 })
→ optional load_agent_profile({ profile: "weather" }) if you need list_events, fetch_order_book, etc.
→ get_uk_weather_forecast({ city: "London", days: 7 })
→ fetch_market({ tokenId: "<Yes Token Id from discover_topic card>" })
→ place_limit_order({ tokenId, price, size, side }) with YOUR numbers from strategy/analysis

SDK mapping: topic/category "WEATHER" → tagSlug "weather" (events), tagId via fetchTag (markets). Prefer discover_topic over bare list_events/list_markets.

### Maker rewards
get_strategies() first
→ list_active_maker_reward_markets({ maxMinCostUsd: <from strategy> })
→ get_farmability({ tokenId: "<yesTokenId or noTokenId from list>" })
→ suggest_qualified_size({ tokenId, intent: "reward_farming" }) — advisory only
→ load_agent_profile({ profile: "rewards" }) if place_optimized_reward_order not in tools/list
→ place_optimized_reward_order or place_maker_reward_order (postOnly GTC)
→ on failure: obey agentDirective — rotate to DIFFERENT market from list_active, never retry same token blindly

### Need a tool not in tools/list
search_tools({ query: "<keyword>", detail: "schema" })
OR load_agent_profile({ profile: "full" })
OR get_tools_by_category({ category: "Trading" | "Advanced" | ... })

### Token / market lookup
fetch_market({ tokenId }) — MCP resolves via listMarkets({ clobTokenIds }) because SDK fetchMarket only accepts id/slug/url.
list_markets({ clobTokenIds: ["<token>"] }) for batch metadata.

### Live data (prefer over polling)
Subscribe MCP resources: polymarket://market/{tokenId}/book, polymarket://user/orders, polymarket://user/activity

### Rate discipline
wait_seconds between placements. Store requote policy in strategy store (maxRequoteRatePerSidePerSec, minRequoteIntervalMs) per reward_farming_best_practices.

## What does NOT exist on this MCP
- run_autonomous_trading_cycle — not registered; use the loop above with strategy store + tier-1 tools.
- Trading by natural-language "intent" — rejected by design; use explicit numeric params.

## Host reminder
After load_agent_profile or get_tools_by_category, re-call tools/list so the client surface updates. Rebuild + restart MCP host after server updates (stale dist breaks category/discovery).

Base SDK reference: https://github.com/Polymarket/ts-sdk/blob/main/README.md
`;
}