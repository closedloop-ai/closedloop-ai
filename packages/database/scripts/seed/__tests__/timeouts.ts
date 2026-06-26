/**
 * Shared Vitest budget for seed tests that do real I/O — either spawning the
 * real `pnpm seed` binary (pnpm + tsx + generated Prisma client cold start) or
 * seeding a real Postgres. That work routinely exceeds Vitest's 5s default
 * test/hook timeout under CI or parallel load, surfacing as flaky
 * `Test timed out in 5000ms` aborts that have nothing to do with the assertions.
 *
 * This is the floor for *un-annotated* integration tests (set as the
 * `testTimeout`/`hookTimeout` in vitest.config.integration.ts) and the per-test
 * budget for the entrypoint unit suite. To keep the subprocess's own timeout —
 * not Vitest — the operative limit (so a genuine hang fails with captured
 * output, not a bare Vitest abort), it must stay above the worst-case *total*
 * time a single un-annotated test can spend in subprocesses.
 *
 * Sizing: the suite's subprocess timeout is 120s (COMMAND_TIMEOUT_MS in
 * reset.integration / LOCAL_LATENCY_MS in smoke), and the worst un-annotated
 * test (reset's "keeps invalid flag and guard failure output private") runs two
 * back-to-back `pnpm seed` spawns — 240s worst case. 300s clears that with
 * margin. A test that chains more or longer spawns than this floor covers must
 * set its own per-`it` budget above its total (as reset's and smoke's
 * multi-spawn `it`s do).
 */
export const SEED_DB_TEST_TIMEOUT_MS = 300_000;
