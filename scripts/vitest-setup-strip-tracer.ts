/**
 * ISS-4436. Stop the dd-trace preload from propagating into child processes.
 *
 * The script-tier lanes set
 * `NODE_OPTIONS=-r dd-trace/ci/init --import dd-trace/register.js` so the tracer
 * instruments Vitest. Many of these suites then `spawnSync` a real `node`/`tsx`
 * child to exercise a CLI end to end, usually with `cwd` pointed at a temp
 * fixture directory. That child inherits `NODE_OPTIONS` but cannot resolve
 * `dd-trace` from its own cwd, so it dies before running anything:
 *
 *   Error: Cannot find module 'dd-trace/ci/init'
 *   Require stack: - internal/preload
 *
 * The test then asserts on empty output and fails. This is the same failure
 * class pr-test.yml already documents for the e2e lanes, where a forwarded
 * NODE_OPTIONS lands on pnpm and kills its workers with MODULE_NOT_FOUND.
 *
 * Stripping it here is safe: `setupFiles` run INSIDE an already-started Vitest
 * worker, so the preload has done its work and the tracer's module hooks are
 * installed. Mutating `process.env` afterwards cannot un-instrument this
 * process — it only changes what children inherit. The lane still reports.
 *
 * Deliberately narrow: it removes only the tracer tokens and preserves
 * everything else in NODE_OPTIONS (e.g. `--max-old-space-size`, which is
 * load-bearing on some lanes), and it leaves the variable unset if it ends up
 * empty rather than exporting an empty string.
 *
 * The strip itself lives in `scripts/tracer-preload-tokens.mjs` rather than
 * here: the desktop runner, the build wrapper and the inheritance regression
 * test remove the same preload and each held its own copy of the matching, kept
 * in step only by a comment. This file used to hold one of those copies, and it
 * knew only the literal token text — so it left `--require=dd-trace/ci/init`,
 * the same instruction in Node's other spelling, in place (ISS-8775).
 */
import { withoutTracerPreload } from "./tracer-preload-tokens.mjs";

const remaining = withoutTracerPreload(process.env).NODE_OPTIONS;
if (remaining === undefined) {
  Reflect.deleteProperty(process.env, "NODE_OPTIONS");
} else {
  process.env.NODE_OPTIONS = remaining;
}
