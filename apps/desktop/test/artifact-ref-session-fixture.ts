/**
 * @file artifact-ref-session-fixture.ts
 * @description The `NormalizedSession` fixture the artifact-ref suites drive
 * `extractArtifactRefs` with, plus the `NOW` instant they date it against.
 *
 * Extracted from `artifact-ref-extractor.test.ts` (ISS-7571) when the
 * shell-quote suite moved to its own file: both suites need the identical
 * fixture, and a second copy is the drift the repo's "extract a nontrivial test
 * fixture into a shared module" rule exists to stop — the ISS-5236 relationship
 * between `SESSION_STARTED_AT` and `NOW` is exactly the kind of contract a copy
 * loses.
 */
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { makeSession as baseSession } from "./normalized-session-test-utils.js";

/**
 * The fixture session's own start instant — source-derived, captured by the
 * parser from the transcript. ISS-5236: this, NOT `NOW`, is what a scan-time ref
 * (one with no event of its own to date it) must be stamped with. Kept strictly
 * earlier than `NOW` so the two can never be confused by an assertion.
 */
const SESSION_STARTED_AT = "2024-01-01T00:00:00.000Z";

/**
 * The caller's import wall clock. Before ISS-5236 every scan-time ref was
 * stamped with this; it must now never reach a ref's `observedAt`.
 */
export const NOW = "2024-01-01T12:00:00.000Z";

export function makeSession(
  overrides: Partial<NormalizedSession> & {
    messages?: NormalizedSession["messages"];
    toolUses?: NormalizedSession["toolUses"];
  } = {}
): NormalizedSession {
  return baseSession({
    sessionId: "test-session-1",
    name: "test",
    cwd: null,
    model: null,
    startedAt: SESSION_STARTED_AT,
    endedAt: null,
    ...overrides,
  });
}
