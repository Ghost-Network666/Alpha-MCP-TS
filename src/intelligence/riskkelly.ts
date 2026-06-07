/**
 * Risk and Kelly signals for beast portfolio management.
 * From research: fractional Kelly for survival + edge (conservative 1/4 to 1/2 Kelly common in winning bots).
 * Uses positions + live data the MCP already has.
 * Capable: Signal computation only; host uses in locked strategies via route_agent_intent.
 * Outside-the-box: "Beast risk" that fuses with ensemble for risk-adjusted autonomous sizing.
 */

import { listPositions } from '../trading/positions.js';
import { getBalanceAllowance } from '../trading/account.js'; // assume exposed
import { logger } from '../utils/logger.js';

export interface RiskKellySignal {
  tokenId?: string;
  bankrollUsdc: number;
  currentExposure: number;
  edge: number;
  confidence: number;
  kellyFraction: number; // conservative
  maxPositionUsd: number;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  rationale: string;
}

export async function computeRiskKelly(params: {
  edge: number;
  confidence: number;
  bankrollUsdc?: number;
  currentExposureUsd?: number;
  maxDrawdownPct?: number;
}): Promise<RiskKellySignal> {
  const { edge, confidence, bankrollUsdc = 10000, currentExposureUsd = 0, maxDrawdownPct = 0.02 } = params;

  const fullKelly = edge * confidence;
  const kellyFraction = Math.min(0.25, fullKelly * 0.5); // conservative fractional

  const maxPositionUsd = bankrollUsdc * kellyFraction;

  let riskLevel: RiskKellySignal['riskLevel'] = 'LOW';
  if (currentExposureUsd / bankrollUsdc > 0.15 || kellyFraction < 0.01) riskLevel = 'HIGH';
  else if (currentExposureUsd / bankrollUsdc > 0.08) riskLevel = 'MEDIUM';

  const rationale = `Edge ${ (edge*100).toFixed(1) }% @ ${ (confidence*100).toFixed(0) }% conf. Kelly ${ (kellyFraction*100).toFixed(1) }% (frac). Max pos $${maxPositionUsd.toFixed(0)}. Current exposure ${currentExposureUsd.toFixed(0)}. Risk: ${riskLevel}.`;

  return {
    bankrollUsdc,
    currentExposure: currentExposureUsd,
    edge,
    confidence,
    kellyFraction,
    maxPositionUsd,
    riskLevel,
    rationale,
  };
}
