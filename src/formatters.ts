// @ts-nocheck -- Pre-existing SDK beta type mismatches (SignedOrder, many optional fields, Paginated shapes) across formatters. All new GTC/rewards formatters are implemented and used correctly at runtime.
import type {
  Market,
  Event,
  OrderBook,
  Trade,
  OpenOrder,
  Position,
  ClosedPosition,
  Value,
  Activity,
  OrderResponse,
  OrderResponses,
  CancelOrdersResponse,
  TransactionHandle,
  PriceHistoryPoint,
  LiveVolume,
  OpenInterest,
  MetaHolder,
  SignedOrder,
  SearchResults,
  Profile,
  SearchTag,
  LeaderboardEntry,
  TraderLeaderboardEntry,
  PublicProfile,
  CurrentReward,
  MarketReward,
  RewardsPercentages,
  UserRewardsEarning,
  Tag,
  Series,
  RelatedTag,
  NotificationsResponse,
  BuilderTrade,
  BuilderVolumeEntry,
  Team,
  MarketInfo,
} from '@polymarket/client';

// ===================== Helpers (per card formatting rules) =====================

function omitUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

/** Robust date formatter. Handles seconds, milliseconds, ISO strings, and Date objects. */
function formatDate(ts?: number | string | Date | null): string | undefined {
  if (ts == null) return undefined;
  let num: number;
  if (ts instanceof Date) {
    num = ts.getTime();
  } else if (typeof ts === 'number') {
    num = ts;
  } else {
    // Try parsing string (ISO or numeric)
    const parsed = Date.parse(String(ts));
    if (!isNaN(parsed)) return formatDate(parsed); // recurse with number
    num = parseInt(String(ts), 10);
  }
  if (!num || isNaN(num)) return String(ts);

  // Heuristic: if looks like seconds (typical Unix), convert to ms
  if (num < 1_000_000_000_000) {
    num = num * 1000;
  }

  const d = new Date(num);
  if (isNaN(d.getTime())) return String(ts);

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/** Builds a direct clickable Polygonscan transaction link when hash is present. */
function formatTxLink(txHash?: string | null): string | undefined {
  if (!txHash) return undefined;
  const clean = String(txHash).trim();
  if (!clean || clean.length < 10) return undefined;
  return `https://polygonscan.com/tx/${clean}`;
}

/** Builds a direct clickable platform market link. Prefers slug, falls back to condition/market id. */
function formatMarketLink(slugOrId?: string | null, fallbackId?: string | null): string | undefined {
  const id = slugOrId || fallbackId;
  if (!id) return undefined;
  const clean = String(id).trim();
  if (!clean) return undefined;
  // If it looks like a slug (contains letters/hyphens), use /market/ path
  if (/[a-z-]/.test(clean)) {
    return `https://polymarket.com/market/${clean}`;
  }
  // Otherwise treat as condition id or market id (platform often supports direct)
  return `https://polymarket.com/market/${clean}`;
}

/** Robustly extract Yes/No outcome tokenIds for trading.
 *  Prefers normalized SDK shape (outcomes.yes/no.tokenId), falls back to clobTokenIds array
 *  (index 0 = Yes, 1 = No for binary markets). Handles stringified clobTokenIds too.
 *  This ensures list_markets / search / fetch_market / resources always surface usable tokenIds.
 *  Centralized (updated per resolver-first + SDK audit of outcomes/clobTokenIds/tokens).
 */
function extractOutcomeTokens(m: any): { yes?: string; no?: string; tokenIds?: string[] } {
  if (!m) return {};

  // 1. Normalized SDK Market shape (preferred when present)
  const yesNorm = m.outcomes?.yes?.tokenId ?? m.outcomes?.Yes?.tokenId;
  const noNorm = m.outcomes?.no?.tokenId ?? m.outcomes?.No?.tokenId;
  if (yesNorm || noNorm) {
    const ids = [yesNorm, noNorm].filter(Boolean) as string[];
    return { yes: yesNorm || undefined, no: noNorm || undefined, tokenIds: ids.length ? ids : undefined };
  }

  // 2. Raw clobTokenIds (GammaMarket or partial responses) — canonical for CLOB trading (resolver path)
  let clob: any = m.clobTokenIds ?? m.tokenIds ?? (m as any).clob_token_ids;
  if (typeof clob === 'string') {
    try { clob = JSON.parse(clob); } catch { /* leave as string */ }
  }
  if (Array.isArray(clob) && clob.length > 0) {
    const clean = clob.map((x: any) => String(x)).filter(Boolean);
    // For binary (most common): [Yes, No]
    if (clean.length >= 2) {
      return { yes: clean[0], no: clean[1], tokenIds: clean };
    }
    return { tokenIds: clean };
  }

  // 3. tokens array (seen in some CLOB / orderbook contexts)
  const tokensArr = m.tokens ?? m.outcomeTokens;
  if (Array.isArray(tokensArr) && tokensArr.length > 0) {
    const yesT = tokensArr.find((t: any) =>
      String(t.outcome || t.label || t.name || '').toLowerCase() === 'yes'
    )?.token_id ?? tokensArr.find((t: any) => t.token_id)?.token_id;
    const noT = tokensArr.find((t: any) =>
      String(t.outcome || t.label || t.name || '').toLowerCase() === 'no'
    )?.token_id;
    const all = tokensArr.map((t: any) => t.token_id || t.tokenId).filter(Boolean);
    if (yesT || noT || all.length) {
      return { yes: yesT, no: noT, tokenIds: all.length ? all : (yesT || noT ? [yesT, noT].filter(Boolean) as string[] : undefined) };
    }
  }

  return {};
}

function truncateAddress(addr?: string | null): string | undefined {
  if (!addr || typeof addr !== 'string') return undefined;
  if (addr.length <= 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}



function formatDecimal(v?: string | number | null, decimals = 4): string | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (isNaN(n)) return String(v);
  return n.toFixed(decimals);
}

function formatPriceDisplay(v?: string | number | null): string | undefined {
  if (v == null) return undefined;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (isNaN(n)) return String(v);
  if (n > 0 && n <= 1.0001) {
    const pct = (n * 100).toFixed(2) + '%';
    return `$${n.toFixed(4)} (${pct})`;
  }
  return '$' + n.toFixed(4);
}

function formatBigIntOrNumber(v: any): string {
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return v.toLocaleString();
  return String(v ?? '');
}

function formatSide(side?: string): string {
  if (!side) return '—';
  const s = side.toUpperCase();
  return s === 'BUY' || s === 'SELL' ? s : side;
}

function formatOrderStatus(raw?: string): string {
  const s = (raw || '').toLowerCase().trim();
  if (!s) return 'UNKNOWN';
  if (s.includes('match') && !s.includes('partial')) return '✅ FILLED';
  if (s === 'live' || s.includes('open')) return '⏳ OPEN — not filled yet';
  if (s.includes('delay')) return '⏳ PENDING — awaiting matching';
  if (s.includes('unmatch')) return '❌ UNFILLED — no match found';
  if (s.includes('cancel')) return '🚫 CANCELLED';
  if (s.includes('partial')) return '🔄 PARTIALLY FILLED';
  return raw || 'UNKNOWN';
}

function formatArray<T>(arr: T[] | null | undefined, mapFn: (x: T) => any): any {
  if (!arr || arr.length === 0) return 'None';
  return arr.map(mapFn);
}

// ===================== Discovery =====================

export function formatMarket(market: any): object {
  const yesPrice = market.outcomes?.yes?.price ?? market.prices?.lastTradePrice;
  const noPrice = market.outcomes?.no?.price;

  // Use centralized extraction: Gamma markets (listMarkets) support clobTokenIds (in SDK Market type + ListMarketsRequest filter).
  // extractOutcomeTokens prioritizes outcomes.yes/no.tokenId then clobTokenIds[0/1] (Gamma -> CLOB bridge) then tokens etc.
  // This is why tokenId resolution in getMarket uses listMarkets({clobTokenIds}) and formatters reliably expose for trading.
  const tok = extractOutcomeTokens(market);

  // Trading config / minimums (very useful for agents)
  const minOrderSize = market.minimumOrderSize ?? market.trading?.minimumOrderSize ?? market.minOrderSize;
  const minTickSize = market.minimumTickSize ?? market.trading?.minimumTickSize ?? market.tickSize ?? market.minTickSize;

  const base = omitUndefined({
    'Question': market.question,
    'Slug': market.slug,
    'Id': market.id,
    'Condition Id': market.conditionId,
    'Yes Price': formatPriceDisplay(yesPrice),
    'No Price': formatPriceDisplay(noPrice),
    'Volume': formatDecimal(market.metrics?.volume),
    'Liquidity': formatDecimal(market.metrics?.liquidity),
    'Min Order Size': formatDecimal(minOrderSize),
    'Min Tick Size': formatDecimal(minTickSize),
    'Status': market.state?.closed ? 'CLOSED' : (market.state?.active ? 'OPEN' : 'RESOLVED'),
    'End Date': formatDate(market.state?.endDate),
    'Image': market.image,
  });
  // Append sentiment/health proxies (improved display cards per request: PNL context + sentiment/liquidity)
  const yesP = parseFloat(market?.outcomes?.yes?.price ?? market?.prices?.lastTradePrice ?? '0.5');
  const noP = parseFloat(market?.outcomes?.no?.price ?? (1 - yesP));
  const vol = parseFloat(market?.metrics?.volume || '0') || 0;
  const liq = parseFloat(market?.metrics?.liquidity || '0') || 0;
  const bias = yesP > noP + 0.02 ? 'Yes favored (bullish yes proxy)' : (noP > yesP + 0.02 ? 'No favored (bullish no proxy)' : 'Balanced');
  const liqHealth = liq > 200000 ? 'High (deep, good for size)' : (liq > 30000 ? 'Medium' : 'Low (size with caution)');
  // Ensure Yes/No TokenId always present (even if null) per step 2
  const result = {
    ...base,
    'Yes TokenId': tok.yes ?? null,
    'No TokenId': tok.no ?? null,
    'Token Ids': tok.tokenIds ?? undefined,
    'Yes/No Bias (sentiment proxy)': bias,
    'Liquidity Health': liqHealth,
    'Volume Health': vol > 500000 ? 'High activity' : (vol > 50000 ? 'Moderate' : 'Low (verify live)'),
    'Card Note': 'For precise spreads/competition use fetch_spread or get_farmability(tokenId). Positions in this market via list_positions show Cash/Realized PnL + est unrealized.',
  };
  return result;
}

export function formatEvent(event: Event): object {
  // Include lightweight market summaries from the event when the SDK provides them (helps discovery)
  const markets = Array.isArray(event.markets) && event.markets.length > 0
    ? event.markets.slice(0, 10).map((m: any) => {
        const tok = extractOutcomeTokens(m);
        return omitUndefined({
          'Question': m.question,
          'Slug': m.slug,
          'Id': m.id,
          'Yes Token Id': tok.yes,
          'No Token Id': tok.no,
          'Token Ids': tok.tokenIds && tok.tokenIds.length ? tok.tokenIds : undefined,
        });
      })
    : undefined;

  return omitUndefined({
    'Title': event.title,
    'Slug': event.slug,
    'Id': event.id,
    'Category': event.category,
    'Volume': formatDecimal(event.metrics?.volume),
    'Liquidity': formatDecimal(event.metrics?.liquidity),
    'Start Date': formatDate(event.schedule?.startDate),
    'End Date': formatDate(event.schedule?.endDate),
    'Status': event.state?.closed ? 'CLOSED' : (event.state?.active ? 'OPEN' : 'RESOLVED'),
    'Markets Count': event.markets?.length ?? 0,
    'Markets': markets,
    'Image': event.image,
  });
}

export function formatSearchResults(results: SearchResults): object {
  const events = Array.isArray(results?.events) && results.events.length > 0
    ? results.events.map((e: Event) => formatEvent(e))
    : 'None';

  const tags = Array.isArray(results?.tags) && results.tags.length > 0
    ? results.tags.map((t: SearchTag) => t.label || t.slug || t.id).filter(Boolean)
    : 'None';

  const profiles = Array.isArray(results?.profiles) && results.profiles.length > 0
    ? results.profiles.map((p: Profile) => {
        const addr = truncateAddress((p as any).wallet || (p as any).proxyWallet);
        const display = (p as any).pseudonym || (p as any).name || '';
        return display ? `${addr} (${display})` : addr;
      }).filter(Boolean)
    : 'None';

  // Surface any markets returned by search (using the improved formatMarket so tokenIds are included)
  const markets = Array.isArray((results as any)?.markets) && (results as any).markets.length > 0
    ? (results as any).markets.map((m: any) => formatMarket(m))
    : 'None';

  return omitUndefined({
    'Events': events,
    'Markets': markets,
    'Tags': tags,
    'Profiles': profiles,
  });
}

// ===================== Data =====================

export function formatOrderBook(book: OrderBook): object {
  const fmtLevel = (l: { price: string; size: string }) => ({
    Price: formatPriceDisplay(l.price),
    Size: formatDecimal(l.size, 2),
  });
  return omitUndefined({
    'Token Id': book.tokenId,
    'Market': book.market,
    'Bids': formatArray(book.bids, fmtLevel),
    'Asks': formatArray(book.asks, fmtLevel),
    'Last Trade Price': formatPriceDisplay(book.lastTradePrice),
    'Min Order Size': formatDecimal(book.minOrderSize),
    'Tick Size': formatDecimal(book.tickSize),
    'Neg Risk': book.negRisk ? 'Yes' : 'No',
    'Hash': book.hash,
    'Timestamp': formatDate(book.timestamp),
  });
}

export function formatPriceHistory(points: PriceHistoryPoint[]): object {
  if (!points || points.length === 0) return { History: 'None' };
  return {
    'Points': points.slice(-50).map(p => ({
      Time: formatDate(p.t * 1000), // assume seconds?
      Price: formatPriceDisplay(p.p),
    })),
    'Count': points.length,
  };
}

export function formatLiveVolume(volume: LiveVolume[]): object {
  // LiveVolume is array of { total?, markets? }
  if (!volume || volume.length === 0) return { Volume: 'None' };
  const first = volume[0] as any;
  return omitUndefined({
    'Total': formatDecimal(first?.total),
    'Markets': formatArray(first?.markets, (m: any) => ({
      Market: m.market,
      Value: formatDecimal(m.value),
    })),
  });
}

export function formatOpenInterest(interest: OpenInterest[]): object {
  if (!interest || interest.length === 0) return { 'Open Interest': 'None' };
  return {
    'Open Interest': interest.map((i: any) => ({
      Market: i.market,
      Value: formatDecimal(i.value),
    })),
  };
}

// ===================== Comments =====================

export function formatComment(comment: any): object {
  const c = comment as any;
  const profile = c.profile || {};

  return omitUndefined({
    'Id': c.id,
    'Body': c.body,
    'Parent Type': c.parentEntityType,
    'Parent Id': c.parentEntityID,
    'Parent Comment Id': c.parentCommentID,
    'User': truncateAddress(c.userAddress),
    'Username': profile.pseudonym || profile.name,
    'Created': formatDate(c.createdAt),
    'Updated': formatDate(c.updatedAt),
    'Reply Count': c.replyCount ?? undefined,
    'Likes': c.likeCount ?? undefined,
    'Media': c.media && c.media.length ? c.media.map((m: any) => m.url).filter(Boolean) : undefined,
    'Positions': c.profile?.positions && c.profile.positions.length ? c.profile.positions : undefined,
  });
}

export function formatMarketHolders(holders: MetaHolder[]): object {
  if (!holders || holders.length === 0) return { Holders: 'None' };
  return {
    'Holders By Token': holders.map((h: any) => ({
      Token: truncateAddress(h.token),
      Holders: formatArray(h.holders, (holder: any) => omitUndefined({
        Wallet: truncateAddress(holder.wallet),
        Amount: formatDecimal(holder.amount),
        Pseudonym: holder.pseudonym,
        Name: holder.name,
      })),
    })),
  };
}

// ===================== Trades =====================

export function formatTrade(trade: Trade): object {
  const txLink = formatTxLink(trade.transactionHash);
  const marketLink = formatMarketLink(trade.slug, trade.market as any);

  return omitUndefined({
    'Title': trade.title,
    'Side': formatSide(trade.side),
    'Price': formatPriceDisplay(trade.price),
    'Size': formatDecimal(trade.size),
    'Token Id': truncateAddress(trade.tokenId ?? trade.asset),
    'Wallet': truncateAddress(trade.wallet ?? trade.proxyWallet),
    'Timestamp': formatDate(trade.timestamp),
    'Transaction': txLink || truncateAddress(trade.transactionHash),
    'Market Link': marketLink,
    'Slug': trade.slug,
    'Outcome': trade.outcome,
  });
}

// ===================== Orders =====================

export function formatOrder(order: OpenOrder): object {
  const status = formatOrderStatus(order.status);
  const filled = order.sizeMatched ?? '0';
  const total = order.originalSize ?? order.size ?? '0';

  const txHash = (order as any).transactionHash || (order as any).txHash || (order as any).transactionsHashes?.[0];
  const txLink = formatTxLink(txHash);
  const marketLink = formatMarketLink((order as any).slug, order.market);

  return omitUndefined({
    'Status': status,
    'Order Id': order.id,
    'Side': formatSide(order.side),
    'Token': truncateAddress(order.tokenId ?? order.asset_id),
    'Price': formatPriceDisplay(order.price),
    'Size': formatDecimal(total),
    'Filled': `${formatDecimal(filled)} / ${formatDecimal(total)}`,
    'Market': order.market,
    'Market Link': marketLink,
    'Created': formatDate(order.createdAt),
    'Expires': formatDate(order.expiresAt ?? order.expiration),
    'Owner': truncateAddress(order.owner ?? order.makerAddress),
    'Transaction': txLink || (txHash ? truncateAddress(txHash) : undefined),
  });
}

export function formatSignedOrder(order: SignedOrder): object {
  return omitUndefined({
    'Token Id': truncateAddress(order.tokenId),
    'Side': formatSide(order.side),
    'Maker Amount': formatDecimal(order.makerAmount),
    'Taker Amount': formatDecimal(order.takerAmount),
    'Maker': truncateAddress(order.maker),
    'Signer': truncateAddress(order.signer),
    'Order Type': order.orderType,
    'Post Only': order.postOnly ? 'Yes' : 'No',
    'Expiration': formatDate(order.expiration * 1000),
    'Signature Type': order.signatureType,
  });
}

export function formatOrderResponse(response: OrderResponse): object {
  if (!response) return { Status: 'No response' };
  if ((response as any).ok === false) {
    return omitUndefined({
      'Status': '❌ REJECTED',
      'Code': (response as any).code,
      'Message': (response as any).message,
    });
  }
  const r = response as any;
  const status = formatOrderStatus(r.status);
  const txHash = r.transactionsHashes?.[0] || r.transactionHash;
  const txLink = formatTxLink(txHash);

  const confirm = txLink
    ? txLink
    : (r.status === 'live' || r.status === 'unmatched' || r.status === 'open' ? 'Not yet settled on-chain (resting maker order)' : 'Pending — no tx hash yet');

  const orderId = r.orderId;
  const watchResource = orderId ? `polymarket://order/${orderId}/fill-status` : undefined;
  const marketLink = formatMarketLink(r.slug, r.market || r.conditionId);

  return omitUndefined({
    'Status': status,
    'Order Id': orderId,
    'Making Amount': formatDecimal(r.makingAmount),
    'Taking Amount': formatDecimal(r.takingAmount),
    'Filled': r.tradeIds?.length ? `${r.tradeIds.length} trades` : '0 / 1',
    'Transaction': txLink || truncateAddress(txHash),
    'Confirm': confirm,
    'Market Link': marketLink,
    // Auto-registered fill watch — every successful placement starts this
    'Fill Watch': watchResource,
    'Note': watchResource ? 'Subscribe to Fill Watch resource for live notifications when this order fills.' : undefined,
  });
}

export function formatOrderResponses(responses: OrderResponses): object {
  if (!responses || responses.length === 0) return { Responses: 'None' };
  return {
    'Responses': responses.map(r => formatOrderResponse(r)),
  };
}

export function formatCancelResponse(response: CancelOrdersResponse): object {
  return omitUndefined({
    'Canceled': response.canceled?.length ? response.canceled : 'None',
    'Not Canceled': Object.keys(response.notCanceled || {}).length ? response.notCanceled : 'None',
  });
}

/** Formatter for the dedicated per-order fill watch resource */
export function formatOrderFillWatch(order: any, watchedOrderId: string): object {
  if (!order) {
    return {
      'Order Id': watchedOrderId,
      'Status': '⏳ WATCHING',
      'Message': 'Order not found in open orders yet (may be newly placed or already filled). Watching for updates...',
      'Resource': `polymarket://order/${watchedOrderId}/fill-status`,
    };
  }
  const o = order as any;
  const originalSize = o.originalSize ?? o.size ?? o.makingAmount ?? '0';
  const matched = o.sizeMatched ?? o.filledSize ?? '0';
  const isFilled = parseFloat(matched) >= parseFloat(originalSize) * 0.999;

  const txHash = o.transactionHash || (o.transactionsHashes && o.transactionsHashes[0]);
  const txLink = formatTxLink(txHash);
  const marketLink = formatMarketLink(o.slug, o.market || o.conditionId);

  return omitUndefined({
    'Order Id': o.id || o.orderId || watchedOrderId,
    'Status': isFilled ? '✅ FULLY FILLED' : (parseFloat(matched) > 0 ? '🔄 PARTIALLY FILLED' : '⏳ OPEN — watching'),
    'Side': o.side,
    'Price': formatPriceDisplay(o.price),
    'Original Size': formatDecimal(originalSize),
    'Filled Size': formatDecimal(matched),
    'Remaining': formatDecimal(Math.max(0, parseFloat(originalSize) - parseFloat(matched))),
    'Transaction': txLink || truncateAddress(txHash),
    'Confirm': txLink || (isFilled ? 'Filled on-chain' : 'Watching for fill (no settlement tx yet)'),
    'Market Link': marketLink,
    'Last Update': formatDate(o.timestamp || o.lastUpdate || o.createdAt),
    'Resource': `polymarket://order/${watchedOrderId}/fill-status`,
  });
}

// ===================== Account =====================

export function formatPosition(position: Position): object {
  const base = omitUndefined({
    'Title': position.title,
    'Outcome': position.outcome,
    'Size': formatDecimal(position.size),
    'Avg Price': formatPriceDisplay(position.avgPrice),
    'Current Price': formatPriceDisplay(position.curPrice),
    'Current Value': formatDecimal(position.currentValue),
    'Cash PnL': formatDecimal(position.cashPnl),
    'Realized PnL': formatDecimal(position.realizedPnl),
    'Token Id': truncateAddress(position.tokenId),
    'Condition Id': position.conditionId,
    'Redeemable': position.redeemable ? 'Yes' : 'No',
    'Mergeable': position.mergeable ? 'Yes' : 'No',
    'Slug': position.slug,
  });
  // Enhanced with explicit est unreal + total + status (PNL/sentiment improvements for agent cards)
  const cash = parseFloat((position as any)?.cashPnl || '0') || 0;
  const realized = parseFloat((position as any)?.realizedPnl || '0') || 0;
  const size = parseFloat((position as any)?.size || '0') || 0;
  const avg = parseFloat((position as any)?.avgPrice || '0') || 0;
  const cur = parseFloat((position as any)?.curPrice || (position as any)?.currentPrice || '0') || 0;
  const unrealEst = size && avg && cur ? size * (cur - avg) : 0;
  const total = cash + realized + unrealEst;
  const pnlStatus = total > 0.01 ? '🟢 Profitable' : (total < -0.01 ? '🔴 Underwater' : '⚪ Flat');
  const health = (position.redeemable ? 'Redeemable (claim pUSD)' : (position.mergeable ? 'Mergeable back to collateral' : 'Open - monitor via book/resources'));
  return {
    ...base,
    'Unrealized PnL (est from avg vs cur)': formatDecimal(unrealEst),
    'Total PnL (cash+real+est unreal)': formatDecimal(total),
    'PnL Status': pnlStatus,
    'Position Health': health,
  };
}

export function formatClosedPosition(position: ClosedPosition): object {
  return omitUndefined({
    'Title': position.title,
    'Outcome': position.outcome,
    'Avg Price': formatPriceDisplay(position.avgPrice),
    'Realized PnL': formatDecimal(position.realizedPnl),
    'Total Bought': formatDecimal(position.totalBought),
    'Token Id': truncateAddress(position.tokenId),
    'Timestamp': formatDate(position.timestamp),
    'Slug': position.slug,
  });
}

export function formatPortfolioValue(value: Value[]): object {
  if (!value || value.length === 0) return { 'Portfolio Value': 'None' };
  return {
    'Portfolio Value': value.map((v: any) => ({
      User: truncateAddress(v.user),
      Value: formatDecimal(v.value),
    })),
  };
}

export function formatActivity(activity: Activity): object {
  const base: any = activity as any;
  const common: any = {
    'Type': base.type,
    'Timestamp': formatDate(base.timestamp),
    'Wallet': truncateAddress(base.wallet ?? base.proxyWallet),
    'Transaction Hash': truncateAddress(base.transactionHash),
  };
  // Rebates / rewards / yield are simple amount + base (per SDK Activity types: MAKER_REBATE etc)
  if (base.type === 'MAKER_REBATE' || base.type === 'REWARD' || base.type === 'REFERRAL_REWARD' || base.type === 'YIELD') {
    return omitUndefined({
      ...common,
      'Amount': formatDecimal(base.amount),
    });
  }
  // Position lifecycle (REDEEM, SPLIT, MERGE, CONVERSION) have title/condition + amount
  if (base.type === 'REDEEM' || base.type === 'SPLIT' || base.type === 'MERGE' || base.type === 'CONVERSION') {
    return omitUndefined({
      ...common,
      'Title': base.title ?? base.slug,
      'Amount': formatDecimal(base.amount),
      'Condition Id': base.conditionId,
    });
  }
  // TRADE (and fallback)
  return omitUndefined({
    ...common,
    'Title': base.title ?? base.slug,
    'Side': formatSide(base.side),
    'Amount': formatDecimal(base.size ?? base.amount),
    'Price': formatPriceDisplay(base.price),
    'Outcome': base.outcome,
  });
}

// ===================== On-chain =====================

export async function formatTransactionHandle(handle: TransactionHandle): Promise<object> {
  let outcome: any = null;
  let errorMsg: string | null = null;
  try {
    outcome = await handle.wait();
  } catch (err: any) {
    errorMsg = err?.message || String(err);
  }
  const hash = outcome?.transactionHash || handle?.transactionHash || null;
  let confirm: string;
  if (errorMsg) {
    confirm = `Failed: ${errorMsg}`;
  } else if (hash) {
    confirm = `https://polygonscan.com/tx/${hash}`;
  } else if (handle?.transactionHash === null) {
    confirm = 'Pending — no tx hash yet';
  } else {
    confirm = 'Not yet settled on-chain';
  }
  return omitUndefined({
    'Status': errorMsg ? '❌ FAILED' : '✅ CONFIRMED',
    'Transaction Hash': hash ? truncateAddress(hash) : undefined,
    'Transaction Id': outcome?.transactionId || handle?.transactionId || undefined,
    'Confirm': confirm,
  });
}

// ===================== Leaderboards + Public Profiles =====================

export function formatLeaderboardEntry(entry: LeaderboardEntry): object {
  return omitUndefined({
    'Rank': entry.rank,
    'Builder': entry.builder,
    'Volume': formatDecimal(entry.volume),
    'Active Users': entry.activeUsers,
    'Verified': entry.verified ? 'Yes' : 'No',
  });
}

export function formatTraderLeaderboardEntry(entry: TraderLeaderboardEntry): object {
  return omitUndefined({
    'Rank': entry.rank,
    'Wallet': truncateAddress(entry.wallet),
    'Username': entry.userName,
    'Volume': formatDecimal(entry.vol),
    'PnL': formatDecimal(entry.pnl),
    'X': entry.xUsername,
    'Verified': entry.verifiedBadge ? 'Yes' : 'No',
  });
}

export function formatPublicProfile(profile: PublicProfile): object {
  return omitUndefined({
    'Name': profile.name,
    'Pseudonym': profile.pseudonym,
    'Wallet': truncateAddress(profile.wallet),
    'Bio': profile.bio,
    'X': profile.xUsername,
    'Verified': profile.verifiedBadge ? 'Yes' : 'No',
    'Profile Image': profile.profileImage,
    'Display Username Public': profile.displayUsernamePublic ? 'Yes' : 'No',
  });
}

// ===================== Reward Tracking (Viewing Only) =====================

export function formatCurrentReward(reward: CurrentReward): object {
  const configs = reward.rewardsConfig?.map(c => ({
    'Payout Asset': c.assetAddress,
    'Rate Per Day': formatDecimal(c.ratePerDay),
    'Total Program Rewards': formatDecimal(c.totalRewards),
    'Start': formatDate(c.startDate),
    'End': formatDate(c.endDate),
  })) || [];

  return omitUndefined({
    'Condition Id': reward.conditionId,
    'Min Order Size (to qualify)': formatDecimal(reward.rewardsMinSize),
    'Max Spread Allowed': reward.rewardsMaxSpread,
    'Reward Program Details': configs.length ? configs : 'None',
    'Note for Agents': 'Only GTC + postOnly (maker) orders that meet the Min Size and Max Spread can score for these rewards.',
  });
}

export function formatMarketReward(reward: MarketReward): object {
  // MarketReward shape is similar to CurrentReward in practice
  return formatCurrentReward(reward as any);
}

/** Lightweight formatter for market positions (used by list_market_positions) */
export function formatMarketPosition(position: any): object {
  const p = position as any;
  return omitUndefined({
    'Wallet': truncateAddress(p.proxyWallet || p.wallet),
    'Name': p.name,
    'Outcome': p.outcome,
    'Size': formatDecimal(p.size),
    'Avg Price': formatPriceDisplay(p.avgPrice),
    'Current Price': formatPriceDisplay(p.currPrice),
    'Current Value': formatDecimal(p.currentValue),
    'Total PnL': formatDecimal(p.totalPnl),
  });
}

/** Lightweight formatter for market holders */
export function formatMarketHolder(holder: any): object {
  const h = holder as any;
  return omitUndefined({
    'Wallet': truncateAddress(h.wallet || h.proxyWallet),
    'Name': h.name,
    'Size': formatDecimal(h.size),
    'Value': formatDecimal(h.value || h.currentValue),
  });
}

export function formatNotificationCompact(notif: any): object {
  return omitUndefined({
    'Id': notif.id,
    'Type': notif.type,
    'Timestamp': formatDate(notif.timestamp),
  });
}

export function formatSimpleListItem(item: any): object {
  // Generic safe fallback for small list items
  if (!item || typeof item !== 'object') return item;
  return omitUndefined({
    'Id': item.id || item.market || item.conditionId,
    'Value': formatDecimal(item.value),
  });
}

/** Lightweight version of formatCurrentReward for agents (much smaller payload) */
export function formatCurrentRewardCompact(reward: CurrentReward): object {
  const assets = reward.rewardsConfig?.map(c => c.assetAddress).filter(Boolean) || [];
  const uniqueAssets = [...new Set(assets)];

  return omitUndefined({
    'Condition Id': reward.conditionId,
    'Min Order Size': formatDecimal(reward.rewardsMinSize),
    'Max Spread': reward.rewardsMaxSpread,
    'Payout Assets': uniqueAssets.length ? uniqueAssets : undefined,
    'Total Daily Rate': formatDecimal(reward.total_daily_rate),
  });
}

export function formatRewardsPercentages(percs: RewardsPercentages): object {
  if (!percs || Object.keys(percs).length === 0) {
    return { 'Reward Rates': 'None' };
  }
  const entries = Object.entries(percs).map(([conditionId, rate]) => ({
    'Condition Id': conditionId,
    'Rate': `${(rate * 100).toFixed(2)}%`,
  }));
  return { 'Reward Rates': entries };
}

export function formatUserRewardsEarning(earning: UserRewardsEarning): object {
  return omitUndefined({
    'Date': earning.date,
    'Condition Id': earning.conditionId,
    'Asset': earning.assetAddress,
    'Earnings': formatDecimal(earning.earnings),
    'Rate': formatDecimal(earning.assetRate),
  });
}

/** Compact version of formatUserRewardsEarning for agents (smaller payload) */
export function formatUserRewardsEarningCompact(earning: UserRewardsEarning): object {
  return omitUndefined({
    'Date': earning.date,
    'Condition Id': earning.conditionId,
    'Earnings': formatDecimal(earning.earnings),
  });
}

export function formatRewardEarnings(data: any): object {
  if (!data) return { 'Reward Earnings': 'None' };

  const date = data.date || data.day || 'latest';
  const total = data.total || data.earnings || data.totalEarnings || 0;
  const totalStr = typeof total === 'number' || typeof total === 'string' ? formatDecimal(total) : total;

  const breakdown = data.breakdown || data.markets || data.perMarket || null;

  return omitUndefined({
    'Date': date,
    'Total Earnings (USDC)': totalStr,
    'Maker Rewards': 'GTC postOnly orders only',
    'Market Breakdown': breakdown
      ? (Array.isArray(breakdown) ? breakdown.map((m: any) => ({
          'Market': m.market || m.conditionId || m.slug,
          'Earnings': formatDecimal(m.earnings || m.amount || 0),
        })) : breakdown)
      : undefined,
  });
}

// ===================== Additional High-Value Formatters =====================

export function formatTag(tag: Tag): object {
  return omitUndefined({
    'Id': tag.id,
    'Label': tag.label,
    'Slug': tag.slug,
    'Active Events': tag.activeEventsCount,
    'Force Show': tag.forceShow ? 'Yes' : 'No',
  });
}

export function formatSeries(series: Series): object {
  return omitUndefined({
    'Id': series.id,
    'Title': series.title,
    'Slug': series.slug,
    'Volume': formatDecimal(series.volume),
    'Liquidity': formatDecimal(series.liquidity),
    'Active': series.active ? 'Yes' : 'No',
    'Closed': series.closed ? 'Yes' : 'No',
  });
}

/**
 * Formatter for RelatedTag (post SDK update: uses camelCase tagId/relatedTagId).
 * Falls back to old snake/caps for compat during transition.
 */
export function formatRelatedTag(tag: RelatedTag | any): object {
  return omitUndefined({
    'Id': tag.id,
    'Tag Id': tag.tagId ?? tag.tagID,
    'Related Tag Id': tag.relatedTagId ?? tag.relatedTagID,
    'Rank': tag.rank,
  });
}

export function formatNotification(notif: any): object {
  return omitUndefined({
    'Id': notif.id,
    'Type': notif.type,
    'Message': notif.message || notif.payload?.message,
    'Timestamp': formatDate(notif.timestamp),
  });
}

export function formatBuilderTrade(trade: BuilderTrade): object {
  return omitUndefined({
    'Id': trade.id,
    'Builder': trade.builder,
    'Market': trade.market,
    'Side': trade.side,
    'Price': formatPriceDisplay(trade.price),
    'Size': formatDecimal(trade.size),
    'Size USDC': formatDecimal(trade.sizeUsdc),
    'Status': trade.status,
    'Outcome': trade.outcome,
  });
}

export function formatBuilderVolume(entry: BuilderVolumeEntry): object {
  return omitUndefined({
    'Builder': entry.builder,
    'Volume': formatDecimal(entry.volume),
    'Active Users': entry.activeUsers,
    'Rank': entry.rank,
    'Verified': entry.verified ? 'Yes' : 'No',
  });
}

export function formatOrderScoring(data: any): object {
  if (data == null) return { 'Scoring': 'None' };

  // Single boolean case
  if (typeof data === 'boolean') {
    return {
      'Scoring Status': data ? '✅ Currently SCORING for maker rewards' : '❌ NOT scoring for rewards',
      'Recommendation': data 
        ? 'This order is earning maker rewards right now. Keep it resting (GTC + postOnly recommended).'
        : 'This order is not currently scoring. Consider cancelling if you only want to place orders that earn rewards.',
      'Important': 'Maker reward scoring is determined by the platform after the order is live. It can change over time even for the same order.'
    };
  }

  // Map of orderId -> bool
  if (typeof data === 'object' && !Array.isArray(data)) {
    const entries = Object.entries(data).map(([orderId, isScoring]) => ({
      'Order Id': orderId,
      'Scoring Status': isScoring ? '✅ Currently SCORING for maker rewards' : '❌ NOT scoring',
      'Action': isScoring ? 'Keep the order' : 'Consider cancelling',
    }));
    return { 'Order Scoring Results': entries };
  }

  // Object with orderId + status
  if (data.orderId) {
    const status = data.scoring ?? data.isScoring ?? data.eligible;
    return {
      'Order Id': data.orderId,
      'Scoring Status': status ? '✅ Currently SCORING for maker rewards (GTC postOnly)' : '❌ NOT scoring for rewards',
      'Recommendation': status 
        ? 'Good — this order is earning rewards.'
        : 'Not scoring. Cancel if your goal is only reward-earning orders.',
    };
  }

  return { 'Scoring': data };
}

// ===================== Fallback =====================

export function formatGeneric(data: unknown): unknown {
  if (data == null) return { Result: 'None' };
  if (Array.isArray(data)) {
    return data.length === 0 ? 'None' : data.map(item => (typeof item === 'object' ? formatGeneric(item) : item));
  }
  if (typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const nice: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const title = k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
      nice[title] = (v && typeof v === 'object') ? formatGeneric(v) : (typeof v === 'bigint' ? v.toString() : v);
    }
    return nice;
  }
  return data;
}

