/**
 * Known agent pitfalls + SDK-correct mitigations (included in recipes, prompts, get_agent_recipes).
 * SDK reference: PrepareLimitOrderRequest has tokenId, price, size, side, postOnly?, expiration? only.
 */

export const KNOWN_AGENT_GOTCHAS = [
  {
    id: 'farmability_non_reward',
    symptom: 'get_farmability fails or shows Unavailable on non-reward markets; agents pass slug/decimal instead of hex.',
    fix: 'Pass tokenId (0x hex), market slug, or decimal Gamma id — MCP resolves via listMarkets/fetchMarket (SDK). No active reward program → card is book-only (fetchOrderBook + fetchSpreads + fetchMidpoint). For maker rewards use list_active_maker_reward_markets then get_farmability on listed yesTokenId/noTokenId.',
    tools: ['get_farmability', 'list_active_maker_reward_markets', 'fetch_market'],
    sdk: ['fetchOrderBook', 'fetchSpreads', 'fetchMidpoint', 'listMarketRewards'],
  },
  {
    id: 'place_limit_order_type',
    symptom: 'orderType param rejected on place_limit_order.',
    fix: 'SDK placeLimitOrder does NOT accept orderType. GTC = omit expiration; GTD = set expiration (unix sec). postOnly defaults true. FOK/FAK → use place_market_order. Do not pass orderType to the SDK limit path.',
    tools: ['place_limit_order', 'place_market_order'],
    sdk: ['placeLimitOrder', 'placeMarketOrder'],
  },
  {
    id: 'alpha_report_unavailable',
    symptom: 'alpha_report shows Unavailable or score 0 / looks negative.',
    fix: 'Scores are 0–100 (never negative). Low scores = weak/skip actionability, not a crash. Empty scan → relax midPriceMin/Max, liquidityNumMin, or use goal:"rewards" with list_active. Farmability Unavailable on a row → token not in reward band or no book.',
    tools: ['alpha_report', 'generate_alpha_report', 'discover_topic', 'list_active_maker_reward_markets'],
    sdk: ['listMarkets', 'listCurrentRewards'],
  },
  {
    id: 'get_strategies_empty',
    symptom: 'get_strategies returns count:0 on fresh MCP process.',
    fix: 'Expected until first update_strategy/set_strategy OR auto-seed on get_strategies/load_agent_profile (rules:session_defaults + filter:liquidity_discovery). Call get_strategies() first every loop; refine with update_strategy.',
    tools: ['get_strategies', 'update_strategy', 'load_agent_profile'],
    sdk: [],
  },
  {
    id: 'order_book_depth',
    symptom: 'No native order book depth tool.',
    fix: 'Tier-1 get_order_book / get_spread — SDK fetchOrderBook / fetchSpread. Accepts hex tokenId, slug, or decimal market id.',
    tools: ['get_order_book', 'get_spread'],
    sdk: ['fetchOrderBook', 'fetchSpread'],
  },
] as const;

export function buildKnownGotchasMarkdown(): string {
  const lines = KNOWN_AGENT_GOTCHAS.map(
    (g, i) =>
      `${i + 1}. **${g.symptom}**\n   - Fix: ${g.fix}\n   - MCP tools: ${g.tools.join(', ') || 'n/a'}\n   - SDK: ${g.sdk.join(', ') || 'n/a'}`
  );
  return `## Known pitfalls (SDK-native fixes)\n\n${lines.join('\n\n')}`;
}