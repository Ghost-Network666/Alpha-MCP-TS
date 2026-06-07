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
    uriTemplate: 'polymarket://order/{orderId}/fill-status',
    name: 'Order Fill Watch',
    description: 'Live fill status for a specific order. Subscribe to receive notifications when the order is partially or fully filled. Automatically started for every order placed via placement tools.',
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

  constructor(
    server: Server,
    getPub: () => PublicClient,
    getSec: () => Promise<SecureClient>
  ) {
    this.server = server;
    this.getPub = getPub;
    this.getSec = getSec;
  }

  /** Parse a polymarket:// URI and return structured info */
  private parseUri(uri: string): { type: string; tokenId?: string; subPath?: string } | null {
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
          try {
            const live = await fetchLiveSdkReadme();
            const header = `# Live SDK README (@polymarket/client@${live.installedVersion})\nSource: ${live.sourceUrl}\nFetched: ${live.fetchedAt}\nCanonical: ${live.canonicalUrl}\n\n`;
            return {
              contents: [{ uri, mimeType: 'text/markdown', text: header + live.markdown }],
            };
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            const fallback = buildMcpLlmsGuide();
            return {
              contents: [{
                uri,
                mimeType: 'text/markdown',
                text: `# SDK README fetch failed\n${msg}\n\n## MCP fallback guide\n\n${fallback}`,
              }],
            };
          }
        }
        throw new Error(`Unknown sdk resource: ${uri}`);
      }

      case 'mcp': {
        if (parsed.subPath === 'llms.txt' || parsed.subPath === 'usage.md') {
          const guide = buildMcpLlmsGuide();
          let sdkBlock = '';
          try {
            const live = await fetchLiveSdkReadme();
            sdkBlock = `\n\n---\n\n## Live SDK README (attached)\n@polymarket/client@${live.installedVersion} — ${live.sourceUrl}\n\n${live.markdown.slice(0, 120_000)}\n`;
          } catch {
            sdkBlock = '\n\n---\n\n(Live SDK README unavailable — use tools/call fetch_sdk_readme or resource polymarket://sdk/readme)\n';
          }
          return {
            contents: [{
              uri,
              mimeType: 'text/markdown',
              text: guide + sdkBlock,
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

// Beast live signals resource (final improvement for real-time autonomous)
  {
    uriTemplate: 'polymarket://beast/signals/{tokenId}',
    name: 'Beast Trading Signals (Live)',
    description: 'Fused research-backed beast signals (mispricing, momentum, ensemble edge, orderflow, risk/Kelly, cross-market). Subscribe for real-time updates to drive host autonomous loops.',
    mimeType: 'application/json',
  },
