# MCP Server – Technical Overview

**Purpose**  
This is a production-grade Model Context Protocol (MCP) server that exposes CLOB prediction market platform functionality to AI agents and LLM-powered applications (Hermes, OpenClaw, and similar agent frameworks).

It is designed so that agents can discover markets, place and manage orders, monitor positions, and interact with on-chain CTF actions **natively through the MCP protocol**, without the agent needing to understand or directly call the official SDK.

---

## Core Design Principles

- **Agent-first output**: Every tool returns clean, structured, human- and LLM-readable data. Raw SDK responses are never passed through.
- **Official SDK only**: All blockchain and API interactions go exclusively through the official `@polymarket/client` SDK (beta). No custom HTTP clients or reverse-engineered endpoints.
- **Clear separation of public vs authenticated surfaces**.
- **Live data via MCP Resources**: Order books, user orders/fills, positions, and portfolio support real-time subscriptions using WebSocket bridging from the platform.
- **Safety and formatting by default**: Tools include helpful descriptions, validation schemas, and consistent formatting (prices shown as both decimal and percentage, status emojis, truncated addresses, direct Polygonscan links, etc.).

---

## High-Level Capabilities

### 1. Public Market Data (Gamma + Discovery)
- Market, event, and series discovery (including closed markets)
- Search across markets and events
- Tags, sports, teams, and market metadata
- Order books, prices, midpoints, spreads, and price history
- Recent trades and trade estimates
- Builder/trader leaderboards and public profiles
- Rewards and earnings data (view-only)
- Live volume and open interest

### 2. Trading & Order Management (Authenticated)
- Place limit and market orders (with full control over order types: GTC, GTD, FOK, FAK, postOnly)
- Cancel single orders, multiple orders, market-specific orders, or all open orders
- Gasless trading support (where available)
- Order scoring and execution parameter helpers

### 3. Account & Portfolio (Authenticated)
- Current positions (open + closed/resolved)
- Portfolio value
- Recent account activity
- Historical account trades

### 4. On-Chain CTF Actions (Authenticated)
- Split collateral into outcome tokens
- Merge outcome tokens back to collateral
- Redeem resolved positions
- Trading approvals (ERC20 + CTF setApprovalForAll)
- Balance allowance updates

### 5. Live Subscriptions (MCP Resources)
The server bridges platform WebSocket feeds to the MCP Resources system, allowing agents to subscribe to:
- Real-time order books per outcome token
- User order and fill streams
- Position and portfolio updates
- Account activity

When subscribed data changes, the server notifies the agent, which can then read the latest formatted snapshot.

---

## Authentication Model

- **Public tools** require no credentials (market discovery, pricing, order books, etc.).
- **Authenticated tools** require two environment variables supplied by the agent host at process startup:
  - `EOA_PRIVATE_KEY`
  - `DEPOSIT_WALLET_ADDRESS`
- The server performs alias normalization so agent configurations can use the clearer names above while remaining compatible with the underlying SDK expectations.
- No credentials are ever logged or returned in tool responses.

---

## Technology & Architecture

- **Language**: TypeScript (Node.js ≥ 22)
- **Core dependency**: Official `@polymarket/client` (beta) SDK only
- **MCP Implementation**: `@modelcontextprotocol/sdk` (stdio transport)
- **Real-time**: Native WebSocket subscriptions from the SDK, bridged to MCP `resources/subscribe`
- **Output formatting**: Dedicated formatter layer that converts SDK responses into consistent, agent-ready structures before returning them
- **Process model**: Long-lived stdio child process managed by the agent host

---

## Tool Surface

The server is deliberately **lightweight** for agents:

| Layer | Mechanism | Size |
|-------|-----------|------|
| Tier-1 | Default `tools/list` on connect | **31** daily-driver tools (`src/mcp/agent-meta.ts` → `TIER1_CORE_TOOL_NAMES`) |
| Full | `load_agent_profile({ profile })` or `get_tools_by_category({ category })`, then `tools/list` again | **142** handlers implemented; zero removed |

Meta tools: `get_agent_recipes`, `search_tools`, `load_agent_profile`, `list_tool_categories`, `get_tools_by_category`, `get_mcp_usage`.

Primary discovery: `discover_topic({ topic })` (maps topic → SDK `tagSlug`/`tagId`). Power-user: `list_events` / `list_markets` with explicit tag fields.

**What consuming agents change (runtime, in-memory per MCP process):**
- **Strategy store** — `get_strategies` / `set_strategy` / `update_strategy` / `clear_strategy` holds all evolved rules (filters, farming, requote caps). The MCP does not hardcode agent strategy in source.
- **Session tool exposure** — profiles/categories add tool names to `currentlyExposedToolNames`; hosts should re-call `tools/list` after loading more.

**Prompts (5):** `agent_routing` (call first), `mcp_tool_structure_and_categories`, `mcp_llms_full_guide`, `reward_farming_best_practices`, `mispricing_quick_flips`. Live text also at `polymarket://mcp/llms.txt`.

**Not registered:** `run_autonomous_trading_cycle` and similar stub names from old branches — use explicit tools + strategy store loops.

Tools are split into public discovery/data (no auth) and authenticated trading/account/on-chain. All follow MCP `tools/list` + `tools/call` with JSON Schema descriptions. Responses are formatted cards only (never raw SDK payloads).

