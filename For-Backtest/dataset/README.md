# Polymarket Backtesting Dataset

> Live MCP tool output — structured for LLM agent consumption.  
> Generated via Alpha-MCP-TS native tools: `list_markets`, `list_events`, `discover_topic`, `list_tags`.  
> Source: Polymarket CLOB/Gamma API via `@polymarket/client` SDK.

---

## Quick Reference — Pick the Right File

| Task | File |
|------|------|
| Active crypto markets | `topics/crypto.md` |
| Bitcoin-specific markets | `topics/bitcoin.md` · `searches/bitcoin.md` |
| Ethereum markets | `topics/ethereum.md` |
| AI / ML markets | `topics/ai.md` · `searches/openai.md` |
| Election / political markets | `topics/elections.md` · `topics/politics.md` |
| Trump markets | `topics/trump.md` · `searches/trump.md` |
| Soccer / football | `topics/soccer.md` |
| NBA basketball | `topics/nba.md` · `searches/nba.md` |
| NFL football | `topics/nfl.md` |
| UFC / MMA | `topics/ufc.md` |
| Weather markets | `topics/weather.md` |
| Inflation / macro | `searches/inflation.md` · `searches/fed-rate.md` · `searches/recession.md` |
| Browse all active markets | `markets/active-p1.md` → `p2` → `p3` (100 each) |
| Browse closed/resolved events | `events/closed-p1.md` → `p2` |
| All tag IDs + slugs | `tags/all.md` |
| Dataset stats + top markets | `summary_stats.json` |
| Machine-readable (stream) | `markets_active.jsonl` — one JSON object per line |

---

## Directory Structure

```
dataset/
├── README.md                   ← Navigation guide (you are here)
├── index.json                  ← Machine-readable file manifest
├── summary_stats.json          ← Top markets by volume/liquidity, tag rankings
├── tags.json                   ← All Polymarket tags (id, label, slug)
│
├── markets/                    ← Market listings — 300 active markets across 3 pages
│   ├── active-p1.md            ← offset 0–99
│   ├── active-p2.md            ← offset 100–199
│   └── active-p3.md            ← offset 200–299
│
├── events/                     ← Event group listings
│   ├── active-p1.md            ← 100 active events
│   ├── active-p2.md            ← 100 active events
│   ├── closed-p1.md            ← 100 closed/resolved events
│   └── closed-p2.md            ← 100 closed/resolved events
│
├── topics/                     ← Category discovery via discover_topic (events + markets)
│   ├── crypto.md               ← All crypto prediction markets
│   ├── bitcoin.md              ← Bitcoin markets
│   ├── ethereum.md             ← Ethereum markets
│   ├── ai.md                   ← AI / machine learning
│   ├── politics.md             ← Global politics
│   ├── elections.md            ← Elections (all)
│   ├── trump.md                ← Trump-specific
│   ├── sports.md               ← Sports (broad)
│   ├── soccer.md               ← Soccer / football
│   ├── nba.md                  ← NBA basketball
│   ├── nfl.md                  ← NFL football
│   ├── ufc.md                  ← UFC / MMA
│   └── weather.md              ← Weather / climate
│
├── searches/                   ← Keyword title-search (50 markets per query)
│   ├── bitcoin.md · trump.md · election.md · openai.md
│   ├── nba.md · ukraine.md · china.md · world-cup.md
│   └── inflation.md · recession.md · fed-rate.md · stocks.md
│
├── tags/
│   └── all.md                  ← Full tag directory with IDs and slugs
│
└── (JSONL — normalized schema, stream-friendly)
    ├── markets_active.jsonl    ← 100 active markets, 1 JSON per line
    ├── markets_closed.jsonl    ← 100 closed markets
    ├── events_active.jsonl     ← 100 active events (with nested markets)
    ├── events_closed.jsonl     ← 100 closed events
    └── markets_by_tag.json     ← Markets grouped by tag label
```

---

## File Format

### `.md` files (topics / searches / markets / events)

Each file contains:
1. A metadata header: tool name, args, timestamp
2. Formatted MCP output — one card per market/event

```
Question: Will Bitcoin exceed $150k before 2027?
YES: 0.34  |  NO: 0.66
Volume: $2,841,203    Liquidity: $98,432    Ends: 2026-12-31
```

### JSONL files (normalized, machine-readable)

One JSON object per line. Stream-safe for large datasets.

