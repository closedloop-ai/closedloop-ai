import { describe, expect, it } from "vitest";
import {
  PrototypeFileCompleteness,
  PrototypeGrossTotalAvailability,
} from "./file-coverage-fixtures";
import { branchRows, commentAuthorName } from "./mock";
import { buildBranchDetail } from "./mock-detail";
import { STRUCTURED_PR_DESCRIPTION } from "./pr-description-fixtures";
import { timelineTokenTotal } from "./timeline-fixtures";

const HOURS_PATTERN = /(\d+)h/;
const MINUTES_PATTERN = /(\d+)m/;

function durationMinutes(label: string): number {
  return (
    Number(HOURS_PATTERN.exec(label)?.[1] ?? 0) * 60 +
    Number(MINUTES_PATTERN.exec(label)?.[1] ?? 0)
  );
}

describe("buildBranchDetail", () => {
  it("wires every selectable file coverage fixture to its final shown rows", () => {
    const expectations = {
      br_1284: [PrototypeFileCompleteness.Complete, 1, 1],
      br_1281: [PrototypeFileCompleteness.Unavailable, 1, null],
      br_1270: [PrototypeFileCompleteness.Incomplete, 1, null],
      br_dark_mode: [PrototypeFileCompleteness.Incomplete, 1, 1],
      br_files_zero: [PrototypeFileCompleteness.Complete, 0, 0],
      br_1289: [PrototypeFileCompleteness.Incomplete, 2, 3],
    } as const;

    for (const [branchId, [completeness, loaded, expected]] of Object.entries(
      expectations
    )) {
      const row = branchRows.find(({ id }) => id === branchId);
      expect(row, branchId).toBeDefined();

      const first = buildBranchDetail(row!, { useFileCoverageFixtures: true });
      const second = buildBranchDetail(row!, { useFileCoverageFixtures: true });
      expect(first.files, branchId).toHaveLength(loaded);
      expect(first.fileCoverage, branchId).toEqual({
        completeness,
        counts: { loaded, expected },
        grossTotals: {
          additions: expect.objectContaining({
            availability:
              completeness === PrototypeFileCompleteness.Unavailable
                ? PrototypeGrossTotalAvailability.Unavailable
                : PrototypeGrossTotalAvailability.Available,
          }),
          deletions: expect.objectContaining({
            availability:
              completeness === PrototypeFileCompleteness.Unavailable
                ? PrototypeGrossTotalAvailability.Unavailable
                : PrototypeGrossTotalAvailability.Available,
          }),
        },
      });
      expect(second.fileCoverage, branchId).toEqual(first.fileCoverage);
      expect(second.files, branchId).toEqual(first.files);
    }
  });

  it("does not leak ticket-specific file coverage fixtures to other consumers", () => {
    const row = branchRows.find(({ id }) => id === "br_1284");
    expect(row).toBeDefined();

    const ordinaryDetail = buildBranchDetail(row!);
    const fixtureDetail = buildBranchDetail(row!, {
      useFileCoverageFixtures: true,
    });

    expect(ordinaryDetail.files).toHaveLength(5);
    expect(fixtureDetail.files).toHaveLength(1);
    expect(
      fixtureDetail.files.reduce((total, file) => total + file.additions, 0)
    ).toBe(row!.additions);
    expect(
      fixtureDetail.files.reduce((total, file) => total + file.deletions, 0)
    ).toBe(row!.deletions);
  });

  it("preserves a branch with zero sessions without inventing trace comments", () => {
    const row = branchRows.find((branch) => branch.id === "br_dependabot");

    expect(row).toBeDefined();

    const detail = buildBranchDetail(row!);

    expect(detail.sessions).toHaveLength(0);
    expect(detail.timeline.legend).toHaveLength(0);
    expect(detail.sessionComments).toHaveLength(0);
    expect(detail.costTotal).toBe("Unavailable");
    expect(detail.valuePerDollar).toBe("Unavailable");
    expect(detail.deliveredArtifacts).toEqual([]);
  });

  it("places every timeline event beneath an active bar", () => {
    for (const row of branchRows) {
      const detail = buildBranchDetail(row);
      const columns = detail.timeline.columns;

      for (const event of detail.eventDots) {
        const columnIndex = Math.min(
          Math.floor((event.leftPct / 100) * columns.length),
          columns.length - 1
        );

        expect(
          columns[columnIndex]?.idle,
          `${row.branchName}: ${event.label} at ${event.leftPct}% is over an idle interval`
        ).not.toBe(true);
      }

      for (const column of columns.filter(({ idle }) => !idle)) {
        expect(timelineTokenTotal(column), row.branchName).toBeGreaterThan(0);
        expect(
          column.segments.reduce((total, segment) => total + segment.pct, 0),
          `${row.branchName}: active timeline bars must not contain empty vertical space`
        ).toBeCloseTo(100);
      }
    }
  });

  it("keeps repeated session actors attached to their stable identities", () => {
    const row = branchRows.find((branch) => branch.id === "br_saml");

    expect(row).toBeDefined();

    const detail = buildBranchDetail(row!);

    expect(detail.timeline.legend.map(({ actorId }) => actorId)).toEqual([
      "u-sam",
      "u-parker",
      "u-parker",
    ]);
    expect(detail.selectedPullRequest).toEqual({
      number: row!.prNumber,
      title: row!.prTitle,
      url: row!.prUrl,
      state: row!.prState,
      body: STRUCTURED_PR_DESCRIPTION,
    });
  });

  it("derives phase durations from the same waterfall shares shown in the chart", () => {
    for (const row of branchRows) {
      const detail = buildBranchDetail(row);
      const wallClockMinutes = durationMinutes(detail.wallClockLabel);

      for (const segment of detail.costSegments) {
        const phasePct = detail.waterfall
          .filter(({ type }) => type === segment.key)
          .reduce((total, { pct }) => total + pct, 0);

        expect(durationMinutes(segment.duration), row.branchName).toBe(
          Math.round((wallClockMinutes * phasePct) / 100)
        );
      }
    }
  });

  it("keeps every row's session count and event anchors internally consistent", () => {
    for (const row of branchRows) {
      const detail = buildBranchDetail(row);
      const traceTurnIds = new Set(detail.trace.map((turn) => turn.id));

      expect(detail.sessions, row.branchName).toHaveLength(row.sessionCount);
      expect(detail.timeline.legend, row.branchName).toHaveLength(
        row.sessionCount
      );

      for (const event of detail.eventDots) {
        expect(
          traceTurnIds.has(event.targetTurnId),
          `${row.branchName}: ${event.label} has no matching trace turn`
        ).toBe(true);
      }

      if (row.sessionCount === 0) {
        expect(detail.trace, row.branchName).toHaveLength(0);
        expect(detail.eventDots, row.branchName).toHaveLength(0);
      }
    }
  });

  it("does not inherit synthetic-seed metadata into branch variants", () => {
    const row = branchRows.find((branch) => branch.id === "br_1270");

    expect(row).toBeDefined();

    const detail = buildBranchDetail(row!);

    expect(detail.costTotal).not.toBe("$904");
    expect(detail.valuePerDollar).not.toBe("5.98");
    expect(detail.deliveredArtifacts).toEqual([]);
  });

  it("keeps collaborator facets aligned with rendered PR comment authors", () => {
    for (const row of branchRows.filter(({ commentCount }) => commentCount)) {
      const detail = buildBranchDetail(row);
      const commentAuthors = new Set(
        detail.comments.flatMap((comment) => [
          commentAuthorName(comment.author),
          ...(comment.replies ?? []).map(({ author }) =>
            commentAuthorName(author)
          ),
        ])
      );

      expect(new Set(row.collaborators), row.branchName).toEqual(
        commentAuthors
      );
    }
  });
});
