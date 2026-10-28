import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  ArtifactRefTargetKind,
  roleFromMethod,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-pr-link-metadata";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionUpsertTx } from "../records";
import {
  mergeArtifactRefsBySlug,
  persistArtifactLinks,
  resolveArtifactSlugMap,
} from "./slug-links";

const ORG = "org-1";
const SESSION_ARTIFACT = "session-artifact-1";
const OBSERVED_AT = new Date("2026-08-22T17:00:00.000Z");
const SESSION_CONTRIBUTED_AT = new Date("2026-08-22T09:15:00.000Z");

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
  storedMetadata?: unknown;
  upsertRejectsWith?: unknown;
  artifacts?: Array<{ id: string; slug: string | null }>;
};

function fakeTx(parts: FakeTxParts = {}) {
  const artifactLinkDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const artifactLinkCreateMany = parts.upsertRejectsWith
    ? vi.fn().mockRejectedValue(parts.upsertRejectsWith)
    : vi.fn().mockResolvedValue({ id: "link-1" });
  const executeRaw = vi.fn().mockResolvedValue({ count: 1 });
  const artifactFindMany = vi.fn().mockResolvedValue(parts.artifacts ?? []);
  const sessionDetailFindUnique = vi
    .fn()
    .mockResolvedValue({ metadata: parts.storedMetadata ?? null });
  const sessionDetailUpdate = vi.fn().mockResolvedValue({});

  const tx = {
    $executeRaw: executeRaw,
    artifact: { findMany: artifactFindMany },
    artifactLink: {
      deleteMany: artifactLinkDeleteMany,
      createMany: artifactLinkCreateMany,
    },
    sessionDetail: {
      findUnique: sessionDetailFindUnique,
      update: sessionDetailUpdate,
    },
  } as unknown as AgentSessionUpsertTx;

  return {
    tx,
    artifactLinkDeleteMany,
    artifactLinkCreateMany,
    executeRaw,
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
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      undefined,
      new Map(),
      OBSERVED_AT
    );

    expect(f.artifactLinkDeleteMany).not.toHaveBeenCalled();
    expect(f.artifactLinkCreateMany).not.toHaveBeenCalled();
  });

  it("clears every slug link when an explicit empty array is sent", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [],
      new Map(),
      OBSERVED_AT
    );

    expect(f.artifactLinkDeleteMany).toHaveBeenCalledTimes(1);
    const where = f.artifactLinkDeleteMany.mock.calls[0][0].where;
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
      new Map([["ISS-100", "artifact-1"]]),
      OBSERVED_AT
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
      new Map([["ISS-100", "artifact-1"]]),
      OBSERVED_AT
    );

    expect(f.artifactLinkCreateMany).toHaveBeenCalledTimes(1);
    expect(f.artifactLinkCreateMany.mock.calls[0][0].data[0]).toMatchObject({
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
      new Map([["ISS-100", "artifact-1"]]),
      OBSERVED_AT
    );

    expect(
      "relation" in f.artifactLinkCreateMany.mock.calls[0][0].data[0].metadata
    ).toBe(false);
  });

  it("skips a self-link when the slug resolves to the session's own artifact", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef()],
      new Map([["ISS-100", SESSION_ARTIFACT]]),
      OBSERVED_AT
    );

    expect(f.artifactLinkCreateMany).not.toHaveBeenCalled();
    expect(
      f.artifactLinkDeleteMany.mock.calls[0][0].where.targetId
    ).toBeUndefined();
  });

  it("keys the write on the (source, target, linkType) unique constraint", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef()],
      new Map([["ISS-100", "artifact-1"]]),
      OBSERVED_AT
    );

    expect(f.artifactLinkCreateMany.mock.calls[0][0]).toMatchObject({
      skipDuplicates: true,
      data: [
        {
          sourceId: SESSION_ARTIFACT,
          targetId: "artifact-1",
          linkType: LinkType.RelatesTo,
        },
      ],
    });
  });

  it("rethrows a write failure rather than swallowing it", async () => {
    const boom = new Error("connection lost");
    const f = fakeTx({ upsertRejectsWith: boom });

    await expect(
      persistArtifactLinks(
        f.tx,
        ORG,
        SESSION_ARTIFACT,
        [slugRef()],
        new Map([["ISS-100", "artifact-1"]]),
        OBSERVED_AT
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
      new Map(),
      OBSERVED_AT
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
      new Map(),
      OBSERVED_AT
    );

    const metadata = f.sessionDetailUpdate.mock.calls[0][0].data.metadata;
    expect(metadata._unresolvedArtifactRefs.sort()).toEqual([
      "ISS-777",
      "ISS-888",
      "ISS-999",
    ]);
    expect(metadata.keepMe).toBe("yes");
  });

  it("keeps an own __proto__ metadata key while merging unresolved slugs", async () => {
    const f = fakeTx({
      storedMetadata: JSON.parse('{"keepMe":"yes","__proto__":{"deep":1}}'),
    });

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef({ slug: "ISS-777" })],
      new Map(),
      OBSERVED_AT
    );

    const metadata = f.sessionDetailUpdate.mock.calls[0][0].data.metadata;
    expect(Object.hasOwn(metadata, "__proto__")).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(metadata, "__proto__")?.value
    ).toEqual({ deep: 1 });
    expect(metadata.keepMe).toBe("yes");
    expect(metadata._unresolvedArtifactRefs).toEqual(["ISS-777"]);
  });

  it("does not touch session metadata when every slug resolved", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef()],
      new Map([["ISS-100", "artifact-1"]]),
      OBSERVED_AT
    );

    expect(f.sessionDetailFindUnique).not.toHaveBeenCalled();
    expect(f.sessionDetailUpdate).not.toHaveBeenCalled();
  });
});

