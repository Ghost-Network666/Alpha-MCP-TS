// src/mcp/llms-guide.ts
// Call-time delivered non-stale .md style guide for agents (SDK README + MCP mappings).
// The official TS SDK README (https://github.com/Polymarket/ts-sdk/blob/main/README.md — kept up-to-date by the maintainers) is the PRIMARY and canonical source of truth for all SDK coverage, APIs, client factories (createPublicClient/createSecureClient), decorators (allActions), methods (listMarkets, placeLimitOrder, etc.), parameters, errors, and examples. The MCP llms guide + prompts provide only MCP-specific overlays/mappings on top (exact tool names + call shapes + "use explicit only, no intent", strategyStore, resources, cards, categories). Never rely on stale local copies.
// How added/updated to the MCP (instead of stale .MD files or direct llms.txt):
// - Dedicated src/mcp/llms-guide.ts with buildMcpLlmsGuide() that produces full .MD at *runtime* (call-time, so never stale).
// - Registered as MCP Prompt "mcp_llms_full_guide" (agents do prompts/get) and Resource "polymarket://mcp/llms.txt" (agents list/read_resource/subscribe).
// - The content links the SDK README first for base SDK concepts/coverage (maintained upstream), then provides rich MCP-specific mappings/overlays: for each concept, the exact native tool(s) + JSON call shape + "use explicit place_* , never intent" warnings + cross to strategyStore, resources, cards, get_mcp_usage for tracking.
// - Imported in mcp.ts (for PROMPTS + GetPrompt dispatch + build) and resources.ts (for the URI handler).
// - Heavily referenced/required in AGENTS.md (mandatory reads), mcp_tool_structure_and_categories prompt, README, etc. Agents told to load the SDK README + this MCP guide first.
// - Categories list moved to be exported from here and used by runtime list_tool_categories for sync.
// - Updated for no-intent trading, CLOB v2 requoting, usage tracking, etc.
// This gives agents the "how to use the MCP without ever guessing" in official .MD style, using only native SDK explicit calls. The MCP "uses this [SDK README] for all" base instructions + MCP specifics.

export const MCP_CATEGORIES = [
  'Rewards',
  'Strategy',
  'Account',
  'Utilities',
  'Discovery',
  'Trading',
  'Analytics',
  'Weather',    // Free UK weather (multi-provider fallback APIs for forecasts/historical/current, native tools for agents + heartbeat)
  'Meta',       // get_mcp_usage for MCP activities/usage tracking
  'Advanced'    // Low-level, security-sensitive, prepare workflows.
];

