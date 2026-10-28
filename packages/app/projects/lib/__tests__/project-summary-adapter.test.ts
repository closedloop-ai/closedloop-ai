import { Priority } from "@repo/api/src/types/common";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { describe, expect, it } from "vitest";
import {
  PROJECT_COMPLETION_POPULATION_LABEL,
  toProjectSummaryRow,
} from "../project-summary-adapter";

/**
 * ISS-10476: the one mapping between the product's project record and the
 * portable row the promoted surface renders. Its whole job is not to publish a
 * measured-looking number the record does not support — `completionPercentage` is
 * always a number on the wire, including for a project with nothing to count.
 */

const UPDATED_AT = new Date("2026-09-01T12:00:00.000Z");
const NOW = new Date("2026-09-03T12:00:00.000Z");
const TARGET_DATE = new Date("2026-10-05T00:00:00.000Z");

function project(
  overrides: Partial<ProjectWithDetails> = {}
): ProjectWithDetails {
  return {
    completionPercentage: 40,
    id: "project-1",
    name: "Apollo",
    slug: "PRO-1",
    updatedAt: UPDATED_AT,
    ...overrides,
  } as ProjectWithDetails;
}

describe("toProjectSummaryRow", () => {
  it("carries a real completion percentage through with its population named", () => {
    const row = toProjectSummaryRow(project(), { now: NOW });

    expect(row.completionPercentage).toBe(40);
    expect(row.childTaskCount).toBeNull();
    expect(row.completionPopulationLabel).toBe(
      PROJECT_COMPLETION_POPULATION_LABEL
    );
  });

  it("reports an empty population as unavailable, never as a measured 0%", () => {
    const row = toProjectSummaryRow(
      project({ completionPercentage: 0, completionPopulationEmpty: true }),
      { now: NOW }
    );

    expect(row.completionPercentage).toBeNull();
    expect(row.childTaskCount).toBe(0);
  });

  it("drops a priority the artifact vocabulary does not contain", () => {
    const row = toProjectSummaryRow(
      project({ priority: "SOMEDAY" as ProjectWithDetails["priority"] }),
      { now: NOW }
    );

    expect(row.priority).toBeNull();
  });

  it("keeps a priority the vocabulary does contain", () => {
    const row = toProjectSummaryRow(project({ priority: Priority.High }), {
      now: NOW,
    });

    expect(row.priority).toBe(Priority.High);
  });

  it("emits both halves of each date — the host's label and the sortable instant", () => {
    const row = toProjectSummaryRow(project({ targetDate: TARGET_DATE }), {
      now: NOW,
    });

    expect(row.dueDateMs).toBe(TARGET_DATE.getTime());
    expect(row.dueDateLabel).toBeTruthy();
    expect(row.updatedAtMs).toBe(UPDATED_AT.getTime());
  });

  it("leaves an unset target date with neither a label nor an instant", () => {
    const row = toProjectSummaryRow(project({ targetDate: null }), {
      now: NOW,
    });

    expect(row.dueDateLabel).toBeNull();
    expect(row.dueDateMs).toBeNull();
  });

  it("projects the assignee as the row owner, and no assignee as no owner", () => {
    const owned = toProjectSummaryRow(
      project({
        assignee: {
          firstName: "Ada",
          id: "user-1",
          lastName: "Lovelace",
        } as ProjectWithDetails["assignee"],
      }),
      { now: NOW }
    );

    expect(owned.owner?.id).toBe("user-1");
    expect(owned.owner?.name).toContain("Ada");
    expect(toProjectSummaryRow(project(), { now: NOW }).owner).toBeNull();
  });
});
