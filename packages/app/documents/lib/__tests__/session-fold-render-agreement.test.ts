import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { DocumentStatus } from "@repo/api/src/types/document";
import {
  getRowTypeConfig,
  resolveServedSessionDisplayStatus,
} from "@repo/app/documents/components/table/row-type-registry";
import { SortKey } from "@repo/app/documents/components/table/sort-keys";
import {
  rowArtifactStatus,
  SERVED_SESSION_STATUS_ROW_OPTIONS,
  STORED_SESSION_STATUS_ROW_OPTIONS,
} from "@repo/app/documents/lib/row-artifact-status";
import {
  buildFlatItems,
  rootFirstTableViewOrdering,
} from "@repo/app/documents/lib/table-view-pipeline";
import { describe, expect, it } from "vitest";
import { documentRow, sessionRow } from "./root-first-fixtures";

/**
 * ISS-8694 × ISS-9437 — the fold and the render must answer the same question
 * about one session row, under BOTH values of the ISS-8694 key.
 *
 * ISS-10364 (operator ruling, 2026-09-23/24) made the ISS-8694 enrichment this
 * suite used to pin PERMANENTLY INERT: `resolveServedSessionDisplayStatus`
 * always answers `undefined` now, because its only two admissible outputs
 * (`stale`, `unknown`) are retired from the vocabulary. So the ON and OFF
 * resolvers can no longer diverge — both always fall through to the row's own
 * STORED status. The cases below pin that convergence rather than the old
 * two-branch split; a legacy payload that still carries a server-enriched
 * `displayedSessionStatus` (version skew) must be ignored identically by both.
 */

/** A legacy payload shape: the store says ACTIVE, an old server still sent a
 * server-enriched `stale` alongside it. Both resolvers must ignore the latter. */
const LEGACY_SERVED_STALE = sessionRow(
  "session-served-stale",
  "ACTIVE",
  "stale"
);

describe("ISS-10364: resolveServedSessionDisplayStatus is permanently undefined", () => {
  it("ignores a legacy server-enriched displayedSessionStatus on the payload", () => {
    expect(
      resolveServedSessionDisplayStatus(LEGACY_SERVED_STALE)
    ).toBeUndefined();
  });
});

describe("ISS-8694 OFF and ON now agree, both reading the stored column", () => {
  const offOptions = STORED_SESSION_STATUS_ROW_OPTIONS(LEGACY_SERVED_STALE);
  const onOptions = SERVED_SESSION_STATUS_ROW_OPTIONS(LEGACY_SERVED_STALE);

  it("builds the same (empty) options object under both flag states", () => {
    expect(onOptions).toEqual(offOptions);
    expect(onOptions.sessionDisplayedStatus).toBeUndefined();
  });

  it("folds the row to the stored status' root under both", () => {
    expect(rowArtifactStatus(LEGACY_SERVED_STALE, offOptions).root).toBe(
      ARTIFACT_STATUS_ROOT.InProgress
    );
    expect(rowArtifactStatus(LEGACY_SERVED_STALE, onOptions).root).toBe(
      ARTIFACT_STATUS_ROOT.InProgress
    );
  });

  it("renders the stored status under both, so the row's band and its badge agree", () => {
    for (const options of [offOptions, onOptions]) {
      const config = getRowTypeConfig(LEGACY_SERVED_STALE, options);
      expect(config?.statusIcon).toBe("in-progress");
      expect(config?.statusDescription).toBeUndefined();
    }
  });

  it("sorts the row in the in_progress band under both", () => {
    expect(orderedIds(STORED_SESSION_STATUS_ROW_OPTIONS)).toEqual(
      orderedIds(SERVED_SESSION_STATUS_ROW_OPTIONS)
    );
  });
});

function orderedIds(
  resolver:
    | typeof SERVED_SESSION_STATUS_ROW_OPTIONS
    | typeof STORED_SESSION_STATUS_ROW_OPTIONS
): string[] {
  const rows = [
    documentRow("doc-garbage", "GARBAGE"),
    LEGACY_SERVED_STALE,
    documentRow("doc-draft", DocumentStatus.Draft),
    documentRow("doc-executed", DocumentStatus.Executed),
  ];
  return buildFlatItems(
    rows,
    undefined,
    SortKey.Status,
    "asc",
    rootFirstTableViewOrdering(resolver)
  ).map((item) => item.data.id);
}
