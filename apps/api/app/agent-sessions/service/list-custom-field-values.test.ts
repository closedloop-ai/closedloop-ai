import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";
import { SESSIONS_LIST_CUSTOM_FIELD_READ_FAILED_EVENT } from "./list-custom-field-values";

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

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const FIRST_SESSION_ID = "session-custom-fields-1";
const SECOND_SESSION_ID = "session-custom-fields-2";
const FIELD_ID = "field-priority";

describe("agent session list custom-field projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("projects values for the whole page through one entity-id batch", async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([buildTextValueRow(FIRST_SESSION_ID, "High")]);
    installDb({
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            buildSessionListRecord({ artifactId: FIRST_SESSION_ID }),
            buildSessionListRecord({ artifactId: SECOND_SESSION_ID }),
          ]),
        count: vi.fn().mockResolvedValue(2),
      },
      customFieldValue: { findMany },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entityType: CustomFieldEntityType.Session,
          entityId: { in: [FIRST_SESSION_ID, SECOND_SESSION_ID] },
          organizationId: "org-1",
          // davetho review cid 3884188153. The predicate widened DELIBERATELY:
          // the read now also requires the DEFINITION to declare Session, so a
          // Document-only field's stray Session row stays quarantined instead
          // of appearing the moment an admin attaches that field. Asserted as an
          // exact `where` rather than a partial match, because a filter this
          // whole projection's correctness rests on must fail loudly if a later
          // edit drops it.
          customField: {
            OR: [
              { entityTypes: { has: CustomFieldEntityType.Session } },
              { entityTypes: { isEmpty: true } },
            ],
          },
        },
      })
    );
    expect(result.items[0]?.customFields).toEqual([
      expect.objectContaining({
        customFieldId: FIELD_ID,
        displayValue: "High",
        entityId: FIRST_SESSION_ID,
      }),
    ]);
    expect(result.items[1]?.customFields).toEqual([]);
    expect(result.items[1]).toHaveProperty("customFields");
  });

  it("keeps the session page and omits unknown values when the batch read fails", async () => {
    const failure = new Error("custom field read unavailable");
    installDb({
      sessionDetail: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            buildSessionListRecord({ artifactId: FIRST_SESSION_ID }),
          ]),
        count: vi.fn().mockResolvedValue(1),
      },
      customFieldValue: {
        findMany: vi.fn().mockRejectedValue(failure),
      },
    });

    const result = await agentSessionsService.findSessions({
      organizationId: "org-1",
      filters: {},
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).not.toHaveProperty("customFields");
    expect(log.error).toHaveBeenCalledWith(
      SESSIONS_LIST_CUSTOM_FIELD_READ_FAILED_EVENT,
      expect.objectContaining({
        error: failure.message,
        organizationId: "org-1",
        sessionCount: 1,
      })
    );
  });
});

function buildTextValueRow(entityId: string, value: string) {
  return {
    id: `value-${entityId}`,
    customFieldId: FIELD_ID,
    organizationId: "org-1",
    entityType: CustomFieldEntityType.Session,
    entityId,
    textValue: value,
    numberValue: null,
    dateValue: null,
    enumValueId: null,
    multiEnumValueIds: [],
    peopleValueIds: [],
    displayValue: value,
    createdAt: new Date("2026-08-28T00:00:00.000Z"),
    updatedAt: new Date("2026-08-28T00:00:00.000Z"),
    enumValue: null,
    references: [],
    customField: {
      id: FIELD_ID,
      name: "Priority",
      fieldType: CustomFieldType.Text,
      showInTable: true,
      enumOptions: [],
    },
  };
}