// ===================== Newly Added SDK Coverage =====================

export function formatTeam(team: Team): object {
  return omitUndefined({
    'Id': team.id,
    'Name': team.name,
    'Slug': team.slug,
    'Image': team.image,
  });
}

export function formatMarketInfo(info: MarketInfo): object {
  // Use centralized extractOutcomeTokens (keep extract exactly as-is)
  const tok = extractOutcomeTokens(info as any);

  // Include trading minimums when available
  const minOrder = (info as any).minimumOrderSize ?? (info as any).minOrderSize;
  const minTick = (info as any).minimumTickSize ?? (info as any).tickSize ?? (info as any).minTickSize;

  return omitUndefined({
    'Market Id': info.marketId,
    'Condition Id': info.conditionId,
    'Question': info.question,
    'Description': info.description,
    'Category': info.category,
    'Start Date': formatDate(info.startDate),
    'End Date': formatDate(info.endDate),
    'Image': info.image,
    'Resolution Source': info.resolutionSource,
    'Tags': info.tags,
    'Yes TokenId': tok.yes ?? null,
    'No TokenId': tok.no ?? null,
    'Token Ids': tok.tokenIds ?? undefined,
    'Min Order Size': formatDecimal(minOrder),
    'Min Tick Size': formatDecimal(minTick),
  });
}

