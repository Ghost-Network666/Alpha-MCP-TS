#!/usr/bin/env node
/**
 * Diagnostic script: Loads the Polymarket public client exactly like the MCP server
 * and inspects whether tokenIds are present in raw market data vs after formatting.
 * This directly reproduces what the agent's complaint is about.
 */

import { createPublicClient } from '@polymarket/client';
import * as F from './src/formatters.ts';   // Use the live source formatters

const pub = createPublicClient();

async function main() {
  console.error('=== LOADING MCP PUBLIC CLIENT ===');
  console.error('Client created successfully.');

  console.error('\n=== TEST 1: listMarkets (first page, small) ===');
  try {
    const paginator = await pub.listMarkets({ closed: false, pageSize: 3 });
    const page = await paginator.firstPage();
    const markets = page?.items ?? page?.data ?? [];
    console.error(`Returned ${markets.length} markets`);

    if (markets.length > 0) {
      const m = markets[0];
      inspectMarket(m, 'listMarkets[0]');
    }
  } catch (e) {
    console.error('listMarkets error:', e?.message || e);
  }

  console.error('\n=== TEST 2: fetchMarket (known active binary market) ===');
  const testSlugs = ['will-bitcoin-reach-150000-in-2025', 'bitcoin-above-100k-in-2025', 'will-donald-trump-be-president'];
  for (const slug of testSlugs) {
    try {
      const m = await pub.fetchMarket({ slug });
      if (m) {
        inspectMarket(m, `fetchMarket(${slug})`);
        break;
      }
    } catch (e) {
      console.error(`fetchMarket(${slug}) failed:`, e?.message);
    }
  }

  console.error('\n=== TEST 3: search ===');
  try {
    const results = await pub.search({ q: 'bitcoin', pageSize: 2 });
    const firstMarket = (results?.markets || results?.items || [])[0];
    if (firstMarket) {
      inspectMarket(firstMarket, 'search result');
    } else {
      console.error('search returned no usable markets');
    }
  } catch (e) {
    console.error('search error:', e?.message);
  }

  console.error('\n=== DIAGNOSIS COMPLETE ===');
}

function inspectMarket(market, source) {
  console.error(`\n--- RAW MARKET from ${source} ---`);
  console.error('Top-level keys:', Object.keys(market || {}));

  console.error('\nRaw outcomes:', JSON.stringify(market?.outcomes, null, 2));
  console.error('Raw clobTokenIds:', market?.clobTokenIds);
  console.error('Raw tokenIds:', market?.tokenIds);
  console.error('Has outcomes.yes.tokenId?', !!market?.outcomes?.yes?.tokenId);
  console.error('Has outcomes.no.tokenId?', !!market?.outcomes?.no?.tokenId);

  if (market?.outcomes?.yes?.tokenId || market?.clobTokenIds) {
    console.error('>>> RAW TOKEN DATA EXISTS IN SDK RESPONSE');
  } else {
    console.error('>>> NO TOKEN DATA VISIBLE IN RAW SDK RESPONSE');
  }

  console.error('\n--- FORMATTED OUTPUT (what MCP actually returns to agent) ---');
  try {
    const formatted = F.formatMarket(market);
    console.error(JSON.stringify(formatted, null, 2));

    const hasYesToken = 'Yes Token Id' in formatted && formatted['Yes Token Id'];
    const hasNoToken = 'No Token Id' in formatted && formatted['No Token Id'];
    const hasTokenIds = 'Token Ids' in formatted && formatted['Token Ids']?.length > 0;

    if (hasYesToken || hasNoToken || hasTokenIds) {
      console.error('>>> FORMATTED OUTPUT CONTAINS TOKEN IDS → agent should see them');
    } else {
      console.error('>>> FORMATTED OUTPUT IS MISSING TOKEN IDS ← THIS IS THE AGENT\'S COMPLAINT');
    }
  } catch (fmtErr) {
    console.error('Formatting failed:', fmtErr?.message || fmtErr);
  }
}

main().catch(err => {
  console.error('Fatal diagnostic error:', err);
  process.exit(1);
});
