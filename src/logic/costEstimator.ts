/**
 * Cost & Burn Rate Estimation Strategy
 *
 * This module shapes how token consumption across different AI models
 * (Claude Sonnet, Opus, Haiku, Codex, DeepSeek) translates into estimated daily cost
 * and attention badges on the Kindle e-ink display.
 */

export interface TokenUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelName: string;
}

export interface CostEstimateResult {
  estimatedCostUsd: number;
  burnRatePerHourUsd: number;
  efficiencyTier: 'economic' | 'moderate' | 'heavy';
}

/**
 * Calculates estimated cost and efficiency rating based on model rates.
 *
 * Standard Reference Rates (per million tokens):
 * - Claude 3.7 / 3.5 Sonnet: $3.00 input, $15.00 output, $0.30 cache read
 * - Claude 3.5 Haiku: $0.80 input, $4.00 output, $0.08 cache read
 * - Claude Opus: $15.00 input, $75.00 output, $1.50 cache read
 * - DeepSeek / Local: $0.14 - $0.28 input/output
 */
export function calculateTokenCost(usage: TokenUsageBreakdown, activeHoursToday: number = 4): CostEstimateResult {
  // TODO: User Contribution Opportunity
  // Implement the cost calculation formula and efficiency tier categorization below:
  //
  // Consider:
  // 1. How you want to price cache read tokens vs fresh input tokens (e.g. 90% cache discount).
  // 2. What threshold should trigger the 'heavy' vs 'economic' tier badge on your e-ink board.

  let estimatedCostUsd = 0.0;
  let burnRatePerHourUsd = 0.0;
  let efficiencyTier: CostEstimateResult['efficiencyTier'] = 'economic';

  // --- YOUR IMPLEMENTATION GOES HERE ---
  // (Replace this default placeholder)
  const blendedRatePerMillion = usage.modelName.toLowerCase().includes('opus')
    ? 25.0
    : usage.modelName.toLowerCase().includes('haiku')
    ? 1.5
    : 4.5; // default Sonnet blend

  const totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens * 0.1;
  estimatedCostUsd = parseFloat(((totalTokens / 1_000_000) * blendedRatePerMillion).toFixed(2));
  burnRatePerHourUsd = activeHoursToday > 0 ? parseFloat((estimatedCostUsd / activeHoursToday).toFixed(2)) : 0;
  efficiencyTier = estimatedCostUsd > 10.0 ? 'heavy' : estimatedCostUsd > 3.0 ? 'moderate' : 'economic';
  // -------------------------------------

  return {
    estimatedCostUsd,
    burnRatePerHourUsd,
    efficiencyTier,
  };
}
