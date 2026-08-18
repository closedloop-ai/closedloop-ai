-- ISS-4920: drop the unused model_pricing and pricing_rules tables. Neither was
-- ever read or written by production code — the genai-prices engine (@repo/cost /
-- @closedloop-ai/loops-api tokens.ts) is the single token-cost source for every harness,
-- and model_pricing carried a regression test asserting it stays empty. Mirrors
-- FEA-2134's 0006_drop_pricing_lookup_miss (same vestigial-pricing-scaffold cleanup).
DROP TABLE IF EXISTS "model_pricing";
DROP TABLE IF EXISTS "pricing_rules";
