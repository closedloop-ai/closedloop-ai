import { describe, expect, it } from "vitest";
import type { AuditFiledFinding } from "../../../../shared/audit-contract";
import {
  correlateFileOutcomes,
  createdViewIds,
  FindingFileStatus,
} from "../audit-file-model";
import {
  type AuditFindingView,
  groupFindingsBySeverity,
} from "../audit-finding-model";

/** Build a single finding view via the real grouping path (ids stay in sync). */
function viewFor(overrides: {
  title: string;
  description?: string;
  signature?: string;
}): AuditFindingView {
  const [group] = groupFindingsBySeverity([
    {
      title: overrides.title,
      description: overrides.description ?? "d",
      signature: overrides.signature,
    },
  ]);
  const view = group?.findings[0];
  if (!view) {
    throw new Error("expected one grouped finding view");
  }
  return view;
}

function outcome(
  key: string,
  title: string,
  status: FindingFileStatus
): AuditFiledFinding {
  return { key, title, status };
}

describe("correlateFileOutcomes", () => {
  it("pairs each view to its outcome by request position (not dedup key)", () => {
    const a = viewFor({ title: "Stale doc", signature: "sig:a" });
    const b = viewFor({ title: "Wrong flag", signature: "sig:b" });
    // filed is one entry per requested finding, in request order.
    const filed = [
      outcome("keyA", "Stale doc", FindingFileStatus.Created),
      outcome("keyB", "Wrong flag", FindingFileStatus.Skipped),
    ];

    const map = correlateFileOutcomes([a, b], filed);

    expect(map.get(a.id)).toBe(FindingFileStatus.Created);
    expect(map.get(b.id)).toBe(FindingFileStatus.Skipped);
  });

  it("badges two SAME-dedup-key views independently (created vs skipped)", () => {
    // Two selected findings that normalize to the same dedup key: the backend
    // creates the first and skips the second. A key-based map would mark both
    // the same and lose the distinction; position-correlation keeps them apart.
    const first = viewFor({ title: "Dup finding", signature: "sig:dup:1" });
    const second = viewFor({ title: "Dup finding", signature: "sig:dup:2" });
    const sharedKey = "dupkey";
    const filed = [
      outcome(sharedKey, "Dup finding", FindingFileStatus.Created),
      outcome(sharedKey, "Dup finding", FindingFileStatus.Skipped),
    ];

    const map = correlateFileOutcomes([first, second], filed);

    expect(first.id).not.toBe(second.id);
    expect(map.get(first.id)).toBe(FindingFileStatus.Created);
    expect(map.get(second.id)).toBe(FindingFileStatus.Skipped);
  });

  it("maps a failed outcome to Failed", () => {
    const view = viewFor({ title: "Boom", signature: "sig:boom" });
    const map = correlateFileOutcomes(
      [view],
      [outcome("boomkey", "Boom", FindingFileStatus.Failed)]
    );
    expect(map.get(view.id)).toBe(FindingFileStatus.Failed);
  });

  it("returns an empty map when outcome count drifts from the request", () => {
    const a = viewFor({ title: "A" });
    const b = viewFor({ title: "B" });
    // A contract violation (2 views, 1 outcome) must not mis-pair — bail empty.
    const map = correlateFileOutcomes(
      [a, b],
      [outcome("k", "A", FindingFileStatus.Created)]
    );
    expect(map.size).toBe(0);
  });
});

describe("createdViewIds", () => {
  it("returns only the CREATED view ids (skipped/failed lingering)", () => {
    const created = viewFor({ title: "New", signature: "sig:new" });
    const skipped = viewFor({ title: "Dup", signature: "sig:dup" });
    const failed = viewFor({ title: "Boom", signature: "sig:boom" });
    const filed = [
      outcome("k1", "New", FindingFileStatus.Created),
      outcome("k2", "Dup", FindingFileStatus.Skipped),
      outcome("k3", "Boom", FindingFileStatus.Failed),
    ];

    const ids = createdViewIds([created, skipped, failed], filed);

    expect(ids).toEqual([created.id]);
  });

  it("drops only ONE of two same-key views (the created one)", () => {
    const first = viewFor({ title: "Dup", signature: "sig:dup:1" });
    const second = viewFor({ title: "Dup", signature: "sig:dup:2" });
    const sharedKey = "dupkey";
    const filed = [
      outcome(sharedKey, "Dup", FindingFileStatus.Created),
      outcome(sharedKey, "Dup", FindingFileStatus.Skipped),
    ];

    const ids = createdViewIds([first, second], filed);

    // Only the created row is cleared; the skipped row lingers for the user.
    expect(ids).toEqual([first.id]);
  });
});
