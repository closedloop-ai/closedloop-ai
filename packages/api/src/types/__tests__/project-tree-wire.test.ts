import { describe, expect, it } from "vitest";
import { projectTreeWireSchema } from "../project-tree-wire";

const tree = {
  nodes: [{ root: { id: "a" }, children: [] }],
  externalParents: [],
};

describe("project tree wire structure", () => {
  it("accepts the pre-enrichment payload", () => {
    expect(projectTreeWireSchema.parse(tree)).toEqual(tree);
  });

  it("accepts the opt-in hierarchy revision alongside the document version", () => {
    expect(
      projectTreeWireSchema.parse({
        ...tree,
        projectVersion: "documents-v1",
        hierarchyRevision: "hierarchy-v2",
      })
    ).toMatchObject({
      projectVersion: "documents-v1",
      hierarchyRevision: "hierarchy-v2",
    });
  });

  it("preserves unknown additive fields and truncation reasons", () => {
    const payload = {
      ...tree,
      nodes: [
        {
          root: { id: "a", currentVersion: 7, futureField: true },
          children: [],
        },
      ],
      truncation: {
        anchorsIncluded: 1,
        anchorsMatchedAtLeast: 2,
        reasons: ["future_bound"],
      },
      futureResponse: "kept",
    };
    expect(projectTreeWireSchema.parse(payload)).toEqual(payload);
  });

  it.each([
    0,
    -1,
    1.5,
    null,
    "7",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects an invalid version %s", (currentVersion) => {
    expect(
      projectTreeWireSchema.safeParse({
        ...tree,
        nodes: [{ root: { id: "a", currentVersion }, children: [] }],
      }).success
    ).toBe(false);
  });

  it.each([
    {},
    { nodes: null, externalParents: [] },
    { nodes: [{ root: { id: "a" } }], externalParents: [] },
    {
      ...tree,
      truncation: { anchorsIncluded: 1, anchorsMatchedAtLeast: 2, reasons: [] },
    },
  ])("rejects malformed tree structure", (payload) => {
    expect(projectTreeWireSchema.safeParse(payload).success).toBe(false);
  });
});
