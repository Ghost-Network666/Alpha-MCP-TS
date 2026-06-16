# AGENTS.md — Alpha-MCP-TS

**CRITICAL: Follow these rules on every session.**

This repo implements a lightweight MCP server for the CLOB prediction market platform. Consuming agents must **never have to guess**.

**ONLY AGENTS.md IS USED** for the agent contract, "never guess", mandatory startup, recipes, and all instructions. The project's README.md has been removed from agent usage and references per request. All links, "see README", and mandatory flows now point exclusively here (AGENTS.md). The GitHub blob link for the project README is no longer referenced or active for agents.

The project README.md file itself has been stubbed with an explicit redirect at the top: any visitor (or old link) is instructed to use *only* the AGENTS.md GitHub URL. Relative references in source were updated from "see README.md". No other code, prompts, recipes, or docs reference the project's README for agent purposes. AGENTS.md is the sole "been used" file.

## Mandatory First Reads (do these in order)

1. Read `AGENTS.md` (this file — the sole canonical document for agent rules, startup, "never guess" contract, and instructions. README.md is legacy and **not used**).
2. Read critical sections of `src/mcp.ts` (lines 1-100 for imports/strategyStore/client setup; TIER1_CORE_TOOL_NAMES / ListToolsRequestSchema / currentlyExposedToolNames; GetPromptRequestSchema + entire content of the prompts especially `mcp_llms_full_guide` (SDK README first) and `agent_routing`; strategy store handlers; recordToolUsage + get_mcp_usage; agentDirective injection).
3. Read `src/mcp/agent-meta.ts` (TIER1 list and profiles).
4. Call MCP prompts: `prompts/get mcp_llms_full_guide` (starts with canonical SDK README + mappings; practical access often via `fetch_sdk_readme` tool) and `prompts/get agent_routing`.
5. Exercise the surface: call `tools/list` (full flat pure SDK), then direct `tools/call` on 1:1 wrappers (e.g. `list_events`, `list_markets` with pagination, `discover_topic`, `search`, `fetch_tag`, `fetch_market_tags`, `place_limit_order` etc.). Strategy bag and recipes are host-internal concerns (not public MCP tools in the pure model).

Only after the above, explore other files (`src/data/markets.ts`, `src/formatters.ts`, etc.).

## Build & Test

```bash
npm install
npm run build
node dist/mcp.js          # stdio MCP server
```

After any source edit: `npm run build` then **fully reload/restart the MCP server** in the consuming host.

## Key Rules

- The MCP exposes **only tools that are 1:1 wrappers of the Polymarket SDK**. No helper or meta tools are provided. Agents discover tools via `tools/list` and call them by name via `tools/call`.

