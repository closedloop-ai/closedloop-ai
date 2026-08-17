import { describe, expect, it } from "vitest";
import { branchRows, commentAuthorName } from "./mock";
import { buildBranchDetail } from "./mock-detail";
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
  it("preserves a branch with zero sessions without inventing trace comments", () => {
    const row = branchRows.find((branch) => branch.id === "br_dependabot");

    expect(row).toBeDefined();

    const detail = buildBranchDetail(row!);

    expect(detail.sessions).toHaveLength(0);
    expect(detail.timeline.legend).toHaveLength(0);
    expect(detail.sessionComments).toHaveLength(0);
    expect(detail.costTotal).toBe("$0");
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
        detail.comments.map(({ author }) => commentAuthorName(author))
      );

      expect(new Set(row.collaborators), row.branchName).toEqual(
        commentAuthors
      );
    }
  });
});
