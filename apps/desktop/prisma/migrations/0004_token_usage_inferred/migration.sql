-- FEA-2085: distinguish a guessed Codex model attribution from a genuine one.
--
-- The Codex parser previously keyed token rows under the unpriceable placeholder
-- "gpt-codex" when a rollout carried no extractable model id. That id matched no
-- @pydantic/genai-prices entry, producing a token_cost.pricing_miss (FEA-2082).
-- The parser now falls back to the real, priceable "gpt-5-codex" instead, which
-- is indistinguishable in the data from a genuine gpt-5-codex session. This
-- column preserves the "this attribution was inferred (guessed)" signal that the
-- placeholder string used to carry implicitly.
ALTER TABLE "token_usage" ADD COLUMN "inferred" BOOLEAN NOT NULL DEFAULT false;
