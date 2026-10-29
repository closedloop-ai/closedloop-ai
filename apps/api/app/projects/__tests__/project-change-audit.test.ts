/**
 * Unit tests for the project audit receipt (ISS-9688).
 *
 * The defect: `PUT /projects/:id` emitted nothing, so a project status or
 * priority change left no entry in the audit ledger while the equivalent
 * document write had emitted one since FEA-3862.
 *
 * These cover the helper's decision — WHICH events a given before/after pair
 * produces. That a real PUT actually calls it is pinned separately, by the
 * route test, because a helper with no caller is the failure mode a unit test
 * cannot see.
 */

import { AuditAction, AuditObjectType } from "@repo/api/src/types/audit";
import { Priority } from "@repo/api/src/types/common";
import { ProjectStatus } from "@repo/api/src/types/project";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchAuditEvents = vi.hoisted(() => vi.fn());

vi.mock("@/app/audit/audit-emit-service", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("@/app/audit/audit-emit-service")>();
  return { ...real, dispatchAuditEvents };
});

import { userAuditActor } from "@/app/audit/audit-emit-service";
import { dispatchProjectChangeAuditEvents } from "../project-change-audit";

const ORG = "org-1";
const PROJECT = "project-1";
const USER = "user-1";
const ACTOR = userAuditActor(USER);

function fields(
  over: Partial<{ status: ProjectStatus; priority: Priority | null }> = {}
): { status: ProjectStatus; priority: Priority | null } {
  return {
    status: ProjectStatus.NotStarted,
    priority: Priority.Medium,
    ...over,
  };
}

function emit(
  before: ReturnType<typeof fields>,
  after: ReturnType<typeof fields>
) {
  dispatchProjectChangeAuditEvents({
    organizationId: ORG,
    projectId: PROJECT,
    actor: ACTOR,
    before,
    after,
  });
}

beforeEach(() => {
  dispatchAuditEvents.mockReset();
});

describe("dispatchProjectChangeAuditEvents", () => {
  it("records a project status transition on the ledger", () => {
    emit(
      fields({ status: ProjectStatus.NotStarted }),
      fields({ status: ProjectStatus.InProgress })
    );

    expect(dispatchAuditEvents).toHaveBeenCalledTimes(1);
    expect(dispatchAuditEvents).toHaveBeenCalledWith([
      {
        organizationId: ORG,
        actor: ACTOR,
        action: AuditAction.ProjectStatusChanged,
        objectType: AuditObjectType.Project,
        objectId: PROJECT,
        detail: {
          from: ProjectStatus.NotStarted,
          to: ProjectStatus.InProgress,
        },
      },
    ]);
  });

  it("records a project priority transition on the ledger", () => {
    emit(
      fields({ priority: Priority.Medium }),
      fields({ priority: Priority.Urgent })
    );

    expect(dispatchAuditEvents).toHaveBeenCalledWith([
      {
        organizationId: ORG,
        actor: ACTOR,
        action: AuditAction.ProjectPriorityChanged,
        objectType: AuditObjectType.Project,
        objectId: PROJECT,
        detail: { from: Priority.Medium, to: Priority.Urgent },
      },
    ]);
  });

  it("records BOTH fields through ONE bulk enqueue when they move together", () => {
    // Bounded fan-out: two moved fields must not become two concurrent pooled
    // inserts. One `dispatchAuditEvents` call carrying both events is the
    // contract (`apps/api/AGENTS.md`), so assert the call COUNT, not just that
    // both actions appear somewhere.
    emit(
      fields({ status: ProjectStatus.NotStarted, priority: Priority.Low }),
      fields({ status: ProjectStatus.Completed, priority: Priority.High })
    );

    expect(dispatchAuditEvents).toHaveBeenCalledTimes(1);
    const events = dispatchAuditEvents.mock.calls[0][0];
    expect(events).toHaveLength(2);
    expect(events.map((e: { action: string }) => e.action)).toEqual([
      AuditAction.ProjectStatusChanged,
      AuditAction.ProjectPriorityChanged,
    ]);
  });

  it("records NOTHING when a project is re-saved at the values it already held", () => {
    // A no-op PUT must not put a phantom entry on the chain. The ledger is
    // hashed and append-only, so a spurious row is not merely noise — it is a
    // permanent assertion that something happened when nothing did.
    emit(fields(), fields());

    expect(dispatchAuditEvents).not.toHaveBeenCalled();
  });

  it("records setting an unset priority (null → HIGH) with the null `from` preserved", () => {
    // ISS-9441: "no priority" is a real value on the ledger. Folding it to
    // MEDIUM here would record a transition the project never made.
    emit(fields({ priority: null }), fields({ priority: Priority.High }));

    expect(dispatchAuditEvents).toHaveBeenCalledTimes(1);
    expect(dispatchAuditEvents).toHaveBeenCalledWith([
      {
        organizationId: ORG,
        actor: ACTOR,
        action: AuditAction.ProjectPriorityChanged,
        objectType: AuditObjectType.Project,
        objectId: PROJECT,
        detail: { from: null, to: Priority.High },
      },
    ]);
  });

  it("records clearing a priority (HIGH → null) with the null `to` preserved", () => {
    emit(fields({ priority: Priority.High }), fields({ priority: null }));

    expect(dispatchAuditEvents).toHaveBeenCalledTimes(1);
    expect(dispatchAuditEvents).toHaveBeenCalledWith([
      {
        organizationId: ORG,
        actor: ACTOR,
        action: AuditAction.ProjectPriorityChanged,
        objectType: AuditObjectType.Project,
        objectId: PROJECT,
        detail: { from: Priority.High, to: null },
      },
    ]);
  });

  it("records NOTHING when an unset priority is re-saved unset (null → null)", () => {
    emit(fields({ priority: null }), fields({ priority: null }));

    expect(dispatchAuditEvents).not.toHaveBeenCalled();
  });

  it("records only the field that moved when the other is unchanged", () => {
    emit(
      fields({ status: ProjectStatus.InProgress, priority: Priority.High }),
      fields({ status: ProjectStatus.Archived, priority: Priority.High })
    );

    const events = dispatchAuditEvents.mock.calls[0][0];
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe(AuditAction.ProjectStatusChanged);
  });
});
