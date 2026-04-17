import { getOne } from "../db.js";

export type Tier = "RELIABLE" | "ELEVATED" | "HIGH_RISK";

export function computeInsuranceRate(failureRate: number): number {
  return Math.max(0.001, failureRate * 1.5 + 0.001);
}

export function computeTier(insuranceRate: number): Tier {
  if (insuranceRate < 0.01) return "RELIABLE";
  if (insuranceRate <= 0.05) return "ELEVATED";
  return "HIGH_RISK";
}

export async function getEffectiveRate(
  baseRate: number,
  agentId: string,
  providerId: string,
): Promise<number> {
  const adjustment = await getOne<{ loading_factor: string }>(
    "SELECT loading_factor FROM premium_adjustments WHERE agent_id = $1 AND provider_id = $2",
    [agentId, providerId],
  );
  const factor = adjustment ? parseFloat(adjustment.loading_factor) : 1.0;
  return baseRate * factor;
}
