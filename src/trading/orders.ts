import type {
  OrderResponse,
  CancelOrdersResponse,
  OpenOrder,
} from '@polymarket/client';

// Request types are beta-SDK internal; use loose typing for now
type PrepareLimitOrderRequest = any;
import { getSecureClient, withBuilderAttribution } from '../config/client.js';
import { collectAll } from '../utils/pagination.js';
import { withErrorHandling } from '../utils/errors.js';
import { logger, logTrade } from '../utils/logger.js';

const secure = () => getSecureClient();

/**
 * Place a limit order. Returns discriminated response (check .ok).
 */
export async function submitLimitOrder(params: any): Promise<OrderResponse> {
  const client = await secure();
  const attributedParams = withBuilderAttribution(params);
  logTrade('Placing limit order', { side: attributedParams.side, price: attributedParams.price, size: attributedParams.size, tokenId: attributedParams.tokenId.slice(0, 8) });
  const resp = await withErrorHandling(
    () => client.placeLimitOrder(attributedParams),
    'trading.placeLimitOrder'
  );
  if (resp.ok) {
    logTrade('Limit order accepted', { orderId: resp.orderId });
  } else {
    logger.warn('Limit order rejected', { code: resp.code, message: resp.message });
  }
  return resp;
}

/**
 * Place market order (FOK/FAK).
 */
export async function submitMarketOrder(params: any): Promise<OrderResponse> {
  const client = await secure();
  const attributedParams = withBuilderAttribution(params);
  logTrade('Placing market order', { side: attributedParams.side, tokenId: attributedParams.tokenId?.slice?.(0, 8), amount: attributedParams.amount, shares: attributedParams.shares });
  const resp = await withErrorHandling(() => client.placeMarketOrder(attributedParams), 'trading.placeMarketOrder');
  if (resp.ok) {
    logTrade('Market order filled', { orderId: resp.orderId });
  }
  return resp;
}

export async function cancelSingleOrder(orderId: string): Promise<CancelOrdersResponse> {
  const client = await secure();
  logger.info('Cancelling order', { orderId });
  return withErrorHandling(() => client.cancelOrder({ orderId }), 'trading.cancelOrder');
}

export async function cancelAllOrders(): Promise<CancelOrdersResponse> {
  const client = await secure();
  logger.warn('Cancelling ALL open orders');
  return withErrorHandling(() => client.cancelAll(), 'trading.cancelAll');
}

export async function cancelOrdersForMarket(tokenIdOrMarket: { tokenId?: string; market?: string }) {
  const client = await secure();
  return withErrorHandling(
    () => client.cancelMarketOrders(tokenIdOrMarket),
    'trading.cancelMarketOrders'
  );
}

export async function getOpenOrders(params?: { market?: string; tokenId?: string; id?: string }) {
  const client = await secure();
  const paginator = client.listOpenOrders(params || {});
  return collectAll(paginator, { maxPages: 50 });
}

export async function getOrder(orderId: string): Promise<OpenOrder> {
  const client = await secure();
  return withErrorHandling(() => client.fetchOrder({ orderId }), 'trading.fetchOrder');
}

/**
 * Helper: cancel then place replacement (common for quote updates).
 */
export async function replaceLimitOrder(
  oldOrderId: string | undefined,
  newParams: PrepareLimitOrderRequest
): Promise<OrderResponse> {
  if (oldOrderId) {
    try {
      await cancelSingleOrder(oldOrderId);
    } catch (e) {
      logger.debug('Cancel during replace failed (order may already be gone)', { oldOrderId });
    }
  }
  return submitLimitOrder(newParams);
}
