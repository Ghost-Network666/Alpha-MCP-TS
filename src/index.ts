#!/usr/bin/env node
/**
 * Trading Client — Production-Ready TypeScript SDK Demo for the CLOB platform
 *
 * Usage examples:
 *   pnpm dev                    # runs this file (default market maker or discovery)
 *   pnpm build && pnpm start
 *
 * Set DEFAULT_MARKET_SLUG or DEFAULT_TOKEN_ID + PRIVATE_KEY etc in .env
 */
import { logger } from './utils/logger.js';
import { getEnv, requireAuthEnv } from './config/env.js';
import { getSecureClient, ensureTradingSetup } from './config/client.js';
import { listAllMarkets, getMarket } from './data/markets.js';
import { getBookSnapshot, getMidpoint, getSpread } from './data/orderbook.js';
import { getAccountSummary } from './trading/account.js';
import { getOpenOrders, cancelAllOrders } from './trading/orders.js';
import { getAllPositions, setupTradingEnvironment } from './trading/positions.js';
import { runExampleMarketMaker } from './strategies/marketMaker.js';

const USAGE = `
TS SDK Client for CLOB platform (Unified @polymarket/client@beta)

One SDK for everything:
  • Gamma (markets, events, search)
  • Data + Order Books + Prices + History
  • CLOB Trading (limit/market orders, cancels)
  • Real-time WebSockets (market + authenticated user channel)
  • CTF On-chain (split / merge / redeem positions + gasless wallet + approvals)

Commands:
  discover                 List active markets
  market <slug>            Detailed market + live book snapshot
  account                  Open positions + recent activity + portfolio value
  positions                Open + closed positions (full CTF view)
  maker [slug|tokenId]     Run the example market maker (places REAL orders)
  setup                    One-time gasless + trading approvals setup
  setup-ctf                Explicit full CTF environment setup (same as above)
  cancel-all               Emergency cancel every open order

All actions use ONLY the official unified SDK — no raw HTTP.
`;

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'help';
  const env = getEnv();

  // Only log wallet when we actually have one (public commands work with zero config)
  if (env.WALLET_ADDRESS) {
    logger.info('Client starting', { node: process.version, wallet: env.WALLET_ADDRESS.slice(0, 8) + '...' });
  } else {
    logger.info('Client starting (public / read-only mode)', { node: process.version });
  }

  switch (cmd) {
    case 'discover':
    case 'list': {
      const markets = await listAllMarkets({ closed: false, pageSize: 5, tag: undefined });
      console.log('\nTop active markets:');
      markets.slice(0, 5).forEach((m, i) => {
        console.log(`${i + 1}. ${m.question} (slug: ${m.slug})`);
        console.log(`   Yes: ${m.outcomes?.yes?.price ?? '?'} | No: ${m.outcomes?.no?.price ?? '?'}`);
      });
      break;
    }

    case 'market': {
      const slug = args[1] || env.DEFAULT_MARKET_SLUG;
      if (!slug) throw new Error('Usage: market <slug>');
      const market = await getMarket({ slug });
      console.log('\nMarket:', market.question);
      console.log('Outcomes:', JSON.stringify(market.outcomes, null, 2));

      const tokenId = market.outcomes?.yes?.tokenId;
      if (tokenId) {
        const [book, mid, spread] = await Promise.all([
          getBookSnapshot(tokenId),
          getMidpoint(tokenId),
          getSpread(tokenId),
        ]);
        console.log('\nBest bid/ask snapshot:');
        console.log('  Midpoint:', mid, 'Spread:', spread);
        console.log('  Top bids:', book.bids?.slice(0, 3));
        console.log('  Top asks:', book.asks?.slice(0, 3));
      }
      break;
    }

    case 'account': {
      requireAuthEnv(); // friendly error + exit if no valid keys
      await getSecureClient();
      console.log('Authenticated as', env.WALLET_ADDRESS);
      await getAccountSummary();
      const opens = await getOpenOrders();
      console.log(`\nOpen orders: ${opens.length}`);
      break;
    }

    case 'maker': {
      requireAuthEnv();
      const id = args[1];
      logger.warn('=== STARTING MARKET MAKER — REAL ORDERS WILL BE PLACED ===');
      await runExampleMarketMaker(id);
      // runs until SIGINT
      break;
    }

    case 'setup': {
      requireAuthEnv();
      const secure = await getSecureClient();
      await ensureTradingSetup(secure);
      console.log('Trading setup complete (aligns to latest SDK deposit defaults + idempotent approvals).');
      break;
    }

    case 'cancel-all': {
      requireAuthEnv();
      logger.warn('Cancelling ALL open orders for this wallet...');
      const resp = await cancelAllOrders();
      console.log('Cancelled:', resp.canceled?.length || 0);
      break;
    }

    case 'positions': {
      requireAuthEnv();
      console.log('Fetching full position lifecycle view (open + closed) via unified SDK...');
      const { openPositionsPaginator, closedPositions } = await getAllPositions();
      // Collect a page of open positions using our helper pattern
      const { collectAll } = await import('./utils/pagination.js');
      const open = await collectAll(openPositionsPaginator as any, { maxPages: 5 });
      console.log(`\nOpen positions: ${open.length}`);
      console.log('Closed positions (sample):', closedPositions.length);
      break;
    }

    case 'setup-ctf': {
      requireAuthEnv();
      await setupTradingEnvironment();
      console.log('CTF on-chain environment ready (approvals + gasless).');
      break;
    }

    case 'help':
    default:
      console.log(USAGE);
      console.log('Example: npm run dev -- maker presidential-election-2028');
      break;
  }
}

main().catch((err) => {
  logger.error('Fatal error', { error: err.message, stack: err.stack });
  process.exit(1);
});
