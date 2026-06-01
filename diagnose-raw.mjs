/**
 * Pure runtime diagnostic (no TS, no formatters).
 * Uses the exact same public client the MCP uses.
 * Goal: See the RAW data the SDK returns for markets — this is the source of truth
 * for the agent's complaint that tokenIds are missing from discovery tools.
 */

import { createPublicClient } from '@polymarket/client';

const NODE = process.execPath;
console.error('=== MCP DIAGNOSTIC (raw SDK data) ===');
console.error('Node runtime:', NODE);
console.error('Process CWD:', process.cwd());

const pub = createPublicClient();
console.error('Public client created.');

async function inspectRaw(source, market) {
  if (!market) {
    console.error(`[${source}] No market`);
    return;
  }
  const keys = Object.keys(market);
  const hasOutcomes = !!market.outcomes;
  const yesTok = market.outcomes?.yes?.tokenId ?? market.outcomes?.Yes?.tokenId;
  const noTok = market.outcomes?.no?.tokenId ?? market.outcomes?.No?.tokenId;
  let clob = market.clobTokenIds ?? market.tokenIds;
  if (typeof clob === 'string') {
    try { clob = JSON.parse(clob); } catch {}
  }

  console.error(`\n=== RAW from ${source} ===`);
  console.error('Top keys:', keys.slice(0, 25).join(', ') + (keys.length > 25 ? ' ...' : ''));
  console.error('outcomes present?', hasOutcomes);
  console.error('outcomes.yes.tokenId:', yesTok);
  console.error('outcomes.no.tokenId :', noTok);
  console.error('clobTokenIds (raw)  :', market.clobTokenIds);
  console.error('clobTokenIds (parsed):', Array.isArray(clob) ? clob : 'not array');
  console.error('Has usable tokenId for trading?', !!(yesTok || noTok || (Array.isArray(clob) && clob.length >= 2)));

  if (!yesTok && !noTok && (!Array.isArray(clob) || clob.length < 2)) {
    console.error('>>> PROBLEM CONFIRMED: No tokenId available in this response shape');
  }
}

async function main() {
  // Test 1: listMarkets (what the agent mostly uses for discovery)
  console.error('\n--- listMarkets (pageSize=2) ---');
  const pag = await pub.listMarkets({ closed: false, pageSize: 2 });
  const page = await (pag.firstPage ? pag.firstPage() : pag.next?.());
  const items = page?.items ?? page?.data ?? [];
  console.error('listMarkets returned', items.length, 'items');
  if (items[0]) await inspectRaw('listMarkets[0]', items[0]);

  // Test 2: fetchMarket (explicit)
  console.error('\n--- fetchMarket on a popular market ---');
  const candidates = ['will-bitcoin-reach-150000-in-2025', 'bitcoin-above-100000-in-2025', 'is-donald-trump-president'];
  for (const slug of candidates) {
    try {
      const m = await pub.fetchMarket({ slug });
      if (m?.id) {
        await inspectRaw(`fetchMarket(${slug})`, m);
        break;
      }
    } catch (e) {
      console.error('fetchMarket', slug, 'failed:', e?.message);
    }
  }

  // Test 3: search
  console.error('\n--- search("bitcoin") ---');
  try {
    const res = await pub.search({ q: 'bitcoin', pageSize: 1 });
    const m = (res?.markets || res?.items || [])[0];
    if (m) await inspectRaw('search result', m);
  } catch (e) {
    console.error('search failed:', e?.message);
  }

  console.error('\n=== RAW DATA DIAGNOSIS COMPLETE ===');
  console.error('If the fields above are empty/null for tokenIds, this is exactly why the agent cannot trade newly discovered markets.');
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
