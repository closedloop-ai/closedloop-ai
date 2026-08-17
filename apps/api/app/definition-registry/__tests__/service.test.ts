/**
 * FEA-3290 (F1, Slice 3) — registry writer unit tests.
 *
 * These assert the invariants the registry service is responsible for, using a
 * faithful in-memory fake of the Prisma `TransactionClient` that models
 * `upsert`-by-unique-key exactly (create-if-absent, update-if-present, keyed on
 * the compound natural key). This proves the writer's semantics deterministically
 * without a database, in the default vitest suite; the real-Postgres upsert
 * semantics are additionally proven in
 * `__tests__/integration/definition-registry-realdb.test.ts`.
 *
 * Covered:
 *  - same {content, kind, org} twice ⇒ exactly ONE DefinitionVersion (idempotent).
 *  - a whitespace-only edit ⇒ a SECOND version (rides Slice-1's exact,
 *    whitespace-preserving contract — not the coarse lenient normalizer).
 *  - SourceOccurrence idempotent rescan (same provenance ⇒ one occurrence,
 *    lastSeenAt bumped); a different provenance ⇒ an additional occurrence.
 *  - org-scoping isolation: two orgs, identical content ⇒ two version rows, no
 *    cross-org read.
 *  - fingerprint-integration: the registry's definitionHash is byte-identical to
 *    calling `computeDefinitionHash({frontmatter:"", body:content, kind})`
 *    directly (and the module imports it — no local sha256).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeDefinitionHash } from "@repo/api/src/definition-fingerprint";
import type { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { SourceAccessState, SourceOccurrenceType } from "@repo/database";
import ts from "typescript6";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ensureDefinitionVersion,
  recordDefinitionSourceOccurrence,
  registerDefinitionVersion,
} from "../service";

// ---------------------------------------------------------------------------
// Faithful in-memory fake TransactionClient (models upsert-by-unique-key).
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function keyOf(fields: Row): string {
  // Stable, order-independent key of the compound-unique input object.
  return JSON.stringify(
    Object.keys(fields)
      .sort()
      .map((k) => [k, fields[k]])
  );
}

/**
 * A tiny Prisma-delegate fake keyed on the single compound-unique `where` field
 * (the delegates used by the registry each have exactly one). It models the
 * exact upsert contract: if a row with that natural key exists, apply `update`;
 * otherwise insert `create`. Rows carry a synthetic `id`.
 *
 * `naturalKeyFields` names the columns that form the occurrence natural key so
 * the null-target path (`findFirst` + `create`/`update`) dedupes on the same
 * identity the compound-unique `upsert` path uses — faithfully modelling the
 * NULL-safe dedupe the writer does when `computeTargetId` is null.
 */
