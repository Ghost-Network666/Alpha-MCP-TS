import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { PublicClient, SecureClient, Paginated } from '@polymarket/client';
import {
  createMarketSubscription,
  createUserSubscription,
  type ReconnectingSubscription,
} from '../websocket/subscriptions.js';
import * as F from '../formatters.js';
import { getMarket } from '../data/markets.js';
import { logWs } from '../utils/logger.js';
import { buildMcpLlmsGuide } from './llms-guide.js';
import { fetchLiveSdkReadme } from './sdk-readme.js';

import { createPublicClient, http, parseAbiItem } from 'viem';
import { polygon } from 'viem/chains';

const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as const;
const CTF_POLYGON = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as const;

export const RESOURCE_CAPABILITIES = {
  subscribe: true,
  listChanged: true,
} as const;

// Supported resource templates (for ListResourceTemplates)
export const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'polymarket://market/{tokenId}/book',
    name: 'Market Order Book (Live)',
    description: 'Live order book for a specific outcome token. Subscribe for real-time updates on bids/asks.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'polymarket://market/{tokenId}',
    name: 'Market Snapshot',
    description: 'Current market metadata, prices, and status (snapshot on read).',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'polymarket://user/orders',
    name: 'User Open Orders (Live)',
    description: 'Authenticated user open orders with live updates on placements, fills, and cancels.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'polymarket://user/positions',
    name: 'User Positions',
    description: 'Current portfolio positions (snapshot; subscribe for change notifications).',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'polymarket://user/portfolio',
    name: 'User Portfolio Value',
    description: 'Total portfolio value in USDC (snapshot).',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'polymarket://user/activity',
    name: 'User Activity Feed',
    description: 'Recent account activity (snapshot; subscribe for updates).',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'polymarket://user/fills',
    name: 'User Fills (Real-time)',
    description: 'Filtered view of fills and trades from activity (snapshot; subscribe via user channel for zero-token push on executions). Supports agent real-time awareness without polling.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'polymarket://order/{orderId}/fill-status',
    name: 'Order Fill Watch',
    description: 'Live fill status for a specific order. Subscribe to receive notifications when the order is partially or fully filled. Automatically started for every order placed via placement tools.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'wallet://{address}/events',
    name: 'Wallet Events (Live)',
    description: 'Real-time wallet events for address (trades, order fills, split/merge/redeem). Supports subscribe for push via notifications/resources/updated. Authenticated user WS if own wallet (from credentials); public order-book derived or snapshot for third-party (use after extract_wallet_from_url + list_trades to discover markets). Zero-token monitoring.',
    mimeType: 'application/json',
  },
  {
    uriTemplate: 'polymarket://wallet/{address}/activity',
    name: 'Wallet On-Chain Activity (Live, Public Any Address)',
    description: 'Real-time on-chain activity (USDC transfers + ConditionalTokens splits/merges/redeems/token transfers) for ANY wallet address via viem watchers on Polygon. No auth/credentials required. Use subscribe_wallet_activity({address}) to activate push. Complements list_trades({maker}) historical + auth-only subscribe_user. SDK has no public ClobUser variant or maker-realtime listActivity extension.',
    mimeType: 'application/json',
  },
];

// Static top-level resources
export const STATIC_RESOURCES = [
  {
    uri: 'polymarket://markets',
    name: 'Active Markets',
    description: 'List of currently active platform markets (first page snapshot).',
    mimeType: 'application/json',
  },
  {
    uri: 'polymarket://markets/leaderboard/builders',
    name: 'Builder Leaderboard',
    description: 'Top builders by volume.',
    mimeType: 'application/json',
  },
  {
    uri: 'polymarket://markets/leaderboard/traders',
    name: 'Trader Leaderboard',
    description: 'Top traders by PNL or volume.',
    mimeType: 'application/json',
  },
  {
    uri: 'polymarket://mcp/llms.txt',
    name: 'MCP Full Usage Guide (SDK README + MCP mappings)',
    description: 'MCP overlay mappings (live). Pair with polymarket://sdk/readme for upstream SDK docs.',
    mimeType: 'text/markdown',
  },
  {
    uri: 'polymarket://sdk/readme',
    name: 'Live TS SDK README (upstream)',
    description: 'Fetched at read time from github.com/Polymarket/ts-sdk (cached ~1h). Canonical SDK instructions.',
    mimeType: 'text/markdown',
  },
];