export function buildMcpLlmsGuide(): string {
  // Built at call time (prompts/get or the mcp/llms.txt resource) to avoid stale committed .MD files.
  // Content curated + kept in sync with the MCP (tool patterns, cards, strategy, public rules, explicit native calls) + MCP mappings.
  // Base SDK coverage/instructions: link the official TS SDK README (https://github.com/Polymarket/ts-sdk/blob/main/README.md — kept up-to-date by the maintainers; covers SDK APIs, clients, examples, concepts for the beta TS SDK that this MCP wraps 100% natively).
  // Not a fully auto-iterated dump of arrays (the value is the explanatory "how to use without guessing" + exact JSON examples + no-intent rules + MCP overlays on the SDK README).
  // Per team: use the SDK README as agent instructions for the underlying SDK. This MCP version adds the *usage mapping*: "for SDK concepts (see README), call these exact MCP tools with these args".
  // Load the SDK README first, then this + mcp_tool_structure_and_categories at startup. Then use categories + get_strategies().
  // All via official @polymarket/client SDK only. Never guess. Never use intent for trading.
  // The MCP uses the SDK README link for all base instructions (as recommended).

  let md = `# MCP Server - Full Agent Guide (SDK README + MCP mappings)

This MCP is **lightweight and agent-first** for the CLOB prediction market platform (prediction markets on Polygon via CLOB + CTF).
**Core principle**: Tiny default tool surface (~10 core tools via CORE_TOOL_NAMES). Use categories + prompts to discover/load more. 
**Agents must never guess**: Always start with the mandatory sequence below. All your logic/rules/filters/exits in strategy store (get_strategies first every loop). Use only native SDK paths via these explicit tools. Follow every agentDirective. Public: always provide your own keys (no defaults/hardcodes anywhere in this MCP or docs).

**Base instructions (PRIMARY SOURCE OF TRUTH):** For the underlying TS SDK (all APIs, clients, auth, examples, concepts, client creation with createPublicClient/createSecureClient, .extend(allActions) for decorators, method signatures like listMarkets/fetchMarket/placeLimitOrder, param shapes, pagination, errors, WS managers, wallet adapters, etc.), read the official README first and treat it as canonical: https://github.com/Polymarket/ts-sdk/blob/main/README.md (maintained up-to-date by the maintainers — this MCP uses the SDK 100% natively with no custom HTTP, only thin safe wrappers + formatters + categories + strategyStore). 

Instead of duplicating SDK docs or using stale local MDs/llms.txt, this prompt + the MCP resource polymarket://mcp/llms.txt delivers MCP-specific overlays + exact native call mappings on top of the SDK README so consuming agents have zero ambiguity on "how do I do X natively in *this MCP* using the SDK". Load the SDK README first, then this MCP guide.

## Mandatory Startup Sequence (NEVER SKIP)
1. Call prompts/get for "mcp_llms_full_guide" (this full .md) **and** "mcp_tool_structure_and_categories".
2. Call "reward_farming_best_practices" (if rewards/maker) and/or "mispricing_quick_flips".
3. Call list_tool_categories.
4. Call get_tools_by_category for needed (Rewards, Discovery, Strategy, Trading, Account, Utilities, Analytics, Advanced).
5. (Optional but recommended for operators/observability) Call get_mcp_usage to see tracked MCP surface activities and tool usage stats.
5. Call get_strategies() (no args) to load your persisted rules/filters from the store.
6. Use categories for more tools when needed. Persist **everything** (sizes, quotes, exits, prefs) via set/update_strategy. Use wait_seconds for discipline. Obey agentDirectives in every response.

**Never use "intent" for pure trading** — call place tools directly with your sizes/params from strategy or calc. suggest_qualified_size / get_farmability are *advisory only* for reward qualification/sizing policy. For directional or any core trading: compute or load policy then pass concrete values to place_limit_order etc.

## Core Tools (Always Available - No Bloat)
From tools/list you get only:
- list_tool_categories, get_tools_by_category, get_mcp_usage (MCP-internal activity/usage tracker — this is how activities and usage are tracked)
- wait_seconds
- get_strategies, set_strategy, update_strategy, clear_strategy
- get_balance_allowance, list_active_maker_reward_markets, suggest_qualified_size

Full ~130+ capabilities via on-demand categories (prevents bloat, forces deliberate use). Advanced category for sensitive (sign/send/prepare/deploy).

## Full Exhaustive Coverage of the Unified @polymarket/client TS SDK — Exact SDK Functions + MCP Native Mappings (per expert guidance)

**You are an expert Polymarket MCP developer using the official unified TypeScript SDK @polymarket/client@beta (follow the categorized list below exactly for any feature mapping).**

**Core SDK Setup (always use this pattern per official README):** 
import { createPublicClient, createSecureClient } from '@polymarket/client';
// Prefer createSecureClient for trading/gasless/wallet (see official for options: signer, wallet, environment, apiKey etc.)
const client = await createSecureClient({ signer, wallet, apiKey?, builder creds?, ... });
client = client.extend(allActions); // decorators for clean client.listMarkets, client.placeLimitOrder / postOrder, client.getBBO etc.

**Base instructions (always load first):** the official TS SDK README at https://github.com/Polymarket/ts-sdk/blob/main/README.md. This MCP maps every item below to exact native MCP tool + args (or the direct client.xxx call when documenting SDK usage). Never guess. Explicit only.

MCP internally follows the expert pattern: createSecureClient + .extend(allActions) for full surface. Use client.xxx (decorators). Pagination with for-await or MCP helpers. Gasless preferred. SDK error classes + rate protection.

### 1. Client Creation & Core
createPublicClient(config?) — Read-only (Gamma/Data + public WS)
createSecureClient(config) — Full (trading + CLOB + gasless + wallet + auth)
BasePublicClient, BaseSecureClient, ServiceClient (low-level)

MCP factories + extend (see client.ts). setup_gasless_wallet tool (deprecated no-op per latest SDK deposit default; gasless handled at createSecureClient).

### 2. Market Discovery & Gamma
client.listMarkets(params), client.getMarket(idOrSlug), client.searchMarkets(query), client.listSeries, client.listTags, client.listTeams, client.listSports, client.listEvents, client.getEvent

MCP: list_markets, fetch_market (tokenId via internal listMarkets clob), search, list_events/fetch_event, list_tags/sports/teams/series (Discovery category).

### 3. CLOB Trading (Orders) — secure client, gasless when possible
client.placeOrder(params) [or placeLimitOrder/placeMarketOrder/postOrder in current beta], cancelOrder, batchCancel, getOpenOrders, getOrder, getOrderBook, getBBO, getMidpoint, getPrices, getPriceHistory

MCP: place_limit_order / place_market_order / create_and_post_order / post_orders, cancel_*, list_open_orders / fetch_order, fetch_order_book / midpoint / price / spread / history, get_farmability (for BBO/depth/signals).

### 4-10. Portfolio, Account, Wallet, Rewards, Builders, WS, Helpers
See the exact lists in the user's expert instructions (client.getPositions, getProfile, claimRewards, ClobMarketWebSocketManager, buildHmacSignature, wallet adapters, etc.).

MCP maps them to corresponding tools in Account/Trading/Rewards/Advanced (or resources for WS managers). Full details + "use client.xxx directly in non-MCP code" are in the SDK README (primary) + this guide's mappings + mcp_tool_structure_and_categories prompt. Load prompts/get mcp_llms_full_guide first.

**Best practices (MCP and agents must follow):** Prefer createSecureClient (now defaults to Deposit Wallet per latest SDK). Gasless setup automatic for non-EOA at creation; setupGaslessWallet deprecated. Decorators pattern (client.listMarkets etc.). Pagination on lists. SDK errors (RateLimitError etc.). Real-time via the bridged WS managers (MCP resources). setupTradingApprovals idempotent. Map any feature request to the exact function in the 1-10 categories above + the MCP tool that wraps it.

MCP tools: list_markets (with clobTokenIds + category/search passthrough + resolver for tokenId), fetch_market (id/slug/url/tokenId — internal listMarkets clob bridge), search, list_events, fetch_event, list_tags, list_sports, list_teams, list_series, fetch_tag, fetch_series (via Discovery category). Use pagination internally.

### 3. CLOB Trading (Orders) — Always use secure client + gasless when possible
- client.placeOrder(params) — Limit / Market, GTC / IOC / FOK / GTD (signed)
- client.cancelOrder(orderId)
- client.batchCancel(orderIds)
- client.getOpenOrders()
- client.getOrder(orderId)
- client.getOrderBook(tokenId, params)
- client.getBBO(tokenId) — Best Bid/Offer
- client.getMidpoint(tokenId)
- client.getPrices(tokenId)
- client.getPriceHistory(tokenId)

MCP: place_limit_order, place_market_order, create_and_post_order (unified maker), post_orders (batch), cancel_order(s), cancel_all_orders, list_open_orders, fetch_order, fetch_order_book, fetch_midpoint, fetch_price, fetch_spread, fetch_price_history, watch_order_until_filled, get_farmability (for BBO/mid + depth + signals). Prefer postOnly GTC for rewards. Use prepare_* + send for Advanced.

### 4. Portfolio & Positions
- client.getPositions(params) — by market, outcome
- client.getPortfolio(summary?)
- client.getActivity(params) — trades, transfers, etc.
- client.getTrades(params)
- client.getTransfers(params)

MCP: list_positions (with filters), list_closed_positions, fetch_portfolio_value, list_activity (rich with rebates), list_account_trades. Cards include full PnL.

### 5. Account Management
- client.createOrDeriveApiKey()
- client.fetchApiKeys()
- client.deleteApiKey(keyId)
- client.getProfile()
- client.updateProfile()
- client.getLeaderboards(params)
- client.getComments(params)
- client.postComment(params)

MCP: create_api_key / derive / create_or_derive / fetch_api_keys / delete_api_key (Advanced), get_profile, update_profile, post_comment (Account category), list_builder_leaderboard, list_trader_leaderboard, fetch_public_profile, list_comments, fetch_comment, list_comments_by_user_address.

### 6. Wallet & Onchain / Gasless (secure + Advanced)
- client.approveToken(token, amount)
- client.deployDepositWallet()
- client.getDepositWallet()
- client.isGaslessReady()
- client.waitForGaslessTransaction(txHash)
- Gasless approval + transaction workflows

Per latest SDK (Jun 2026 commits): createSecureClient defaults wallet to signer's Deposit (auto-deploy if DEPOSIT_WALLET); setupGaslessWallet @deprecated no-op (setup at creation); setupTradingApprovals idempotent.

MCP: approve_erc20, approve_erc1155_for_all, deploy_deposit_wallet, fetch_deposit_wallet, setup_gasless_wallet (compat), is_gasless_ready (implicit), setup_trading_approvals (idempotent), split/merge/redeem_positions, prepare_* family, send_transaction (very sensitive), update_balance_allowance, fetch_balance_allowance (standalone for reliability).

### 7. Rewards & Subscriptions
- client.getRewards()
- client.claimRewards()
- client.listSubscriptions()
- client.subscribeTo(topic)
- client.unsubscribe()

MCP: list_active_maker_reward_markets (primary enriched), list_current_rewards, get_farmability (rewards + book + score), place_maker_reward_order / place_optimized_reward_order, validate_for_maker_rewards, suggest_reward_order_parameters, list_user_earnings*, fetch_reward_percentages. Subscriptions via resources (polymarket://user/* bridged).

### 8. Builders & Relayer
- Builder program actions
- Remote signing support

MCP: create_builder_api_key, fetch_builder_api_keys, revoke_builder_api_key, list_builder_leaderboard/trades/volume, fetch_builder_fee_rates. Relayer preferred for gasless (passed in createSecureClient).

### 9. WebSockets (Real-time) — MCP bridges, never direct in agent code
- ClobMarketWebSocketManager — Orderbook updates
- ClobUserWebSocketManager — user orders, fills, positions
- RtdsWebSocketManager — real-time data service
- SportsWebSocketManager
- Methods: connect(), close(), event listeners (orderbook, trades, etc.)

MCP: Resources (subscribe/read) for polymarket://market/{tokenId}/book, polymarket://user/orders, /fills, /positions, /portfolio, /activity, polymarket://order/{id}/fill-status (auto on place). Uses ReconnectingSubscription + client.subscribe internally. Prefer resources over polling.

### 10. Helpers & Utils
- Wallet adapters: viem (privateKey — MCP default), ethers-v5, privy
- resolveAccountIdentity
- Pagination (async iterators on all list methods — MCP uses callPaginatedWithFormat + collectAll)
- HMAC signing (buildHmacSignature), input validation, error handling (RateLimitError, SigningError, etc. — MCP rate protection + structured errors + agentDirective)
- All Types from @polymarket/types and bindings (Market with clobTokenIds/outcomes/tokens, OrderSide, OrderType, ActivityType incl. rebates, etc. — normalized in MCP cards)

**MCP Best Practices (follow exactly):**
- Always prefer createSecureClient (deposit wallet default per latest SDK; gasless auto for non-EOA at creation; setup_gasless_wallet deprecated no-op) for trading/wallet.
- Use decorators pattern for clean calls (client.listMarkets, client.placeLimitOrder / postOrder etc.).
- All list* : use pagination (for await or MCP wrappers).
- Error handling: SDK classes + MCP structured {ok:false, retryAfter, agentDirective}.
- Real-time: always use MCP resources (bridged WS managers).
- For any feature: map to exact SDK function above + corresponding MCP tool (or direct client. call in non-MCP code).

See full current mappings + examples in the rest of this guide + mcp_tool_structure_and_categories prompt. Load them first.

### Environments
production (default). Others via config for test.

### Errors (full set; MCP rate protection + agentDirective turns many into structured recoverable)
CancelledSigningError, RateLimitError, RequestRejectedError, SigningError, TimeoutError, TransactionFailedError, TransportError, UnexpectedResponseError, UserInputError, CreateSecureClientError, SetupGaslessWalletError, ListMarketsError, FetchMarketError, PlaceLimitOrderError, PostOrderError, ... (many per-action guards with isError()).

### All Actions (from /actions/ + decorators on extended client) — MCP Mappings
**Markets / Discovery (use MCP Discovery category first)**
- listMarkets(params) — clobTokenIds, rewardsMinSize, volume/liquidity filters, closed/active, pageSize/cursor. MCP: list_markets (with category/search passthrough + clobTokenIds resolver). Always get Yes/No TokenId + Token Ids in cards.
- fetchMarket({id|slug|url} only) — NO tokenId. MCP: fetch_market({id/slug/url/tokenId}) — resolves tokenId via internal listMarkets({clobTokenIds:[...]}) + first (the reliable bridge).
- searchMarkets / search({q}) — MCP: search tool.
- listEvents, getEvent, listSeries, listTags, listTeams, listSports, fetchTag, fetchSeries, listMarketHolders, fetchEventLiveVolume, fetchEventTags, fetchMarketTags, fetchRelatedTags, fetchRelatedTagResources — MCP: list_events (category filter), search, or get_tools_by_category("Discovery") for list_tags / list_sports etc if added as thin wrappers; otherwise use list_markets + search for most.
- getMarketInfo etc.

**CLOB / Trading (CLOB native, explicit only)**
- placeOrder / placeLimitOrder / placeMarketOrder (signed, GTC/IOC/FOK/FAK, postOnly), createLimitOrder, postOrder, postOrders (batch). MCP: place_limit_order, place_market_order, create_and_post_order, place_maker_reward_order / place_optimized_reward_order (enforce GTC+postOnly+scoring for rewards), post_orders (batch <=15). **Never use intent.**
- cancelOrder, cancelOrders, cancelAll, cancelMarketOrders. MCP: cancel_order / cancel_orders / cancel_all_orders / cancel_orders_for_market.
- getOrderBook(tokenId), getBBO, getMidpoint, getPrices, getPriceHistory, getOpenOrders, getOrder, estimateMarketPrice, fetchOrderScoring, fetchOrdersScoring. MCP: fetch_order_book, fetch_midpoint, fetch_price, fetch_spread, get_farmability (book + rewards + competitionSignal + mids + score), watch_order_until_filled, get_order_scoring_status.
- listOpenOrders, listAccountTrades. MCP via list_activity or dedicated.

**Portfolio & Positions**
- getPositions, listPositions (open/closed), getPortfolio, getActivity (trades/rebates/transfers), getTrades, getTransfers. MCP: list_positions, list_closed_positions, fetch_portfolio_value, list_activity (rich cards with rebates/PnL), get_farmability.

**Account Management**
- createOrDeriveApiKey, fetchApiKeys, deleteApiKey, getProfile, updateProfile, getLeaderboards (builder/trader), listComments, postComment, fetchPublicProfile, listBuilderLeaderboard, listBuilderTrades, listBuilderVolume. MCP: some via Advanced or Account category (list_builder_leaderboard exposed); get_profile etc via get_tools_by_category("Account") if thin-wrapped or use list_activity + resources for most agent needs.

**Wallet / Onchain (Advanced or direct)**
- approveToken, deployDepositWallet, getDepositWallet, isGaslessReady, waitForGaslessTransaction, setupTradingApprovals (idempotent), split/merge/redeem (via prepare or onchain CTF tools). MCP: get_balance_allowance, approve_erc20, approve_erc1155_for_all, setup_trading_approvals, setup_gasless_wallet (compat), split_position, merge_positions, redeem_positions, prepare_* (Advanced), send_transaction (very sensitive). Latest SDK: deposit wallet default in createSecureClient.

**Rewards & Subscriptions**
- getRewards / listCurrentRewards / listMarketRewards / claimRewards, listSubscriptions, subscribe/unsubscribe. MCP: list_active_maker_reward_markets (enriched primary), list_current_rewards (raw), get_farmability, reward place tools; subscriptions bridged to resources.

**Builders / Relayer / Data / Transfers**
- builder fee/volume/leaderboard actions, remote signing. MCP: list_builder_* tools + builder attribution in config examples (the one labeled "recommended Relayer setup").
- Full historical via list_activity / resources.
- initiateTransfer etc via onchain tools.

**Sports / other**
- listSports, fetchSportsMarketTypes — MCP Discovery or list_events + search; add thin MCP wrappers in future categories for completeness.

### Decorators (High-level; attached after .extend(allActions))
Public: discovery (listMarkets etc), data/analytics (positions, volume, holders), account (public), rewards (public), subscriptions.
Secure: all above + trading (place/cancel), wallet (gasless, deposit, approvals), account (full keys/profile), rewards (claim).
MCP: calls the decorated methods under the hood (e.g. sec.placeLimitOrder), returns formatted cards + agentDirective. For raw access use Advanced category tools.

Usage in SDK (ref only): const client = createSecureClient({...}).extend(allActions); await client.listMarkets(...); await client.placeLimitOrder(...);

### WebSockets (Real-time; MCP bridges, never direct subscribe in agent loops)
SDK provides subscribe() on client (market/user/sports/rtds specs) returning async iterable + handle.
Managers (internal in current beta): ClobMarketWebSocketManager (books), ClobUserWebSocketManager (orders/fills/positions), RtdsWebSocketManager, SportsWebSocketManager. Public + auth variants.
MCP: auto ReconnectingSubscription + resource manager. Subscribe/read via MCP resources protocol:
- polymarket://market/{tokenId}/book (live bids/asks + updates)
- polymarket://user/orders , /fills , /positions , /portfolio , /activity
- polymarket://order/{orderId}/fill-status (auto-started on every place_*)
Call list_resources, read_resource, subscribe on the MCP server. Server pushes notifications. Prefer over polling.

### Wallet Integration
- viem: privateKey(pk) from @polymarket/client/viem (MCP default for signer).
- ethers-v5, privy adapters via subpaths.
- resolveAccountIdentity, deposit wallet derivation (getDepositWallet), Safe/proxy via builder.
MCP: supply EOA_PRIVATE_KEY + DEPOSIT_WALLET_ADDRESS at startup; gasless via setup_gasless_wallet tool.

### Types (re-exported from bindings + local)
Market (with outcomes, clobTokenIds, tokens, rewards), Event, Order, OrderBook, Position, Paginated, OrderSide/Buy/Sell, OrderType (GTC etc), TimeInForce, SignatureType, ActivityType (incl rebates), all Request/Response for every action, WS message types, errors with isError guards.
MCP cards (formatMarket etc) normalize these + add Yes/No TokenId, health, sentiment (bias/skew), farmabilityScore, PnL status, agentDirective.

### Low-Level
Direct ServiceClient for uncovered endpoints.
ABIs (USDC, ConditionalTokens, collateral adapters).
RPC utils, auth flows (HMAC via buildHmacSignature + relayerApiKey/remoteBuilderSigning helpers).
MCP Advanced category for prepare/sign/send/raw tx where needed. Most agents never need (use place_*/approve_* tools).

**MCP value-adds for the full surface**: rich cards never raw SDK, tokenId resolver everywhere, strategyStore as your brain (persist all filters/exits/requote policy), get_mcp_usage for tracking your calls, live resources for WS, rate protection + directives, no bloat (load categories + prompts first), explicit only.

See also the SDK README for examples/patterns. MCP keeps its mcp_llms_full_guide + this in sync at call-time.

### External Free UK Weather Data (multi-API fallbacks, native tools for agents + heartbeat)
Use completely free/no-key (Open-Meteo primary, pulls UK Met Office UKV 2km high-res for UK + global models) + other free-tier APIs (OpenWeatherMap, Visual Crossing, WeatherAPI) as fallbacks on rate limit/error.
- No cost for non-commercial (Open-Meteo: 10k calls/day free, no key; others free tiers ~1k/day with key).
- Supports forecast (hourly/daily temp, precip, cloud, wind etc.), historical (1940+), current.
- Resolve UK cities (London, Manchester, Birmingham, Edinburgh etc.) or lat,lon.
- Native MCP tools (load via list_tool_categories + get_tools_by_category("Weather")).
- Use with WEATHER category markets for mispricing (compare forecast to market prices via fetch_market + bayesian or strategy).
- Heartbeat enhancement: X signals + live weather data for real leads (e.g. X rain hype but forecast dry → signal).
- Cache 15min, rate protected, attribution in cards.
- If one rate limited: auto fallback to next provider.
- Example: get_uk_weather_forecast({city: "London", days: 7}) → card with data. Then cross with list_markets({category: "WEATHER"}).

MCP tools added (native, public, Weather category):
- get_uk_weather_forecast({city: "London" | "51.5,-0.12", days?, variables?})
- get_uk_weather_historical({city, start_date, end_date, variables?})
- get_uk_weather_current({city, variables?})
Providers (fallback order, first with key or no-key): OpenMeteo (no key, UKMO UKV), OpenWeatherMap (env OPENWEATHERMAP_API_KEY), VisualCrossing (VISUALCROSSING_API_KEY), WeatherAPI (WEATHERAPI_KEY). All free tiers/no-cost for base use. See formatWeather cards.

See exhaustive SDK section for pattern. Update your strategy with weather rules for edge.

## Official Platform Concepts (condensed legacy mappings — prefer the exhaustive section above) — Exact MCP Native Mappings

### Markets & Events (Fetching, Discovery)
- list_markets(...) — see exhaustive above. MCP primary.
- fetch_market({tokenId support via resolver}) — see above.
- list_events, search, list_tags etc — MCP Discovery tools + search; use list_events({category}) for sports/weather.

(For positions/trading/rewards etc details see the exhaustive SDK coverage section above + MCP tool descriptions in categories. The mappings below are legacy/condensed; the structure at top of this guide is authoritative.)

### Activity, Portfolio, Notifications (condensed)
- list_activity, list_positions, fetch_portfolio_value, fetch_notifications — use MCP list_activity / list_positions / fetch_portfolio_value + user/* resources.

### Onchain / Gasless / Approvals / Relayer (condensed)
- See exhaustive "Wallet / Onchain" and "Advanced" category tools. Use setup_gasless_wallet, setup_trading_approvals, approve_*, split/merge/redeem, prepare_* .

### Analytics, Profiles, Misc (condensed)
- list_builder_leaderboard etc available via Discovery/Account category tools or search. format* cards always.

## Prompts (Call via prompts/get — Your On-Demand .MD Guidance)
- mcp_llms_full_guide (this — the full concepts-to-tools mapping, refreshed from code)
- mcp_tool_structure_and_categories (MANDATORY quickstart + exact patterns + clob/tokenId + public rules + strategy as brain)
- reward_farming_best_practices (X insights + full native farming framework + exit rules)
- mispricing_quick_flips (bayesian + quick edge flows)

## Strategy Store (Your Brain — Single Source of Truth, No Bloat)
get_strategies() (no args) returns everything.
update_strategy({key: "rules:current_farming", quoteNearMid: true, bothSides: true, maxSpreadRatio:0.6, liquidityMin:50000, exitOnAdverse: true, preferredCategories: ["CRYPTO"], mySizePolicy: {...}, ... })
set_strategy for full replace, clear_strategy.
Store: all filters, TP/SL, event prefs, scoring, 24/7, reprice rules, custom "best" logic. Evolve it yourself. Persist long-term externally if needed (MCP in-mem only).

## Resources (Live Data - Prefer Over Poll)
list_resources / read_resource / subscribe / unsubscribe.
- polymarket://market/{tokenId}/book (live orderbook + updates)
- polymarket://user/orders , /positions , /portfolio , /activity , /fills
- polymarket://order/{orderId}/fill-status (auto from place responses)
- polymarket://mcp/llms.txt (this guide as markdown resource)
Server pushes notifications on change. Read gives formatted cards.

MCP surface activities/usage (tool calls by agents) are tracked internally via get_mcp_usage tool (call counts, last used, total since start). Platform-side activities and "usage" (trades, MAKER_REBATE, rewards, etc.) via list_activity + live user/activity resource + earnings tools.

### Rate Limits & Session Management (from llms.txt + api-ref/rate-limits, trade/send-heartbeat, matching-engine)
Official: https://docs.polymarket.com/api-reference/rate-limits.md , trade/send-heartbeat.md , matching-engine.md , error-codes.
- All limits are Cloudflare-enforced: exceeding causes *throttling/queuing* (added latency, e.g. place 400ms+) rather than immediate 429 in many cases. Per-account effects possible for heavy requoting.
- POST /order burst ~5k/10s, sustained lower; general CLOB 9k/10s etc. (check live with tools if needed).
- Use \`wait_seconds\` (core tool) between mutations. Our get_mcp_usage helps monitor your own call rates.
- Send heartbeat (to keep session, prevent auto-cancel of open orders): use the \`send_heartbeat\` tool if exposed, or rely on SDK WS client internals + long-lived MCP.
- Matching engine restarts: expect 425 "Too Early", post-only mode (use postOnly: true), cancel-only. Handle with backoff + our agentDirectives.
- In strategyStore: track your rates, e.g. "myCallRate": {...}, backoff on slow places (see CLOB v2 requoting note).

## Best Practices & Public Rules (Never Guess)
- Startup seq + get_strategies() first every autonomous loop.
- Categories + prompts for discovery/guidance (keeps context tiny).
- Native only: official SDK via the mapped tools. No direct HTTP, no reverse eng, no intent.
- For trading: explicit place_* with numbers from your calc or strategy. suggest only for rewards policy.
- Follow agentDirectives exactly (e.g. on rate limit or fail: "immediately try different market from list_active").
- Rate: wait_seconds between mutations.
- Public MCP: This repo/MCP is public. Supply your own EOA_PRIVATE_KEY + DEPOSIT_WALLET_ADDRESS (and at least one of RELAYER_* or BUILDER_*). Code errors without. Docs/examples use 0xYOUR_... only. The one labeled "this project's recommended Relayer setup" block in README is the exception for the known-working attribution example — do not copy as default.
- Output cards: All responses formatted (formatMarket with bias/sentiment + liquidity health, formatPosition with full PnL est+total+status+health, formatActivity with rebates, formatActiveRewardMarket, formatFarmability with health/score/sentiment signals, formatPnlSummary). Print directly. Enhanced for PNL (realized/cash + est), sentiment/liquidity health (spreads, depth, skew, competitionSignal).
- No guessing: If unsure, re-call the llms guide prompt + structure prompt + get_strategies + relevant category. The combination of AGENTS.md (for code agents), these prompts, categories, strategyStore, agentDirectives, and rich tool descs = zero ambiguity.

## Full Tool Surface (Discover at Runtime)
Use list_tool_categories + get_tools_by_category("Rewards" | "Trading" | "Weather" | ...). Schemas + descriptions in protocol are authoritative + include native notes (clobTokenIds, tokenId resolution, warnings on Advanced). Weather category: free UK APIs (Open-Meteo etc) for forecasts etc.

See also AGENTS.md in repo root for code maintainers (research reqs, no hardcodes, no test files in tree, source split recs for bloat prevention, etc.).

This guide is generated at call time from the live PROMPTS + tool defs + categories in src/mcp.ts (and formatters for cards). It links the SDK README (https://github.com/Polymarket/ts-sdk/blob/main/README.md) as the base instructions + adds MCP mappings (full exhaustive surface covered above). Call the prompt again after updates to refresh. See the SDK README + https://github.com/Polymarket/ts-sdk (and its PRs) for underlying native behaviors.

For code changes: follow AGENTS.md mandatory reads + research + pre-commit /review subagent + build + stdio load test (use /tmp only for temps). Never commit hardcodes or test files.

`;

  md += "\n\n## Current Categories (runtime authoritative via list_tool_categories)\nRewards | Strategy | Account | Utilities | Discovery | Trading | Analytics | Weather (free UK multi-API forecasts/historical/current with fallbacks) | Meta (get_mcp_usage for MCP activities/usage tracking) | Advanced\n\n## Notes\n- Tools/prompts evolve; always refresh via prompts/get and categories for latest.\n- Base SDK reference (all concepts, APIs, examples — use this as primary agent instructions): https://github.com/Polymarket/ts-sdk/blob/main/README.md (kept up-to-date by the maintainers; MCP uses the SDK exclusively).\n- This MCP mapping (full exhaustive SDK surface) ensures native use without ever guessing which tool or arg shape (SDK README first + these MCP overlays).";
  return md;
}
