# AGENTS.md — Instructions for LLMs / AI Coding Agents working on AlphaMCP-TS

**CRITICAL: Follow these rules on every session. Never skip the "Mandatory First Reads".**

This repo implements a **lightweight, agent-controlled MCP server for the CLOB prediction market platform**. The entire design goal is:

> Agents (LLMs) that *use* this MCP via the protocol must **never have to guess** how to use tools, when to load more, what the current strategy is, or what the best practices are.

# Official Source of Truth
This MCP wires the official TypeScript SDK (https://github.com/Polymarket/ts-sdk — kept up-to-date by the maintainers). All tool behavior, parameters, and responses follow the official SDK documentation.

The MCP achieves this with:
- Tiny default `tools/list` surface (see CORE_TOOL_NAMES).
- Explicit category discovery (`list_tool_categories` + `get_tools_by_category`).
- On-demand guidance via the MCP `prompts` API (`mcp_tool_structure_and_categories`, `reward_farming_best_practices`, `mispricing_quick_flips`, `mcp_llms_full_guide` — the full guide linking the official SDK README first (https://github.com/Polymarket/ts-sdk/blob/main/README.md as primary agent instructions) + MCP mappings, non-stale/dynamic).
- The in-MCP **strategy store** (`get_strategies` / `set_strategy` / `update_strategy` / `clear_strategy`) as the *single source of truth* for all agent rules, filters, prefs, exit conditions, etc. The agent evolves its own "brain" here instead of bloating its system prompt or guessing.
- Built-in **MCP usage/activity tracking** via `get_mcp_usage` (in core) + file logs + platform activity resources (`list_activity`, live `polymarket://user/activity`). This is how activities (tool calls) and usage (stats, patterns) are tracked.

---

## MANDATORY FIRST ACTIONS — DO THIS BEFORE ANY CODE READ OR EDIT

You **MUST** execute these steps in order using your tools:

1. Read this entire `AGENTS.md`.
2. Read `README.md` (full).
3. Read `MCP_SERVER_OVERVIEW.md` (full).
4. Use the `read_file` tool (with limits) to thoroughly read **src/mcp.ts** — it is the heart of everything:
   - Start with lines 1-100 (imports, strategyStore, client setup).
   - Read the category system: `listAllCategories`, `getToolsByCategory`, `list_tool_categories`, `get_tools_by_category` (search for these).
   - **Critical sections** (read with context):
     - `CORE_TOOL_NAMES` Set definition (around line 1743). Note get_mcp_usage for activity/usage tracking.
     - `PROMPTS` array definition (around 1759).
     - `ListToolsRequestSchema` handler that *filters* to core only (around 1778).
     - The full `GetPromptRequestSchema` handler + the **entire string content** of the prompts (especially `mcp_tool_structure_and_categories`, `reward_farming_best_practices`, and the full `mcp_llms_full_guide` which links the SDK README first + MCP mappings) (around 3445+).
     - Strategy store usage in handlers (search `set_strategy`, `update_strategy`, `get_strategies`).
     - How `agentDirective` fields are injected in many responses (this is how we stop the LLM from guessing or asking the human).
     - The recordToolUsage + mcpUsageTracker + get_mcp_usage handler (how activities and usage of the MCP are tracked).
   - Also read the tool definitions for the meta tools and the strategy tools.
5. Read `src/data/markets.ts` (especially `getMarket` which now supports `tokenId` via internal `listMarkets({clobTokenIds})`).
6. Read `src/formatters.ts` (to understand the "never raw data" rule).
7. Only *after* the above, explore other files as needed (`src/mcp/resources.ts`, trading/*, config/*, etc.).

If you are asked to implement a feature, fix a bug, or review, you must re-read the critical sections of `src/mcp.ts` listed above before proposing or writing code.

**When the task involves "how agents use the MCP"**, your changes must reinforce the "no guessing" contract (see section below).

---

## How This MCP Works So Consuming Agents Never Guess

This is the most important design principle in the repo.

### 1. Surface Control (tiny by default)
- `tools/list` (ListToolsRequestSchema) **only ever returns the CORE set** (~10 tools) + the two category meta-tools.
- The full 100+ tool surface lives in the code but is **never advertised** by default. This keeps context small and forces deliberate loading.
- Consuming agent **must** call:
  - `list_tool_categories`
  - `get_tools_by_category("Rewards")` / `"Strategy"` / `"Discovery"` etc. when it needs more.

See the comment at the top of the CORE_TOOL_NAMES block and the ListTools handler.

### 2. Guidance via MCP Prompts (the "how do I use you?" contract)
The MCP registers prompts (see `PROMPTS` and `GetPromptRequestSchema`):
- `mcp_tool_structure_and_categories` — the primary "how this MCP is meant to be used" document. It tells the agent the core surface, the category loading pattern, and that the strategy store is where *all* its custom logic lives.
- `reward_farming_best_practices` — detailed, X-sourced tactics + exact mapping to the tiny set of native tools + the autonomous loop the agent must follow.
- `mispricing_quick_flips` — similar for the other common pattern.
- `mcp_llms_full_guide` — **full guide: FIRST the official TS SDK README (https://github.com/Polymarket/ts-sdk/blob/main/README.md — kept up-to-date by the maintainers; link this as primary agent instructions for all SDK coverage, APIs, concepts, clients, examples) + MCP-specific mappings (dynamically generated from live code, no stale .MDs). Explicitly maps SDK concepts (see README) → exact native MCP tools + JSON call shapes + "never use intent for trading; always explicit place_limit_order etc with your numbers from strategy/calc". Documents enhanced formatter output cards (PNL in positions/activity, sentiment/liquidity health in markets/farmability via spreads/depth/skew/competitionSignal, new RewardMarketCard + FarmabilityCard + PnlSummary). Also covers resources (polymarket://mcp/llms.txt serves the same), startup, public rules. **Call the SDK README first, then this (and structure prompt) first for complete non-guessing experience. The MCP uses the SDK README link for all base instructions.**

**Consuming agents are expected to call `prompts/get` for these** (especially `mcp_tool_structure_and_categories` + `mcp_llms_full_guide`) early, instead of guessing from tool names/descriptions alone.

The prompt contents are the **authoritative usage guide**. If the usage pattern changes, you **must** update the prompt text inside the GetPrompt handler. Also update this AGENTS.md.

### 3. The Strategy Store is the Agent's Brain (no hardcoding)
See the big comment at the top of `strategyStore` (line ~34) and the tool descriptions for `set_strategy` / `update_strategy` / `get_strategies`.

- The agent stores **everything** it evolves (filters, event prefs, farming rules like `quoteNearMid`, `bothSides`, exit conditions, scoring logic, `maxMinCostUsd`, etc.) under arbitrary keys in the store.
- `get_strategies()` (no args) returns the *complete current rule set*.
- `update_strategy` is the preferred cheap partial update (preserves everything else).
- At the start of every autonomous loop the agent is instructed (in the prompts and in many `agentDirective`s) to call `get_strategies()` first.
- This is why the MCP can stay tiny: the agent owns its complexity; the MCP just gives a universal persistent bag + the building-block tools.

**Never** add a new dedicated tool for "farming rules" or "my filters". Route everything through the strategy tools.

### 4. agentDirective + Never Ask the Human
Many tools (especially reward and error paths) return an `agentDirective` field with imperative instructions like:
"DO NOT ask the user... IMMEDIATELY: (1) Call list_active... (2) Pick a different one..."

The consuming LLM **must** be instructed (via the structure prompt + its own system prompt) to obey these.

### 5. Testing / Verification Pattern for MCP Changes
See previous sessions and the test driver patterns used:
- Always `npm run build`.
- Load the MCP (`node dist/mcp.js`) over stdio.
- Perform full handshake (initialize + notifications/initialized).
- Call `list_tool_categories`, `get_tools_by_category`, `get_mcp_usage`, `prompts/list`, `prompts/get "mcp_tool_structure_and_categories"`.
- Exercise the new/ changed tool (e.g. `list_markets` with `clobTokenIds`, `fetch_market` with `tokenId`).
- Assert that the response contains the expected data and follows the lightweight contract.
- Use real tokens from `listAllMarkets` or `list_active_maker_reward_markets` for tests.
- **There must be no testing / diagnostic / honcho / one-off scripts in the repo root or committed to main.** (See "No Testing Files" rule below.)

**Critical reload note (from incident with "logger is not defined" after usage tracking / meta tools update):** 
After code changes that touch logging, recordToolUsage, mcpUsageTracker, list_tool_categories, get_tools_by_category, get_mcp_usage, list_markets etc., the *consuming agent host* (not just this repo) **must**:
1. `cd` to the MCP dir and run `npm run build` (refreshes dist/mcp.js with the logger import at top of src/mcp.ts:32 + unconditional recordToolUsage(name) at CallToolRequestSchema:1834 before switch).
2. **Fully restart/reload the MCP stdio server** in the host (e.g. disable/re-enable the server in Claude Desktop, or kill the node process and relaunch). A stale dist/mcp.js causes exactly `McpError: logger is not defined` (or subsequent unreachable) on the discovery/meta tools, while `polymarket://markets` resource may still partially respond.
- In this workspace, verification is always pure native (`"/mnt/c/Program Files/nodejs/node.exe" -e '...' ` spawning dist/mcp.js over pipes with full init + calls, zero committed test .js files; all in /tmp or ephemeral only).
- After host restart: re-call the SDK README (https://github.com/Polymarket/ts-sdk/blob/main/README.md), then `prompts/get "mcp_llms_full_guide"`, `list_tool_categories`, `get_tools_by_category("Meta")`, `get_mcp_usage` immediately.

## SDK Surface — Full Exhaustive Coverage of the Unified @polymarket/client TS SDK (v0.1.0-beta.2, current repo state) + Known Issues / Gaps / MCP Workarounds

**Per documented SDK guidance:** The MCP now uses the official TS SDK README (https://github.com/Polymarket/ts-sdk/blob/main/README.md) as the primary/base agent instructions for all SDK coverage (APIs, clients, examples — kept up-to-date by the maintainers). mcp_llms_full_guide + polymarket://mcp/llms.txt now provide the FULL EXHAUSTIVE structure (Installation & Core Imports, Client Factories, Exported Modules/Subpaths, Core Classes & Helpers, Environments, full Errors list, All Actions categorized exactly as markets/discovery/CLOB/portfolio/account/wallet/rewards/builders/data/transfers/sports, Decorators (public+secure), WS (managers bridged), Wallet Integration, Types, Low-Level) + exact MCP tool mappings for every concept. Updated across llms-guide.ts (build + the long guide), mcp.ts (prompt desc + content), resources.ts, AGENTS.md, README. This ensures "the mcp uses this for all" + zero guessing. Confirmed via native stdio + runtime inspection of node_modules/@polymarket/client (create*, .extend(allActions), methods, subpaths).

MCP code itself uses createPublicClient() + createSecureClient({wallet, signer: privateKey from /viem}) + .extend(allActions) (updated in src/config/client.ts) for full decorator surface, then thin safe wrappers + formatters + strategyStore + resources + tracking.

**Research performed**: runtime node inspection of installed beta (top exports, after-extend method list incl. listSports/listTags/listTeams/fetchTag/listBuilder*, create*, errors, actions groups, extend), node_modules/@polymarket/client/dist/*.d.ts + package.json exports, current src/ usage (client factories, standalone actions for balance reliability post-gasless, direct decorated calls), GitHub ts-sdk, and cross-checks vs MCP tools.

### What the SDK *directly* provides (after create*Client + .extend(allActions))
See the exhaustive categorized breakdown + MCP mappings in the `mcp_llms_full_guide` prompt (or resource polymarket://mcp/llms.txt). It mirrors the complete public surface:
- Installation, imports, client factories (Public for read, Secure for trading/gasless; config with signer/wallet/apiKey/builder; .extend(allActions) for decorators).
- Subpaths: /actions (standalone), /viem (privateKey), /ethers-v5, /privy, /node, main + @polymarket/bindings reexports.
- Core: Base*Client, allActions/discoveryActions/tradingActions/etc groups, pagination (Paginated + async iter), buildHmacSignature, erc*/split/merge call builders, auth workflows.
- Full Errors (CancelledSigningError, RateLimitError, ... many with isError guards).
- All Actions: Markets/Discovery (listMarkets with clobTokenIds etc, fetchMarket limited, search, listEvents/Series/Tags/Teams/Sports, listCurrentRewards, listMarketRewards, ...), CLOB/Trading (placeLimitOrder/MarketOrder, postOrders, cancels, getOrderBook/BBO/mid/price/history, open orders, scoring), Portfolio (positions, portfolio, activity/trades/transfers), Account (api keys, profile, leaderboards, comments), Wallet/Onchain (approvals, deposit wallet, gasless ready, wait tx, redeem/split/merge calls), Rewards/Subs, Builders/Relayer, Data, Transfers, Sports.
- Decorators: Public (discovery/data/analytics/account/rewards/subs) + Secure (adds trading/wallet/full account/rewards claim).
- WS: client.subscribe + (internal) ClobMarket/User/Rtds/Sports WebSocketManagers; MCP bridges all to resources (market book, user/*, order fill-status) with reconnect.
- Wallet: viem/ethers/privy adapters, remoteBuilderSigning, relayerApiKey, deposit derivation.
- Types: Market (clobTokenIds, outcomes, tokens), Order, Position, OrderSide/Type, ActivityType (incl. rebates), full request/response, WS msgs.
- Low-level: ServiceClient, ABIs, direct calls, HMAC.

MCP value adds (on top of raw): tokenId resolver (listMarkets clob filter bridge for fetch by tokenId + everywhere in cards), never-raw formatted cards (Yes/No TokenId always, bias/sentiment, liquidity health, farmabilityScore/competitionSignal, full PnL in positions/activity, agentDirective), strategyStore (your brain for all rules/filters/exits/requote policies), usage tracking (get_mcp_usage), WS resources, rate guards + directives, lightweight (core + categories + prompts), public-only default + explicit only (no intent).

**Note on .extend(allActions)**: MCP now does this explicitly on both public and secure clients (see src/config/client.ts) so the full ~50+ decorated methods (listMarkets, placeLimitOrder, listSports, fetchTag, listBuilder*, getOrderBook, listActivity, fetchPortfolioValue, setupGaslessWallet (deprecated no-op per latest), isGaslessReady, setupTradingApprovals (idempotent), etc.) are available internally. Per latest SDK: createSecureClient defaults to Deposit Wallet (auto setup/deploy for non-EOA); some balance flows still use standalone from @polymarket/client/actions for post-gasless reliability (the client instance shape can change).


**Note on "category" / "search" in MCP's list_markets tool schema**: The tool advertises them (for agent ergonomics + SDK README concepts). Runtime probe: passing them to pub.listMarkets() does not throw (extra fields tolerated, query params sent, backend may apply partial filter for "search" on markets list or "category" via tags). However they are **not primary in SDK ListMarketsRequestSchema**. For broad topic "many more events" across events+markets, prefer the dedicated `search({q})` tool or `list_events` + filtered `list_markets`. list_markets({category, rewardsMinSize, clobTokenIds, ...}) remains excellent for structured farming/mispricing scans.

### Concrete Issues / Gaps / Gotchas (why the agent's situation happened + how MCP mitigates)
1. **tokenId resolution for CLOB** (core for rewards/orders): SDK fetchMarket has no tokenId support (design of this beta; REST has "get market by token" but client fetch does not expose equivalent first-class). listMarkets *does* support `clobTokenIds` filter (and conditionIds). **MCP fix (correct per ts-sdk source + prior PR research)**: getMarket({tokenId}) + fetch_market tool + tokenId resources internally do `listMarkets({ clobTokenIds: [tokenId], pageSize:1 })` + first. This is why the resource gave the agent exact Yes/No TokenIds that "matched what you wanted". Always use the MCP wrappers; do not call raw SDK fetchMarket with a tokenId.
2. **`polymarket://markets` resource only a tiny skewed snapshot** (direct cause of "many more events than returned", "heavily skewed toward the GTA VI meme markets"): Impl is literally `pub.listMarkets({closed:false, pageSize:20})` + format (first page, default Gamma ordering, no filters). Not an enumerator. "Active Markets (first page)" in description. **Mitigation**: Documented now in AGENTS + llms-guide. Primary discovery = load "Discovery" category then `list_markets({active:true, pageSize:30, ...})` / with `category`/`rewardsMinSize`/`clobTokenIds` etc. + dedicated `search` tool + `list_events({category?})`. Native tests here confirmed volume (10k+ chars, weather category, search hits for politics/crypto/sports).
3. **Rewards programs require enrichment for usable cards**: listCurrentRewards gives programs (conditionId, min/max, rates) but *no* question text, no yes/noTokenIds, no current mids/prices. **MCP does the work** (in list_active_maker_reward_markets: fetch page, optional early minSize filter, batch listMarkets({conditionIds}) for metadata + token extraction + mids, compute USD cost + attractiveness, rank, formatActiveRewardMarket + farmability). Then get_farmability for live book signals. This is why list_active is the "PRIMARY tool for autonomous reward market selection".
4. **listCurrentRewards page size control limited in SDK**: Request schema minimal (cursor/sponsored). MCP hardcodes 50 in the protected call ("always fetch a healthy page") then slices/ranks client-side (maxResults cap 20 default, relaxable). Similar for other paginators — use pageSize where supported (markets/events do), fall back to firstPage + post-filter.
5. **Meta/introspection tools (list_tool_categories, get_tools_by_category, get_mcp_usage) are 100% MCP, not SDK**: They live in the CallToolRequestSchema handler + pure functions. Adding `recordToolUsage(name)` (which does `logger.info`) at the *very top* (before switch, for every call incl. meta) without the import in the committed tree = exact "logger is not defined" on first use of categories or list_markets etc. (even if resource still limped along). **Lesson + fix applied**: import must be present; native stdio tests (pure, no scripts) after every change that touches handler/tracking. get_mcp_usage + file logs + strategyStore now directly answer "how do you track the activities? the usage?".
6. **Secure action methods vs standalone actions**: After gasless (per latest SDK, setupGaslessWallet is @deprecated no-op; gasless/deposit defaults inside createSecureClient) or certain configs, some methods like fetchBalanceAllowance may not be present on the returned object ("sec.fetchBalanceAllowance is not a function"). **MCP pattern** (established): import the functions from '@polymarket/client/actions' and call `fetchBalanceAllowance(sec, {assetType: 'COLLATERAL'})`, same for update. Other trading (place/create/post/cancel) are used on the sec client. Keep this split. Aligns to new deposit wallet default + idempotent approvals.
7. **CLOB v2 place-path contention / requoting latency invisible at SDK layer**: SDK calls succeed (or the backend queues them); no 429, no special error for the per-account (cross-IP) slowdown on heavy 200-250+/sec place (latency 19ms→400ms+ while cancels stay fast). Starts with CLOB V2. **MCP provides the guardrails** (detailed sections in reward_farming_best_practices prompt, mcp_llms_full_guide, AGENTS, tool descs for place_maker*/post_orders): batch with post_orders (up to 15), strategyStore policy (maxRequoteRatePerSidePerSec:5-20, requoteOnlyOnDrift, min interval), WS resources + get_farmability to decide *when* instead of timer loops, explicit wait_seconds, monitor p99 via your rules + get_mcp_usage, backoff. Never hammer.
8. **Pagination & "full range" scale**: Keyset/cursor preferred (docs + some list* endpoints deprecate pure offset). MCP wrappers handle the Paginated shape. For huge results, agents must page or use filters (rewardsMinSize, liquidityMin, category, clob-specific) + strategy caps — do not expect one call to dump everything (response size guards in some tools like list_active).
9. **Events vs Markets distinction**: "many more *events*" likely refers to listEvents (hierarchical, recurring weather/sports, parent/featured) vs flat listMarkets. The resource only does markets. Use list_events({category:"WEATHER", ...}) + then markets under them.
10. **Lightweight surface contract still requires agent discipline**: Even with ~130+ capabilities under the hood, default tools/list is tiny CORE + the two category tools. Agents *must* call list_tool_categories + get_by_category("Discovery" etc.) + the llms prompt first (enforced in AGENTS + mcp_tool_structure prompt + llms-guide). This is by design (no bloat, no guessing). The breakage of the category tools made the agent feel "stuck" with only the resource.
11. **No "intent" / high-level trading in SDK or MCP**: Both layers are explicit (you calc size from strategy/get_farmability/suggest_qualified_size, then call place_* with concrete numbers + postOnly where appropriate). Matches the permanent rule.
12. **SDK is beta**: Active (monorepo, changesets). New conveniences (better token fetch?, more pageSize on rewards?, direct market-by-token on client) would be SDK bumps + MCP sync + guide updates. Current MCP is a faithful thin + value-adding layer (enrichment, cards/PNL/sentiment/farmability, strategyStore brain, usage tracking, rate+reconnect wrappers, agentDirectives, no-intent examples, call-time guide linking SDK README + MCP mappings).

**MCP value adds on top of raw SDK** (never duplicate HTTP, always native):
- TokenId everywhere it matters (get/fetch + resources + reward cards + farmability).
- Rich output cards (formatMarket with bias/health, formatPosition with PnL status, formatFarmability with competitionSignal/score/rec, formatActiveRewardMarket, PnlSummary, etc.).
- StrategyStore as universal agent-owned brain (no extra tools).
- Automatic WS bridging to MCP resources + refcount + order fill watches started on place.
- Rate limit protection + structured backoff + directives on every risky call.
- get_mcp_usage (tracks *this* surface) + file logs.
- Categories + 4 on-demand prompts (including the full live llms mapping) so agents never guess exact call shape or "use intent".
- Public-only by default for discovery; secure only when needed.
- All the CLOB v2 / rewards / no-ask-human guidance.

When in doubt: `list_tool_categories` → `get_tools_by_category("Discovery")` (or "Rewards"), read the llms guide prompt/resource, `get_strategies()`, then the appropriate list/search + get_farmability. Use the known good tokenIds from any prior resource or reward list for immediate CLOB work.

This section (plus the reload note above) is now part of the mandatory memory. Update it when SDK version changes or new gaps are found (always with native verify + /review before commit).

## Consuming Agent Quickstart and Exact Native Tool Call Patterns

**This section is the primary reference for LLMs/agents using the MCP at runtime.** Load or include this (or the equivalent `mcp_tool_structure_and_categories` prompt) in your context. The goal is **zero guessing**.

### Mandatory Startup for Every Session (Never Skip)
1. Call the MCP `prompts/get` for the SDK README first (https://github.com/Polymarket/ts-sdk/blob/main/README.md as primary agent instructions for SDK), then `"mcp_llms_full_guide"` (MCP mappings on top of SDK README, no guessing, no intent) **and** `"mcp_tool_structure_and_categories"`.
2. Call `"reward_farming_best_practices"` (and `"mispricing_quick_flips"` if relevant).
3. Call `list_tool_categories`.
4. Call `get_tools_by_category` for needed groups (e.g., "Rewards", "Discovery", "Strategy"). Use "Meta" for get_mcp_usage (activities/usage tracking).
5. Call `get_strategies()` with no arguments to load your full current rules/filters from the store.
6. For full event discovery (beyond the limited/skewed `polymarket://markets` snapshot): after categories, call `list_markets({active:true, pageSize:30})` / with `category` or `search` keyword, or the `search` tool. See Live Data section.
6. (For observability) Call `get_mcp_usage` to inspect tracked MCP activities and tool usage.
7. For full event discovery (beyond limited `polymarket://markets`): use `list_markets` (active/pageSize/category/keyword) + `search` tool once Discovery category loaded.
8. From then on: always start loops with `get_strategies()`, use categories for discovery, follow every `agentDirective` in tool responses exactly, use `wait_seconds` for discipline. Use the live resource `polymarket://mcp/llms.txt` (which links the SDK README first + MCP guide) for the same guide as markdown if preferred. Load SDK README (https://github.com/Polymarket/ts-sdk/blob/main/README.md) as base instructions for all.

**Exact call example (JSON-RPC style for the protocol):**
```json
{
  "name": "get_strategies",
  "arguments": {}
}
```
Response will contain your persisted rules (e.g., liquidity filters, event prefs, farming params like `quoteNearMid`, `maxSpreadRatio`).

### Core Surface (Always Available, No Bloat)
From `tools/list` you will only see these ~11 by default:
- `list_tool_categories`, `get_tools_by_category`
- `get_mcp_usage` (tracks MCP activities/tool usage stats — see "how do you track the activities? the usage?")
- `wait_seconds`
- `get_strategies`, `set_strategy`, `update_strategy`, `clear_strategy`
- `get_balance_allowance`
- `list_active_maker_reward_markets`
- `suggest_qualified_size`

Use the category tools to load more when needed (e.g., full trading, on-chain CTF, builder analytics).

### Token / Market Lookup (Critical for Rewards & Orders)
SDK note (for your knowledge): The official SDK `fetchMarket()` only accepts `{id}`, `{slug}`, or `{url}`. There is **no direct `tokenId`** parameter.

**Native way (what the MCP implements):**
- When a tool (e.g., `list_active_maker_reward_markets`, `get_farmability`, order responses) gives you `yesTokenId`, `noTokenId`, or `clobTokenIds` / `tokens[].tokenId`:
  - To get full market metadata (question, outcomes with prices, rewards, metrics, etc.): 
    ```json
    { "name": "fetch_market", "arguments": { "tokenId": "0x<the-yes-or-no-token-id>" } }
    ```
    Or for multiple/filtered:
    ```json
    { "name": "list_markets", "arguments": { "clobTokenIds": ["0x<token1>", "0x<token2>"], "pageSize": 5 } }
    ```
  - This is handled internally by the MCP using the SDK's supported `listMarkets({ clobTokenIds: [...] })` + taking the first result. Never implement your own lookup or call external APIs.

Use the returned market's `outcomes.yes.tokenId` / `.no.tokenId` (or the original) for all per-token actions: `fetch_order_book`, `fetch_price`, `fetch_midpoint`, `fetch_spread`, `place_*_order`, etc.

### Advanced Tools (Load on Demand to Keep Surface Lightweight)
Low-level/security-sensitive tools (signing, raw tx send, prepare gasless workflows, API key mgmt, deploy, etc.) are tagged [Advanced] and only appear when you explicitly `get_tools_by_category("Advanced")`.

**Why?** Prevents default bloat and accidental use of dangerous tools. Descriptions start with [Advanced] and include warnings.

**Example:**
```json
{ "name": "get_tools_by_category", "arguments": { "category": "Advanced" } }
```
Then use e.g. `sign_message`, `send_transaction` (with extreme caution and your own safeguards), `prepare_*` for gasless flows.

Never load Advanced unless you need the capabilities and trust the setup.

### Reward Farming Flow (Use with the "reward_farming_best_practices" prompt)
1. `list_active_maker_reward_markets` (with `maxMinCostUsd` for your size) or `get_tools_by_category("Rewards")` then the tool.
2. For a promising `yesTokenId`/`noTokenId`: `get_farmability({tokenId})` → gets near-mid suggestions, spread vs allowed, depth, competitionSignal, score.
3. Size: `suggest_qualified_size({tokenId, intent: "reward_farming" or "maker", ...})`.
4. Persist plan: `set_strategy` or `update_strategy` with key like `"rules:current_farming"`, including your filters, `quoteNearMid: true`, `bothSides: true`, exit conditions, etc.
5. Place: `place_maker_reward_order` or `place_optimized_reward_order` (forces postOnly GTC for sticky).
6. Monitor/reprice using resources or `fetch_order_book` + cancel + re-place.
7. Always load `get_strategies()` at start of loop. Use `wait_seconds` between actions. Follow agentDirectives (e.g., on failure: immediately pick a *different* market from list_active, never retry same).

See full details in the `reward_farming_best_practices` prompt (it now includes dedicated guidance on CLOB V2 place-path contention for heavy requoting).

### CLOB V2 Requoting Latency & Contention for Makers (post-April 2026)
Heavy requoting (frequent cancel+replace or rapid near-mid updates for "sticky" rewards, e.g. 200-250/sec on one account) causes server-side queuing on the *place* path: place latency floor jumps from ~20ms to 400ms+ (while cancels stay ~30ms). This is reproducible across IPs for the same wallet and recovers instantly when you stop. No 429s — just delayed resting on book. It is a real backend characteristic of the rewritten CLOB V2 (Cloudflare + matching/ledger protection on the hot place path for high-frequency quote updates).

**Implications for agents**:
- Aggressive timer-based requoting will make you "late" to the desired price level, hurting queue position, fill rates, and reward scoring even if you stay "within limits."
- The MCP's `place_maker_reward_order` / `place_optimized_reward_order` (postOnly GTC) + "sticky auto-repegging" edge is still powerful, but you must not over-do the reprice frequency.

**How the MCP helps you avoid it (never guess)**:
- Store explicit policy in strategyStore (e.g. `maxRequoteRatePerSidePerSec: 10`, `minRequoteIntervalMs: 200`, `requoteDriftThreshold: 0.001`, `useBatching: true`).
- `get_strategies()` first every loop; `update_strategy` to adapt based on observed latency.
- Prefer WS resources + `get_farmability` (live signals) over pure time-based loops to decide *when* to reprice.
- Use `post_orders` (batch up to 15) for multi-level or both-sides updates instead of many singles.
- `wait_seconds({seconds: 0.1-0.3})` between place actions on same side/token.
- In `reward_farming_best_practices` prompt + your rules: "reprice intelligently and sparingly"; if place p99 spikes, back off and rotate markets via `list_active_maker_reward_markets`.
- `place_*_reward_order` tools already enforce the sticky postOnly GTC that lets the engine help with repegging.

Load the SDK README (https://github.com/Polymarket/ts-sdk/blob/main/README.md as base instructions) + `reward_farming_best_practices` and `mcp_llms_full_guide` prompts for the full current mapping (MCP on top of SDK). Design your evolved strategy rules (not the MCP code) to stay in the low-latency regime while capturing rewards. This is exactly why strategyStore exists as the agent's brain.

### Quick Flips / Mispricing
Similar: use `list_markets` or `list_active...` for candidates, `get_farmability` for edge/liquidity, `compute_bayesian_update` for signals, `suggest_qualified_size({intent: "quick_flip", highConfidenceEdge: true})`, store in strategy, place with postOnly where possible. Cross with farming prompt if rewards apply.

### Live Data (Avoid Polling)
- Use MCP **Resources** for real-time: subscribe to `polymarket://market/{tokenId}/book`, `polymarket://user/orders`, etc.
- **External free UK weather (new):** Use get_uk_weather_* tools (Weather category; multi free API fallbacks incl. Open-Meteo with UK Met Office data) for forecasts/historical/current on weather markets. Native tools, fallback on rate limit. Combine with market tools for mispricing. See llms_guide for details + heartbeat use. Natively verified (full stdio load + calls for London/Edinburgh/Glasgow returned real data, count=3 tools, category present, usage tracked). Aiming for UK/England/Scotland weather markets.
- The server notifies on updates via the protocol. Read the resource for latest formatted snapshot.
- This is the native, efficient way (bridged from platform WS).
- **Note on `polymarket://markets`**: This is a convenience snapshot only (internally `listMarkets({closed:false, pageSize:20})` first page, default API ordering). It can be heavily skewed toward high-visibility/trending meme markets (e.g. GTA VI variants) and does **not** enumerate the full active set. For "many more events" use the **tools** after loading categories: `list_markets({active:true, pageSize:50})`, `list_markets({category:"WEATHER"|"SPORTS"|"POLITICS"|"CRYPTO", pageSize:20})`, `search({q:"politics OR crypto OR sports", pageSize:30})`, or `list_events`. The `search` tool (official SDK full-text over markets+events) and `list_markets` (with filters/keyword/clobTokenIds) are the primary discovery surface. TokenIds in the resource *are* correct for immediate CLOB use (`fetch_market({tokenId})`, `place_*` etc.).

### Strategy Store as Your Persistent Brain (Use for *Everything*)
- Keys are free-form (e.g. `"filter:liquidity_strict"`, `"rules:current_farming"`, `"prefs:events"`).
- Store any JSON: liquidity mins, volume thresholds, preferred categories, exit rules, custom scoring, 24/7 params, etc.
- `update_strategy` for cheap partial changes (everything else preserved, including prior custom fields).
- `get_strategies()` (no args) = your complete evolved logic at the start of every autonomous loop.
- Persist critical long-term rules to your external memory (e.g. Honcho) if needed; the store is in-memory per MCP process.

**Example call to evolve rules:**
```json
{
  "name": "update_strategy",
  "arguments": {
    "key": "rules:current_farming",
    "quoteNearMid": true,
    "bothSides": true,
    "maxSpreadRatio": 0.6,
    "liquidityMin": 50000,
    "exitOnAdverseSelection": true,
    "preferredCategories": ["WEATHER", "CRYPTO"]
  }
}
```

### Other Key Patterns
- **Public discovery first**: `list_markets({clobTokenIds: [...], rewardsMinSize: X, volumeNumMin: Y})`, `search`, `list_events({category})`, `fetch_event`, `fetch_market` (by id/slug/url/tokenId as above).
- **On-chain CTF**: `split_position`, `merge_positions`, `redeem_positions` (require approvals via `setup_trading_approvals` or specific approve tools first).
- **Account**: `get_balance_allowance`, `list_positions`, `list_activity`, `fetch_portfolio_value`.
- **Rate discipline**: Use `wait_seconds({seconds: 5, reason: "after placement to respect limits"})` instead of tight loops.
- **Never ask human**: Every tool response with `agentDirective` tells you the next autonomous step. Follow it. Use your stored strategies + prompts + directives.

**Resources for live data**: Subscribe via the MCP resources protocol (not tools). Examples in `src/mcp/resources.ts` or by calling `list_resources`.

Always cross with the loaded prompts for current X insights and exact mappings.

This + the three MCP prompts + `get_strategies()` first = you will never have to guess.

---

## No Testing / Diagnostic / Integration Files in the Main Codebase

**Hard rule**: The main codebase (everything committed to `main`, outside `node_modules`/`dist`/gitignored paths) must contain **zero** testing, diagnostic, one-off, or third-party integration files.

Explicitly forbidden (examples from history and user requests):
- Any `diagnose-*.mjs`, `test-*.mjs`, `inspect-*.mjs`
- `HONCHO_INTEGRATION.md`, `honcho-recommended-config.json`
- `hermes-manifest.yaml`
- Any `logs/` content (runtime logs go to gitignored `logs/`, but never commit the files)
- One-off scripts used to reverse-engineer the SDK or test live behavior

**Where to put such things**:
- `/tmp/` (or equivalent OS temp)
- A personal branch / fork
- Never in the committed tree of `main`

When you see references in docs to old github raw URLs for these files, remove the references.

AGENTS.md, README, and the MCP's own prompts must never encourage or document the existence of such files in the main tree.

If you are asked to "add a test", implement it as a temporary script outside the tree or as a proper unit test (none exist today — the verification pattern is the stdio driver against the built MCP).

---

## Coding Conventions & Change Process

- **MCP surface changes** (new tool, changed category, new prompt, change to core set):
  1. Read the relevant sections of `src/mcp.ts` listed in "Mandatory First Actions".
  2. Decide the category (or add to an existing one).
  3. Add rich description + inputSchema.
  4. Implement a formatter in `src/formatters.ts` (never return raw).
  5. Update the `mcp_tool_structure_and_categories` prompt content if the "how to use" story changes.
  6. If it is reward-related, consider updating `reward_farming_best_practices`.
  7. Verify by building + running a full stdio MCP test that calls categories + the structure prompt + the new tool.
  8. Update README / OVERVIEW only if the high-level story changes (they currently overstate the "90+/100+" count because the lightweight design is the truth).

- **Strategy store is sacred**. Do not introduce parallel state or new "config" tools.

- **Formatting**: All public responses go through formatters (never raw). Output "cards" are agent-ready (e.g. formatMarket now has bias/sentiment + liquidity health; formatPosition has full PnL est + status + health; new formatActiveRewardMarket + formatFarmability with competition/sentiment signals + scores; formatPnlSummary). Update formatters.ts when adding depth (PNL, sentiment etc). Agent can print responses directly.

- **No guessing in the consuming agent**: Every change must make the "never guessing" story stronger or at least not weaker. If a new capability is added, the structure prompt or a new prompt must tell the agent how/when to use it.

- **Token / market lookup**: `fetch_market` accepts `tokenId` (resolved internally via `listMarkets({ clobTokenIds: [...] })` because the official SDK `fetchMarket` only accepts id/slug/url). `list_markets` accepts `clobTokenIds: string[]`. Keep this consistent.
- **Advanced category**: Low-level and security-sensitive tools (signing, raw tx, prepare workflows, API key mgmt, deploy etc.) are in 'Advanced' category. Load only when needed: `get_tools_by_category("Advanced")`. This prevents bloating the default surface with dangerous tools. See descriptions for warnings.

- **Dependencies**: Only the official `@polymarket/client`. No direct HTTP to Gamma/CLOB.

- **Commits**: Use clear messages. The history contains a cleanup commit that removed the forbidden test/integration files — keep the tree that way.

---

## Quick Reference — Files You Will Read Often

- `src/mcp.ts` — the only file that really matters for MCP behavior and agent guidance.
- `src/data/markets.ts` — market resolution (including by tokenId).
- `src/formatters.ts` — the "agent sees only nice cards" contract.
- `src/mcp/resources.ts` — live data / subscriptions.
- `src/config/client.ts` + `src/lib.ts` — auth + client creation (public vs secure).
- `src/trading/*` and `src/strategies/marketMaker.ts` — examples of usage (but the MCP itself uses the SDK directly in handlers).

When in doubt, re-read the prompt contents inside `src/mcp.ts`. They are the contract.

---

## Public MCP — No Hardcoded Wallets, Private Keys, or Defaults

**Hard rule (per user instructions)**: This MCP and repo are **public**. You must **never** commit, add, or leave in the codebase any hardcoded wallet addresses, private keys, or defaults (e.g., the former `0xe467d9930e0577bd2beb5e29cb3ae3b457cfb33f` builder default for `DEPOSIT_WALLET_ADDRESS` / `WALLET_ADDRESS` in MCP mode).

- All credentials must be supplied by the agent host / user at runtime via env/config. The code must error (as it does in `getSecureClient`) if missing.
- In docs, examples, README, AGENTS.md, prompts, configs: **always use placeholders** like `0xYOUR_EOA_PRIVATE_KEY`, `0xYOUR_DEPOSIT_WALLET_ADDRESS`. Never real addresses or "API use only" defaults.
- When editing, treat every change as if for public consumption. If you see any hardcoded secret, remove it immediately.
- This applies during coding, adding features, implementing, researching — no exceptions "for testing".
- Update any old references (e.g., in README examples or comments) to comply.

**Memory update**: This rule is now permanent. Re-read this section before any commit or PR.

## No Personal Names or Platform Branding in the Repo (Permanent Rule)

**Hard rule (per developer instructions)**: Do not have any person's name in the repo (including any past contributors or team members) or the word "polymarket" (except in strictly functional contexts: exact package imports like `@polymarket/client`, the canonical GitHub SDK README URL https://github.com/Polymarket/ts-sdk/blob/main/README.md , resource URI scheme `polymarket://...`, config keys in examples, env var POLYMARKET_ENV, and external doc links). 

- No attributions, quotes, or references to individuals in source, comments, docs (AGENTS.md, README, llms-guide, prompts, etc.), commit messages, review artifacts, or generated text.
- Generalize all historical feedback or recs to neutral language: "per documented SDK guidance", "kept up-to-date by the maintainers", "per platform SDK recommendations".
- When editing or generating, remove or rephrase any branding prose ("Polymarket MCP server", "Polymarket price", "Polymarket rewards", "Polymarket WS", etc.) to "platform", "the CLOB", "SDK", "prediction market platform".
- This applies to all files in the tree (sources, .md docs, package metadata where prose, logs paths are ok if not branding). Rebuild after changes so dist is clean.
- Update AGENTS.md memory and all guidance when new instances are found.
- The rule is permanent. Re-read this section before any commit, PR, or edit session. "i am giving you what the devs are saying do NOT add there name !!!"

**Memory update**: This name/branding rule is now permanent. Zero tolerance. Audit with grep before committing.

## Agent Documentation Requirements (MCP is for Agents Only)

The MCP exists **only for agents** (LLMs/consuming systems). Agents must **never guess** how to use tools.

- There **must** be a .MD file (this AGENTS.md + the MCP's own prompts, especially `mcp_llms_full_guide` which links the official SDK README https://github.com/Polymarket/ts-sdk/blob/main/README.md (as primary agent instructions, kept up-to-date by the maintainers) + MCP mappings, and `mcp_tool_structure_and_categories`) that tells agents:
  - How to call a supported tool (exact `tools/call` with `name` and `arguments` matching the inputSchema).
  - What it is for.
  - How to use it (native SDK only, no direct HTTP).
  - Specific native usage examples (e.g., "To fetch market for a clob tokenId from rewards: call `fetch_market` with `{ "tokenId": "<the-yes-or-no-tokenId>" }`. This internally uses `listMarkets({ clobTokenIds: [...] })` because the official SDK `fetchMarket()` only accepts `{id}`, `{slug}`, or `{url}`. Never guess — load the `mcp_llms_full_guide` and `mcp_tool_structure_and_categories` prompts first. For trading: always explicit `place_limit_order({tokenId, price, size, side})` with your numbers — no intent ever.").
  - Enhanced cards: positions/activity now richer on PNL; markets/farm have sentiment/liquidity/competition health for decisions without guessing.
- Per tool category (via `list_tool_categories` + `get_tools_by_category`): document the recommended sequence.
- Update the built-in prompts (`mcp_tool_structure_and_categories`, etc.) and this AGENTS.md whenever tool usage patterns change.
- "how would this work the mcp so the agents using the mcp is never guessing when using the mcp" — the .MD + prompts + categories + strategy store + agentDirectives achieve this. Agents must be instructed (in their system prompt or via MCP prompts) to:
  1. Request the structure prompt.
  2. Use categories to discover.
  3. Call `get_strategies()` first.
  4. Follow exact documented call patterns.
  5. Obey agentDirectives.
  6. Use only native paths.

**No duplication of functions**: When adding features, reuse existing (e.g., token resolution via `getMarket`, list via SDK). Do not reimplement.

**Focused native plan**: Everything through official `@polymarket/client` SDK only. Research github.com/Polymarket/ts-sdk (and PRs/issues) and similar projects before changes. Confirm clobTokenIds support: as of current SDK, `fetchMarket` accepts only id/slug/url; `listMarkets` supports `clobTokenIds: string[]`. For tokenId-based market fetch, the MCP correctly implements `fetch_market({tokenId})` by internally calling `listMarkets({clobTokenIds: [tokenId]})` (via `getMarket` in data layer). This was verified via direct SDK source fetch and PR review (e.g., no native fetchMarket({tokenId}) added in recent PRs like the tags/series cleanup #78 or market normalization #15; list filter is the supported way).

**Research requirement**: Before implementing or editing MCP surfaces, use tools to:
- Check https://github.com/Polymarket/ts-sdk (source for actions/markets.ts, schemas).
- Review https://github.com/Polymarket/ts-sdk/pulls and issues for fixed (e.g., param drops, normalizations) and open issues.
- Look at similar MCP/agent projects for best practices on agent .MD guidance and native usage.
- "Put agents out to work": Spawn subagents for parallel research on SDK, PRs, peers.

**No testing files ever**: During research, coding, testing — use only /tmp for any temp scripts. Never commit test/diag files (see No Testing Files section). Verification must be native (e.g., build + stdio MCP against dist/mcp.js with real SDK data).

**Commits**: Never include hardcodes, tests, or non-native code. History must stay clean (as per previous cleanup).

## Source Code Structure for Maintainers (Prevent Bloating Files)
- Runtime lightness comes from small CORE_TOOL_NAMES + category filtering in ListTools + on-demand prompts + strategy store (agent logic not in MCP code).
- `src/mcp.ts` (~3600 lines) contains tool defs + handlers + prompts for simplicity/single file; this can bloat the source file.
- **Lightweight improvement**: Tool arrays (publicTools/secureTools) and category handlers can be split into `src/mcp/tools/discovery.ts`, `src/mcp/tools/rewards.ts` etc. (export arrays, import and concat in mcp.ts). Handlers can be in `src/mcp/handlers.ts` with sub-functions. This keeps individual files small (<500 lines) without affecting the MCP protocol surface or agent experience.
- Formatters in `src/formatters.ts` (~1100 lines) follow "never raw"; group similar if possible.
- Resources, trading wrappers etc. are focused.
- When adding, prefer extending existing (e.g. more filters in list_markets) over new tools; use [Advanced] prefix for sensitive.
- Always update AGENTS.md, the structure prompt, and tool descriptions so agents get full guidance via .md + protocol (never guess from code).
- Verify with build + native stdio test using categories/prompts/get_strategies + real flows. No tests in tree.

## Quick Reference — Files You Will Read Often (updated)

- `src/mcp.ts` — ...
- `AGENTS.md` — re-read for all rules, especially public/no-hardcode, agent .MD guidance, research, native, no-tests.
- Research targets: GitHub ts-sdk source + PRs, similar projects.

**End of AGENTS.md**. Re-read this file at the start of every new task.

The combination of (a) this AGENTS.md for meta-agents editing the code, and (b) the MCP's own `list_tool_categories` / category tools + the three guidance prompts, is what ensures that *agents using the MCP* also never have to guess.