function makeDelegate(uniqueField: string, naturalKeyFields?: string[]) {
  const rows: Row[] = [];
  let seq = 0;
  function nextId(): string {
    seq += 1;
    return `${uniqueField}-${seq}`;
  }
  function naturalKeyOf(source: Row): string {
    if (!naturalKeyFields) {
      return "";
    }
    const picked: Row = {};
    for (const f of naturalKeyFields) {
      picked[f] = source[f] ?? null;
    }
    return keyOf(picked);
  }
  return {
    rows,
    upsert(args: {
      where: Record<string, Row>;
      create: Row;
      update: Row;
      select?: Row;
    }) {
      const natural = args.where[uniqueField];
      if (natural == null) {
        throw new Error(`upsert where must use ${uniqueField}`);
      }
      const k = keyOf(natural);
      const existing = rows.find((r) => r.__key === k);
      if (existing) {
        Object.assign(existing, args.update);
        return Promise.resolve({ id: existing.id });
      }
      const created: Row = { __key: k, id: nextId(), ...args.create };
      rows.push(created);
      return Promise.resolve({ id: created.id });
    },
    // NULL-safe dedupe path used when computeTargetId is null.
    findFirst(args: { where: Row }) {
      const target = naturalKeyOf(args.where);
      const hit = rows.find((r) => naturalKeyOf(r) === target);
      return Promise.resolve(hit ? { id: hit.id } : null);
    },
    create(args: { data: Row }) {
      const created: Row = { id: nextId(), ...args.data };
      created.__key = naturalKeyOf(created);
      rows.push(created);
      return Promise.resolve({ id: created.id });
    },
    createMany(args: { data: Row | Row[]; skipDuplicates?: boolean }) {
      const candidates = Array.isArray(args.data) ? args.data : [args.data];
      let count = 0;
      for (const candidate of candidates) {
        const natural = naturalKeyOf(candidate);
        if (
          args.skipDuplicates &&
          rows.some((row) => naturalKeyOf(row) === natural)
        ) {
          continue;
        }
        rows.push({
          __key: natural,
          id: nextId(),
          ...candidate,
        });
        count += 1;
      }
      return Promise.resolve({ count });
    },
    update(args: { where: { id: string }; data: Row }) {
      const hit = rows.find((r) => r.id === args.where.id);
      if (hit) {
        Object.assign(hit, args.data);
      }
      return Promise.resolve({ id: args.where.id });
    },
    updateMany(args: { where: Row; data: Row }) {
      const hits = rows.filter((row) => matchesFakeWhere(row, args.where));
      for (const hit of hits) {
        Object.assign(hit, args.data);
      }
      return Promise.resolve({ count: hits.length });
    },
  };
}

function matchesFakeWhere(row: Row, where: Row): boolean {
  return Object.entries(where).every(([field, predicate]) => {
    const value = row[field];
    if (
      predicate &&
      typeof predicate === "object" &&
      !(predicate instanceof Date)
    ) {
      const bounds = predicate as {
        gt?: Date;
        lt?: Date;
        lte?: Date;
      };
      if (!(value instanceof Date)) {
        return false;
      }
      if (bounds.gt && !(value > bounds.gt)) {
        return false;
      }
      if (bounds.lt && !(value < bounds.lt)) {
        return false;
      }
      if (bounds.lte && !(value <= bounds.lte)) {
        return false;
      }
      return true;
    }
    return value === predicate;
  });
}

/**
 * Model the writer's atomic `INSERT … ON CONFLICT DO UPDATE` for the null-target
 * (pack) path. `$executeRaw` receives the tagged-template values positionally in
 * the exact order the writer interpolates them (compute_target_id is a literal
 * NULL and is NOT interpolated), so we reconstruct the row and dedupe on the same
 * null-target natural key the partial unique index enforces in Postgres — the
 * conflict updates lastSeenAt/accessState instead of inserting a duplicate.
 */
const NULL_TARGET_RAW_KEY_FIELDS = [
  "definitionVersionId",
  "occurrenceType",
  "repoFullName",
  "repoPath",
  "repoCommit",
  "localPath",
  "packId",
] as const;

