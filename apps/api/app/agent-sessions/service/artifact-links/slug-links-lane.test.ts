/**
 * Direct unit coverage for the closedloop-slug artifact-link lane.
 *
 * The sibling `slug-links.test.ts` drives the whole `agentSessionsService` to
 * assert ONE thing — the `deleteMany` guard shape that spares the session_pr and
 * session_branch lanes. That case stays where it is; everything else in this
 * module (role derivation, same-slug merge precedence, slug batch resolution,
 * self-link skip, unresolved-slug accumulation, the P2002 race swallow) had no
 * coverage at all.
 *
 * `persistArtifactLinks` and `resolveArtifactSlugMap` take `tx` as an explicit
 * parameter, so they are driven with a hand-rolled fake rather than the service
 * harness — no `@repo/database` mock is needed, since this module's imports are
 * type-only or zod.
 */

import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  ArtifactRefTargetKind,
  roleFromMethod,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionUpsertTx } from "../records";
import {
  mergeArtifactRefsBySlug,
  persistArtifactLinks,
  resolveArtifactSlugMap,
} from "./slug-links";

const ORG = "org-1";
const SESSION_ARTIFACT = "session-artifact-1";

function slugRef(overrides: Record<string, unknown> = {}): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.ClosedloopArtifact,
    slug: "ISS-100",
    isPrimary: false,
    method: "slug_in_branch",
    ...overrides,
  } as SyncedArtifactRef;
}

type FakeTxParts = {
  existingLink?: { id: string } | null;
  storedMetadata?: unknown;
  createRejectsWith?: unknown;
  artifacts?: Array<{ id: string; slug: string | null }>;
};

function fakeTx(parts: FakeTxParts = {}) {
  const artifactLinkDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const artifactLinkFindFirst = vi
    .fn()
    .mockResolvedValue(parts.existingLink ?? null);
  const artifactLinkCreate = parts.createRejectsWith
    ? vi.fn().mockRejectedValue(parts.createRejectsWith)
    : vi.fn().mockResolvedValue({});
  const artifactFindMany = vi.fn().mockResolvedValue(parts.artifacts ?? []);
  const sessionDetailFindUnique = vi
    .fn()
    .mockResolvedValue({ metadata: parts.storedMetadata ?? null });
  const sessionDetailUpdate = vi.fn().mockResolvedValue({});

  const tx = {
    artifact: { findMany: artifactFindMany },
    artifactLink: {
      deleteMany: artifactLinkDeleteMany,
      findFirst: artifactLinkFindFirst,
      create: artifactLinkCreate,
    },
    sessionDetail: {
      findUnique: sessionDetailFindUnique,
      update: sessionDetailUpdate,
    },
  } as unknown as AgentSessionUpsertTx;

  return {
    tx,
    artifactLinkDeleteMany,
    artifactLinkFindFirst,
    artifactLinkCreate,
    artifactFindMany,
    sessionDetailFindUnique,
    sessionDetailUpdate,
  };
}

describe("roleFromMethod", () => {
  it("returns input for a primary ref regardless of method", () => {
    expect(roleFromMethod("slug_in_cwd", true)).toBe("input");
  });

  it("maps the explicit-intent methods to input", () => {
    expect(roleFromMethod("mcp_tool_call", false)).toBe("input");
    expect(roleFromMethod("launch_metadata", false)).toBe("input");
  });

  it("maps the incidental-location methods to workspace", () => {
    expect(roleFromMethod("slug_in_branch", false)).toBe("workspace");
    expect(roleFromMethod("slug_in_cwd", false)).toBe("workspace");
    expect(roleFromMethod("slug_in_session_slug", false)).toBe("workspace");
  });

  it("falls back to referenced for an unknown method", () => {
    // Forward compatibility: a method a newer desktop emits must not crash or
    // silently classify as explicit intent.
    expect(roleFromMethod("some_future_method", false)).toBe("referenced");
  });
});