**Resource note:** `polymarket://markets` is a first-page snapshot (~20 markets), not a full enumerator.

---

## Intended Usage Pattern

This MCP is intended to be registered with agent runtimes (e.g. via `hermes mcp add` or equivalent in other frameworks). Once registered:

1. The agent host spawns the MCP server with the required environment variables.
2. The agent performs the standard MCP handshake (`initialize`, `tools/list`, `resources/list`).
3. The LLM can then call tools and subscribe to resources exactly like any other MCP server.
4. All responses are pre-formatted so the agent can display or reason over them directly.

---

## Scope & Non-Goals

- This server is a **tooling and integration layer**, not a trading bot or strategy engine (although it contains some example strategy code for reference).
- It does **not** implement its own order matching, risk engine, or custody.
- Default `tools/list` is tier-1 only; the full SDK-aligned surface (~142 tools) is available on demand via profiles/categories. Low-level [Advanced] tools load separately.
- It is not a general-purpose platform REST or WebSocket client.

---

## Recent agent-surface fixes (Jun 2026)

Shipped in source (`src/mcp.ts`, `src/mcp/agent-meta.ts`, `src/trading/place-limit-args.ts`, `src/utils/clob-token.ts`, `src/intelligence/*`). Verify after `npm run build` with `grok mcp doctor alphamcp` (Grok Build / CLI).

```
┌──────────────────────────┬────────┬───────────────────────────────────────────────────────────────────────────────────────┐
│ Request                  │ Status │ What shipped                                                                          │
├──────────────────────────┼────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ place_limit_order schema │ Fixed  │ Schema includes orderType (GTC/GTD/FOK/FAK) and postOnly; handler uses                │
│ + orderType / postOnly   │        │ buildPlaceLimitOrderArgs() (GTC omitted on wire, postOnly defaults true, GTD gets     │
│                          │        │ expiration).                                                                          │
├──────────────────────────┼────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ get_farmability slug /   │ Fixed  │ MARKET_TOKEN_REF_PROPERTIES + resolveClobTokenId() in src/utils/clob-token.ts;        │
│ decimal ID               │        │ handler calls resolveTokenIdFromToolArgs(). listMarketRewards uses real conditionId ( │
│                          │        │ not tokenId).                                                                         │
├──────────────────────────┼────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ get_order_book / get_    │ Fixed  │ Dedicated tier-1 tools; handlers share cases with fetch_* and resolve slug/decimal    │
│ spread                   │        │ before CLOB calls.                                                                    │
├──────────────────────────┼────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ Better alpha_report      │ Fixed  │ Default 45–55¢ band, liquidity/volume filters, mid-band ranking bonus,                │
│                          │        │ confidenceScore + actionability; tier-1 alpha_report alias → same handler as generate │
│                          │        │ _alpha_report.                                                                        │
├──────────────────────────┼────────┼───────────────────────────────────────────────────────────────────────────────────────┤
│ place_optimized_reward   │ Fixed  │ Tier-1 in agent-meta.ts; schema uses MARKET_TOKEN_REF_PROPERTIES; handler resolves    │
│ _order exposed           │        │ slug/decimal then suggest → validate → postOnly place.                                │
└──────────────────────────┴────────┴───────────────────────────────────────────────────────────────────────────────────────┘
```

## Known pitfalls (agents — `get_agent_recipes.knownGotchas` + prompts)

| Symptom | SDK-correct fix |
|--------|------------------|
| `get_farmability` Unavailable on non-reward markets | Pass hex, slug, or decimal id; non-reward → book-only (`fetchOrderBook` + `fetchMidpoint`). Rewards → `list_active_maker_reward_markets` first. |
| `orderType` rejected on `place_limit_order` | SDK `placeLimitOrder` has no `orderType`; GTC default, GTD = `expiration`. FOK/FAK → `place_market_order`. |
| `alpha_report` Unavailable / score 0 | Scores are 0–100 only; low = weak/skip. Relax filters or use `goal:"rewards"`. |
| `get_strategies` count 0 | Auto-seeds on first `get_strategies` or `load_agent_profile`; then `update_strategy`. |
| No order book tool | Tier-1 `get_order_book` / `get_spread` → SDK `fetchOrderBook` / `fetchSpread`. |

**Notes**

- `place_limit_order` still requires a hex `tokenId`; slug/decimal resolution applies to `get_farmability`, `get_order_book`, `get_spread`, and `place_optimized_reward_order` (use `fetch_market` first for raw limit places).
- Some tokens return “No orderbook exists” from the CLOB; handlers return structured JSON + `agentDirective` instead of crashing.
- MCP host config for this repo: `.grok/config.toml` only (see `.gitignore` for excluded Cursor/generic JSON).

---

## Current Status (High Level)

- Production orders and on-chain CTF actions have been executed successfully through the server.
- Strong emphasis on reliable stdio behavior (important for long-running agent sessions).
- Designed and tested primarily with Hermes and similar agent frameworks.
- All data transformations aim to make responses immediately usable by LLMs without additional parsing.

---

**Contact / Questions**  
For technical questions about this integration or the exposed surface, please reach out with specific areas of interest (tool schemas, subscription behavior, formatting conventions, etc.).

This document is intentionally high-level and contains no secrets, private keys, wallet addresses, or internal implementation details.
