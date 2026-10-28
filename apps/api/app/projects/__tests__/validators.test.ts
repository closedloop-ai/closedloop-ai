import { NUL_CHARACTER as NUL } from "@repo/api/src/types/postgres-text";
import { MAX_PROJECT_TEAMS } from "@repo/api/src/types/project";
import { describe, expect, it } from "vitest";
import { createProjectValidator, updateProjectValidator } from "../validators";

const VALID_UUID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function uuids(count: number): string[] {
  return Array.from({ length: count }, () => crypto.randomUUID());
}

describe("createProjectValidator", () => {
  it("rejects a body with no teamIds", () => {
    const result = createProjectValidator.safeParse({ name: "My Project" });
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    const teamIssue = issues.find((i) => i.path.includes("teamIds"));
    expect(teamIssue).toBeDefined();
  });

  it("rejects teamIds: [] with an issue on the teamIds path", () => {
    const result = createProjectValidator.safeParse({
      name: "My Project",
      teamIds: [],
    });
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    const teamIssue = issues.find((i) => i.path.includes("teamIds"));
    expect(teamIssue).toBeDefined();
  });

  it("accepts teamIds: [<uuid>]", () => {
    const result = createProjectValidator.safeParse({
      name: "My Project",
      teamIds: [VALID_UUID],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid element in teamIds with an issue on the teamIds path", () => {
    const result = createProjectValidator.safeParse({
      name: "My Project",
      teamIds: ["not-a-uuid"],
    });
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    const teamIssue = issues.find((i) =>
      i.path.some((p) => p === "teamIds" || p === 0)
    );
    expect(teamIssue).toBeDefined();
    expect(teamIssue?.path).toContain("teamIds");
  });

  // The cap is enforced here, not only in the service, so an over-cap array
  // never reaches the id-resolution path or the per-element error rendering.
  it("accepts exactly MAX_PROJECT_TEAMS and rejects one more", () => {
    expect(
      createProjectValidator.safeParse({
        name: "My Project",
        teamIds: uuids(MAX_PROJECT_TEAMS),
      }).success
    ).toBe(true);

    const overCap = createProjectValidator.safeParse({
      name: "My Project",
      teamIds: uuids(MAX_PROJECT_TEAMS + 1),
    });
    expect(overCap.success).toBe(false);
    const capIssue = overCap.error?.issues.find(
      (issue) => issue.path.length === 1 && issue.path[0] === "teamIds"
    );
    expect(capIssue?.code).toBe("too_big");
  });
});

describe("updateProjectValidator", () => {
  // ISS-11198: a guard is valid only beside the field it guards.
  it("accepts the name and description guards only beside their fields", () => {
    const guarded = updateProjectValidator.safeParse({
      name: "Artemis",
      expectedName: "Apollo",
      description: "",
      expectedDescription: "",
    });
    const nameGuardAlone = updateProjectValidator.safeParse({
      expectedName: "Apollo",
    });
    const descriptionGuardAlone = updateProjectValidator.safeParse({
      expectedDescription: "",
    });

    expect(guarded.data).toMatchObject({
      expectedName: "Apollo",
      expectedDescription: "",
    });
    expect(nameGuardAlone.error?.issues.map((issue) => issue.message)).toEqual([
      "Send `expectedName` only together with `name`",
    ]);
    expect(descriptionGuardAlone.error?.issues.map((i) => i.path)).toEqual([
      ["expectedDescription"],
    ]);
  });

  it("accepts a body with teamIds omitted (leave-teams-unchanged case)", () => {
    const result = updateProjectValidator.safeParse({ name: "Renamed" });
    expect(result.success).toBe(true);
  });

  it("rejects teamIds: [] with an issue on the teamIds path", () => {
    const result = updateProjectValidator.safeParse({ teamIds: [] });
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    const teamIssue = issues.find((i) => i.path.includes("teamIds"));
    expect(teamIssue).toBeDefined();
  });

  it("accepts teamIds: [<uuid>]", () => {
    const result = updateProjectValidator.safeParse({ teamIds: [VALID_UUID] });
    expect(result.success).toBe(true);
  });

  it("accepts exactly MAX_PROJECT_TEAMS and rejects one more", () => {
    expect(
      updateProjectValidator.safeParse({ teamIds: uuids(MAX_PROJECT_TEAMS) })
        .success
    ).toBe(true);

    const overCap = updateProjectValidator.safeParse({
      teamIds: uuids(MAX_PROJECT_TEAMS + 1),
    });
    expect(overCap.success).toBe(false);
    const capIssue = overCap.error?.issues.find(
      (issue) => issue.path.length === 1 && issue.path[0] === "teamIds"
    );
    expect(capIssue?.code).toBe("too_big");
  });
});

// ISS-11195: stored project text is stripped of NUL before its length rule.
describe("project text fields and NUL (ISS-11195)", () => {
  const FIELD_ID = crypto.randomUUID();

  it("strips NUL from create name, description and slug", () => {
    const result = createProjectValidator.safeParse({
      name: `a${NUL}b`,
      description: `d${NUL}`,
      slug: `s${NUL}`,
      teamIds: [VALID_UUID],
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: "ab",
      description: "d",
      slug: "s",
    });
  });

  it("strips NUL from update name, description, codebaseSummary and string custom-field values", () => {
    const result = updateProjectValidator.safeParse({
      name: `a${NUL}b`,
      description: `d${NUL}`,
      codebaseSummary: `c${NUL}`,
      customFields: { [FIELD_ID]: `v${NUL}` },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      name: "ab",
      description: "d",
      codebaseSummary: "c",
      customFields: { [FIELD_ID]: "v" },
    });
  });

  it("keeps a null codebaseSummary and slug as null", () => {
    expect(
      updateProjectValidator.safeParse({ codebaseSummary: null }).data
        ?.codebaseSummary
    ).toBeNull();
    expect(
      createProjectValidator.safeParse({
        name: "P",
        slug: null,
        teamIds: [VALID_UUID],
      }).data?.slug
    ).toBeNull();
  });

  it("strips NUL from settings strings and keys at any depth", () => {
    const result = updateProjectValidator.safeParse({
      settings: { [`k${NUL}`]: { nested: [`v${NUL}`] } },
    });

    expect(result.success).toBe(true);
    expect(result.data?.settings).toEqual({ k: { nested: ["v"] } });
  });

  it("refuses settings keys that collapse to one key once stripped", () => {
    expect(
      updateProjectValidator.safeParse({
        settings: { [`a${NUL}b`]: 1, ab: 2 },
      }).success
    ).toBe(false);
  });

  it("leaves settings with no NUL unchanged", () => {
    const settings = { theme: "Old 🚀 ", nested: { list: [1, "x", null] } };

    expect(
      updateProjectValidator.safeParse({ settings }).data?.settings
    ).toEqual(settings);
  });

  it("still refuses a name that is nothing but NULs", () => {
    expect(updateProjectValidator.safeParse({ name: NUL }).success).toBe(false);
    expect(
      createProjectValidator.safeParse({ name: NUL, teamIds: [VALID_UUID] })
        .success
    ).toBe(false);
  });
});