```json
{
  "id": "608362",
  "question": "Will OpenAI's market cap be less than $500B at IPO?",
  "status": "active",
  "outcomes": ["Yes", "No"],
  "probabilities": { "Yes": 0.10, "No": 0.90 },
  "volume_total": 277483.74,
  "volume_24h": 1145.34,
  "volume_7d": 3106.29,
  "volume_30d": 12058.94,
  "liquidity": 5767.22,
  "start_date": "2025-09-23",
  "end_date": "2026-06-30",
  "description": "...(first 800 chars)...",
  "event_title": "OpenAI IPO Closing Market Cap",
  "neg_risk": true,
  "accepting_orders": true
}
```

### summary_stats.json

```json
{
  "generated_at": "...",
  "counts": { "markets_active": 100, "markets_closed": 100, "events_active": 100, ... },
  "top_markets_by_volume": [...],
  "top_markets_by_liquidity": [...],
  "tags_by_volume": [...]
}
```

---

## Data Coverage

| Type | Count |
|------|-------|
| Active markets (paginated pages) | 300 |
| Active events | 200 |
| Closed/resolved events | 200 |
| Topic categories | 13 |
| Keyword searches | 12 |
| Normalized JSONL markets | 100 active + 100 closed |

Generated: 2026-06-28

---

## Files

| File | Description |
|------|-------------|
| `tags.json` | All 100 tags with id/label/slug, sorted alphabetically |
| `markets_active.jsonl` | 100 active markets — one JSON object per line |
| `markets_closed.jsonl` | 100 closed markets — one JSON object per line |
| `events_active.jsonl` | 100 active events with nested market summaries |
| `events_closed.jsonl` | 100 closed events with nested market summaries |
| `markets_by_tag.json` | Markets grouped by tag label, with per-tag volume totals |
| `search_results.json` | Labelled search snapshots: general, sports, series, weather, temperature |
| `summary_stats.json` | Dataset-level stats, top markets by volume/liquidity, top tags by volume |

---

## Market Schema (markets_active.jsonl / markets_closed.jsonl)

```json
{
  "id":              "string  — Polymarket market ID",
  "question":        "string  — market question text",
  "slug":            "string  — URL slug",
  "status":          "active | closed | inactive",
  "outcomes":        ["Yes", "No"],
  "probabilities":   { "Yes": 0.87, "No": 0.13 },
  "volume_total":    123456.78,
  "volume_24h":      1234.56,
  "volume_7d":       8765.43,
  "volume_30d":      45678.90,
  "liquidity":       9876.54,
  "start_date":      "2025-01-01",
  "end_date":        "2026-12-31",
  "description":     "string (truncated to 800 chars)",
  "resolution_source": "string | null",
  "event_title":     "string | null",
  "event_id":        "string | null",
  "neg_risk":        false,
  "accepting_orders": true
}
```

## Event Schema (events_active.jsonl / events_closed.jsonl)

```json
{
  "id":            "string",
  "title":         "string",
  "slug":          "string",
  "ticker":        "string | null",
  "status":        "active | closed | inactive",
  "category":      "string | null",
  "start_date":    "2025-01-01",
  "end_date":      "2026-12-31",
  "volume_total":  123456.78,
  "volume_24h":    1234.56,
  "liquidity":     9876.54,
  "open_interest": 5000.00,
  "competitive":   0.96,
  "description":   "string (truncated to 600 chars)",
  "market_count":  4,
  "markets":       [{ "id", "question", "outcomes", "probabilities", "volume_total", "volume_24h", "liquidity", "end_date" }],
  "tags":          [{ "id", "label", "slug" }]
}
```

---

## Usage for LLM Agents

**Read a specific file type (stream-friendly JSONL):**
```js
import { createReadStream } from "fs";
import { createInterface } from "readline";

const rl = createInterface({ input: createReadStream("markets_active.jsonl") });
for await (const line of rl) {
  const market = JSON.parse(line);
  // market.probabilities["Yes"] → current YES price
}
```

**Quick tag lookup:**
```js
const { tags } = JSON.parse(fs.readFileSync("tags.json"));
const openai = tags.find(t => t.slug === "openai");
```

**Top markets at a glance:**
```js
const { top_markets_by_volume } = JSON.parse(fs.readFileSync("summary_stats.json"));
```

---

## Dataset Stats

- **Total markets:** 200 (100 active, 100 closed)
- **Total events:** 200 (100 active, 100 closed)
- **Tags:** 100
- **Active market volume (USD):** $2,507,361,912