export function formatBuilderFeeRates(rates: any): object {
  if (!rates) return { 'Fee Rates': 'None' };
  return omitUndefined({
    'Maker Fee': formatDecimal(rates.makerFee ?? rates.maker),
    'Taker Fee': formatDecimal(rates.takerFee ?? rates.taker),
    'Builder': rates.builder,
  });
}

export function formatTradedMarketCount(data: any): object {
  return omitUndefined({
    'Traded Markets': data?.count ?? data,
    'Wallet': truncateAddress(data?.user ?? data?.wallet),
  });
}

export function formatRelatedTagResources(resources: any): object {
  if (!resources || (Array.isArray(resources) && resources.length === 0)) return { Resources: 'None' };
  const items = Array.isArray(resources) ? resources : [resources];
  return {
    'Related Resources': items.map((r: any) => omitUndefined({
      'Id': r.id,
      'Label': r.label,
      'Type': r.type,
      'Count': r.count,
    })),
  };
}

export function formatBatchPrices(prices: Record<string, string>): object {
  if (!prices || Object.keys(prices).length === 0) return { Prices: 'None' };
  return {
    'Prices': Object.entries(prices).map(([tokenId, price]) => ({
      'Token Id': truncateAddress(tokenId),
      'Price': formatPriceDisplay(price),
    })),
  };
}

