/**
 * Beast signals aggregator + live resource helper.
 * Outside-the-box: Single call or resource that fuses multiple intelligence for "beast mode" hosts.
 * Hosts can subscribe to polymarket://beast/signals/{tokenId} for real-time autonomous decisions.
 * Capable: Uses existing WS + intelligence; no new brain/loop.
 */

import { getOrderFlowSignal } from '../intelligence/orderflow.js';
import { computeEnsembleEdge } from '../intelligence/ensemble.js';
import { detectMispricing } from '../intelligence/mispricing.js';
import { getMomentumSignal } from '../intelligence/momentum.js';
import { computeRiskKelly } from '../intelligence/riskkelly.js';
import { logger } from '../utils/logger.js';

export async function getBeastSignalBundle(tokenId: string, priorProb = 0.5, bankroll = 10000) {
  const [flow, ensemble, misprice, momentum, risk] = await Promise.all([
    getOrderFlowSignal(tokenId).catch(() => null),
    computeEnsembleEdge(tokenId, priorProb, bankroll).catch(() => null),
    detectMispricing(tokenId).catch(() => null),
    getMomentumSignal(tokenId).catch(() => null),
    computeRiskKelly({ edge: 0.05, confidence: 0.7, bankrollUsdc: bankroll }).catch(() => null),
  ]);

  const topEdge = ensemble?.edge || misprice?.edge || 0;
  const fusedConfidence = Math.max(ensemble?.confidence || 0, momentum?.confidence || 0, misprice?.confidence || 0);

  return {
    tokenId,
    topEdge,
    fusedConfidence,
    signals: { flow, ensemble, misprice, momentum, risk },
    recommendation: topEdge > 0.03 && fusedConfidence > 0.7 ? 'BEAST_EXECUTE' : 'MONITOR',
    rationale: `Fused beast bundle: top edge ${(topEdge*100).toFixed(1)}% @ ${ (fusedConfidence*100).toFixed(0) }% conf. ${ensemble?.rationale || ''}`,
  };
}
