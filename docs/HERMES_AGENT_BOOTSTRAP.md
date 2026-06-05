# Hermes agent bootstrap — copy into `~/.hermes/`

Hermes injects `AGENTS.md` and `SOUL.md` at boot. Paste the sections below so every sub-agent uses **native MCP tools → intent routing → explicit trade params** (never guessing).

MCP server: AlphaMCP-TS (`alphamcp` in Grok) — stdio `dist/mcp.js`, tier-1 ~28 tools, ~145 handlers via categories.

---

## Paste under `~/.hermes/AGENTS.md` → Permanent Directives

```markdown
## MCP usage and routing (never guess)

- All platform actions go through **native AlphaMCP-TS** `tools/call` only (official `@polymarket/client` SDK under the hood). No direct HTTP.
- **Every session:** `configure_agent_routing({ enabled: true, intent: "rewards_farm", autonomousAssist: true })` then use native tools — each response includes `routing.nextTools`.
- **Before trading or book reads:** `fetch_sdk_readme` (or `polymarket://sdk/readme`) and match `sdkAlignment.mcpToSdk` from the route response to the SDK README method — never invent parameters.
- **Per task:** change intent via `configure_agent_routing({ enabled: true, intent: "..." })` or call one native tool (e.g. `list_active_maker_reward_markets`) and follow `routing.nextTools` on the response.
- Intent routes **which** tools to call — **not** price/size/side. Use explicit numbers on `place_limit_order` / `place_optimized_reward_order`.
- When the plan includes `load_agent_profile`, call it then **re-call `tools/list`** (strict hosts only expose listed tools).
- Discovery: `discover_topic`, `list_active_maker_reward_markets`, `get_agent_recipes` — not `polymarket://markets` as a catalog.
- Rewards path: intelligence → `list_active` / `generate_alpha_report` → `get_farmability` → `place_optimized_reward_order`.
- Obey every `agentDirective` in tool responses. Do not ask the human for option menus.
- `get_strategies()` at the start of every autonomous loop; `update_strategy` to evolve rules.
```

---

## Paste under `~/.hermes/SOUL.md` → Technical posture

```markdown
- Master the MCP via **route_agent_intent** and **fetch_sdk_readme** — intent is always mapped to native tool names and JSON shapes from the server, never improvised.
- Tier-1 is minimal on purpose; `load_agent_profile` / `get_tools_by_category` register the rest without removing capabilities.
- Trading: route → book/farmability → your numbers → `place_limit_order` or `place_optimized_reward_order`. No natural-language trade intent.
```

---

## Hermes MCP config (stdio)

Point Hermes at the built server (same as `.grok/config.toml`):

```yaml
mcp_servers:
  alphamcp:
    command: bash
    args:
      - -lc
      - cd '/path/to/AlphaMCP TS' && exec node dist/mcp.js
```

Use `load_agent_profile` profiles: `weather` | `rewards` | `trading` | `discovery` | `full`.

---

## Delegation (leader → sub-agents)

When using `delegate_task`, scope tools to:

1. `route_agent_intent` + `fetch_sdk_readme` + `get_agent_recipes` (always)
2. Profile for the sub-task (`rewards`, `weather`, `trading`, …)
3. Only the native tools listed in the routed `steps` for that intent

Sub-agents must re-run `route_agent_intent` when the goal changes — do not reuse a stale plan.