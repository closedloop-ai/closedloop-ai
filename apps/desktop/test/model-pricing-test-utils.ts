import {
  computeTokenCost,
  type TokenCostInput,
} from "@closedloop-ai/loops-api/genai-cost";

export type ExpectedTokenCost = TokenCostInput & {
  costUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
};

export function computeExpectedTokenCost(
  input: TokenCostInput
): ExpectedTokenCost {
  const result = computeTokenCost(input);
  if (!(result.priced && typeof result.costUsd === "number")) {
    throw new Error(`Expected ${input.model} to be priced`);
  }
  return {
    ...input,
    costUsd: result.costUsd,
    inputCostUsd: result.inputCostUsd ?? 0,
    outputCostUsd: result.outputCostUsd ?? 0,
    cacheReadCostUsd: result.cacheReadCostUsd ?? 0,
    cacheWriteCostUsd: result.cacheWriteCostUsd ?? 0,
  };
}
