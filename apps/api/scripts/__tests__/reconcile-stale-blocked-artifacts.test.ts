import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconcileOutcome } from "@/app/documents/blocked-dependent-unblock-service";
import {
  createScriptOutput,
  type ScriptOutput,
  type ScriptWritable,
} from "../script-progress-output";

/**
 * ISS-9632 — the operator-facing half of the reconciliation sweep.
 *
 * Two things are pinned here, both because getting them wrong is a data
 * incident rather than a cosmetic bug:
 *
 *  1. PREVIEW IS THE DEFAULT AND PREVIEW WRITES NOTHING. If the `apply` branch
 *     were ever inverted, a plain `npx tsx scripts/reconcile-stale-blocked-artifacts.ts`
 *     — documented as safe and read-only — would mutate every org's artifacts.
 *     The assertions demand that the OTHER function was never called, not just
 *     that the right one was.
 *  2. THE REPORT MAY NOT OVERSTATE WHAT IT MOVED. Applying reports the WRITTEN
 *     set (`unblockedIds`), never the resolved set (`resolvedIds`), which can
 *     be larger when a concurrent write moved a row out of `BLOCKED` and the
 *     update's guard declined it. This script's whole purpose is to be the
 *     evidence that the defect was real; a count that overstates it is worse
 *     than no count. Same failure mode as ISS-8463 on the sibling backfill.
 */

const reconcileStaleBlockedArtifacts = vi.hoisted(() => vi.fn());
const previewStaleBlockedArtifacts = vi.hoisted(() => vi.fn());

vi.mock("@/app/documents/blocked-dependent-unblock-service", () => ({
  blockedDependentUnblockService: {
    reconcileStaleBlockedArtifacts,
    previewStaleBlockedArtifacts,
  },
}));

import { runReconciliation } from "../reconcile-stale-blocked-artifacts";

const TRAILING_NEWLINE = /\n$/;

const ORG_A = "org-a";
const ORG_B = "org-b";

function outcome(
  organizationId: string,
  scanned: number,
  resolvedIds: string[],
  unblockedIds: string[]
): ReconcileOutcome {
  return { organizationId, scanned, resolvedIds, unblockedIds };
}

function captureStream(lines: string[]): ScriptWritable {
  return {
    write(chunk, callback) {
      lines.push(chunk.replace(TRAILING_NEWLINE, ""));
      callback(null);
      return true;
    },
  };
}

async function capture(
  run: (output: ScriptOutput) => Promise<unknown>
): Promise<string[]> {
  const lines: string[] = [];
  await run(
    createScriptOutput({
      stdout: captureStream(lines),
      stderr: captureStream(lines),
    })
  );
  return lines;
}

describe("runReconciliation — preview mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("previews without ever reaching the writing sweep", async () => {
    previewStaleBlockedArtifacts.mockResolvedValue(
      outcome(ORG_A, 4, ["stale-1"], [])
    );

    const lines = await capture((output) =>
      runReconciliation({ organizationIds: [ORG_A], apply: false, output })
    );

    expect(previewStaleBlockedArtifacts).toHaveBeenCalledWith({
      organizationId: ORG_A,
    });
    expect(reconcileStaleBlockedArtifacts).not.toHaveBeenCalled();
    expect(lines[0]).toContain("would unblock 1");
    expect(lines[0]).toContain("stale-1");
    expect(lines.join("\n")).not.toContain("unblocked 1");
  });

  it("prints no id list when nothing would move", async () => {
    previewStaleBlockedArtifacts.mockResolvedValue(outcome(ORG_A, 3, [], []));

    const lines = await capture((output) =>
      runReconciliation({ organizationIds: [ORG_A], apply: false, output })
    );

    expect(lines[0]).toBe(`${ORG_A}: scanned 3 BLOCKED, would unblock 0`);
    expect(lines[0]).not.toContain(" — ");
  });
});

describe("runReconciliation — apply mode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("applies without ever reaching the preview sweep", async () => {
    reconcileStaleBlockedArtifacts.mockResolvedValue(
      outcome(ORG_A, 4, ["stale-1"], ["stale-1"])
    );

    const lines = await capture((output) =>
      runReconciliation({ organizationIds: [ORG_A], apply: true, output })
    );

    expect(reconcileStaleBlockedArtifacts).toHaveBeenCalledWith({
      organizationId: ORG_A,
    });
    expect(previewStaleBlockedArtifacts).not.toHaveBeenCalled();
    expect(lines[0]).toContain("unblocked 1");
    expect(lines.join("\n")).not.toContain("would unblock");
  });

  it("reports the WRITTEN count, not the resolved count, and says so when they differ", async () => {
    // Three rows resolved; the guarded update landed one. The other two were
    // moved out of BLOCKED by a concurrent write.
    reconcileStaleBlockedArtifacts.mockResolvedValue(
      outcome(ORG_A, 9, ["a", "b", "c"], ["a"])
    );

    const lines = await capture((output) =>
      runReconciliation({ organizationIds: [ORG_A], apply: true, output })
    );

    const joined = lines.join("\n");
    expect(lines[0]).toContain("unblocked 1");
    expect(lines[0]).not.toContain("unblocked 3");
    expect(joined).toContain("2 resolved row(s) were NOT written");
    expect(joined).toContain("TOTAL: 1 org(s), scanned 9, unblocked 1");
  });

  it("does not warn when every resolved row was written", async () => {
    reconcileStaleBlockedArtifacts.mockResolvedValue(
      outcome(ORG_A, 2, ["a"], ["a"])
    );

    const lines = await capture((output) =>
      runReconciliation({ organizationIds: [ORG_A], apply: true, output })
    );

    expect(lines.join("\n")).not.toContain("NOT written");
  });

  it("totals across every organization it was given", async () => {
    reconcileStaleBlockedArtifacts
      .mockResolvedValueOnce(outcome(ORG_A, 3, ["a"], ["a"]))
      .mockResolvedValueOnce(outcome(ORG_B, 5, ["b", "c"], ["b", "c"]));

    const lines = await capture((output) =>
      runReconciliation({
        organizationIds: [ORG_A, ORG_B],
        apply: true,
        output,
      })
    );

    expect(lines.at(-1)).toBe("TOTAL: 2 org(s), scanned 8, unblocked 3");
  });
});