describe("mergeArtifactRefsBySlug", () => {
  it("ignores refs that are not closedloop-artifact kind", () => {
    const merged = mergeArtifactRefsBySlug([
      { kind: ArtifactRefTargetKind.Branch } as SyncedArtifactRef,
      slugRef(),
    ]);

    expect([...merged.keys()]).toEqual(["ISS-100"]);
  });

  it("ignores a ref whose slug is empty or whitespace", () => {
    expect(mergeArtifactRefsBySlug([slugRef({ slug: "   " })]).size).toBe(0);
    expect(mergeArtifactRefsBySlug([slugRef({ slug: "" })]).size).toBe(0);
  });

  it("lets the higher-precedence role win and carries its method with it", () => {
    // workspace arrives first, then input — input must win, and the recorded
    // method must be the winner's, not the loser's.
    const merged = mergeArtifactRefsBySlug([
      slugRef({ method: "slug_in_branch" }),
      slugRef({ method: "mcp_tool_call" }),
    ]);

    expect(merged.get("ISS-100")).toMatchObject({
      role: "input",
      method: "mcp_tool_call",
    });
  });

  it("does not let a lower-precedence role displace a higher one", () => {
    const merged = mergeArtifactRefsBySlug([
      slugRef({ method: "mcp_tool_call" }),
      slugRef({ method: "slug_in_branch" }),
    ]);

    expect(merged.get("ISS-100")).toMatchObject({
      role: "input",
      method: "mcp_tool_call",
    });
  });

  it("OR-aggregates isPrimary across duplicates", () => {
    const merged = mergeArtifactRefsBySlug([
      slugRef({ isPrimary: false }),
      slugRef({ isPrimary: true }),
    ]);

    expect(merged.get("ISS-100")?.isPrimary).toBe(true);
  });

  it("keeps the first relation supplied and does not overwrite it", () => {
    const merged = mergeArtifactRefsBySlug([
      slugRef({ relation: "created" }),
      slugRef({ relation: "workspace" }),
    ]);

    expect(merged.get("ISS-100")?.relation).toBe("created");
  });

  it("adopts a relation from a later ref when the first carried none", () => {
    const merged = mergeArtifactRefsBySlug([
      slugRef(),
      slugRef({ relation: "created" }),
    ]);

    expect(merged.get("ISS-100")?.relation).toBe("created");
  });
});

describe("resolveArtifactSlugMap", () => {
  it("short-circuits without querying when no session carries a slug ref", async () => {
    const f = fakeTx();
    const sessions = [
      { artifactRefs: undefined },
      { artifactRefs: [{ kind: ArtifactRefTargetKind.Branch }] },
    ] as unknown as readonly SyncedAgentSession[];

    const map = await resolveArtifactSlugMap(f.tx, ORG, sessions);

    expect(map.size).toBe(0);
    expect(f.artifactFindMany).not.toHaveBeenCalled();
  });

  it("batches DISTINCT slugs across sessions into one org-scoped query", async () => {
    const f = fakeTx({
      artifacts: [
        { id: "a-1", slug: "ISS-100" },
        { id: "a-2", slug: "ISS-200" },
      ],
    });
    const sessions = [
      { artifactRefs: [slugRef({ slug: "ISS-100" })] },
      { artifactRefs: [slugRef({ slug: "ISS-200" })] },
      { artifactRefs: [slugRef({ slug: "ISS-100" })] },
    ] as unknown as readonly SyncedAgentSession[];

    const map = await resolveArtifactSlugMap(f.tx, ORG, sessions);

    expect(f.artifactFindMany).toHaveBeenCalledTimes(1);
    const where = f.artifactFindMany.mock.calls[0][0].where;
    expect(where.organizationId).toBe(ORG);
    expect([...where.slug.in].sort()).toEqual(["ISS-100", "ISS-200"]);
    expect(map.get("ISS-100")).toBe("a-1");
    expect(map.get("ISS-200")).toBe("a-2");
  });

  it("drops a resolved row whose slug came back null", async () => {
    const f = fakeTx({ artifacts: [{ id: "a-1", slug: null }] });
    const sessions = [
      { artifactRefs: [slugRef()] },
    ] as unknown as readonly SyncedAgentSession[];

    expect((await resolveArtifactSlugMap(f.tx, ORG, sessions)).size).toBe(0);
  });
});

