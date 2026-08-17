import {
  DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
  DOCUMENT_LIST_MAX_LIMIT,
  DOCUMENT_LIST_MAX_OFFSET,
  DocumentListRecency,
  type FindDocumentsOptions,
} from "@repo/api/src/types/document";
import { describe, expect, test } from "vitest";
import {
  buildArtifactListParams,
  collectMyTasksTreeProjectIds,
} from "../utils";

describe("buildArtifactListParams", () => {
  test("scopes to the assignee and forwards the requested server page (ISS-4576)", () => {
    const params = buildArtifactListParams("user-123", {
      limit: 50,
      offset: 100,
    });
    const expected: Omit<FindDocumentsOptions, "includeTotal"> = {
      assigneeId: "user-123",
      limit: 50,
      offset: 100,
    };
    expect(params).toEqual(expected);
    expect(params).not.toHaveProperty("type");
  });

  test("returns undefined assigneeId (unfetchable) when input is null but stays bounded", () => {
    const params = buildArtifactListParams(null, {
      limit: DOCUMENT_LIST_MAX_LIMIT,
      offset: 0,
    });
    const expected: Omit<FindDocumentsOptions, "includeTotal"> = {
      assigneeId: undefined,
      limit: DOCUMENT_LIST_MAX_LIMIT,
      offset: 0,
    };
    expect(params).toEqual(expected);
    expect(params).not.toHaveProperty("type");
  });

  test("clamps a limit above the endpoint ceiling down to DOCUMENT_LIST_MAX_LIMIT", () => {
    const params = buildArtifactListParams("user-123", {
      limit: DOCUMENT_LIST_MAX_LIMIT * 10,
      offset: 0,
    });
    expect(params.limit).toBe(DOCUMENT_LIST_MAX_LIMIT);
  });

  test("floors a non-positive limit at 1 and a negative offset at 0 (Math.min alone would not)", () => {
    const params = buildArtifactListParams("user-123", {
      limit: 0,
      offset: -25,
    });
    expect(params.limit).toBe(1);
    expect(params.offset).toBe(0);
  });

  test("caps an offset above the endpoint ceiling to DOCUMENT_LIST_MAX_OFFSET so the read never 400s (codex P2)", () => {
    const params = buildArtifactListParams("user-123", {
      limit: 50,
      offset: DOCUMENT_LIST_MAX_OFFSET + 50,
    });
    expect(params.offset).toBe(DOCUMENT_LIST_MAX_OFFSET);
  });

  test("sends NEITHER narrowing param while the FEA-1626 flag is off", () => {
    // Closed-by-default (ISS-4779) AND deploy-skew safety (wongk): the flag-off
    // request must be byte-identical to what this board sent before FEA-1626,
    // so it stays valid against an API that has not deployed the new params and
    // reads full history against one that has.
    const params = buildArtifactListParams("user-123", {
      limit: 50,
      offset: 0,
    });

    expect(params).not.toHaveProperty("recencyDays");
    expect(params).not.toHaveProperty("includeArchivedProjects");
  });

  test("asks for BOTH narrowings explicitly once the FEA-1626 flag is on", () => {
    const params = buildArtifactListParams(
      "user-123",
      { limit: 50, offset: 0 },
      true
    );

    // Opting IN is what the flag does: the server applies nothing on its own, so
    // an omitted param here would ship the flag with no perceivable effect.
    expect(params.recencyDays).toBe(DOCUMENT_LIST_DEFAULT_RECENCY_DAYS);
    expect(params.includeArchivedProjects).toBe(false);
  });

  test("drops the window on the wire when the user removes the recency chip", () => {
    const params = buildArtifactListParams(
      "user-123",
      { limit: 50, offset: 0 },
      true,
      true
    );

    expect(params.recencyDays).toBe(DocumentListRecency.All);
    expect(params.includeArchivedProjects).toBe(true);
  });

  test("keeps the chip's removal inert while the flag is off", () => {
    // No window is in force, so there is nothing to remove and nothing to say
    // on the wire — the request must not start carrying params the flag-off
    // path never sent.
    const params = buildArtifactListParams(
      "user-123",
      { limit: 50, offset: 0 },
      false,
      true
    );

    expect(params).not.toHaveProperty("recencyDays");
    expect(params).not.toHaveProperty("includeArchivedProjects");
  });
});

describe("collectMyTasksTreeProjectIds", () => {
  test("includes projects from contributor branches even without assigned artifacts", () => {
    const projectIds = collectMyTasksTreeProjectIds(
      [{ projectId: "project-assigned" }, { projectId: null }],
      [
        { projectId: "project-branch-only" },
        { projectId: "project-assigned" },
        { projectId: null },
      ]
    );

    expect(projectIds).toEqual(["project-assigned", "project-branch-only"]);
  });
});
