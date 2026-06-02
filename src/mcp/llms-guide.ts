// src/mcp/llms-guide.ts
// Call-time delivered non-stale .md style guide for agents (llms.txt inspired).
// We DID use https://docs.polymarket.com/llms.txt : its curated .md index structure and list of official concepts (Markets & Events, Order Lifecycle, Positions & Tokens, Prices & Orderbook, Rewards/Maker Rebates, Trading, Clients/SDKs, Rate Limits, Error Codes, Matching Engine, etc.) was the direct basis/template for the section "## Official Polymarket Concepts (from llms.txt + linked .md) — Exact MCP Native Mappings".
// How added to the MCP (instead of stale .MD files):
// - Dedicated src/mcp/llms-guide.ts with buildMcpLlmsGuide() that produces full .MD at *runtime* (call-time, so never stale).
// - Registered as MCP Prompt "mcp_llms_full_guide" (agents do prompts/get) and Resource "polymarket://mcp/llms.txt" (agents list/read_resource/subscribe).
// - The content does NOT copy the link list (that would stale); instead, it provides rich, MCP-specific mappings: for each official concept, the exact native tool(s) + JSON call shape + "use explicit place_* , never intent" warnings + cross to strategyStore, resources, cards, get_mcp_usage for tracking.
// - Imported in mcp.ts (for PROMPTS + GetPrompt dispatch + build) and resources.ts (for the URI handler).
// - Heavily referenced/required in AGENTS.md (mandatory reads), mcp_tool_structure_and_categories prompt, README, etc. Agents told to load it first.
// - Categories list moved to be exported from here and used by runtime list_tool_categories for sync.
// - Updated for no-intent trading, CLOB v2 requoting, usage tracking, etc.
// This gives agents the "how to use the MCP without ever guessing" in official .MD style, using only native SDK explicit calls.

export const MCP_CATEGORIES = [
  'Rewards',
  'Strategy',
  'Account',
  'Utilities',
  'Discovery',
  'Trading',
  'Analytics',
  'Meta',       // get_mcp_usage for MCP activities/usage tracking
  'Advanced'    // Low-level, security-sensitive, prepare workflows.
];

