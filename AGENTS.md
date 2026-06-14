# AGENTS.md — Alpha-MCP-TS

**CRITICAL: Follow these rules on every session.**

This repo implements a lightweight MCP server for the CLOB prediction market platform. Consuming agents must **never have to guess**.

## Mandatory First Reads (do these in order)

1. Read `README.md`
2. Read critical sections of `src/mcp.ts` (lines 1-100 for imports/strategyStore/client setup; TIER1_CORE_TOOL_NAMES / ListToolsRequestSchema / currentlyExposedToolNames; GetPromptRequestSchema + entire content of the prompts especially `mcp_llms_full_guide` (SDK README first) and `agent_routing`; strategy store handlers; recordToolUsage + get_mcp_usage; agentDirective injection).
3. Read `src/mcp/agent-meta.ts` (TIER1 list and profiles).
4. Call MCP prompts: `prompts/get mcp_llms_full_guide` (primary canonical SDK + MCP mappings) and `prompts/get agent_routing`.
5. Call `get_agent_recipes` and `get_strategies()`.

Only after the above, explore other files (`src/data/markets.ts`, `src/formatters.ts`, etc.).

## Build & Test

```bash
npm install
npm run build
node dist/mcp.js          # stdio MCP server
```

After any source edit: `npm run build` then **fully reload/restart the MCP server** in the consuming host.

## Key Rules