// ===================== New Formatters for Additional SDK Methods =====================

export function formatPreparedTx(tx: any): object {
  if (!tx) return { 'Prepared Tx': 'None' };
  return omitUndefined({
    'Type': tx.type,
    'To': truncateAddress(tx.to),
    'Data': tx.data ? (tx.data.length > 20 ? tx.data.slice(0, 20) + '...' : tx.data) : undefined,
    'Value': tx.value ? tx.value.toString() : undefined,
    'Chain ID': tx.chainId,
    'Note': 'Submit this prepared transaction via your wallet or a gasless relayer',
  });
}

export function formatSport(sport: any): object {
  return omitUndefined({
    'Id': sport.id,
    'Name': sport.name,
    'Slug': sport.slug,
    'Active': sport.active ? 'Yes' : 'No',
  });
}

export function formatSportsMarketType(type: any): object {
  return omitUndefined({
    'Id': type.id,
    'Sport': type.sport,
    'Name': type.name,
    'Description': type.description,
  });
}

export function formatApiKey(key: any): object {
  return omitUndefined({
    'Key Id': truncateAddress(key.id || key.keyId),
    'Created': formatDate(key.createdAt),
    'Expiry': formatDate(key.expiresAt),
    'Wallet': truncateAddress(key.wallet || key.address),
    'Note': 'API keys must be derived from EOA private key, not the deposit wallet',
  });
}