describe("persistArtifactLinks", () => {
  it("leaves existing links untouched when refs are undefined", async () => {
    // undefined means the client sent nothing (older desktop, chunked payload) —
    // distinct from [] which means "references nothing" and must clear.
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      undefined,
      new Map()
    );

    expect(f.artifactLinkDeleteMany).not.toHaveBeenCalled();
    expect(f.artifactLinkCreate).not.toHaveBeenCalled();
  });

  it("clears every slug link when an explicit empty array is sent", async () => {
    const f = fakeTx();

    await persistArtifactLinks(f.tx, ORG, SESSION_ARTIFACT, [], new Map());

    expect(f.artifactLinkDeleteMany).toHaveBeenCalledTimes(1);
    const where = f.artifactLinkDeleteMany.mock.calls[0][0].where;
    // With nothing resolved there is no targetId exclusion — the delete is total.
    expect(where.targetId).toBeUndefined();
    expect(where.sourceId).toBe(SESSION_ARTIFACT);
    expect(where.linkType).toBe(LinkType.RelatesTo);
  });

  it("excludes still-referenced targets from the replacement delete", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef()],
      new Map([["ISS-100", "artifact-1"]])
    );

    const where = f.artifactLinkDeleteMany.mock.calls[0][0].where;
    expect(where.targetId).toEqual({ notIn: ["artifact-1"] });
  });

  it("creates the link carrying role, method, isPrimary and relation", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [
        slugRef({
          method: "mcp_tool_call",
          isPrimary: true,
          relation: "created",
        }),
      ],
      new Map([["ISS-100", "artifact-1"]])
    );

    expect(f.artifactLinkCreate).toHaveBeenCalledTimes(1);
    expect(f.artifactLinkCreate.mock.calls[0][0].data).toMatchObject({
      organizationId: ORG,
      sourceId: SESSION_ARTIFACT,
      targetId: "artifact-1",
      linkType: LinkType.RelatesTo,
      metadata: {
        role: "input",
        method: "mcp_tool_call",
        isPrimary: true,
        relation: "created",
      },
    });
  });

  it("omits relation from the metadata when the extractor supplied none", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef()],
      new Map([["ISS-100", "artifact-1"]])
    );

    expect(
      "relation" in f.artifactLinkCreate.mock.calls[0][0].data.metadata
    ).toBe(false);
  });

  it("skips a self-link when the slug resolves to the session's own artifact", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef()],
      new Map([["ISS-100", SESSION_ARTIFACT]])
    );

    expect(f.artifactLinkCreate).not.toHaveBeenCalled();
    // A self-target is not "still referenced" either — it never enters the set.
    expect(
      f.artifactLinkDeleteMany.mock.calls[0][0].where.targetId
    ).toBeUndefined();
  });

  it("does not re-create a link that already exists", async () => {
    const f = fakeTx({ existingLink: { id: "link-1" } });

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef()],
      new Map([["ISS-100", "artifact-1"]])
    );

    expect(f.artifactLinkCreate).not.toHaveBeenCalled();
  });

  it("swallows a P2002 from a concurrent sync creating the same link", async () => {
    const f = fakeTx({ createRejectsWith: { code: "P2002" } });

    await expect(
      persistArtifactLinks(
        f.tx,
        ORG,
        SESSION_ARTIFACT,
        [slugRef()],
        new Map([["ISS-100", "artifact-1"]])
      )
    ).resolves.toBeUndefined();
  });

  it("rethrows a non-P2002 create failure", async () => {
    const boom = new Error("connection lost");
    const f = fakeTx({ createRejectsWith: boom });

    await expect(
      persistArtifactLinks(
        f.tx,
        ORG,
        SESSION_ARTIFACT,
        [slugRef()],
        new Map([["ISS-100", "artifact-1"]])
      )
    ).rejects.toBe(boom);
  });

  it("records an unresolved slug in session metadata", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef({ slug: "ISS-999" })],
      new Map()
    );

    expect(f.sessionDetailUpdate).toHaveBeenCalledTimes(1);
    expect(
      f.sessionDetailUpdate.mock.calls[0][0].data.metadata
        ._unresolvedArtifactRefs
    ).toEqual(["ISS-999"]);
  });

  it("merges into prior unresolved slugs without duplicating or dropping other metadata", async () => {
    const f = fakeTx({
      storedMetadata: {
        _unresolvedArtifactRefs: ["ISS-999", "ISS-888"],
        keepMe: "yes",
      },
    });

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef({ slug: "ISS-999" }), slugRef({ slug: "ISS-777" })],
      new Map()
    );

    const metadata = f.sessionDetailUpdate.mock.calls[0][0].data.metadata;
    expect(metadata._unresolvedArtifactRefs.sort()).toEqual([
      "ISS-777",
      "ISS-888",
      "ISS-999",
    ]);
    expect(metadata.keepMe).toBe("yes");
  });

  it("does not touch session metadata when every slug resolved", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef()],
      new Map([["ISS-100", "artifact-1"]])
    );

    expect(f.sessionDetailFindUnique).not.toHaveBeenCalled();
    expect(f.sessionDetailUpdate).not.toHaveBeenCalled();
  });
});