- `tools/list` returns only the small tier-1 core by default (~20-30 tools per live audit). Use `load_agent_profile` or `get_tools_by_category` for progressive disclosure to the full surface (currently 110 tools after "full" profile; treat live tools/list + get_tools_by_category + mcp_doctor as ground truth — numbers can shift slightly). Re-call `tools/list` after loading more.
- All trading is **explicit** only: `place_limit_order` / `place_optimized_reward_order` etc. with concrete `price`/`size`/`side` calculated from `get_farmability`, `suggest_qualified_size`, and rules in the strategy store. Never trade-by-intent.
- The strategy store (`get_strategies` / `update_strategy` / `set_strategy`) is a lightweight free-form persistent bag for the host (Hermes) to evolve rules/filters/exit conditions under composite keys. The host owns the brain + native heartbeat.md / OpenClaw loop.
- Every tool response includes routing info + `agentDirective`. Obey the directives. Re-call `route_agent_intent` when instructed instead of guessing next steps.
- **Heartbeat completeness (Jun 2026 audit)**: Added mcp_surface_doctor (audits that every step/nextTools in all 43+ route_agent_intent plans is actually exposed after load_agent_profile / get_tools_by_category). Expanded CATEGORY_PREFIX_BY_TOOL + regexes to cover previously-missing names (list_activity, fetch_order, watch_order_until_filled, price/midpoint/history, reward earnings/scoring, series, leaderboards, comments, profiles, open interest, etc.). Live 110 is truth. New orchestration tools (account_snapshot, and stubs/plans for reward_candidates_ranked, execution_guard, fills_summary, order_maintenance_plan, clob_quote_pack, place_and_verify_*, strategy snapshot, heartbeat_state_*, etc.) are being added so heartbeat is one-pass deterministic (doctor → strategy snapshot → account_snapshot → ranked pack / maintenance plan → guard → explicit place/verify → fills_summary → state update). Risk annotations (riskClass, heartbeatAllowed, mutatesPositions) added to steps. Surface doctor must pass before autonomous heartbeat is enabled. mcp_surface_doctor + account_snapshot are the immediate enablers.
- No testing, diagnostic, or one-off scripts are ever committed to the repo (use /tmp or ephemeral only). Verification is always native (full stdio handshake + calls against the built `dist/mcp.js`, or via the registered alphamcp instance using `search_tool` then `use_tool`).
- The authoritative non-stale guidance lives in the live MCP prompts (especially `mcp_llms_full_guide` which starts with the official TS SDK README) + `src/mcp.ts`. This file is intentionally short.
- **Safety classification & autonomous guards (Jun 2026)**: Intelligence tools = read/research only (signals → update_strategy only). Strategy tools = persist policy/signals (Hermes brain owns). Trading = reads + mutation. Account = safe reads + dangerous actions. Advanced = high-risk (approvals, transfers, sigs, tx, API key mut). Heartbeat executes ONLY routed plans (never guessed chains). Autonomous live loops (locked+heartbeat) HARD-BLOCK all mutations unless strategy+balance+book+spread+route all qualify recently for the key (enforced in CallTool + plans include explicit qualifier sequence + recorders). mcp_doctor surfaces counts + rules; route plans for heartbeat_locked now list the 5 qualifiers explicitly.
- **Guardrails layer (added Jun 2026)**: Pre-execution validation in src/mcp/guardrails.ts (getGuardrails + checkOrderAgainstGuardrails). Config under strategy key "guardrails:global" via update_strategy (maxOrderSizeUsd, maxPriceDeviationFromMid, allowedTokenIds, maxOpenOrdersTotal, readOnly). Enforced before SDK in the three place_* tools (after normalize, before any create/post). Defaults completely open (additive). Blocks return {success:false, blocked:true, reason, guardrailKey, agentDirective}. Observable in get_mcp_usage (current + total/recent blocks) + mcp_doctor (synthetic checks run every report for default-open, readOnly, size, allowlist, deviation). No new tools; re-uses the bag. Local owner cap only — no keys/remote auth. mcp_doctor + npm run doctor now cover guardrail behavior.
- **NLR + confidence + execute_recipe + A2A/circuit/feedback/dynamic (Jun 2026)**: route_agent_intent accepts naturalLanguage (heuristic classifier vs INTENT_REGISTRY, confidence gating). execute_recipe walks with guardrails + circuit breaker (N=3 fails -> degraded + fallback). New: delegate_to_agent (A2A structured handoff for host sessions_spawn/peer delegation), get_routing_feedback (classifier counters + tuning suggestions from outcomes, persisted routing:feedback), get_available_tools(context) (dynamic filter by guardrails/balance etc). 43 intents. See get_agent_recipes (a2aDelegation, routingHealthAndCatalog). Ritual after routing changes: build + local dist/mcp/intent-routing.js audit (explicit/locked/NL/failure) + alphamcp search+use + mcp_doctor (routingHealth).
- **Full 1-call intelligence routing for everything across Gamma (Jun 2026 continuation)**: route_agent_intent({naturalLanguage}) is the universal single native tool. Agent calls it once with any Gamma question (incl filters like "list all open world cup events with liquidity over 100k", "high volume crypto markets", arbitrary subjects). Internal: NLR classifier (boosted aliases + general list/find + event/market triggers -> discovery_scan 0.93+), auto topic extraction (alias-aware via resolveTopicSlug + safe defaults), auto filter extraction (closed, liq/vol min, titleSearch etc from NL), unconditional full:true discoverTopic (server-side offset paging + filter merge in data/discovery — bypasses all caps), directAnswer populated with pre-filtered structured events/markets (+ tokenIds, prices, liquidity). agentDirective: "NATIVE INTENT DELIVERED ... complete answer from one call ... Everything across Gamma handled inside MCP (no leaking, no raw function)". All function handling (fetch, filter, page, format) stays MCP internal. Agent never guesses tool/args/filters/pagination/sequence. 1 call > answer, no issues. Local + recipes + doctor confirm; live alphamcp use requires host reload post-build.
- **100% SDK coverage (clarification)**: The MCP is built on the unified @polymarket/client SDK (consolidates CLOB/Gamma/Data/Relayer/WS). GammaClient for market discovery (gamma-tag-registry.ts, discover_topic, search, list_tags/fetch_tag). DataClient for analytics (list_positions with PnL, generate_alpha_report, positions/portfolio/activity). RelayerClient for gasless (place_optimized_reward_order). WebSocket user streams via SDK subs bridged to MCP Resources (user/orders, user/fills, market/book for real-time, zero-token push). All tools/resources call SDK methods/clients only – no external REST/raw HTTP. 100% coverage = CLOB + Gamma + Data + WS streams through the SDK. Limitation (Polymarket WS API, not MCP gap): UserWsClient is authenticated – cannot monitor third-party wallet without its credentials. Practical public watch: use new extract_wallet_from_url on profile URL to get address, list_trades({maker}) to find markets it participates in, subscribe to their public book resources (polymarket://market/{tokenId}/book) via MarketWsClient for trades. Builder auth now uses the official @polymarket/builder-signing-sdk (integrated from GitHub org) via generate_builder_headers for robust, canonical headers in gasless/builder flows (replaces ad-hoc HMAC; future-proofs). See getAgentRecipes() publicWalletWatch + sdkCoverageAndLimitations + builderSigning, mcp_llms_full_guide (SDK README first), and route_agent_intent for plans. Agent never guesses SDK details.

## When making changes

Re-read the critical sections of `src/mcp.ts` listed above before editing. Changes must reinforce the "no guessing" contract.

## Continuous Improvement (internal)

After changes that touch routing, intelligence, recipes, doctor, prompts, strategy, meta tools, or this file, follow the standing discipline:
- `npm run build` (clean).
- Exercise via the connected alphamcp (search_tool first) + fresh local `node` execution of `dist/mcp/intent-routing.js` (buildIntentRoute + INTENT_REGISTRY audit on multiple intents including locked + heartbeat cases).
- Confirm 43+ intent coverage with rich plans/directives, healthy `mcp_doctor` (routingAlwaysOn, intentCount), no raw data, contract holds.
- Report achievements + next gaps explicitly.
- Lightly update this AGENTS.md.

The detailed ritual steps, previous achievement logs, and "you never stop looking to improve" notes are maintained in session memory / the long-form internal contract (prompts + prior AGENTS context) rather than bloating this file.

## References

- Full "never guess" contract + exact call shapes: `prompts/get mcp_llms_full_guide` (starts with canonical SDK README at https://github.com/Polymarket/ts-sdk/blob/main/README.md + live MCP mappings) + `prompts/get agent_routing` + `prompts/get mcp_tool_structure_and_categories`.
- SDK source of truth: https://github.com/Polymarket/ts-sdk/blob/main/README.md (consult first via the mcp_llms_full_guide prompt; no MCP tools or resources serve full/stale .MD content).
- Health: `mcp_doctor` or `npm run doctor`.
- Routing for 100% of native tools: `route_agent_intent({ intent: "..." })` (see full registry in `get_agent_recipes` or `route_agent_intent` responses).