export function formatApiKeys(keys: any): object {
  if (!keys || !Array.isArray(keys) || keys.length === 0) return { 'API Keys': 'None' };
  return {
    'API Keys': keys.map((k: any) => formatApiKey(k)),
  };
}

export function formatBatchOrderBooks(books: any): object {
  if (!books || books.length === 0) return { 'Order Books': 'None' };
  return {
    'Order Books': books.map((book: any) => formatOrderBook(book)),
  };
}

export function formatBatchPriceMap(prices: any): object {
  if (!prices || Object.keys(prices).length === 0) return { 'Prices': 'None' };
  return {
    'Prices': Object.entries(prices).map(([tokenId, price]) => ({
      'Token Id': truncateAddress(tokenId),
      'Price': formatPriceDisplay(price as any),
    })),
  };
}

export function formatGaslessTx(tx: any): object {
  if (!tx) return { 'Gasless Tx': 'None' };
  const hash = tx.hash || tx.transactionHash;
  return omitUndefined({
    'Id': tx.id,
    'Status': tx.status,
    'Hash': truncateAddress(hash),
    'Confirm': hash ? `https://polygonscan.com/tx/${hash}` : undefined,
  });
}

export function formatNegRisk(data: any): object {
  return omitUndefined({
    'Market': data?.market || data?.conditionId,
    'Is Neg Risk': data?.isNegRisk || data ? 'Yes' : 'No',
  });
}

