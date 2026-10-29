/**
 * Branch-coverage tests for startup-readiness-state.ts (ISS-11284), targeting
 * branches not exercised by startup-readiness-state.test.ts /
 * startup-readiness-state-verdicts.test.ts: the null/zero savedSessionCount
 * zero-vs-nonzero arm of getHeadline's Ready branch and the dead-lettered-
 * count derivation in getCloudWarning.
 *
 * The null-savedSessionCount arms of getHeadline (Ready/default) are NOT
 * covered here: `buildStartupReadinessModel` sets `malformedSavedSessions`
 * whenever `savedSessions.status === Ready` and the sanitized count is null,
 * which forces NeedsAttention before those phases can be reached — so a null
 * count can never reach Ready or the default headline branch through the
 * public phase machine. Reported as unreachable rather than pinned with a
 * synthetic test.
 */
import { describe, expect, it } from "vitest";
import {
  buildStartupReadinessModel,
  SavedSessionsReadinessStatus,
  StartupReadinessPhase,
} from "../startup-readiness-state";
import {
  CAUGHT_UP_CLOUD_SYNC,
  DRAINED_BACKLOG,
  READY_INPUTS,
} from "./startup-readiness-fixtures";

describe("getHeadline Ready-phase zero vs nonzero arm", () => {
  it("reports zero saved sessions distinctly from a positive count", () => {
    const zero = buildStartupReadinessModel({
      ...READY_INPUTS,
      savedSessions: { status: SavedSessionsReadinessStatus.Ready, total: 0 },
    });

    expect(zero.phase).toBe(StartupReadinessPhase.Ready);
    expect(zero.headline).toBe("No saved sessions found");
  });
});

describe("getCloudWarning dead-letter derivation", () => {
  it("sums session and component dead letters when the backlog count is smaller", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudSync: {
        ...CAUGHT_UP_CLOUD_SYNC,
        deadLetteredSessions: 2,
        deadLetteredComponents: 3,
      },
      cloudSyncBacklog: { ...DRAINED_BACKLOG, deadLetteredCount: 1 },
    });

    expect(model.phase).toBe(StartupReadinessPhase.SyncDeadLettered);
    expect(model.cloudWarning).toBe(
      "5 source files could not sync. Local sessions remain available."
    );
  });

  it("uses the backlog dead-letter count when it exceeds the per-lane sum", () => {
    const model = buildStartupReadinessModel({
      ...READY_INPUTS,
      cloudSync: {
        ...CAUGHT_UP_CLOUD_SYNC,
        deadLetteredSessions: 0,
        deadLetteredComponents: 0,
      },
      cloudSyncBacklog: { ...DRAINED_BACKLOG, deadLetteredCount: 4 },
    });

    expect(model.phase).toBe(StartupReadinessPhase.SyncDeadLettered);
    expect(model.cloudWarning).toBe(
      "4 source files could not sync. Local sessions remain available."
    );
  });
});
