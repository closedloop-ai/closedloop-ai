/**
 * ISS-9584 (PRD-721) — the Sessions list parity corpus, shared by the cloud and
 * desktop list reads.
 *
 * Each query is written ONCE, as an ISS-9476 {@link ListQueryExpression}. Each
 * host lowers it its own way and runs it against its own store:
 *   - apps/api/app/agent-sessions/service/session-list-parity.integration.test.ts
 *     (the query string the route parses, the ISS-9477 `listQuery` lowering,
 *     then `findSessions` on Postgres);
 *   - apps/desktop/test/session-list-parity.test.ts (expression →
 *     `SharedAgentSessionsQuery` → `getSharedAgentSessions` on SQLite, through
 *     both the SQL cursor tier and the hydrated tier, and again through the
 *     `pageData` read the Sessions page takes its rows from).
 * A row's key is its `externalSessionId` on both hosts: the desktop list serves
 * it as `id`, the cloud list as `externalSessionId`.
 *
 * Three kinds of case:
 *   - {@link SessionListParityCaseKind.Conform}: both hosts return
 *     `expectedKeys`, in order, and the `total` `parityTotalOf` names
 *     (ISS-9483). Sort values are unique among the rows a case
 *     returns, so no conform case leans on the id tie-break. A last-activity
 *     tie counts its start time, which both hosts narrow it by.
 *   - {@link SessionListParityCaseKind.DesktopRefusal}: the desktop capability
 *     refuses the query (ISS-9476); the cloud serves it.
 *   - {@link SessionListParityCaseKind.KnownDivergence}: the hosts disagree
 *     today and each side asserts its CURRENT answer, so resolving the
 *     divergence flips a test. None is fixed here.
 *
 * The model and builders are `session-list-parity-model.ts`; the scenarios
 * are `session-list-parity-{conform,evidence,semantic,divergences}.ts`. This
 * module gathers them.
 *
 * Pure data and pure functions: no test runner, no database, no Electron.
 */
import {
  SESSION_LIST_PARITY_CONFORM_SCENARIO,
  SESSION_LIST_PARITY_NARROWING_SCENARIO,
} from "./session-list-parity-conform";
import { SESSION_LIST_PARITY_DIVERGENCE_SCENARIOS } from "./session-list-parity-divergences";
import { SESSION_LIST_PARITY_EVIDENCE_SCENARIO } from "./session-list-parity-evidence";
import type { SessionListParityScenario } from "./session-list-parity-model";
import { SESSION_LIST_PARITY_SEMANTIC_SCENARIO } from "./session-list-parity-semantic";

/** Every scenario, each seeded into its own store on each host. */
export const SESSION_LIST_PARITY_SCENARIOS: readonly SessionListParityScenario[] =
  [
    SESSION_LIST_PARITY_CONFORM_SCENARIO,
    SESSION_LIST_PARITY_NARROWING_SCENARIO,
    SESSION_LIST_PARITY_EVIDENCE_SCENARIO,
    SESSION_LIST_PARITY_SEMANTIC_SCENARIO,
    ...SESSION_LIST_PARITY_DIVERGENCE_SCENARIOS,
  ];