function makeTx() {
  const definitionVersion = makeDelegate("organizationId_definitionHash");
  const sourceOccurrence = makeDelegate(
    "definitionVersionId_occurrenceType_repoFullName_repoPath_repoCommit_computeTargetId_localPath_packId",
    [
      "definitionVersionId",
      "occurrenceType",
      "repoFullName",
      "repoPath",
      "repoCommit",
      "computeTargetId",
      "localPath",
      "packId",
    ]
  );
  // FEA-3982 edit-lineage: the (version, user) upsert the writer issues when a
  // caller supplies `editorUserId`. Keyed on the compound unique input.
  const definitionVersionEditor = makeDelegate("definitionVersionId_userId", [
    "definitionVersionId",
    "userId",
  ]);
  let rawSeq = 0;
  // FEA-3982: the writer issues TWO distinct atomic `$executeRaw` upserts — the
  // null-target source-occurrence insert and the editor-lineage insert. Route by
  // the target table in the template so each is modeled with its own conflict
  // semantics (LEAST/GREATEST for the editor window).
  function executeRaw(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number> {
    const sql = strings.join(" ");
    if (sql.includes("definition_version_editors")) {
      return executeRawEditor(...values);
    }
    return executeRawNullTargetOccurrence(...values);
  }
  function executeRawEditor(...values: unknown[]): Promise<number> {
    const [definitionVersionId, userId, observedAt] = values as [
      unknown,
      unknown,
      Date,
    ];
    const hit = definitionVersionEditor.rows.find(
      (r) =>
        r.definitionVersionId === definitionVersionId && r.userId === userId
    );
    if (hit) {
      // ON CONFLICT DO UPDATE SET first = LEAST(...), last = GREATEST(...).
      if (observedAt < (hit.firstEditedAt as Date)) {
        hit.firstEditedAt = observedAt;
      }
      if (observedAt > (hit.lastEditedAt as Date)) {
        hit.lastEditedAt = observedAt;
      }
      return Promise.resolve(1);
    }
    rawSeq += 1;
    definitionVersionEditor.rows.push({
      id: `raw-editor-${rawSeq}`,
      definitionVersionId,
      userId,
      role: "editor",
      firstEditedAt: observedAt,
      lastEditedAt: observedAt,
    });
    return Promise.resolve(1);
  }
  function executeRawNullTargetOccurrence(
    ...values: unknown[]
  ): Promise<number> {
    const [
      organizationId,
      definitionVersionId,
      occurrenceType,
      accessState,
      repoFullName,
      repoPath,
      repoCommit,
      localPath,
      packId,
      firstSeenAt,
      lastSeenAt,
    ] = values;
    const incoming: Row = {
      organizationId,
      definitionVersionId,
      occurrenceType,
      accessState,
      repoFullName,
      repoPath,
      repoCommit,
      computeTargetId: null,
      localPath,
      packId,
      firstSeenAt,
      lastSeenAt,
    };
    const keyOfNullTarget = (source: Row): string =>
      keyOf(
        Object.fromEntries(
          NULL_TARGET_RAW_KEY_FIELDS.map((f) => [f, source[f] ?? null])
        )
      );
    const target = keyOfNullTarget(incoming);
    const hit = sourceOccurrence.rows.find(
      (r) => r.computeTargetId == null && keyOfNullTarget(r) === target
    );
    if (hit) {
      hit.lastSeenAt = lastSeenAt;
      hit.accessState = accessState;
      return Promise.resolve(1);
    }
    rawSeq += 1;
    sourceOccurrence.rows.push({ id: `raw-occ-${rawSeq}`, ...incoming });
    return Promise.resolve(1);
  }
  return {
    definitionVersion,
    sourceOccurrence,
    definitionVersionEditor,
    // Cast to the TransactionClient shape the writer expects; only the three
    // delegates + `$executeRaw` (null-target path) above are exercised.
    tx: {
      definitionVersion,
      sourceOccurrence,
      definitionVersionEditor,
      $executeRaw: executeRaw,
    } as never,
  };
}

const ORG_A = "org-a";
const ORG_B = "org-b";
const KIND: AgentComponentKind = "skill";
const TARGET = "target-1";

// ---------------------------------------------------------------------------

describe("registerDefinitionVersion", () => {
  let fake: ReturnType<typeof makeTx>;

  beforeEach(() => {
    fake = makeTx();
  });

  it("upserts exactly ONE DefinitionVersion for the same {content, kind, org} (idempotent, bumps lastSeenAt)", async () => {
    const content = "# My Skill\n\nDo the thing.\n";
    const t1 = new Date("2026-01-01T00:00:00.000Z");
    const t2 = new Date("2026-02-01T00:00:00.000Z");

    const id1 = await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      computeTargetId: TARGET,
      installPath: ".claude/skills/my-skill/SKILL.md",
      observedAt: t1,
    });
    const id2 = await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      computeTargetId: TARGET,
      installPath: ".claude/skills/my-skill/SKILL.md",
      observedAt: t2,
    });

    expect(id1).toBe(id2);
    expect(fake.definitionVersion.rows).toHaveLength(1);
    // Only lastSeenAt moved; firstSeenAt stayed at first observation.
    const row = fake.definitionVersion.rows[0];
    expect(row.firstSeenAt).toEqual(t1);
    expect(row.lastSeenAt).toEqual(t2);
  });

  it("keeps definition and provenance observation windows monotonic when older evidence arrives later", async () => {
    const content = "# Historical Skill\n";
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-03-01T00:00:00.000Z");

    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      computeTargetId: TARGET,
      installPath: "/historical/SKILL.md",
      observedAt: newer,
      accessState: SourceAccessState.accessible,
    });
    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      computeTargetId: TARGET,
      installPath: "/historical/SKILL.md",
      observedAt: older,
      accessState: SourceAccessState.inaccessible,
    });

    expect(fake.definitionVersion.rows[0].firstSeenAt).toEqual(older);
    expect(fake.definitionVersion.rows[0].lastSeenAt).toEqual(newer);
    expect(fake.sourceOccurrence.rows[0].firstSeenAt).toEqual(older);
    expect(fake.sourceOccurrence.rows[0].lastSeenAt).toEqual(newer);
    expect(fake.sourceOccurrence.rows[0].accessState).toBe(
      SourceAccessState.accessible
    );
  });

  it("keeps exact-version identity separate from genuine provenance evidence", async () => {
    const definitionVersionId = await ensureDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content: "# Invocation snapshot\n",
      observedAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    expect(fake.definitionVersion.rows).toHaveLength(1);
    expect(fake.sourceOccurrence.rows).toHaveLength(0);

    await recordDefinitionSourceOccurrence(fake.tx, {
      organizationId: ORG_A,
      definitionVersionId,
      computeTargetId: TARGET,
      installPath: "/captured/SKILL.md",
      observedAt: new Date("2026-04-01T00:00:01.000Z"),
    });

    expect(fake.sourceOccurrence.rows).toHaveLength(1);
    expect(fake.sourceOccurrence.rows[0].localPath).toBe("/captured/SKILL.md");
  });

  it("produces a SECOND version for a whitespace-only edit (rides Slice-1's exact contract, not the coarse lenient hash)", async () => {
    const base = "# My Skill\nDo it.\n";
    const whitespaceEdit = "#  My Skill\nDo it.\n"; // one extra space — semantically same to a human, different bytes

    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content: base,
    });
    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content: whitespaceEdit,
    });

    // Two distinct exact versions — the fingerprint is whitespace-PRESERVING.
    expect(fake.definitionVersion.rows).toHaveLength(2);
    const hashes = fake.definitionVersion.rows.map((r) => r.definitionHash);
    expect(new Set(hashes).size).toBe(2);
  });

  it("upserts ONE SourceOccurrence for a repeated provenance (idempotent rescan, AC-6) and an ADDITIONAL one for a new provenance", async () => {
    const content = "# S\n";

    // Same version, same (target, path) observed twice.
    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      computeTargetId: TARGET,
      installPath: "/a/SKILL.md",
      observedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      computeTargetId: TARGET,
      installPath: "/a/SKILL.md",
      observedAt: new Date("2026-03-01T00:00:00.000Z"),
    });
    expect(fake.sourceOccurrence.rows).toHaveLength(1);
    expect(fake.sourceOccurrence.rows[0].lastSeenAt).toEqual(
      new Date("2026-03-01T00:00:00.000Z")
    );

    // Same version, a DIFFERENT path ⇒ a new occurrence.
    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      computeTargetId: TARGET,
      installPath: "/b/SKILL.md",
    });
    expect(fake.sourceOccurrence.rows).toHaveLength(2);
    // ...but still ONE version (same fingerprint, many occurrences).
    expect(fake.definitionVersion.rows).toHaveLength(1);
  });

  it("defaults occurrenceType to local and accessState to accessible; honors an inaccessible override", async () => {
    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content: "# S\n",
      computeTargetId: TARGET,
      installPath: "/a/SKILL.md",
    });
    expect(fake.sourceOccurrence.rows[0].occurrenceType).toBe(
      SourceOccurrenceType.local
    );
    expect(fake.sourceOccurrence.rows[0].accessState).toBe(
      SourceAccessState.accessible
    );

    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content: "# T\n",
      computeTargetId: TARGET,
      installPath: "/t/SKILL.md",
      accessState: SourceAccessState.inaccessible,
    });
    const inacc = fake.sourceOccurrence.rows.find(
      (r) => r.accessState === SourceAccessState.inaccessible
    );
    expect(inacc).toBeDefined();
  });

  it("never passes NULL into an occurrence key participant (coalesces repo*/pack to '' and localPath to '')", async () => {
    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content: "# S\n",
      computeTargetId: TARGET,
      installPath: null, // ⇒ localPath ""
    });
    const occ = fake.sourceOccurrence.rows[0];
    expect(occ.repoFullName).toBe("");
    expect(occ.repoPath).toBe("");
    expect(occ.repoCommit).toBe("");
    expect(occ.packId).toBe("");
    expect(occ.localPath).toBe("");
  });

  it("isolates orgs: identical content in two orgs ⇒ two version rows (same hash, different org), no cross-org collision", async () => {
    const content = "# Shared Skill\n";

    const idA = await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
    });
    const idB = await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_B,
      componentKind: KIND,
      content,
    });

    expect(idA).not.toBe(idB);
    expect(fake.definitionVersion.rows).toHaveLength(2);
    const orgs = fake.definitionVersion.rows.map((r) => r.organizationId);
    expect(new Set(orgs)).toEqual(new Set([ORG_A, ORG_B]));
    // Same fingerprint on both — the (org, hash) key admits both.
    const hashes = fake.definitionVersion.rows.map((r) => r.definitionHash);
    expect(hashes[0]).toBe(hashes[1]);
    // Every write carried its own org into create.
    for (const row of fake.definitionVersion.rows) {
      expect(row.organizationId).toBeDefined();
    }
  });

  it("produces a definitionHash byte-identical to computeDefinitionHash({frontmatter:'', body:content, kind}) — no local hash (fingerprint-integration)", async () => {
    const content = "# Exact\nbody line\n";
    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
    });
    const { definitionHash, normalizerContractVersion } = computeDefinitionHash(
      {
        frontmatter: "",
        body: content,
        kind: KIND,
      }
    );
    const row = fake.definitionVersion.rows[0];
    expect(row.definitionHash).toBe(definitionHash);
    expect(row.normalizerContractVersion).toBe(normalizerContractVersion);
  });

  it("writes a pack SourceOccurrence with occurrenceType=pack + packId when registering a pack member (FEA-3909 — the previously-never-written seam)", async () => {
    const content = "# Pack Skill\n\nreusable.\n";
    const PACK = "pack-1";

    const versionId = await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      occurrenceType: SourceOccurrenceType.pack,
      packId: PACK,
    });

    // Exactly one occurrence, typed `pack`, carrying the pack id — and the local
    // evidence columns coalesced to '' (never NULL into the unique key).
    expect(fake.sourceOccurrence.rows).toHaveLength(1);
    const occ = fake.sourceOccurrence.rows[0];
    expect(occ.occurrenceType).toBe(SourceOccurrenceType.pack);
    expect(occ.packId).toBe(PACK);
    expect(occ.definitionVersionId).toBe(versionId);
    expect(occ.computeTargetId).toBeNull();
    expect(occ.repoFullName).toBe("");
    expect(occ.repoPath).toBe("");
    expect(occ.repoCommit).toBe("");
    expect(occ.localPath).toBe("");
  });

  it("carries the SAME DefinitionVersion into multiple packs (many-to-many, PD3): one version row, one pack occurrence per distinct packId — never a copy", async () => {
    const content = "# Shared Component\n\nlives in two packs.\n";

    const idPackA = await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      occurrenceType: SourceOccurrenceType.pack,
      packId: "pack-A",
    });
    const idPackB = await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      occurrenceType: SourceOccurrenceType.pack,
      packId: "pack-B",
    });

    // Referenced by both packs — the identical fingerprint yields ONE version.
    expect(idPackA).toBe(idPackB);
    expect(fake.definitionVersion.rows).toHaveLength(1);
    // ...but two distinct `pack` occurrences, one per pack id.
    expect(fake.sourceOccurrence.rows).toHaveLength(2);
    const packIds = fake.sourceOccurrence.rows.map((r) => r.packId).sort();
    expect(packIds).toEqual(["pack-A", "pack-B"]);
    for (const occ of fake.sourceOccurrence.rows) {
      expect(occ.occurrenceType).toBe(SourceOccurrenceType.pack);
      expect(occ.definitionVersionId).toBe(idPackA);
    }
  });

  it("re-registering the SAME pack member (same content + packId) is idempotent: one version, one pack occurrence, lastSeenAt bumped (AC-6)", async () => {
    const content = "# S\n";
    const PACK = "pack-1";
    const t1 = new Date("2026-01-01T00:00:00.000Z");
    const t2 = new Date("2026-05-01T00:00:00.000Z");

    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      occurrenceType: SourceOccurrenceType.pack,
      packId: PACK,
      observedAt: t1,
    });
    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      occurrenceType: SourceOccurrenceType.pack,
      packId: PACK,
      observedAt: t2,
    });

    expect(fake.definitionVersion.rows).toHaveLength(1);
    expect(fake.sourceOccurrence.rows).toHaveLength(1);
    expect(fake.sourceOccurrence.rows[0].lastSeenAt).toEqual(t2);
  });

  it("dedupes concurrent same-key pack registrations to ONE occurrence via the atomic null-target upsert (no findFirst-then-create race)", async () => {
    const content = "# Concurrent Pack Member\n";
    const PACK = "pack-race";

    // Two registrations of the same (content, pack) key issued together — the
    // null-target path routes through the ON CONFLICT upsert, so even racing
    // inserts collapse to a single `pack` occurrence (the second conflicts and
    // updates instead of inserting a duplicate).
    await Promise.all([
      registerDefinitionVersion(fake.tx, {
        organizationId: ORG_A,
        componentKind: KIND,
        content,
        occurrenceType: SourceOccurrenceType.pack,
        packId: PACK,
      }),
      registerDefinitionVersion(fake.tx, {
        organizationId: ORG_A,
        componentKind: KIND,
        content,
        occurrenceType: SourceOccurrenceType.pack,
        packId: PACK,
      }),
    ]);

    expect(fake.definitionVersion.rows).toHaveLength(1);
    expect(fake.sourceOccurrence.rows).toHaveLength(1);
    expect(fake.sourceOccurrence.rows[0].occurrenceType).toBe(
      SourceOccurrenceType.pack
    );
    expect(fake.sourceOccurrence.rows[0].packId).toBe(PACK);
    // The null-target path never calls findFirst/create — those delegate methods
    // stay unused (the atomic $executeRaw upsert owns this write).
  });

  it("FEA-3982: records an editor lineage row when editorUserId is supplied, and de-dupes a re-observe to one row bumping lastEditedAt", async () => {
    const content = "# Lineage Skill\nbody\n";
    const older = new Date("2026-02-01T00:00:00.000Z");
    const newer = new Date("2026-04-01T00:00:00.000Z");

    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      editorUserId: "user-1",
      observedAt: older,
    });
    // Same user re-observes ⇒ ONE lineage row, lastEditedAt bumped, first kept.
    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      editorUserId: "user-1",
      observedAt: newer,
    });
    // A second distinct user authoring the same bytes ⇒ a SECOND editor.
    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content,
      editorUserId: "user-2",
      observedAt: newer,
    });

    const editors = fake.definitionVersionEditor.rows;
    expect(editors).toHaveLength(2);
    expect(new Set(editors.map((r) => r.userId))).toEqual(
      new Set(["user-1", "user-2"])
    );
    const userOne = editors.find((r) => r.userId === "user-1");
    expect(userOne?.firstEditedAt).toEqual(older);
    expect(userOne?.lastEditedAt).toEqual(newer);
    // The lineage FKs the one version row (same hash ⇒ one version).
    expect(fake.definitionVersion.rows).toHaveLength(1);
    for (const row of editors) {
      expect(row.definitionVersionId).toBe(fake.definitionVersion.rows[0]?.id);
    }
  });

  it("FEA-3982: writes NO editor lineage row when editorUserId is absent (skew-safe no-op)", async () => {
    await registerDefinitionVersion(fake.tx, {
      organizationId: ORG_A,
      componentKind: KIND,
      content: "# Unattributed\n",
      // No editorUserId (e.g. a pack import of pre-authored bytes).
    });
    expect(fake.definitionVersionEditor.rows).toHaveLength(0);
  });

  it("imports the fingerprint from @repo/api/src/definition-fingerprint and never hashes locally (guards against re-implementation)", () => {
    // Structural import-graph invariant, asserted on the parsed AST rather than
    // the raw source text: text guards break on renames/reorders and can be
    // satisfied by a comment (AGENTS.md → Test Practices).
    const source = parseServiceModule();
    const imports = collectImports(source);
    const identifiers = collectIdentifiers(source);

    // The one and only hash source is Slice-1's contract.
    const fingerprintImport = imports.find(
      (entry) =>
        entry.moduleSpecifier === "@repo/api/src/definition-fingerprint"
    );
    expect(fingerprintImport?.names).toContain("computeDefinitionHash");

    // No SECOND hash source. `node:crypto` + `createHash` cover the stdlib
    // route; the identifier sweep additionally catches a third-party digest
    // (`import { sha256 } from "@noble/hashes/sha256"`), which would otherwise
    // satisfy both checks above while still re-implementing the fingerprint.
    expect(imports.map((entry) => entry.moduleSpecifier)).not.toContain(
      "node:crypto"
    );
    expect(identifiers.has("createHash")).toBe(false);
    expect(
      [...identifiers].filter((name) => HASH_PRIMITIVE_PATTERN.test(name))
    ).toEqual([]);
  });
});

