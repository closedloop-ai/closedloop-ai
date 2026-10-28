/**
 * ISS-9483 (PRD-721 R10-S08) — latency and result size of the DESKTOP
 * Sessions list read, per parity-corpus query, at the store sizes production
 * desktops hold (`DESKTOP_STORE_SESSIONS`).
 *
 * A measurement, not a gate: nothing here asserts a duration. Each conform
 * query of the parity corpus's conform scenario is sent to
 * `getSharedAgentSessions` — the list query alone, the same scope the cloud
 * sibling bench measures via `findSessions`
 * (`apps/api/app/agent-sessions/service/session-list-query.bench.ts`), so
 * `total`/`pageItems`/`responseBytes` compare like with like across hosts.
 * This is narrower than the registered `pageData` IPC handler, which
 * additionally bundles the usage aggregate and facet counts into one round
 * trip; that broader read has no cloud-side equivalent measured here.
 * Each query's latency statistics, the `total` and page size it returned, and
 * the bytes of the response are printed as JSON lines.
 *
 * Run: pnpm -C apps/desktop exec vitest bench --run --config vitest.node.config.ts test/session-list-query.bench.ts
 */
import {
  baselineP95Of,
  p95Of,
  SessionListBenchHost,
} from "@repo/lib/sessions/__tests__/session-list-bench-baseline.js";
import {
  DESKTOP_STORE_SESSIONS,
  replicateParityRows,
} from "@repo/lib/sessions/__tests__/session-list-parity-bench-scale.js";
import { SESSION_LIST_PARITY_CONFORM_SCENARIO } from "@repo/lib/sessions/__tests__/session-list-parity-conform.js";
import {
  parityCasesOf,
  SessionListParityCaseKind,
} from "@repo/lib/sessions/__tests__/session-list-parity-model.js";
import { afterAll, beforeAll, test, vi } from "vitest";
import { coerceSharedAgentSessionsListRequest } from "../src/main/dashboard/agent-dashboard-ipc-coercion.js";
import { ensureOrgDirectory } from "../src/main/session/org-directory-cache.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import {
  closeParityHost,
  openParityStore,
  PARITY_API_KEY,
  PARITY_API_ORIGIN,
  parityOrgDirectoryResponse,
  parityPayloadOf,
} from "./support/session-list-parity-host.js";

const scenario = SESSION_LIST_PARITY_CONFORM_SCENARIO;
const cases = parityCasesOf(scenario, SessionListParityCaseKind.Conform);

beforeAll(async () => {
  // The measured loop below calls only `getSharedAgentSessions`, which reads
  // the org directory via `getOrgDirectorySnapshot()` — a plain getter with
  // no refresh — so nothing here calls `pageData`/`ensureOrgDirectory` again
  // after this warm-up. Global fetch stays stubbed to
  // `parityOrgDirectoryResponse` anyway (the repo's own idiom, e.g.
  // `vibe-profile-sign-in-iss12394.test.ts`) as cheap insurance: if a future
  // caller here reintroduces a `pageData`/`ensureOrgDirectory` call with no
  // `fetchImpl`, `ORG_DIRECTORY_TTL_MS` (5 min) would otherwise let a
  // background refresh past minute 5 reach the real
  // `https://api.parity.test/users` and fail on DNS, on the same event loop
  // as the measured samples.
  vi.stubGlobal("fetch", parityOrgDirectoryResponse);
  await ensureOrgDirectory({
    getApiOrigin: () => PARITY_API_ORIGIN,
    getApiKey: () => PARITY_API_KEY,
    fetchImpl: parityOrgDirectoryResponse,
  });
});

afterAll(async () => {
  await closeParityHost();
  vi.unstubAllGlobals();
});

test.for(Object.entries(DESKTOP_STORE_SESSIONS))(
  "desktop Sessions list read at the %s store size",
  { timeout: 0 },
  async ([percentile, sessions], { bench }) => {
    const rows = replicateParityRows(scenario.rows, sessions);
    const db = await openParityStore(rows);
    for (const parityCase of cases) {
      const payload = parityPayloadOf(parityCase);
      const request = coerceSharedAgentSessionsListRequest(payload);
      const response = await getSharedAgentSessions(db.syncSource, request);
      const result = await bench(`${percentile} ${parityCase.name}`, () =>
        getSharedAgentSessions(db.syncSource, request)
      ).run({ retainSamples: true });
      const p95Ms = p95Of(result.latency.samples ?? []);
      record({
        host: SessionListBenchHost.Desktop,
        storePercentile: percentile,
        rows: rows.length,
        query: parityCase.name,
        samples: result.latency.samplesCount,
        meanMs: result.latency.mean,
        p50Ms: result.latency.p50,
        p75Ms: result.latency.p75,
        p95Ms,
        baselineP95Ms: baselineP95Of(
          SessionListBenchHost.Desktop,
          percentile,
          parityCase.name
        ),
        p99Ms: result.latency.p99,
        total: response.total,
        pageItems: response.items.length,
        responseBytes: Buffer.byteLength(JSON.stringify(response)),
      });
    }
  }
);

/**
 * One query's measurement, printed as a JSON line as soon as it is taken, so
 * a run stopped part-way still has every query it finished in its output.
 */
function record(entry: Record<string, unknown>): void {
  console.info(JSON.stringify(entry));
}