interface ActiveMarketSub {
  sub: ReconnectingSubscription;
  refCount: number;
  tokenId: string;
}

interface ActiveUserSub {
  sub: ReconnectingSubscription;
  refCount: number;
}

export class ResourceManager {
  private server: Server;
  private getPub: () => PublicClient;
  private getSec: () => Promise<SecureClient>;

  private subscribedUris = new Set<string>();

  // Live WS subscriptions (reference counted)
  private marketSubs = new Map<string, ActiveMarketSub>(); // key = tokenId
  private userSub: ActiveUserSub | null = null;

  // Per-order fill watches (powered by the single user WS)
  private watchedOrders: Set<string> = new Set<string>();

  // On-chain viem watchers for *any* public wallet (no auth) - USDC transfers + ConditionalTokens activity (splits/merges/redeems/transfers). Enables polymarket://wallet/{addr}/activity + subscribe_wallet_activity. Refcounted. (Minimal extension for public tracking gap in SDK; no custom buffers.)
  private walletOnchain = new Map<string, { unwatch: (() => void)[]; refCount: number; address: string }>();

  constructor(
    server: Server,
    getPub: () => PublicClient,
    getSec: () => Promise<SecureClient>
  ) {
    this.server = server;
    this.getPub = getPub;
    this.getSec = getSec;
  }

  /** Parse a polymarket:// URI (or legacy wallet://) and return structured info */
  private parseUri(uri: string): { type: string; tokenId?: string; subPath?: string } | null {
    // Support legacy wallet://<address>/events (and /activity) for public any-wallet on-chain tracking
    if (uri.startsWith('wallet://')) {
      const rest = uri.slice('wallet://'.length);
      const parts = rest.split('/').filter(Boolean);
      if (parts.length >= 1) {
        const address = parts[0];
        const subPath = parts[1] || 'events';
        return { type: 'wallet', tokenId: address, subPath };
      }
      return null;
    }
    if (!uri.startsWith('polymarket://')) return null;
    const rest = uri.slice('polymarket://'.length);
    const parts = rest.split('/').filter(Boolean);

    if (parts[0] === 'market' && parts.length >= 2) {
      const tokenId = parts[1];
      const subPath = parts[2]; // 'book' | undefined
      return { type: 'market', tokenId, subPath };
    }
    if (parts[0] === 'user' && parts.length >= 2) {
      return { type: 'user', subPath: parts[1] };
    }
    if (parts[0] === 'markets') {
      if (parts[1] === 'leaderboard' && parts[2]) {
        return { type: 'markets', subPath: `leaderboard/${parts[2]}` };
      }
      return { type: 'markets' };
    }
    if (parts[0] === 'order' && parts.length >= 2) {
      const orderId = parts[1];
      const subPath = parts[2]; // 'fill-status' or undefined
      return { type: 'order', tokenId: orderId, subPath }; // reuse tokenId field for orderId for simplicity
    }
    if (parts[0] === 'mcp') {
      return { type: 'mcp', subPath: parts.slice(1).join('/') || 'llms.txt' };
    }
    if (parts[0] === 'sdk' && parts[1] === 'readme') {
      return { type: 'sdk', subPath: 'readme' };
    }
    if (parts[0] === 'wallet' && parts.length >= 2) {
      const address = parts[1];
      const subPath = parts[2] || 'events';
      return { type: 'wallet', tokenId: address, subPath };
    }
    return null;
  }

  private isUserResource(type: string, subPath?: string): boolean {
    return type === 'user';
  }

