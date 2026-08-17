/**
 * @file rollup-options-test-utils.ts
 * @description ISS-5098 (wongk, #4355): the shared, deliberately inert reporter
 * for suites that drive the session-analytics rollup but do not assert on its
 * diagnostics.
 *
 * `SessionAnalyticsRollupOptions.log` is REQUIRED, and so is the invocation row
 * writer's reporter, because the legacy stored-session bootstrap the rollup runs
 * builds invocation candidates from `events.agent_id` — a column with no foreign
 * key — and the writer nulls any reference no `agents` row satisfies rather than
 * let it abort the whole insert. An omittable reporter would let that drop commit
 * in silence, which is the attribution loss the guard exists to prevent.
 *
 * Deliberately its own lightweight module: the suites that need it do not
 * otherwise import the Prisma test harness, and a test helper must not drag a
 * heavy runtime in for one constant.
 *
 * A suite that ASSERTS on reporting passes its own recorder instead of this.
 */
import type { SessionAnalyticsRollupOptions } from "../src/main/database/session-analytics-rollup.js";

export const ROLLUP_OPTS: SessionAnalyticsRollupOptions = {
  log: () => undefined,
};