All tool outputs are pre-formatted, human-readable, and ready for LLM interpretation. No additional parsing required. Every response uses clear **Label:** value formatting, dates, links, status emojis, and agent guidance ("Guidance", "Next Step", "Recommendation", "Agent Directive") where helpful (no raw SDK JSON or nested structures that require further processing). This delivers lower token consumption (e.g. market card ~130 tokens vs 800+ for raw), faster decisions, and no parsing overhead for the agent.
- `tools/list` returns the pure SDK surface (create_public_client, create_secure_client, list_markets, fetch_market, place_limit_order, split_position, redeem_positions, create_rfq_request, get_trader_leaderboard, subscribe_market, list_series, is_gasless_ready, etc. — and all other direct SDK methods). No get_tools_by_category, search_tools, load_agent_profile, mcp_* (as tools), get_agent_recipes, strategy store (get/set/update/clear_strategy), wait_seconds, send_heartbeat, or custom analytics (compute_market_signals, generate_alpha_report, rank_*, get_liquidity_health etc).
- All trading is **explicit** only: `place_limit_order` / `place_optimized_reward_order` etc. with concrete `price`/`size`/`side` calculated from `get_farmability`, `suggest_qualified_size`, and rules in the strategy store (if host uses internal). Never trade-by-intent. (Note: strategy store tools themselves removed from surface.)
- Tools are standard MCP: discover with `tools/list`; call with `tools/call` using exact name and args. The agent (LLM) decides. No server-side NL parsing or proprietary routing layer.
- All trading is **explicit** only: `place_limit_order` / `place_optimized_reward_order` etc. with concrete `price`/`size`/`side` calculated from `get_farmability`, `suggest_qualified_size`, and rules in the strategy store. Never trade-by-intent.
- The strategy store (`get_strategies` / `update_strategy` / `set_strategy`) is a lightweight free-form persistent bag for the host (Hermes) to evolve rules/filters/exit conditions under composite keys. The host owns the brain + native heartbeat.md / OpenClaw loop.
- Tools are standard MCP: discover with `tools/list` (returns the pure SDK surface only); call with `tools/call` using exact name and args. The agent (LLM) decides which tool(s) to invoke based on the tool list and descriptions. No server-side NL parsing or proprietary routing layer. No meta helpers.
- **Verification**: No testing/diagnostic/one-off scripts committed (use /tmp or ephemeral). Always native: full stdio against built `dist/mcp.js`, or via registered alphamcp using `search_tool` then `use_tool` on direct tool names. `npm run doctor` (basic) or `tools/list` against dist for health.
- Authoritative non-stale guidance: live MCP prompts (especially `prompts/get mcp_llms_full_guide`, which starts with the official TS SDK README at https://github.com/Polymarket/ts-sdk/blob/main/README.md) + `src/mcp.ts`.
- **Pure flat model (current)**: NL intent routing (`route_agent_intent` etc.) has been removed. No meta/helper tools in the public surface (no `get_tools_by_category`, `search_tools`, `load_agent_profile`, `get_agent_recipes`, public strategy store `get/set/update/clear_strategy`, `wait_seconds`, `send_heartbeat`, custom analytics like `compute_*`/`generate_alpha_report`/`rank_*` etc.). `tools/list` returns the complete set of 1:1 Polymarket SDK wrappers immediately (flat, no tiers, no progressive disclosure, no "core only"). Agent discovers exact names via `tools/list`, then calls with `tools/call` using concrete args. The LLM decides sequencing. Live `tools/list` + direct calls + prompts are truth.
- Pagination (enforced on all `list_*`): default `limit = 10` (max 100). Use `limit` (or legacy `pageSize`) + `offset` (default 0). Responses include `items`, `total` (when available from SDK paginator), `limit`, `offset`, `nextCursor`. Tool descriptions state the limits.
- Strategy store: lightweight internal/host (Hermes) supporting bag under composite keys for rules/filters (not a public MCP tool surface in the pure model). Host owns brain + heartbeat.md / OpenClaw.
- All trading explicit only (concrete `price`/`size`/`side` from `get_farmability`, `suggest_qualified_size`, or host strategy rules). Never trade-by-intent.
- Guardrails (local, via strategy key "guardrails:global" if used by host): pre-execution checks on place_* (size, deviation, allowlist, readOnly). Blocks return explicit {blocked, reason, agentDirective}.
- Outputs: always pre-formatted human-readable **Label:** cards (dates, links, emojis, Guidance/Directive where helpful). Low token, no raw JSON parsing needed by agent.

## When making changes

Re-read the critical sections of `src/mcp.ts` (imports/client setup, ListToolsRequestSchema (must return full flat no filter), GetPrompt + prompt content, pagination/CallTool list_* handlers, recordToolUsage) + this AGENTS.md + `src/mcp/agent-meta.ts` (empty tiers) before editing. Changes must reinforce the flat pure-SDK surface: `tools/list` always the complete 1:1 wrappers; no gating/progressive paths.

## Continuous Improvement (internal)

After changes touching discovery, prompts, pagination, strategy, or this file:
- `npm run build` (clean).
- Exercise via connected alphamcp (`search_tool` first for schema) + `use_tool` on direct SDK tools (e.g. `list_events` with tagSlug/limit/offset for tournaments, `list_markets` (tagId or titleSearch + pagination), `discover_topic`, `search`, `fetch_market_tags`, `fetch_tag`, `fetch_sdk_readme`, `list_tags`, `place_limit_order` etc.) to confirm `tools/list` is full + calls work.
- Confirm health via `npm run doctor` (or `tools/list` + sample paginated calls against built dist). Verify no "core only"/gating language in live surface.
- Report gaps (e.g. any missing SDK wrapper) explicitly.
- Lightly update this AGENTS.md (keep focused on current model).

The model is an ultra-lightweight pure 1:1 SDK proxy over stdio. Historical task logs and removed meta are in session memory/prompts only — not this file.

## References

- Full "never guess" contract + exact call shapes: `prompts/get mcp_llms_full_guide` (starts with canonical SDK README at https://github.com/Polymarket/ts-sdk/blob/main/README.md + live MCP mappings) + `prompts/get agent_routing`.
- SDK source of truth: https://github.com/Polymarket/ts-sdk/blob/main/README.md (consult first via the mcp_llms_full_guide prompt or `fetch_sdk_readme` tool; no MCP tools/resources serve stale full .MD content).
- Health: `npm run doctor` (basic) or `tools/list` against built dist.
- Discovery and direct calls: `tools/list` (returns the complete pure 1:1 Polymarket SDK wrappers); then `tools/call` with exact names + args (pagination limits, tag handling etc. per tool schemas). The agent (LLM) decides. No helper/meta tools, no server-side intent parsing.

## Discovery Best Practices
- For tournaments/categories: use `list_events(tagSlug='precise-slug')` with `includeMarkets=true` (or active/closed filters). This is the recommended path for reliable category/tournament discovery (list_events supports tagSlug directly and returns events bundled with their markets).
- For specific markets: use `list_markets` with `tagId` (numeric, resolved via `fetch_tag` if you only have slug) or `titleSearch`. Never rely on `tagSlug` with `list_markets` (SDK ignores the slug param; only numeric `tag_id`/`tagId` works).
- Use `fetch_market_tags` on a known market (by id/slug) to discover current live tag slugs for that market, then feed those slugs into `list_events` for accurate discovery. After `fetch_market_tags`, the response includes the note: "These are the live tags. Use these slugs with list_events for accurate discovery."
- Always enforce pagination: all `list_*` tools default to `limit=10` (max 100). Pass `limit` (or `pageSize`) + `offset`. Responses include `items`, `total` (when SDK provides), `limit`, `offset`, `nextCursor`.
- `discover_topic` accepts any string as topic (no hardcoded aliases). It tries `list_events` first (with active/closed filters), falls back to resolved `tag_id` + `list_markets`, and surfaces the explicit "No content found..." message when appropriate.
- `search` uses the broad Gamma `publicSearch` (events+markets+tags+keep closed) and falls back to `list_markets(titleSearch, closed:true)`; empty yields the specific guidance message.
- For pure SDK surface: call tools directly after `tools/list`. Use `fetch_tag` + numeric ids for tag filtering on markets when needed.