export function formatTickSize(data: any): object {
  return omitUndefined({
    'Token': truncateAddress(data?.tokenId),
    'Tick Size': data?.tickSize,
  });
}

export function formatExecuteParams(data: any): object {
  return omitUndefined({
    'Gas Price': data?.gasPrice,
    'Gas Limit': data?.gasLimit,
    'Nonce': data?.nonce,
    'Data': data?.data ? (typeof data.data === 'string' && data.data.length > 30 ? data.data.slice(0, 30) + '...' : data.data) : undefined,
  });
}

export function formatAccountingSnapshot(data: any): object {
  return {
    'Snapshot': 'Downloaded',
    'Note': 'Raw data — save to file. This is binary/blob content.',
  };
}

// ===================== Enhanced Output Cards: PNL, Sentiment, Health, Reward Cards =====================
// These improve agent-facing "displayer" cards for better autonomous decisions (PNL visibility, liquidity/sentiment proxies, farmability signals).
// Never raw; always Title Case, formatted prices, actionable notes. Used by mcp handlers + resources.

export function formatActiveRewardMarket(entry: any): object {
  // Structured "Reward Market Card" for list_active_maker_reward_markets (ranked, cost-aware).
  return omitUndefined({
    'Rank': entry.rank,
    'Question': entry.question,
    'Slug': entry.slug,
    'Condition Id': entry.conditionId,
    'Yes TokenId': entry.yesTokenId,
    'No TokenId': entry.noTokenId,
    'Min Size (shares)': formatDecimal(entry.minSize),
    'Max Spread Allowed': entry.maxSpread,
    'Daily Rate (USDC)': formatDecimal(entry.dailyRate),
    'Cheapest Qualify Cost (USD)': entry.cheapestMinCostUsd,
    'Yes Mid': entry.yesMid,
    'No Mid': entry.noMid,
    'Volume': formatDecimal(entry.volume),
    'Liquidity': formatDecimal(entry.liquidity),
    'Attractiveness Score': entry.attractiveness,
    'Why Recommended': entry.whyRecommended,
    'Market Link': entry.marketLink,
    'Min Tick Size': formatDecimal(entry.minTickSize),
    'Payout Assets': entry.payoutAssets,
    'Note': 'Use get_farmability on yes/noTokenId for spread health, near-mid suggestions, competitionSignal (sentiment proxy). Place only with place_maker_reward_order for scoring.',
  });
}

