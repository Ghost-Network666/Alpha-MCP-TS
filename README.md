# Alpha-MCP-TS

**AGENTS AND CONSUMING SYSTEMS: USE ONLY https://github.com/Ghost-Network666/Alpha-MCP-TS/blob/main/AGENTS.md**

This README.md has been removed from all agent usage, links, and "been used" paths (per request). The sole canonical file for the "never guess" contract, mandatory reads, recipes, prompts, startup, build, verification, and all instructions/rules is **AGENTS.md** (the GitHub link above).

All prior references to this README (including any GitHub blob link to it) have been excised for agents. Only the AGENTS.md link is used.

For human/repo overview only (non-agents): the MCP is a lightweight stdio server providing a pure 1:1 first-class mapping of the @polymarket/client SDK as MCP tools (no custom meta in the core surface, no REST, local only).

## Build
```bash
npm install
npm run build
node dist/mcp.js          # stdio MCP server
```

After any source edit: `npm run build` then **fully reload/restart the MCP server** in the consuming host.

See **AGENTS.md** for:
- Mandatory first reads and calls (prompts/get mcp_llms_full_guide, get_agent_recipes, get_strategies, etc.)
- Key rules (explicit trading only, strategy store owned by host, tools/list + tools/call direct, progressive disclosure via categories/profiles)
- Strict SDK-only policy confirmation
- Continuous improvement ritual
- References (SDK source of truth is the Polymarket ts-sdk README linked inside the mcp_llms_full_guide prompt)

## Lightweight – no extraneous tools. Local over stdio – no REST, no external dependencies. Standard MCP – pure tools/list + tools/call. 100% SDK‑native – every tool maps 1:1 to a function in @polymarket/client.

(Full details and current TIER1 + category surface in AGENTS.md and via live MCP tools after host reload.)

## Quick host doctor
- `npm run doctor`
- In-session: mcp_doctor
