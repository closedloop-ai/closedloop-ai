import { buildUserColor } from "@repo/api/src/agent-session-user-color";
import { describe, expect, it, vi } from "vitest";
import { buildSessionListRecord } from "@/__tests__/support/agent-sessions/service.test-harness";
import { toSessionListItem } from "./projections";
import {
  type AgentSessionListRecord,
  agentSessionDetailSelect,
  agentSessionDetailSelectForOrganization,
  agentSessionDetailSelectWithoutActivitySegmentsForOrganization,
  agentSessionListSelect,
  agentSessionListSelectForOrganization,
} from "./records";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const ASSIGNEE = {
  id: "user-assignee",
  email: "assignee@example.com",
  firstName: "Grace",
  lastName: "Hopper",
  avatarUrl: "https://example.com/grace.png",
};
const CREATOR = {
  id: "user-creator",
  email: "creator@example.com",
  firstName: "Alan",
  lastName: "Turing",
  avatarUrl: null,
};
const CREATED_AT = new Date("2026-05-20T16:55:00.000Z");
const DUE_DATE = new Date("2026-06-01T00:00:00.000Z");

function withArtifact(artifact: Record<string, unknown>) {
  const base = buildSessionListRecord();
  return buildSessionListRecord({
    artifact: { ...(base.artifact as Record<string, unknown>), ...artifact },
  }) as AgentSessionListRecord;
}

describe("ISS-12197 / ISS-12251: the Artifact row's ownership fields on the session read", () => {
  it("serves the artifact's assignee, creator, creation time and due date, timestamps as ISO strings", () => {
    const item = toSessionListItem(
      withArtifact({
        assignee: ASSIGNEE,
        createdAt: CREATED_AT,
        createdBy: CREATOR,
        dueDate: DUE_DATE,
      })
    );

    expect(item.assignee).toEqual(ASSIGNEE);
    expect(item.createdBy).toEqual(CREATOR);
    expect(item.createdAt).toBe(CREATED_AT.toISOString());
    expect(item.dueDate).toBe(DUE_DATE.toISOString());
  });

  it("serves an explicit null for an artifact with no assignee, no creator and no due date", () => {
    const item = toSessionListItem(
      withArtifact({
        assignee: null,
        createdAt: CREATED_AT,
        createdBy: null,
        dueDate: null,
      })
    );

    // `null`, not omitted: omission is reserved for a producer that did not
    // read the column, and this one did.
    expect(item).toHaveProperty("assignee", null);
    expect(item).toHaveProperty("createdBy", null);
    expect(item).toHaveProperty("dueDate", null);
    expect(item.createdAt).toBe(CREATED_AT.toISOString());
  });

  it("omits every key when the select did not project the columns", () => {
    const item = toSessionListItem(withArtifact({}));

    expect(item).not.toHaveProperty("assignee");
    expect(item).not.toHaveProperty("createdAt");
    expect(item).not.toHaveProperty("createdBy");
    expect(item).not.toHaveProperty("dueDate");
  });
});

const ORG_ID = "org-ownership";
const OWNERSHIP_KEYS = ["createdAt", "createdBy", "dueDate"];

// The columns are projected on the DETAIL selects only: `createdBy` is a user
// join no list cell renders. Asserted on the
// org-scoped builders the production reads hand Prisma as well as the base
// constants, because those builders replace `artifact` wholesale.
describe("ISS-12197: the ownership columns ride the detail select, never the list", () => {
  it.each([
    ["agentSessionListSelect", agentSessionListSelect],
    [
      "agentSessionListSelectForOrganization",
      agentSessionListSelectForOrganization(ORG_ID),
    ],
  ])("%s leaves them unselected", (_name, select) => {
    for (const key of OWNERSHIP_KEYS) {
      expect(select.artifact.select).not.toHaveProperty(key);
    }
  });

  it.each([
    ["agentSessionDetailSelect", agentSessionDetailSelect],
    [
      "agentSessionDetailSelectForOrganization",
      agentSessionDetailSelectForOrganization(ORG_ID),
    ],
    [
      "agentSessionDetailSelectWithoutActivitySegmentsForOrganization",
      agentSessionDetailSelectWithoutActivitySegmentsForOrganization(ORG_ID),
    ],
  ])("%s projects all three", (_name, select) => {
    for (const key of OWNERSHIP_KEYS) {
      expect(select.artifact.select).toHaveProperty(key);
    }
  });
});

// ISS-12251: the Owner column is a grid cell, so the assignee rides the list
// select as well as the detail ones.
describe("ISS-12251: the assignee rides the list and the detail selects", () => {
  it.each([
    ["agentSessionListSelect", agentSessionListSelect],
    [
      "agentSessionListSelectForOrganization",
      agentSessionListSelectForOrganization(ORG_ID),
    ],
    ["agentSessionDetailSelect", agentSessionDetailSelect],
    [
      "agentSessionDetailSelectForOrganization",
      agentSessionDetailSelectForOrganization(ORG_ID),
    ],
    [
      "agentSessionDetailSelectWithoutActivitySegmentsForOrganization",
      agentSessionDetailSelectWithoutActivitySegmentsForOrganization(ORG_ID),
    ],
  ])("%s projects it", (_name, select) => {
    expect(select.artifact.select).toHaveProperty("assignee");
  });
});

// ISS-12585: the recording user (`session_detail.user_id`) is retired. The wire
// `user` field stays as a deprecated alias of the assignee.
describe("ISS-12585: the deprecated `user` alias carries the assignee", () => {
  it("serves the assignee as `user` and colours from it", () => {
    const record = buildSessionListRecord({
      // A recording user a stale fixture might still carry is never read.
      user: CREATOR,
      artifact: {
        ...(buildSessionListRecord().artifact as Record<string, unknown>),
        assignee: ASSIGNEE,
      },
    }) as AgentSessionListRecord;

    const item = toSessionListItem(record);

    expect(item.user).toEqual(ASSIGNEE);
    expect(item.userColor).toBe(buildUserColor(ASSIGNEE));
  });

  it("serves a null `user` for an unassigned session", () => {
    const item = toSessionListItem(withArtifact({ assignee: null }));

    expect(item.user).toBeNull();
    expect(item.userColor).toBe(buildUserColor(null));
  });

  it.each([
    ["agentSessionListSelect", agentSessionListSelect],
    [
      "agentSessionListSelectForOrganization",
      agentSessionListSelectForOrganization(ORG_ID),
    ],
    ["agentSessionDetailSelect", agentSessionDetailSelect],
    [
      "agentSessionDetailSelectForOrganization",
      agentSessionDetailSelectForOrganization(ORG_ID),
    ],
    [
      "agentSessionDetailSelectWithoutActivitySegmentsForOrganization",
      agentSessionDetailSelectWithoutActivitySegmentsForOrganization(ORG_ID),
    ],
  ])("%s does not select the session's user relation", (_name, select) => {
    expect(select).not.toHaveProperty("user");
    expect(select).not.toHaveProperty("userId");
  });
});