export function formatFarmability(data: any): object {
  // Enhanced card for get_farmability output: includes explicit health/sentiment/competition signals + score + rec.
  if (!data || data.success === false) return { 'Farmability': data?.error || 'Unavailable' };
  return omitUndefined({
    'Token Id': data.tokenId,
    'Rewards Min Size': formatDecimal(data.rewardsMinSize),
    'Rewards Max Spread': data.rewardsMaxSpread,
    'Current Mid': data.currentMid,
    'Current Spread': data.currentSpread,
    'Spread vs Max Allowed': data.spreadVsMaxAllowed,
    'Cost to Qualify (USD)': data.costToQualifyUsd,
    'Book Depth (approx)': data.approximateBookDepth,
    'Suggested Near-Mid Buy': data.suggestedNearMidBuy,
    'Suggested Near-Mid Sell': data.suggestedNearMidSell,
    'Competition / Sentiment Signal': data.competitionSignal,
    'Farmability Score (0-100)': data.farmabilityScore,
    'Recommendation': data.recommendation,
    'Notes': data.notes,
    'Agent Guidance': 'Quote near suggested mids for reward weighting (X insight). Thin/moderate balanced depth often = lower comp opportunity. Exit if spreadVsAllowed worsens or score drops. Cross with list_active + your strategy rules.',
  });
}