  /** Ensure we have a live market WS subscription for this token (idempotent + refcounted) */
  private async ensureMarketSubscription(tokenId: string, uri: string): Promise<void> {
    let entry = this.marketSubs.get(tokenId);
    if (!entry) {
      const pub = this.getPub();
      const sub = createMarketSubscription(pub, [tokenId], {
        onEvent: (event: any) => this.handleMarketEvent(tokenId, event),
      });
      await sub.start();
      entry = { sub, refCount: 0, tokenId };
      this.marketSubs.set(tokenId, entry);
      logWs('Started market resource subscription', { tokenId: tokenId.slice(0, 10) });
    }
    entry.refCount++;
    // Track which URIs are interested in this token's updates
    // (we notify the concrete book URI on events)
  }

  private async ensureUserSubscription(uri: string): Promise<void> {
    if (!this.userSub) {
      const sec = await this.getSec();
      const sub = createUserSubscription(sec, undefined, {
        onEvent: (event: any) => this.handleUserEvent(event),
      });
      await sub.start();
      this.userSub = { sub, refCount: 0 };
      logWs('Started user resource subscription');
    }
    this.userSub.refCount++;
  }

  /**
   * Public method for watch_order_until_filled tool and auto-placement integration.
   * Ensures the authenticated user channel is running (which delivers order/trade events for fills).
   */
  public async ensureUserSubscriptionForWatch(orderId: string): Promise<void> {
    this.watchedOrders.add(orderId);
    await this.ensureUserSubscription(`polymarket://order/${orderId}/fill-status`).catch(() => {});
    logWs('Order watch activated via tool/placement', { orderId: orderId.slice(0, 12) + '...' });
  }