describe("persistArtifactLinks — last-contributed timestamp (ISS-7669)", () => {
  it("stamps the ref's own observed instant, not the session fallback", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef({ observedAt: "2026-08-22T13:30:00.000Z" })],
      new Map([["ISS-100", "artifact-1"]]),
      SESSION_CONTRIBUTED_AT
    );

    const call = f.artifactLinkCreateMany.mock.calls[0][0];
    expect(call.data[0].lastContributedAt).toEqual(
      new Date("2026-08-22T13:30:00.000Z")
    );
    expect(f.executeRaw.mock.calls[0]).toContainEqual([
      "2026-08-22T13:30:00.000Z",
    ]);
    expect(call.data[0].lastContributedAt).not.toEqual(SESSION_CONTRIBUTED_AT);
  });

  it("advances an existing link through a guard that only ever moves it forward", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef({ observedAt: "2026-08-22T17:00:00.000Z" })],
      new Map([["ISS-100", "artifact-1"]]),
      SESSION_CONTRIBUTED_AT
    );

    expect(f.artifactLinkCreateMany).toHaveBeenCalledTimes(1);
    expect(f.executeRaw).toHaveBeenCalledTimes(1);
    const advance = f.executeRaw.mock.calls[0];
    expect(advance.slice(1)).toEqual(
      expect.arrayContaining([
        ["artifact-1"],
        ["2026-08-22T17:00:00.000Z"],
        ORG,
        SESSION_ARTIFACT,
        LinkType.RelatesTo,
      ])
    );
    expect(advance[0].join("?")).toContain(
      "link.last_contributed_at < incoming.contributed_at"
    );
  });

  it("leaves an existing link's metadata untouched", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef({ method: "mcp_tool_call", isPrimary: true })],
      new Map([["ISS-100", "artifact-1"]]),
      SESSION_CONTRIBUTED_AT
    );

    const call = f.artifactLinkCreateMany.mock.calls[0][0];
    expect(call.skipDuplicates).toBe(true);
    // ISS-12552: the only metadata change is scoped to evidence-lane rows;
    // every other row keeps the metadata it has.
    const update = f.executeRaw.mock.calls[0];
    expect(update[0].join("?")).toContain(
      "WHEN link.metadata ->> 'linkKind' = ?\n            THEN link.metadata || incoming.metadata\n            ELSE link.metadata"
    );
    expect(update).toContain(SessionArtifactLinkKind.SessionEvidence);
    expect(call.data[0].metadata).toMatchObject({ role: "input" });
  });

  it("does not advance the stamp when the same payload is synced twice", async () => {
    const refs = [slugRef({ observedAt: "2026-08-22T13:30:00.000Z" })];
    const first = fakeTx();
    const second = fakeTx();

    await persistArtifactLinks(
      first.tx,
      ORG,
      SESSION_ARTIFACT,
      refs,
      new Map([["ISS-100", "artifact-1"]]),
      new Date("2026-08-22T14:00:00.000Z")
    );
    await persistArtifactLinks(
      second.tx,
      ORG,
      SESSION_ARTIFACT,
      refs,
      new Map([["ISS-100", "artifact-1"]]),
      new Date("2026-08-29T09:00:00.000Z")
    );

    expect(second.executeRaw.mock.calls[0][2]).toEqual(
      first.executeRaw.mock.calls[0][2]
    );
  });

  it("falls back to the session instant when the ref states none", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef()],
      new Map([["ISS-100", "artifact-1"]]),
      SESSION_CONTRIBUTED_AT
    );

    expect(
      f.artifactLinkCreateMany.mock.calls[0][0].data[0].lastContributedAt
    ).toEqual(new Date("2026-08-22T09:15:00.000Z"));
  });

  it("falls back to the session instant when the ref states an unparseable one", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef({ observedAt: "not-a-timestamp" })],
      new Map([["ISS-100", "artifact-1"]]),
      SESSION_CONTRIBUTED_AT
    );

    const stamped =
      f.artifactLinkCreateMany.mock.calls[0][0].data[0].lastContributedAt;
    expect(Number.isNaN(stamped.getTime())).toBe(false);
    expect(stamped).toEqual(new Date("2026-08-22T09:15:00.000Z"));
  });

  it("writes nothing when the client sent no refs at all", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      undefined,
      new Map([["ISS-100", "artifact-1"]]),
      SESSION_CONTRIBUTED_AT
    );

    expect(f.artifactLinkCreateMany).not.toHaveBeenCalled();
  });

  it("does not stamp a self-link the session resolved to its own artifact", async () => {
    const f = fakeTx();

    await persistArtifactLinks(
      f.tx,
      ORG,
      SESSION_ARTIFACT,
      [slugRef({ observedAt: "2026-08-22T13:30:00.000Z" })],
      new Map([["ISS-100", SESSION_ARTIFACT]]),
      SESSION_CONTRIBUTED_AT
    );

    expect(f.artifactLinkCreateMany).not.toHaveBeenCalled();
  });
});

