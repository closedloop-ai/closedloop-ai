-- FEA-3419: typed cache-write TTL subdivision (5-minute vs 1-hour ephemeral
-- prompt-cache writes). Anthropic bills 5m writes at 1.25x the base input rate
-- and 1h writes at 2.0x; per-event pricing needs the split at token_events
-- granularity and the aggregate pricing path needs it per (session, model).
--
-- NULLABLE ON PURPOSE, NO DEFAULT: NULL is the provenance marker for "provider
-- never reported a breakdown" (legacy transcripts, non-Claude harnesses,
-- compaction baselines). A reported-zero split stores explicit 0/0. The pair is
-- always written together; fiveM + oneH <= cache_write_tokens is enforced
-- upstream by the parser's validateCacheWriteTtl (all-or-absent rejection).
ALTER TABLE "token_usage" ADD COLUMN "cache_write_5m_tokens" BIGINT;
ALTER TABLE "token_usage" ADD COLUMN "cache_write_1h_tokens" BIGINT;
ALTER TABLE "token_events" ADD COLUMN "cache_write_5m_tokens" BIGINT;
ALTER TABLE "token_events" ADD COLUMN "cache_write_1h_tokens" BIGINT;