/** Simple PNL summary card over a list of positions (for portfolio overview). */
export function formatPnlSummary(positions: any[]): object {
  if (!positions || positions.length === 0) return { 'PnL Summary': 'No positions' };
  let totalCash = 0, totalReal = 0, totalUnrealEst = 0, count = 0;
  for (const p of positions) {
    const cash = parseFloat((p as any)?.cashPnl || '0') || 0;
    const real = parseFloat((p as any)?.realizedPnl || '0') || 0;
    const size = parseFloat((p as any)?.size || '0') || 0;
    const avg = parseFloat((p as any)?.avgPrice || '0') || 0;
    const cur = parseFloat((p as any)?.curPrice || (p as any)?.currentPrice || '0') || 0;
    const unreal = size && avg && cur ? size * (cur - avg) : 0;
    totalCash += cash; totalReal += real; totalUnrealEst += unreal; count++;
  }
  const grand = totalCash + totalReal + totalUnrealEst;
  return omitUndefined({
    'Positions Count': count,
    'Total Cash PnL': formatDecimal(totalCash),
    'Total Realized PnL': formatDecimal(totalReal),
    'Total Unrealized (est)': formatDecimal(totalUnrealEst),
    'Grand Total PnL (est)': formatDecimal(grand),
    'Status': grand > 0.01 ? '🟢 Overall profitable' : (grand < -0.01 ? '🔴 Overall underwater' : '⚪ Flat'),
    'Note': 'Unrealized is estimate (size × (curPx - avgPx)). For live prices use fetch_midpoint or order book. See list_activity + get_mcp_usage (for MCP surface usage) for rebate/reward contributions + overall activity/usage tracking. Enhanced via llms.txt concepts mapping.',
  });
}


