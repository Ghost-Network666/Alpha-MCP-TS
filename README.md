# Polymarket MCP Server

## What this MCP does

This is a Polymarket MCP server designed to work natively with **Hermes** (https://hermes-agent.nousresearch.com/), OpenClaw, and other agent harnesses.

It exposes **90+ tools** + a complete **Resources + Subscriptions** system covering:

- Market + event discovery, tags, series, sports, teams
- Full order lifecycle (limit/market + every cancel variant)
- CTF on-chain actions (split/merge/redeem) with Polygonscan links
- Account (positions, activity, notifications, closed-only mode)
- Leaderboards + public profiles
- Rewards + earnings (view only)
- Builder analytics + volume
- Comments, market holders, open interest, live volume
- Gasless ready check, order scoring
- **Live WebSocket subscriptions via MCP Resources** (market books + user order/fill stream)

**Every tool and resource response is pre-formatted for agents.** Zero raw SDK data ever reaches the LLM. Agents receive clean, display-ready cards (Title Case keys, price-as-`$0.73 (73%)`, order status with emojis ✅⏳🚫, full Polygonscan `Confirm` links, truncated addresses). The agent can print any response directly.

All operations use only the official `@polymarket/client@beta` SDK. Real orders and on-chain CTF actions are production-proven.

## Step 1 — Build

```bash
pnpm install
pnpm build
```

## Step 2 — Environment variables

This MCP supports two different ways of receiving credentials. They are **not** the same.

### Local development / manual testing

Create a `.env` file in the project root:

```env
EOA_PRIVATE_KEY=0x       # EOA wallet private key — used for API key derivation and signing
DEPOSIT_WALLET_ADDRESS=0x # Polymarket deposit/proxy wallet address
POLYMARKET_ENV=mainnet    # mainnet or amoy
```

When you run the server directly (`node dist/mcp.js` or the `mcp` script), `dotenv` loads this file.

### Using with Agent Hosts (Hermes, OpenClaw, Cursor, Claude Desktop, etc.) — READ THIS

When an agent runtime launches this MCP server, **the agent host controls the environment**, not a local `.env` file.

- The host starts `node /path/to/dist/mcp.js` as a child process.
- Any `.env` file is only loaded if the host happens to set the current working directory to this project folder (fragile and not recommended).
- **You must pass the secrets explicitly** through the agent's MCP server configuration.

This MCP includes a small alias mapper so you can use clean names in agent configs:

- `EOA_PRIVATE_KEY` → becomes `PRIVATE_KEY` internally
- `DEPOSIT_WALLET_ADDRESS` → becomes `WALLET_ADDRESS` internally

**Recommended names to use in agent configs:** `EOA_PRIVATE_KEY` + `DEPOSIT_WALLET_ADDRESS`.

Auth note: API keys must be derived from the EOA private key. Every order payload must have maker = signer = deposit wallet, ownerAddress = EOA.

## Hermes Installation (Recommended)

**Important for Agents & Safety**: This MCP exposes 100+ tools. Hermes allows you to register it with a safe default subset of tools so agents are not overwhelmed and sensitive actions are not exposed by default.

### Recommended Registration (with safe defaults)

Use this command (replace only the two credential values):

```bash
hermes mcp add polymarket \
  --command node \
  --args "/absolute/path/to/AlphaMCP-TS/dist/mcp.js" \
  --env EOA_PRIVATE_KEY=0xYOUR_EOA_PRIVATE_KEY \
  --env DEPOSIT_WALLET_ADDRESS=0xYOUR_DEPOSIT_WALLET_ADDRESS \
  --env POLYMARKET_ENV=mainnet \
  --tools-include "list_markets,fetch_market,search,list_events,fetch_event,fetch_order_book,fetch_price,fetch_midpoint,fetch_spread,fetch_event_tags,fetch_market_tags,fetch_portfolio_value,list_positions,list_activity"
```

This registers the MCP with a curated, safe default set of tools (mostly read-only discovery + portfolio/positions). Trading tools are intentionally left out by default.

After registration:

```bash
hermes mcp test polymarket
```

Then in any Hermes session:

```bash
/reload-mcp
```

It is strongly recommended to start a **fresh session** after first setup.

### Later Adjustment

You (or an advanced agent) can change the enabled tools at any time with:

```bash
hermes mcp configure polymarket
```

This opens an interactive checklist.

### Credential Handling (Critical)

- **Never** commit your `EOA_PRIVATE_KEY` or `DEPOSIT_WALLET_ADDRESS` anywhere.
- These values are supplied **only at registration time** via the `--env` flags.
- When an agent updates this repo, it will never touch or overwrite the credentials in your Hermes config — they stay exactly as you provided them.
- The `hermes-manifest.yaml` file in this repo provides structured defaults (including recommended tool allowlist) for future Hermes catalog-style installs (`hermes mcp install` / catalog).

**Note**: Requires Node.js ≥ 22.

## OpenClaw

Add the server with explicit environment variables in `~/.openclaw/openclaw.json` (or your OpenClaw config):

```json
{
  "mcp": {
    "servers": {
      "polymarket": {
        "command": "node",
        "args": ["/absolute/path/to/AlphaMCP-TS/dist/mcp.js"],
        "env": {
          "EOA_PRIVATE_KEY": "0xYOUR_EOA_PRIVATE_KEY",
          "DEPOSIT_WALLET_ADDRESS": "0xYOUR_DEPOSIT_WALLET_ADDRESS",
          "POLYMARKET_ENV": "mainnet"
        }
      }
    }
  }
}
```

Restart the OpenClaw gateway after changes.

## Other Agent Hosts

Any host that supports stdio MCP servers can use this. Always pass the three variables above directly in the host's server definition. Never assume a local `.env` will be picked up.

## After Code Changes (Important)

Every time you edit the TypeScript source (including fixes for stability, new tools, etc.) you **must** rebuild before agents see the change:

```bash
npm run build
# or: pnpm build
```

Then reload/restart the MCP in your agent host.

**Recent stability improvement**: The server now avoids writing any logs to stdout when launched as an MCP server (critical for Hermes, OpenClaw, and other stdio hosts). Make sure you are on a build that includes this fix.

## Formatted Responses (Important for Agents)

Every tool returns a **clean, ready-to-display card**. The agent should treat the tool output as final content and print it directly.

Key formatting rules applied to all responses:
- Prices near 0–1 are shown as both decimal and percentage: `$0.7234 (72.34%)`
- Larger prices shown as `$1.2345`
- Unix timestamps converted to `29 May 2026 14:32 UTC`
- Wallet addresses truncated: `0xE467…33f`
- Order/trade status always includes emoji:
  - `✅ FILLED`
  - `⏳ OPEN — not filled yet`
  - `⏳ PENDING — awaiting matching`
  - `❌ UNFILLED — no match found`
  - `🚫 CANCELLED`
  - `🔄 PARTIALLY FILLED`
- Every successful on-chain action (split/merge/redeem/approvals) includes a real `Confirm` link: `https://polygonscan.com/tx/0x...`
- Empty arrays become the string `"None"`
- Null/undefined fields are omitted

### Example Responses

**fetch_market**
```json
{
  "Question": "Will Trump win the 2028 presidential election?",
  "Slug": "will-trump-win-2028",
  "Yes Price": "$0.6200 (62.00%)",
  "No Price": "$0.3800 (38.00%)",
  "Volume": "12345678.0000",
  "Status": "OPEN",
  "End Date": "7 Nov 2028 00:00 UTC"
}
```

**place_limit_order** (or place_market_order)
```json
{
  "Status": "⏳ OPEN — not filled yet",
  "Order Id": "0xabc123...",
  "Side": "BUY",
  "Price": "$0.52",
  "Size": "10",
  "Filled": "0 / 10",
  "Confirm": "Not yet settled on-chain"
}
```

**split_position** (or any CTF action)
```json
{
  "Status": "✅ CONFIRMED",
  "Transaction Hash": "0x1234…abcd",
  "Confirm": "https://polygonscan.com/tx/0x1234..."
}
```

This design means agents can render tool results immediately without extra parsing or formatting logic.

## Live Resources & Subscriptions ("subscribe" — the final piece)

WebSocket subscriptions were **deliberately not exposed as tools**. Real-time data belongs in the MCP **Resources** system (the protocol-native way for servers to push updates).

### What you get
- `resources/list` + `resources/templates/list` — discover all live feeds
- `resources/read` — always returns the same beautiful pre-formatted cards as tools
- `resources/subscribe` / `resources/unsubscribe` — agent asks for push notifications
- Server automatically bridges the production-grade `ReconnectingSubscription` (with exponential backoff) to `notifications/resources/updated`

When a subscribed resource changes (new book tick, your order filled, etc.), the server emits a notification. The agent then calls `resources/read` again for the fresh formatted snapshot.

### Primary Live Resources

| URI Template                            | Live?     | Description                              | Requires Auth |
|-----------------------------------------|-----------|------------------------------------------|---------------|
| `polymarket://market/{tokenId}/book`    | Yes (WS)  | Real-time order book (bids/asks)         | No            |
| `polymarket://market/{tokenId}`         | Partial   | Market snapshot + price context          | No            |
| `polymarket://user/orders`              | Yes (WS)  | Your open orders + fills/cancels         | Yes           |
| `polymarket://user/positions`           | On change | Current positions                        | Yes           |
| `polymarket://user/portfolio`           | On change | Total portfolio value                    | Yes           |
| `polymarket://user/activity`            | On change | Recent account activity                  | Yes           |
| `polymarket://markets`                  | Snapshot  | Active markets list                      | No            |

### Example agent flow (pseudo)
```
1. resources/templates/list
2. resources/subscribe { uri: "polymarket://market/0x123.../book" }
3. (later) notification/resources/updated for that URI
4. resources/read { uri: "polymarket://market/0x123.../book" } → beautiful formatted book card
5. resources/unsubscribe when done
```

User-channel resources (`polymarket://user/*`) automatically start the authenticated user WebSocket feed. Market book resources start lightweight per-token market feeds. Everything reuses the same battle-tested reconnecting logic that powers the internal market maker strategy.

This is the correct, future-proof "subscribe" implementation.

## Available tools

| Name                      | Description                                      |
|---------------------------|--------------------------------------------------|
| list_markets              | List markets (supports closed + pageSize)        |
| fetch_market              | Fetch market by id, slug or url                  |
| list_events               | List events                                      |
| fetch_event               | Fetch event by id or slug                        |
| search                    | Search markets and events                        |
| fetch_order_book          | Fetch order book for a tokenId                   |
| fetch_price               | Fetch price for tokenId + side                   |
| fetch_midpoint            | Fetch midpoint price for a tokenId               |
| fetch_spread              | Fetch spread for a tokenId                       |
| fetch_price_history       | Fetch price history (tokenId + interval)         |
| fetch_last_trade_price    | Fetch last trade price for a tokenId             |
| list_trades               | List trades (optional user filter)               |
| estimate_market_price     | Estimate market order price impact               |
| place_limit_order         | Place a limit order                              |
| place_market_order        | Place a market order                             |
| cancel_order              | Cancel a single order by orderId                 |
| cancel_orders             | Cancel multiple orders by orderIds               |
| cancel_all                | Cancel all open orders                           |
| cancel_market_orders      | Cancel orders for a specific market              |
| list_open_orders          | List open orders (optional market filter)        |
| fetch_order               | Fetch order details by orderId                   |
| list_positions            | List current positions                           |
| list_closed_positions     | List closed/resolved positions                   |
| fetch_portfolio_value     | Fetch current portfolio value                    |
| list_activity             | List recent account activity                     |
| list_account_trades       | List historical account trades (optional market) |
| setup_trading_approvals   | Set up trading approvals (ERC20 + CTF)           |
| split_position            | Split collateral into outcome tokens (CTF)       |
| merge_positions           | Merge outcome tokens back into collateral (CTF)  |
| redeem_positions          | Redeem resolved positions (conditionId or marketId) |

All 30 tools return pre-formatted, agent-ready cards (never raw SDK data). Public tools require no auth. Secure tools require the two wallet environment variables shown above. The agent can safely display any tool response directly.
