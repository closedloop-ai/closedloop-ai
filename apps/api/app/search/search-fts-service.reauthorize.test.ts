/**
 * `reauthorizeHits`: every hit is re-checked against its source of truth for
 * the requester's org; the search projection is not an access boundary.
 */
import { ArtifactType } from "@repo/api/src/types/artifact";
import { SearchEntityType } from "@repo/api/src/types/search-entity-kind";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  Prisma: {
    empty: { strings: [""], values: [] },
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      values,
    }),
    join: (items: unknown[], separator = ",") => ({ join: items, separator }),
    QueryMode: { insensitive: "insensitive" },
  },
}));

import {
  candidate,
  installDb,
  ORG,
} from "@/__tests__/support/search/search-fts-service.test-fixtures";
import { reauthorizeHits } from "./search-fts-service";

describe("reauthorizeHits", () => {
  beforeEach(() => vi.clearAllMocks());

  it("never authorizes an unmapped/unknown entity type (fail-closed default)", async () => {
    installDb({ candidates: [], visible: {} });
    const authorized = await reauthorizeHits(ORG, [
      candidate({ entity_type: "not-a-real-type", entity_id: "x1" }),
    ]);
    expect(authorized.size).toBe(0);
  });

  it("drops a document whose source artifact is not org-visible (stale/deleted projection)", async () => {
    installDb({
      candidates: [],
      // The projection still carries d-stale, but the source artifact is not
      // under this org (moved orgs / hard-deleted): re-auth must drop it.
      visible: { [SearchEntityType.Document]: ["d-live"] },
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.Document,
        entity_id: "d-live",
      }),
      candidate({
        entity_type: SearchEntityType.Document,
        entity_id: "d-stale",
      }),
    ]);
    expect(authorized.has(`${SearchEntityType.Document}:d-live`)).toBe(true);
    expect(authorized.has(`${SearchEntityType.Document}:d-stale`)).toBe(false);
  });

  it("drops a project whose source is not org-visible (stale/deleted/cross-org)", async () => {
    installDb({
      candidates: [],
      visible: { [SearchEntityType.Project]: ["p-live"] },
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({ entity_type: SearchEntityType.Project, entity_id: "p-live" }),
      candidate({
        entity_type: SearchEntityType.Project,
        entity_id: "p-stale",
      }),
    ]);
    expect(authorized.has(`${SearchEntityType.Project}:p-live`)).toBe(true);
    expect(authorized.has(`${SearchEntityType.Project}:p-stale`)).toBe(false);
  });

  it("never authorizes a leftover loop row (Loops retired, ISS-12435)", async () => {
    installDb({
      candidates: [],
      visible: { [SearchEntityType.Loop]: ["l-live"] },
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({ entity_type: SearchEntityType.Loop, entity_id: "l-live" }),
    ]);
    expect(authorized.size).toBe(0);
  });

  it("authorizes a comment whose thread is in-org and drops a cross-org one (FEA-3930)", async () => {
    installDb({
      candidates: [],
      // Only c-in-org exists under this org (via its thread); c-other-org does
      // not — a cross-org/stale projection row must not leak.
      visible: { [SearchEntityType.Comment]: ["c-in-org"] },
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.Comment,
        entity_id: "c-in-org",
      }),
      candidate({
        entity_type: SearchEntityType.Comment,
        entity_id: "c-other-org",
      }),
    ]);
    expect(authorized.has(`${SearchEntityType.Comment}:c-in-org`)).toBe(true);
    expect(authorized.has(`${SearchEntityType.Comment}:c-other-org`)).toBe(
      false
    );
  });

  it("re-authorizes a document comment through its thread's org, dropping another org's (PLN-2187 T-2.7)", async () => {
    const db = installDb({
      candidates: [],
      visible: { [SearchEntityType.Comment]: ["c-doc-in-org"] },
    });
    const documentComment = (entityId: string) =>
      candidate({
        entity_type: SearchEntityType.Comment,
        entity_id: entityId,
        entity_subtype: ArtifactType.Document,
        anchor_entity_id: "aaaaaaaa-0000-0000-0000-00000000d0c1",
      });

    const authorized = await reauthorizeHits(ORG, [
      documentComment("c-doc-in-org"),
      documentComment("c-doc-other-org"),
    ]);

    expect([...authorized]).toEqual([
      `${SearchEntityType.Comment}:c-doc-in-org`,
    ]);
    const call = (db.comment.findMany as Mock).mock.calls[0][0] as {
      where: { thread: { is: { organizationId: string } } };
    };
    expect(call.where.thread.is.organizationId).toBe(ORG);
  });

  it("authorizes a pull_request in-org and drops a cross-org one (FEA-3930)", async () => {
    installDb({
      candidates: [],
      visible: { [SearchEntityType.PullRequest]: ["pr-in-org"] },
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.PullRequest,
        entity_id: "pr-in-org",
      }),
      candidate({
        entity_type: SearchEntityType.PullRequest,
        entity_id: "pr-other-org",
      }),
    ]);
    expect(authorized.has(`${SearchEntityType.PullRequest}:pr-in-org`)).toBe(
      true
    );
    expect(authorized.has(`${SearchEntityType.PullRequest}:pr-other-org`)).toBe(
      false
    );
  });

  it("gates a pull_request on its owning branch being live (not soft-deleted)", async () => {
    const db = installDb({
      candidates: [],
      visible: { [SearchEntityType.PullRequest]: ["pr1"] },
    });
    await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.PullRequest,
        entity_id: "pr1",
      }),
    ]);
    // The PR reauth query must require the owning branch to be un-deleted, so a
    // PR on a soft-deleted branch never resolves to a dead `/branches/…` route.
    const call = (db.pullRequestDetail.findMany as Mock).mock.calls[0][0] as {
      where: {
        branchArtifact: { is: { branch: { is: { deletedAt: unknown } } } };
      };
    };
    expect(call.where.branchArtifact.is.branch.is.deletedAt).toBeNull();
  });

  it("gates a comment against a soft-deleted branch anchor", async () => {
    const db = installDb({
      candidates: [],
      visible: { [SearchEntityType.Comment]: ["c1"] },
    });
    await reauthorizeHits(ORG, [
      candidate({ entity_type: SearchEntityType.Comment, entity_id: "c1" }),
    ]);
    // A branch-anchored comment must be excluded when its anchor branch is
    // soft-deleted (it would otherwise link to a dead branch route); session
    // anchors are unaffected because the branch relation is absent.
    const call = (db.comment.findMany as Mock).mock.calls[0][0] as {
      where: {
        NOT: {
          thread: {
            is: {
              artifact: { is: { branch: { is: { deletedAt: unknown } } } };
            };
          };
        };
      };
    };
    expect(call.where.NOT.thread.is.artifact.is.branch.is.deletedAt).toEqual({
      not: null,
    });
  });

  it("authorizes a branch in-org and drops a cross-org one (FEA-3930)", async () => {
    installDb({
      candidates: [],
      visible: { [SearchEntityType.Branch]: ["b-in-org"] },
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.Branch,
        entity_id: "b-in-org",
      }),
      candidate({
        entity_type: SearchEntityType.Branch,
        entity_id: "b-other-org",
      }),
    ]);
    expect(authorized.has(`${SearchEntityType.Branch}:b-in-org`)).toBe(true);
    expect(authorized.has(`${SearchEntityType.Branch}:b-other-org`)).toBe(
      false
    );
  });

  it("authorizes an agent_component in-org and drops a cross-org one (FEA-4011 Slice A)", async () => {
    installDb({
      candidates: [],
      // Only ac-in-org exists under this org; ac-other-org does not — a
      // cross-org/stale projection row must not leak.
      visible: { [SearchEntityType.AgentComponent]: ["ac-in-org"] },
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.AgentComponent,
        entity_id: "ac-in-org",
      }),
      candidate({
        entity_type: SearchEntityType.AgentComponent,
        entity_id: "ac-other-org",
      }),
    ]);
    expect(authorized.has(`${SearchEntityType.AgentComponent}:ac-in-org`)).toBe(
      true
    );
    expect(
      authorized.has(`${SearchEntityType.AgentComponent}:ac-other-org`)
    ).toBe(false);
  });

  it("gates an agent_component on it not being uninstalled (FEA-4011 Slice A)", async () => {
    const db = installDb({
      candidates: [],
      visible: { [SearchEntityType.AgentComponent]: ["ac1"] },
    });
    await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.AgentComponent,
        entity_id: "ac1",
      }),
    ]);
    // A since-uninstalled component must be excluded so a raced/missed
    // projection removal cannot keep it searchable (parity with the
    // branch/PR soft-delete gate).
    const call = (db.agentComponent.findMany as Mock).mock.calls[0][0] as {
      where: { uninstalledAt: unknown };
    };
    expect(call.where.uninstalledAt).toBeNull();
  });

  it("authorizes an agent_session hit only when the org transcript gate is ON", async () => {
    installDb({
      candidates: [],
      visible: { [SearchEntityType.AgentSession]: ["sess-1"] },
      transcriptGateOn: true,
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.AgentSession,
        entity_id: "sess-1",
      }),
    ]);
    expect(authorized.has(`${SearchEntityType.AgentSession}:sess-1`)).toBe(
      true
    );
  });

  it("drops an agent_session hit when the org transcript gate is OFF (defense-in-depth)", async () => {
    // Even though the SessionDetail source row exists and belongs to the org,
    // the gate being off must hide it — a stale projection row from when it was
    // on cannot leak.
    installDb({
      candidates: [],
      visible: { [SearchEntityType.AgentSession]: ["sess-1"] },
      transcriptGateOn: false,
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.AgentSession,
        entity_id: "sess-1",
      }),
    ]);
    expect(authorized.size).toBe(0);
  });

  it("drops an agent_session hit whose SessionDetail is not in the org even when the gate is ON", async () => {
    // Gate on, but the source row is not visible under this org (cross-org /
    // stale projection): still dropped.
    installDb({
      candidates: [],
      visible: { [SearchEntityType.AgentSession]: [] },
      transcriptGateOn: true,
    });
    const authorized = await reauthorizeHits(ORG, [
      candidate({
        entity_type: SearchEntityType.AgentSession,
        entity_id: "other-org-sess",
      }),
    ]);
    expect(authorized.size).toBe(0);
  });
});
