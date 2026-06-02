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

The server is deliberately **lightweight** (tiny core set of ~10 tools advertised by default via tools/list, plus `list_tool_categories` + `get_tools_by_category` for on-demand discovery of the full surface) plus a full set of Resources and Resource Templates.

Tools are split into:
- Public discovery / data tools (no auth)
- Authenticated trading, account, and on-chain action tools

All tools follow the standard MCP `tools/list` + `tools/call` pattern and include rich JSON Schema descriptions.

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
- It deliberately does **not** expose every low-level method of the underlying SDK. The surface is intentionally curated for agent usability and safety.
- It is not a general-purpose platform REST or WebSocket client.

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