export function buildMcpLlmsGuide(): string {
  // Built at call time (prompts/get or the mcp/llms.txt resource) to avoid stale committed .MD files.
  // Content curated + kept in sync with the MCP (tool patterns, cards, strategy, public rules, explicit native calls) + rich mappings from official llms.txt concepts.
  // Not a fully auto-iterated dump of arrays (the value is the explanatory "how to use without guessing" + exact JSON examples + no-intent rules).
  // Inspired by https://docs.polymarket.com/llms.txt (the official LLM-curated index of .md docs for concepts/trading/rewards/orderbook/etc).
  // This MCP version gives the *usage mapping*: "for this official concept, call these exact MCP tools with these args".
  // Load this + mcp_tool_structure_and_categories at startup. Then use categories + get_strategies().
  // All via official @polymarket/client SDK only. Never guess. Never use intent for trading.

  let md = `# Polymarket MCP Server - Full Agent Guide (llms.txt style)

This MCP is **lightweight and agent-first** for Polymarket (prediction markets on Polygon via CLOB + CTF).
**Core principle**: Tiny default tool surface (~10 core tools via CORE_TOOL_NAMES). Use categories + prompts to discover/load more. 
**Agents must never guess**: Always start with the mandatory sequence below. All your logic/rules/filters/exits in strategy store (get_strategies first every loop). Use only native SDK paths via these explicit tools. Follow every agentDirective. Public: always provide your own keys (no defaults/hardcodes anywhere in this MCP or docs).

**Why llms.txt style?** Official https://docs.polymarket.com/llms.txt provides a clean index of .md docs (concepts, trading/ , rewards/ , market-makers/ , api-ref etc). Instead of stale local MDs, this prompt + the MCP resource polymarket://mcp/llms.txt delivers a living, code-synced mapping so consuming agents have zero ambiguity on "how do I do X natively in this MCP".

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

## Official Polymarket Concepts (from llms.txt + linked .md) — Exact MCP Native Mappings

### Markets & Events (Fetching, Discovery)
Official: https://docs.polymarket.com/concepts/markets-events.md , market-data/ , api-ref/markets/* , events/*
- list_markets({ closed?, active?, clobTokenIds?: string[], rewardsMinSize?, volumeNumMin?, liquidityNumMin?, tagSlug?, search?, pageSize? }) — supports direct clobTokenIds array filter (native).
- fetch_market({ id? | slug? | url? | tokenId: "0x..." }) — **tokenId support added in MCP**: internally does listMarkets({ clobTokenIds: [tokenId], pageSize:1 }) + first because official SDK fetchMarket() only accepts {id, slug, url} (no tokenId param). Confirmed via ts-sdk source + recent PRs (e.g. #78 tag/series normalization did not add tokenId to fetchMarket; list clob filter is the way).
- list_events({ category?, ... }), fetch_event({id|slug}).
- search({q}).
- list_tags, fetch_tag, list_series, fetch_series, get_event_tags, etc.
- For token from rewards/activity: always resolve via fetch_market({tokenId}) or list_markets({clobTokenIds}).

Use after: getMarket in resources also supports tokenId now for polymarket://market/{tokenId}.

### Positions & Tokens (CTF mechanics)
Official: https://docs.polymarket.com/concepts/positions-tokens.md , trading/ctf/* , api-ref/core/*
- list_positions(), list_closed_positions() — returns formatPosition cards with 'Cash PnL', 'Realized PnL', 'Current Value', avg/cur prices, redeemable/mergeable.
- list_market_positions({conditionId}), get_positions_for_market.
- Onchain: split_position({conditionId, amount}), merge_positions, redeem_positions (after approvals via setup_trading_approvals or prepare_*).
- formatPosition / formatClosedPosition / formatMarketPosition already surface PnL fields + health (redeemable etc). Enhanced cards now include more sentiment/liquidity health signals.

**PNL in cards**: Positions return realized + cash PnL. For unrealized est use currentValue vs entry cost (size*avgPrice). List activity for trade history contributing to PnL.

### Prices, Orderbook, Spreads, Market Data (for Sentiment/Health)
Official: https://docs.polymarket.com/concepts/prices-orderbook.md , market-data/* (get-midpoint, get-order-book, get-spread, get-last-trade-prices, get-fee-rate, tick-size, history, ws channels)
- fetch_order_book({tokenId}), fetch_price({tokenId, side}), fetch_midpoint({tokenId}), fetch_spread({tokenId}), fetch_spreads({tokenIds}), fetch_last_trade_price etc.
- fetch_price_history({tokenId, ...}).
- Resources for live: polymarket://market/{tokenId}/book (real WS bridged, subscribe/read).
- Market Channel / User Channel WS via MCP resources (no polling).

**Sentiment / Health from cards**: formatMarket + get_farmability + formatOrderBook now emphasize:
- Tight spread + good depth = "healthy liquid" (low slippage, good for size).
- Book imbalance (from get_farmability depth calc) + volume = short-term flow sentiment.
- Yes/No price skew (in formatMarket bias) + recent vol as proxy for crowd sentiment.
- Use for entry: only farm/trade when spreadVsMaxAllowed low + competitionSignal favorable.
- Live books via resource give real-time imbalance for adverse selection avoidance.

### Order Lifecycle & Trading (CLOB native - EXPLICIT ONLY)
Official: https://docs.polymarket.com/concepts/order-lifecycle.md , trading/orders/* (create, cancel, overview), trading/quickstart.md , trading/fees.md , trading/orderbook.md
- **Always explicit tool calls. No intent, no "trade for me", no high-level wrappers for core CLOB trading.**
  - place_limit_order({ tokenId, price, size, side: 'BUY'|'SELL', orderType?: 'GTC'|'GTD'|'FOK'|'FAK', postOnly?: boolean, ... })
  - place_market_order({ tokenId, amount, side, ... })
  - create_and_post_order (for advanced).
  - For **maker rewards only**: place_maker_reward_order({tokenId, price, size?}) or place_optimized_reward_order — these force GTC+postOnly + scoring checks. Native sticky edge.
- Cancel: cancel_order({orderId}), cancel_orders({orderIds}), cancel_orders_for_market({market}), cancel_all_orders().
- list_open_orders(), fetch_order({id}), list_account_trades(), watch_order_until_filled({orderId}).
- get_order_scoring_status({orderId}) — check if scoring rewards (GTC postOnly needed).
- Resources: polymarket://user/orders , /order/{id}/fill-status , /user/fills (subscribe for push).

**Trading rules (never guess)**: 
- For pure trading (directional/mispricing): YOU (via your strategy rules or calc) decide size/price/side then call place_limit_order directly with numbers. suggest_qualified_size is advisory (used mainly with intent="reward_farming" or "maker" or "quick_flip" for policy).
- Use postOnly + GTC for maker (cheaper fees + rewards eligibility).
- Always check get_farmability or book first for liquidity/slippage (sentiment proxy).
- Rate discipline: wait_seconds({seconds:4-8, reason:"after order to respect CLOB limits"}) .
- Gasless: use Relayer strategy in env + prepare_* (Advanced) or the higher place_ that support it.
- Attribution: builder/relayer keys for volume credit (your keys).

See also: trading/clients/* (L2 for orders, public for data).

### Rewards, Earnings, Maker Rebates, Liquidity Programs
Official: https://docs.polymarket.com/market-makers/* (overview, liquidity-rewards, maker-rebates.md , getting-started), api-ref/rewards/* , trading/taker-rebates.md , get-current-rebated-fees etc.
- Primary discovery (lightweight, agent-optimized, not raw): list_active_maker_reward_markets({maxMinCostUsd?, maxMinSize?, maxResults?}) — tiny ranked (max 8), with yes/noTokenId, real USD qualify cost (minSize*mid), mids, dailyRate, volume/liquidity, attractiveness. Filter by your strategy caps. Per X: low minSize + decent rate + not near resolve.
- get_farmability({tokenId}) — SDK-native (book + rewards + spreads): returns currentMid, spread, spreadVsMaxAllowed, costToQualifyUsd, suggestedNearMidBuy/Sell (quote near mid for weighting), competitionSignal (thin/moderate/deep + imbalance), farmabilityScore (0-100), recommendation. Use as pre-check + sentiment (low comp = opportunity).
- place_maker_reward_order / place_optimized... (the only ones that guarantee postOnly for scoring).
- validate_for_maker_rewards, suggest_reward_order_parameters (advisory).
- Earnings: list_user_earnings_for_day, fetch_reward_percentages, fetch_total_earnings..., formatRewardEarnings etc (compact versions preferred).
- Rebates surface automatically in list_activity (types MAKER_REBATE, REWARD etc) via formatActivity — Amount + details.
- list_current_rewards / list_market_rewards are RAW (large) — docs steer agents to list_active... + get_farmability instead for autonomy.
- Other: get_current_rebated_fees_for_maker.

**Farming loop (native, no guess)**: get_strategies() → list_active... (your filters from strategy) → get_farmability(token) → suggest_qualified_size({intent:"reward_farming", ...}) → update_strategy (log, including your requote throttling) → place_maker... (batch with post_orders when doing multiple) → resources watch or list_open + reprice *only per your conservative drift/interval rules* (CLOB V2 place-path contention: 200+/sec requotes on one account reliably causes 400ms+ place latency even with no 429s; cancels are lighter; use WS + get_farmability signals, wait_seconds, max ~5-20/sec per side via strategy policy) → exit or rotate per your stored rules. Follow directives.

**CLOB V2 requoting note**: Heavy requoting for "sticky" rewards can trigger server-side queuing on the place path (per-wallet, cross-IP for same account). Design your strategy rules (max rate, drift threshold, batching) to avoid it while still earning. See reward_farming_best_practices prompt for details.

### Activity, Portfolio, Notifications
- list_activity({limit?}) — full lifecycle + now rebates (MAKER_REBATE etc). formatActivity gives Type, Amount, Side, Price, Title.
- list_positions + fetch_portfolio_value.
- fetch_notifications, drop_notifications.

### Onchain / Gasless / Approvals / Relayer
Official: trading/gasless.md , trading/bridge/* , relayer/* , deposit-wallets.md
- CTF: split/merge/redeem (require prior approvals).
- Approvals: setup_trading_approvals() (one-call for ERC20 + CTF), or specific approve_erc20 / approve_erc1155_for_all.
- enable_auto_redeem note: it's a contract approval (setup includes).
- Gasless flows: prepare_* (Advanced) then execute, or Relayer auth path.
- Relayer: submit via keys, get nonce etc (Advanced or via higher tools).
- Builder: list_builder_trades, list_builder_leaderboard for attribution credit.

### Analytics, Profiles, Misc
- list_builder_leaderboard, fetch_public_profile, trader leaderboards (some have PnL), get_open_interest, get_live_volume_for_event, comments, holders, top holders.
- format* cards for all (never raw).

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

MCP surface activities/usage (tool calls by agents) are tracked internally via get_mcp_usage tool (call counts, last used, total since start). Polymarket-side activities and "usage" (trades, MAKER_REBATE, rewards, etc.) via list_activity + live user/activity resource + earnings tools.

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
Use list_tool_categories + get_tools_by_category("Rewards" | "Trading" | ...). Schemas + descriptions in protocol are authoritative + include native notes (clobTokenIds, tokenId resolution, warnings on Advanced).

See also AGENTS.md in repo root for code maintainers (research reqs, no hardcodes, no test files in tree, source split recs for bloat prevention, etc.).

This guide is generated at call time from the live PROMPTS + tool defs + categories in src/mcp.ts (and formatters for cards). Call the prompt again after updates to refresh. See https://github.com/Polymarket/ts-sdk (and its PRs) for underlying native behaviors.

For code changes: follow AGENTS.md mandatory reads + research + pre-commit /review subagent + build + stdio load test (use /tmp only for temps). Never commit hardcodes or test files.

`;

  md += "\n\n## Current Categories (runtime authoritative via list_tool_categories)\nRewards | Strategy | Account | Utilities | Discovery | Trading | Analytics | Meta (get_mcp_usage for MCP activities/usage tracking) | Advanced\n\n## Notes\n- Tools/prompts evolve; always refresh via prompts/get and categories for latest.\n- Official reference: https://docs.polymarket.com/llms.txt + linked .md (concepts, trading/*, market-makers/*, rewards api etc).\n- This MCP mapping ensures native use without ever guessing which tool or arg shape.";
  return md;
}
