/**
 * FEA-4267: the desktop-local catalog LIST collapses a component FAMILY
 * (multiple version rows sharing one org-level `slug`) into ONE canonical row,
 * so the offline/desktop Agents catalog no longer shows duplicate rows for the
 * same logical component — the parity fix for the cloud collapse (wongk). These
 * are pure unit tests over `collapseLocalFamilies`, kept in a dedicated file so
 * the grandfathered `shared-agent-components-api.test.ts` does not grow.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  type AgentComponent,
  AgentComponentKind,
  Harness,
  SourceType,
} from "@repo/api/src/types/agent-component";
import { collapseLocalFamilies } from "../src/main/dashboard/agent-components-family-collapse.js";

// Build the `identityKeyByRow` + `sessionIdsByIdentityKey` inputs the collapse
// now reads (keyed by per-version identity, not the shared name-only `id`) from a
// legacy id-keyed session map: each row's identity key is its own `id`, which is
// unique per version in these fixtures. Mirrors how the production caller stores
// each version bucket under its `slug@fingerprint` identity key.
function collapseFromIdKeyedSessions(
  rows: AgentComponent[],
  sessionIdsById: Map<string, Set<string>>
) {
  const identityKeyByRow = new Map<AgentComponent, string>();
  const sessionIdsByIdentityKey = new Map<string, Set<string>>();
  // FEA-4335: the family key is the row's `slug` in these fixtures — rows sharing
  // a `slug` are one family (versions), each with a unique `id`. This mirrors the
  // production caller, which maps each row to its NAME-level family key while the
  // emitted `slug` carries the per-version content-hash routable key.
  const familyKeyByRow = new Map<AgentComponent, string>();
  for (const row of rows) {
    identityKeyByRow.set(row, row.id);
    familyKeyByRow.set(row, row.slug);
    sessionIdsByIdentityKey.set(
      row.id,
      sessionIdsById.get(row.id) ?? new Set()
    );
  }
  return collapseLocalFamilies(
    rows,
    identityKeyByRow,
    sessionIdsByIdentityKey,
    familyKeyByRow
  );
}

function makeRow(overrides: Partial<AgentComponent>): AgentComponent {
  return {
    id: overrides.id ?? overrides.slug ?? "skill::cl-produce",
    slug: overrides.slug ?? "skill::cl-produce",
    name: overrides.name ?? "cl-produce",
    kind: overrides.kind ?? AgentComponentKind.Skill,
    sourceType: SourceType.Repo,
    source: "repo-a",
    harness: Harness.Claude,
    invocations: overrides.invocations ?? 0,
    sessions: overrides.sessions ?? 0,
    locPerDollar: null,
    trend: [],
    collaborators: [],
    computeTargetIds: overrides.computeTargetIds ?? [],
    firstSeenAt: overrides.firstSeenAt ?? "2026-01-01T00:00:00.000Z",
    lastSeenAt: overrides.lastSeenAt ?? "2026-01-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("collapseLocalFamilies", () => {
  it("collapses several versions of one slug into a single canonical row", () => {
    const rows = [
      makeRow({
        id: "skill::cl-produce@v1",
        versionId: "hash-v1",
        fingerprint: "hash-v1",
        invocations: 3,
        computeTargetIds: ["target-1"],
        firstSeenAt: "2026-01-01T00:00:00.000Z",
        lastSeenAt: "2026-01-02T00:00:00.000Z",
        lastInvokedAt: "2026-01-02T00:00:00.000Z",
      }),
      makeRow({
        id: "skill::cl-produce@v2",
        versionId: "hash-v2",
        fingerprint: "hash-v2",
        invocations: 5,
        computeTargetIds: ["target-2"],
        firstSeenAt: "2026-01-03T00:00:00.000Z",
        lastSeenAt: "2026-01-05T00:00:00.000Z",
        lastInvokedAt: "2026-01-05T00:00:00.000Z",
      }),
    ];
    const sessionIds = new Map<string, Set<string>>([
      ["skill::cl-produce@v1", new Set(["sess-1", "sess-shared"])],
      ["skill::cl-produce@v2", new Set(["sess-2", "sess-shared"])],
    ]);

    const { rows: collapsed, sessionIdsByComponentId } =
      collapseFromIdKeyedSessions(rows, sessionIds);

    assert.equal(collapsed.length, 1);
    const [row] = collapsed;
    // invocations SUM; sessions UNION (sess-shared counted once) = 3 distinct.
    assert.equal(row.invocations, 8);
    assert.equal(row.sessions, 3);
    // devices union + dedupe.
    assert.deepEqual([...row.computeTargetIds].sort(), [
      "target-1",
      "target-2",
    ]);
    // multi-version family: count surfaces, single-version badge dropped.
    assert.equal(row.versionCount, 2);
    assert.equal(row.versionId, undefined);
    assert.equal(row.fingerprint, undefined);
    // representative is the freshest version (v2), aggregate dates widen.
    assert.equal(row.firstSeenAt, "2026-01-01T00:00:00.000Z");
    assert.equal(row.lastSeenAt, "2026-01-05T00:00:00.000Z");
    assert.equal(row.lastInvokedAt, "2026-01-05T00:00:00.000Z");
    // the returned session map holds the UNION under the canonical row's id.
    const canonicalSessions = sessionIdsByComponentId.get(row.id);
    assert.ok(canonicalSessions);
    assert.equal(canonicalSessions.size, 3);
  });

  it("leaves a single-version component unchanged and emits no versionCount", () => {
    const rows = [
      makeRow({
        id: "skill::solo@v1",
        slug: "skill::solo",
        name: "solo",
        versionId: "hash-solo",
        fingerprint: "hash-solo",
        invocations: 7,
      }),
    ];
    const sessionIds = new Map<string, Set<string>>([
      ["skill::solo@v1", new Set(["sess-1"])],
    ]);

    const { rows: collapsed } = collapseFromIdKeyedSessions(rows, sessionIds);
    const [row] = collapsed;

    assert.equal(row.invocations, 7);
    assert.equal(row.versionCount, undefined);
    // single-version keeps its badge.
    assert.equal(row.versionId, "hash-solo");
    assert.equal(row.fingerprint, "hash-solo");
  });

  it("keeps distinct families separate", () => {
    const rows = [
      makeRow({
        id: "skill::a@v1",
        slug: "skill::a",
        name: "a",
        versionId: "h1",
      }),
      makeRow({
        id: "skill::a@v2",
        slug: "skill::a",
        name: "a",
        versionId: "h2",
      }),
      makeRow({
        id: "skill::b@v1",
        slug: "skill::b",
        name: "b",
        versionId: "h3",
      }),
    ];
    const sessionIds = new Map<string, Set<string>>();

    const { rows: collapsed } = collapseFromIdKeyedSessions(rows, sessionIds);

    assert.equal(collapsed.length, 2);
    assert.deepEqual(collapsed.map((r) => r.slug).sort(), [
      "skill::a",
      "skill::b",
    ]);
    const familyA = collapsed.find((r) => r.slug === "skill::a");
    assert.equal(familyA?.versionCount, 2);
  });

  it("picks the freshest-INVOKED version as representative despite an older lastSeenAt", () => {
    // v-new invoked later but observed earlier; the representative is ordered by
    // invocation recency first, so v-new must supply the display identity even
    // though folding widens the aggregate lastSeenAt to v-old's later scan.
    const rows = [
      makeRow({
        id: "skill::fam@old",
        name: "old-name",
        source: "https://repo/old",
        versionId: "hash-old",
        fingerprint: "hash-old",
        lastSeenAt: "2026-01-20T00:00:00.000Z",
        lastInvokedAt: "2026-01-05T00:00:00.000Z",
      }),
      makeRow({
        id: "skill::fam@new",
        name: "new-name",
        source: "https://repo/new",
        versionId: "hash-new",
        fingerprint: "hash-new",
        lastSeenAt: "2026-01-10T00:00:00.000Z",
        lastInvokedAt: "2026-01-15T00:00:00.000Z",
      }),
    ];
    const sessionIds = new Map<string, Set<string>>();

    const { rows: collapsed } = collapseFromIdKeyedSessions(rows, sessionIds);
    const [row] = collapsed;

    assert.equal(row.name, "new-name");
    assert.equal(row.source, "https://repo/new");
    // aggregate dates: max lastInvokedAt is v-new's, max lastSeenAt is v-old's.
    assert.equal(row.lastInvokedAt, "2026-01-15T00:00:00.000Z");
    assert.equal(row.lastSeenAt, "2026-01-20T00:00:00.000Z");
  });

  // ISS-5009: the honest Source projection describes the CHOSEN revision's
  // provenance, so it has to be adopted alongside the `source`/`sourceType` it
  // was derived beside. If it were left on the seeded (older) version, the
  // collapsed row would answer "is this real provenance?" for a revision it is
  // no longer displaying — the older version's answer under the newer one's text.
  it("adopts the representative version's honestSource, not the seeded version's", () => {
    const rows = [
      makeRow({
        id: "skill::fam@old",
        name: "old-name",
        source: "old-pack",
        sourceType: SourceType.Pack,
        honestSource: {
          hasProvenance: true,
          source: "old-pack",
          sourceType: SourceType.Pack,
        },
        versionId: "hash-old",
        lastSeenAt: "2026-01-20T00:00:00.000Z",
        lastInvokedAt: "2026-01-05T00:00:00.000Z",
      }),
      makeRow({
        id: "skill::fam@new",
        name: "new-name",
        // The fresher revision lost its pack association: its provenance is now
        // an echo of its own key, so the honest answer flips to false.
        source: "new-name",
        sourceType: SourceType.Local,
        honestSource: {
          hasProvenance: false,
          source: null,
          sourceType: SourceType.Local,
        },
        versionId: "hash-new",
        lastSeenAt: "2026-01-10T00:00:00.000Z",
        lastInvokedAt: "2026-01-15T00:00:00.000Z",
      }),
    ];

    const { rows: collapsed } = collapseFromIdKeyedSessions(
      rows,
      new Map<string, Set<string>>()
    );
    const [row] = collapsed;

    assert.equal(row.name, "new-name");
    assert.deepEqual(row.honestSource, {
      hasProvenance: false,
      source: null,
      sourceType: SourceType.Local,
    });
  });

  // FEA-4335 (shafty023): the PRODUCTION case — sibling versions now emit DISTINCT
  // content-hash `slug`s but map to ONE shared name-level family key. The earlier
  // fixtures set `familyKeyByRow = row.slug`, so rows sharing a slug collapse and a
  // regression that ignored `familyKeyByRow` (grouping by slug directly) would
  // still pass. This drives the collapse purely through the family key with
  // distinct slugs, so it fails if `familyKeyByRow` is ignored.
  it("collapses distinct content-hash slugs sharing one name-level family key", () => {
    const familyKey = "skill::cl-produce";
    const rows = [
      makeRow({
        id: "skill::cl-produce@aaaa",
        // Distinct content-hash routable slug for version 1.
        slug: `skill::${"a".repeat(64)}`,
        versionId: "a".repeat(64),
        fingerprint: "aaaa",
        invocations: 3,
        lastSeenAt: "2026-01-02T00:00:00.000Z",
        lastInvokedAt: "2026-01-02T00:00:00.000Z",
      }),
      makeRow({
        id: "skill::cl-produce@bbbb",
        // Distinct content-hash routable slug for version 2 (the fresher rep).
        slug: `skill::${"b".repeat(64)}`,
        versionId: "b".repeat(64),
        fingerprint: "bbbb",
        invocations: 5,
        lastSeenAt: "2026-01-05T00:00:00.000Z",
        lastInvokedAt: "2026-01-05T00:00:00.000Z",
      }),
    ];
    // Map BOTH distinct-slug rows to the SAME name-level family key.
    const identityKeyByRow = new Map<AgentComponent, string>();
    const familyKeyByRow = new Map<AgentComponent, string>();
    const sessionIdsByIdentityKey = new Map<string, Set<string>>();
    for (const row of rows) {
      identityKeyByRow.set(row, row.id);
      familyKeyByRow.set(row, familyKey);
      sessionIdsByIdentityKey.set(row.id, new Set());
    }

    const { rows: collapsed } = collapseLocalFamilies(
      rows,
      identityKeyByRow,
      sessionIdsByIdentityKey,
      familyKeyByRow
    );

    // Two distinct slugs still collapse to ONE family row via the shared key.
    assert.equal(collapsed.length, 1);
    const [row] = collapsed;
    assert.equal(row.invocations, 8);
    assert.equal(row.versionCount, 2);
    // The representative route is the FRESHER version's content-hash slug — not
    // the name-level family key and not the older version's slug.
    assert.equal(row.slug, `skill::${"b".repeat(64)}`);
    assert.notEqual(row.slug, familyKey);
  });
});