type ModuleImport = { moduleSpecifier: string; names: string[] };

/** Parse the registry service into an AST (comments do not become nodes). */
function parseServiceModule(): ts.SourceFile {
  const modulePath = join(import.meta.dirname, "..", "service.ts");
  return ts.createSourceFile(
    modulePath,
    readFileSync(modulePath, "utf8"),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true
  );
}

/** Every top-level import declaration, with the names each one binds. */
function collectImports(source: ts.SourceFile): ModuleImport[] {
  const imports: ModuleImport[] = [];
  for (const statement of source.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      )
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    const names =
      bindings && ts.isNamedImports(bindings)
        ? bindings.elements.map((element) => element.name.text)
        : [];
    imports.push({ moduleSpecifier: statement.moduleSpecifier.text, names });
  }
  return imports;
}

/** Every identifier text that appears anywhere in the module's AST. */
function collectIdentifiers(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      names.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/**
 * Identifier names that ARE a hash primitive. Anchored and case-insensitive, so
 * `sha256`/`SHA256`/`md5`/`blake3` trip it while the module's own
 * `definitionHash`/`contentHash`/`computeDefinitionHash` do not. Comments never
 * become identifiers, so the prose "no local sha256" cannot satisfy this.
 */
const HASH_PRIMITIVE_PATTERN =
  /^(?:sha\d*|md[245]|blake\d*[bs]?\d*|keccak\d*|ripemd\d*)$/i;