describe("mergeArtifactRefsBySlug — observedAt recency (ISS-7669)", () => {
  it("keeps the LATEST observed instant across refs naming one slug", () => {
    const merged = mergeArtifactRefsBySlug([
      slugRef({ observedAt: "2026-08-22T10:00:00.000Z" }),
      slugRef({ observedAt: "2026-08-22T18:45:00.000Z" }),
      slugRef({ observedAt: "2026-08-22T12:00:00.000Z" }),
    ]);

    expect(merged.get("ISS-100")?.observedAt).toBe("2026-08-22T18:45:00.000Z");
  });

  it("takes a later instant from a ref that loses the role precedence", () => {
    const merged = mergeArtifactRefsBySlug([
      slugRef({
        method: "mcp_tool_call",
        observedAt: "2026-08-22T10:00:00.000Z",
      }),
      slugRef({
        method: "slug_in_branch",
        observedAt: "2026-08-22T18:45:00.000Z",
      }),
    ]);

    const entry = merged.get("ISS-100");
    expect(entry?.role).toBe("input");
    expect(entry?.observedAt).toBe("2026-08-22T18:45:00.000Z");
  });

  it("leaves observedAt absent when no ref stated one", () => {
    const merged = mergeArtifactRefsBySlug([slugRef(), slugRef()]);

    expect("observedAt" in (merged.get("ISS-100") ?? {})).toBe(false);
  });
});
