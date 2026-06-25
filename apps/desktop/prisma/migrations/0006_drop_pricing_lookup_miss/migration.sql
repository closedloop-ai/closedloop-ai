-- FEA-2134: drop the pricing_lookup_miss table. The genai-prices engine is now
-- the single token-cost source for all harnesses (no separate FEA-1845 path),
-- and unpriced-model misses are reported through the reportTokenCostPricingMiss
-- observability seam instead of this write-only table.
DROP TABLE IF EXISTS "pricing_lookup_miss";
