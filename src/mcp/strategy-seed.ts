/** Session-default strategy keys (in-memory + optional disk persist). */

export function seedSessionStrategyDefaults(
  store: Map<string, unknown>,
  profileHint = 'session'
): boolean {
  if (store.size > 0) return false;
  const now = new Date().toISOString();
  store.set('rules:session_defaults', {
    quoteNearMid: true,
    bothSides: false,
    maxRequoteRatePerSidePerSec: 10,
    minRequoteIntervalMs: 200,
    maxMinCostUsd: 5,
    midPriceMin: 0.45,
    midPriceMax: 0.55,
    preferredTopics: [profileHint === 'rewards' ? 'rewards' : profileHint],
    updatedAt: now,
    note: 'Auto-seeded when strategy store was empty — evolve via update_strategy.',
  });
  store.set('filter:liquidity_discovery', {
    liquidityNumMin: 10000,
    volumeNumMin: 5000,
    midPriceMin: 0.45,
    midPriceMax: 0.55,
    updatedAt: now,
  });
  return true;
}