  private async releaseMarketSubscription(tokenId: string): Promise<void> {
    const entry = this.marketSubs.get(tokenId);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      await entry.sub.close().catch(() => {});
      this.marketSubs.delete(tokenId);
      logWs('Closed market resource subscription', { tokenId: tokenId.slice(0, 10) });
    }
  }

  private async releaseUserSubscription(): Promise<void> {
    if (!this.userSub) return;
    this.userSub.refCount--;
    if (this.userSub.refCount <= 0) {
      await this.userSub.sub.close().catch(() => {});
      this.userSub = null;
      logWs('Closed user resource subscription');
    }
  }

  /** On-chain (viem) public wallet activity watcher for USDC + CTF (ConditionalTokens) events. Refcounted per lowercased address. Powers polymarket://wallet/{address}/activity (and legacy wallet://) for any address (SDK User WS is auth-only). */
  private async ensureOnchainWalletSubscription(address: string, uri: string): Promise<void> {
    const key = address.toLowerCase();
    let entry = this.walletOnchain.get(key);
    if (!entry) {
      try {
        const viemClient = createPublicClient({ chain: polygon, transport: http() });
        const unwatchers: (() => void)[] = [];
        const notify = (ev: any) => this.handleWalletOnchainEvent(address, ev);

        // USDC ERC20 Transfer (from/to wallet) - deposits, withdraws, settlements
        const usdcTransfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
        unwatchers.push(viemClient.watchEvent({
          address: USDC_POLYGON,
          event: usdcTransfer,
          onLogs: (logs) => {
            for (const log of logs) {
              const f = (log.args as any)?.from?.toLowerCase?.();
              const t = (log.args as any)?.to?.toLowerCase?.();
              if (f === key || t === key) {
                notify({ type: 'usdc_transfer', payload: { ...(log.args as any), txHash: log.transactionHash, blockNumber: log.blockNumber ? String(log.blockNumber) : '', address: key }, source: 'viem-onchain' });
              }
            }
          },
        }));

        // CTF ERC1155-style + custom events (splits ~ "buy/enter position", merges, redeems, transfers of outcome tokens)
        const ctfSingle = parseAbiItem('event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)');
        unwatchers.push(viemClient.watchEvent({
          address: CTF_POLYGON,
          event: ctfSingle,
          onLogs: (logs) => {
            for (const log of logs) {
              const a = log.args as any;
              const addrs = [a?.from, a?.to, a?.operator].filter(Boolean).map((x: string) => String(x).toLowerCase());
              if (addrs.includes(key)) {
                notify({ type: 'ctf_transfer_single', payload: { ...a, txHash: log.transactionHash, blockNumber: log.blockNumber ? String(log.blockNumber) : '', address: key, tokenId: String(a?.id || '') }, source: 'viem-onchain' });
              }
            }
          },
        }));

        const ctfSplit = parseAbiItem('event PositionSplit(address indexed stakeholder, bytes32 indexed parentCollectionId, bytes32 indexed conditionId, uint256[] partition, uint256[] amount)');
        unwatchers.push(viemClient.watchEvent({
          address: CTF_POLYGON,
          event: ctfSplit,
          onLogs: (logs) => {
            for (const log of logs) {
              const sh = (log.args as any)?.stakeholder?.toLowerCase?.();
              if (sh === key) notify({ type: 'position_split', payload: { ...(log.args as any), txHash: log.transactionHash, blockNumber: log.blockNumber ? String(log.blockNumber) : '', address: key }, source: 'viem-onchain' });
            }
          },
        }));

        const ctfMerge = parseAbiItem('event PositionMerge(address indexed stakeholder, bytes32 indexed parentCollectionId, bytes32 indexed conditionId, uint256[] partition, uint256[] amount)');
        unwatchers.push(viemClient.watchEvent({
          address: CTF_POLYGON,
          event: ctfMerge,
          onLogs: (logs) => {
            for (const log of logs) {
              const sh = (log.args as any)?.stakeholder?.toLowerCase?.();
              if (sh === key) notify({ type: 'position_merge', payload: { ...(log.args as any), txHash: log.transactionHash, blockNumber: log.blockNumber ? String(log.blockNumber) : '', address: key }, source: 'viem-onchain' });
            }
          },
        }));

        const ctfRedeem = parseAbiItem('event PayoutRedemption(address indexed redeemer, bytes32 indexed parentCollectionId, bytes32 indexed conditionId, uint256[] indexSets, uint256 payout)');
        unwatchers.push(viemClient.watchEvent({
          address: CTF_POLYGON,
          event: ctfRedeem,
          onLogs: (logs) => {
            for (const log of logs) {
              const r = (log.args as any)?.redeemer?.toLowerCase?.();
              if (r === key) notify({ type: 'payout_redemption', payload: { ...(log.args as any), txHash: log.transactionHash, blockNumber: log.blockNumber ? String(log.blockNumber) : '', address: key }, source: 'viem-onchain' });
            }
          },
        }));

        entry = { unwatch: unwatchers, refCount: 0, address: key };
        this.walletOnchain.set(key, entry);
        logWs('Started on-chain wallet activity watcher (viem USDC+CTF)', { address: key.slice(0, 10) + '...' });
      } catch (e: any) {
        logWs('On-chain wallet watcher start failed (snapshots + user WS still available)', { address: key, error: (e as Error)?.message || String(e) });
        return;
      }
    }
    entry.refCount++;
  }

  private async releaseOnchainWalletSubscription(address: string): Promise<void> {
    const key = address.toLowerCase();
    const entry = this.walletOnchain.get(key);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount <= 0) {
      for (const u of entry.unwatch) { try { u(); } catch {} }
      this.walletOnchain.delete(key);
      logWs('Closed on-chain wallet activity watcher', { address: key.slice(0, 10) });
    }
  }

  private handleWalletOnchainEvent(address: string, event: any) {
    const addrLower = address.toLowerCase();
    for (const u of this.subscribedUris) {
      if ((u.startsWith('wallet://') || u.includes('wallet/')) && u.toLowerCase().includes(addrLower)) {
        this.server.sendResourceUpdated({ uri: u }).catch(() => {});
      }
    }
    logWs('Onchain wallet activity event', { address: addrLower.slice(0, 8), type: event?.type });
  }

  /** Called by market WS onEvent */
  private handleMarketEvent(tokenId: string, event: any) {
    // We only care about book updates for the primary live resource
    const bookUri = `polymarket://market/${tokenId}/book`;
    if (this.subscribedUris.has(bookUri)) {
      // Per MCP spec, we notify; client will re-read if it wants fresh data
      this.server.sendResourceUpdated({ uri: bookUri }).catch((e) =>
        logWs('Failed to send resource updated', { error: (e as Error).message })
      );
    }

    // Optionally also notify the base market resource (less chatty)
    const marketUri = `polymarket://market/${tokenId}`;
    if (this.subscribedUris.has(marketUri) && (event.type === 'trade' || event.type === 'book')) {
      this.server.sendResourceUpdated({ uri: marketUri }).catch(() => {});
    }
  }

  /** Called by user WS onEvent */
  private handleUserEvent(event: any) {
    const notify = (uri: string) => {
      if (this.subscribedUris.has(uri)) {
        this.server.sendResourceUpdated({ uri }).catch(() => {});
      }
    };

    // Map common user event types to the resources we expose
    if (event.type === 'order' || event.type === 'trade' || event.type === 'fill') {
      notify('polymarket://user/orders');
      notify('polymarket://user/activity');
      notify('polymarket://user/fills');

      // === Per-order fill watch notifications ===
      const orderIdFromEvent = event?.payload?.id || event?.payload?.orderId || event?.id;
      const makerOrders = event?.payload?.maker_orders || event?.makerOrders || [];

      const matchedOrderIds = new Set<string>();
      if (orderIdFromEvent) matchedOrderIds.add(String(orderIdFromEvent));
      for (const mo of makerOrders) {
        if (mo?.orderId) matchedOrderIds.add(String(mo.orderId));
      }

      for (const oid of matchedOrderIds) {
        if (this.watchedOrders.has(oid)) {
          const watchUri = `polymarket://order/${oid}/fill-status`;
          notify(watchUri);
          logWs('Fill update detected for watched order', { orderId: oid });
        }
      }
    }
    if (event.type === 'position' || event.type === 'balance') {
      notify('polymarket://user/positions');
      notify('polymarket://user/portfolio');
    }
    // Always notify activity for any user event
    notify('polymarket://user/activity');

    // Wallet-specific events for subscribed wallet://<address>/events (filter by payload address for auth or public-derived)
    const walletUris = Array.from(this.subscribedUris).filter((u) => u.startsWith('wallet://'));
    if (walletUris.length > 0) {
      const evPayload = event?.payload || event || {};
      const evAddr = String(evPayload?.proxyWallet || evPayload?.maker || evPayload?.user || evPayload?.address || '').toLowerCase();
      if (evAddr) {
        for (const wuri of walletUris) {
          if (wuri.toLowerCase().includes(evAddr)) {
            notify(wuri);
            logWs('Wallet event pushed for subscribed address', { uri: wuri, type: event?.type });
          }
        }
      }
    }
  }

  // ==================== PUBLIC API used by MCP handlers ====================

  async listResources() {
    return {
      resources: STATIC_RESOURCES,
    };
  }

  async listResourceTemplates() {
    return {
      resourceTemplates: RESOURCE_TEMPLATES,
    };
  }

  async readResource(uri: string) {
    const parsed = this.parseUri(uri);
    if (!parsed) {
      throw new Error(`Unsupported resource URI: ${uri}`);
    }

    const pub = this.getPub();

    switch (parsed.type) {
      case 'markets': {
        if (parsed.subPath === 'leaderboard/builders') {
          const paginator = await pub.listBuilderLeaderboard({});
          const page = await paginator.firstPage();
          const items = page?.items ?? [];
          const formatted = items.map((e: any) => F.formatLeaderboardEntry(e));
          return {
            contents: [{
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({ Builders: formatted }, null, 2),
            }],
          };
        }
        if (parsed.subPath === 'leaderboard/traders') {
          const paginator = await pub.listTraderLeaderboard({});
          const page = await paginator.firstPage();
          const items = page?.items ?? [];
          const formatted = items.map((e: any) => F.formatTraderLeaderboardEntry(e));
          return {
            contents: [{
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({ Traders: formatted }, null, 2),
            }],
          };
        }

        // Active markets (first page, open only)
        const paginator: Paginated<unknown> = await pub.listMarkets({ closed: false, pageSize: 20 });
        const page = await paginator.firstPage();
        const items = page?.items ?? [];
        const formatted = Array.isArray(items) ? items.map((m: any) => F.formatMarket(m)) : [];
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ Markets: formatted }, null, 2),
          }],
        };
      }

      case 'sdk': {
        if (parsed.subPath === 'readme') {
          // Per design: MCP does not serve or host full/stale .MD content via tools or resources.
          // Agents must consult the canonical (kept up-to-date) SDK README at the URL first.
          // The mcp_llms_full_guide prompt (and polymarket://mcp/llms.txt) provides the MCP-specific mappings on top of it.
          const guide = buildMcpLlmsGuide();
          const pointer = [
            'SDK source of truth (primary agent instructions): https://github.com/Polymarket/ts-sdk/blob/main/README.md',
            '(Call prompts/get mcp_llms_full_guide to receive the full guide that starts with the SDK README + exact MCP tool mappings for every concept.)',
            '',
            'This resource returns a pointer only. MCP provides no fetch_sdk_readme tool and does not dump full Markdown bodies.',
            '',
            guide
          ].join('\n');
          return {
            contents: [{ uri, mimeType: 'text/markdown', text: pointer }],
          };
        }
        throw new Error(`Unknown sdk resource: ${uri}`);
      }

      case 'mcp': {
        if (parsed.subPath === 'llms.txt' || parsed.subPath === 'usage.md') {
          // Serve the MCP mappings guide. Never attach full external SDK .MD.
          const guide = buildMcpLlmsGuide();
          const pointer = guide + '\n\n---\n\nSDK instructions: https://github.com/Polymarket/ts-sdk/blob/main/README.md (linked and required first in the mcp_llms_full_guide prompt above). MCP resources/tools serve mappings + cards only; do not use for full .MD files.';
          return {
            contents: [{
              uri,
              mimeType: 'text/markdown',
              text: pointer,
            }],
          };
        }
        throw new Error(`Unknown mcp resource: ${uri}`);
      }

      case 'market': {
        if (!parsed.tokenId) throw new Error('Missing tokenId in market URI');
        const tokenId = parsed.tokenId;

        if (parsed.subPath === 'book') {
          const book = await pub.fetchOrderBook({ tokenId });
          const formatted = F.formatOrderBook(book);
          return {
            contents: [{
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(formatted, null, 2),
            }],
          };
        }

        // Default: market snapshot - now use getMarket({tokenId}) for full metadata (via clobTokenIds resolution)
        const [market, book, price] = await Promise.all([
          getMarket({ tokenId }).catch(() => null),
          pub.fetchOrderBook({ tokenId }).catch(() => null),
          pub.fetchMidpoint({ tokenId }).catch(() => null),
        ]);
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              TokenId: tokenId,
              Market: market ? F.formatMarket(market as any) : 'Unavailable',
              Book: book ? F.formatOrderBook(book) : 'Unavailable',
              Midpoint: price,
              Note: 'Full market metadata now resolved via fetch_market / getMarket by tokenId. Use polymarket://market/{tokenId}/book for live book only.',
            }, null, 2),
          }],
        };
      }

      case 'user': {
        const sec = await this.getSec();
        const subPath = parsed.subPath;

        if (subPath === 'orders') {
          const paginator: Paginated<unknown> = await sec.listOpenOrders({});
          const page = await paginator.firstPage();
          const items = page?.items ?? [];
          const formatted = Array.isArray(items) ? items.map((o: any) => F.formatOrder(o)) : [];
          return {
            contents: [{
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({ OpenOrders: formatted.length ? formatted : 'None' }, null, 2),
            }],
          };
        }

        if (subPath === 'positions') {
          const paginator: Paginated<unknown> = await sec.listPositions({ pageSize: 50 });
          const page = await paginator.firstPage();
          const items = page?.items ?? [];
          const formatted = Array.isArray(items) ? items.map((p: any) => F.formatPosition(p)) : [];
          return {
            contents: [{
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({ Positions: formatted.length ? formatted : 'None' }, null, 2),
            }],
          };
        }

        if (subPath === 'portfolio') {
          const value = await sec.fetchPortfolioValue();
          const formatted = F.formatPortfolioValue(value);
          return {
            contents: [{
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(formatted, null, 2),
            }],
          };
        }

        if (subPath === 'activity') {
          const paginator: Paginated<unknown> = await sec.listActivity({ pageSize: 30 });
          const page = await paginator.firstPage();
          const items = page?.items ?? [];
          const formatted = Array.isArray(items) ? items.map((a: any) => F.formatActivity(a)) : [];
          return {
            contents: [{
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({ Activity: formatted.length ? formatted : 'None' }, null, 2),
            }],
          };
        }

        if (subPath === 'fills') {
          const paginator: Paginated<unknown> = await sec.listActivity({ pageSize: 50 });
          const page = await paginator.firstPage();
          const rawItems: any[] = (page?.items ?? []) as any[];
          const items = rawItems.filter((a: any) => ['TRADE', 'FILL', 'REBATE'].includes(String(a?.type || '').toUpperCase()));
          const formatted = Array.isArray(items) ? items.map((a: any) => F.formatActivity(a)) : [];
          return {
            contents: [{
              uri,
              mimeType: 'application/json',
              text: JSON.stringify({ Fills: formatted.length ? formatted : 'None', note: 'Filtered from activity. Subscribe to polymarket://user/orders or user/activity for real-time push (zero additional tokens for events).' }, null, 2),
            }],
          };
        }

        throw new Error(`Unknown user resource: ${uri}`);
      }

      case 'order': {
        const orderId = parsed.tokenId!; // holds the orderId in this context
        const sec = await this.getSec();
        let order: any = null;
        try {
          order = await sec.fetchOrder({ orderId });
        } catch {
          // order may be filled and moved out of open orders, or not visible yet
        }

        const formatted = F.formatOrderFillWatch(order, orderId);
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(formatted, null, 2),
          }],
        };
      }

      case 'wallet': {
        const address = parsed.tokenId!;
        const sec = await this.getSec().catch(() => null as any);
        let items: any[] = [];
        try {
          if (sec) {
            // Prefer listTrades if attached via allActions for maker-specific; fallback to filtered activity
            if (typeof (sec as any).listTrades === 'function') {
              const paginator = await (sec as any).listTrades({ maker: address, pageSize: 20 });
              const page = await (typeof paginator.firstPage === 'function' ? paginator.firstPage() : paginator);
              items = page?.items ?? [];
            } else {
              const paginator: Paginated<unknown> = await sec.listActivity({ pageSize: 30 });
              const page = await (typeof paginator.firstPage === 'function' ? paginator.firstPage() : paginator);
              const rawItems: any[] = (page && typeof page === 'object' && 'items' in page ? (page as any).items : (Array.isArray(page) ? page : [])) as any[];
              items = rawItems.filter((a: any) => {
                const p = a?.payload || a;
                const addr = String(p?.proxyWallet || p?.maker || p?.user || '').toLowerCase();
                return addr === address.toLowerCase();
              });
            }
          }
        } catch {}
        const formatted = items.map((e: any) => F.formatActivity(e));
        return {
          contents: [{
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({
              Address: address,
              Events: formatted.length ? formatted : 'None',
              Note: 'On-chain activity resource for public wallet (viem watchers for USDC/CTF). Subscribe to receive standard MCP resource/updated notifications. Snapshot from SDK list_trades({maker}) or filtered activity. SDK limitation: no public auth-free ClobUser realtime; this surfaces the gap.',
            }, null, 2),
          }],
        };
      }

      default:
        throw new Error(`Unsupported resource: ${uri}`);
    }
  }

  async subscribe(uri: string): Promise<void> {
    const parsed = this.parseUri(uri);
    if (!parsed) {
      throw new Error(`Cannot subscribe to unsupported URI: ${uri}`);
    }

    // Prevent duplicate subscription tracking
    if (this.subscribedUris.has(uri)) {
      return; // already watching
    }

    this.subscribedUris.add(uri);

    try {
      if (parsed.type === 'market' && parsed.tokenId) {
        await this.ensureMarketSubscription(parsed.tokenId, uri);
      } else if (this.isUserResource(parsed.type, parsed.subPath)) {
        // user resources require auth
        await this.ensureUserSubscription(uri);
      } else if (parsed.type === 'order' && parsed.tokenId) {
        this.watchedOrders = this.watchedOrders || new Set<string>();
        this.watchedOrders.add(parsed.tokenId);
        await this.ensureUserSubscription(uri).catch(() => {});
        logWs('Order fill watch registered', { orderId: parsed.tokenId });
      } else if (parsed.type === 'wallet' && parsed.tokenId) {
        // Authenticated if this matches the connected wallet (user WS will deliver events for it); for third-party/public use on-chain viem watchers (new) + public market book derivation.
        const currentWallet = process.env.DEPOSIT_WALLET_ADDRESS || process.env.WALLET_ADDRESS;
        if (currentWallet && parsed.tokenId.toLowerCase() === currentWallet.toLowerCase()) {
          await this.ensureUserSubscription(uri).catch(() => {});
        }
        // Start on-chain listener for USDC/CTF events for this address (enables subscribe_wallet_activity + polymarket://wallet/{addr}/activity for any public wallet, no auth).
        await this.ensureOnchainWalletSubscription(parsed.tokenId, uri).catch(() => {});
        logWs('Wallet resource subscribed (onchain viem for public activity + user WS if auth match)', { address: parsed.tokenId });
      }
      // markets list, leaderboards etc. are snapshot-only; subscription is accepted but produces infrequent/no updates
      logWs('Resource subscribed', { uri });
    } catch (err: any) {
      // Roll back tracking on failure
      this.subscribedUris.delete(uri);
      throw err;
    }
  }

  async unsubscribe(uri: string): Promise<void> {
    if (!this.subscribedUris.has(uri)) return;

    this.subscribedUris.delete(uri);

    const parsed = this.parseUri(uri);
    if (!parsed) return;

    if (parsed.type === 'market' && parsed.tokenId) {
      await this.releaseMarketSubscription(parsed.tokenId);
    } else if (parsed.type === 'user') {
      await this.releaseUserSubscription();
    } else if (parsed.type === 'order') {
      // No dedicated WS per order — powered by the shared user subscription
      this.watchedOrders?.delete(parsed.tokenId!);
    } else if (parsed.type === 'wallet' && parsed.tokenId) {
      await this.releaseOnchainWalletSubscription(parsed.tokenId).catch(() => {});
    }
    logWs('Resource unsubscribed', { uri });
  }

  /** Cleanup everything (on server shutdown) */
  async closeAll(): Promise<void> {
    for (const entry of this.marketSubs.values()) {
      await entry.sub.close().catch(() => {});
    }
    this.marketSubs.clear();

    if (this.userSub) {
      await this.userSub.sub.close().catch(() => {});
      this.userSub = null;
    }

    // Clean on-chain wallet activity watchers (viem) so public any-wallet tracking resources don't leak on shutdown/reload. The agent controls subscription lifecycle via subscribe/unsubscribe.
    for (const entry of this.walletOnchain.values()) {
      for (const u of entry.unwatch) { try { u(); } catch {} }
    }
    for (const entry of this.walletOnchain.values()) {
      for (const u of entry.unwatch) { try { u(); } catch {} }
    }
    this.walletOnchain.clear();

    this.subscribedUris.clear();
  }
}

// Factory helper for mcp.ts wiring
export function createResourceManager(
  server: Server,
  getPub: () => PublicClient,
  getSec: () => Promise<SecureClient>
): ResourceManager {
  return new ResourceManager(server, getPub, getSec);
}

