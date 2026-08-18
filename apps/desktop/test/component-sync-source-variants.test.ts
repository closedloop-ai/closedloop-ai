/**
 * @file component-sync-source-variants.test.ts
 * @description ISS-4662 (item 1) — the component sync lane must carry the
 * RETAINED per-content-hash variants (ISS-4564) that previously never left the
 * device, WITHOUT pushing any component over the transport chunker's
 * per-component byte budget (which would dead-letter it wholesale — a strict
 * regression on exactly the rows this lane means to enrich).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SYNCED_COMPONENT_VARIANTS_MAX,
  SYNCED_COMPONENT_VARIANTS_MAX_SERIALIZED_BYTES,
  SyncedComponentVariantsTruncatedReason,
  serializedJsonUtf8ByteSize,
} from "@repo/api/src/types/synced-component-content";
import { loadSyncedComponentRows } from "../src/main/database/component-sync-source.js";
import type { DesktopPrisma } from "../src/main/database/prisma-client.js";

/** Matches a `SELECT` list that includes the body column. */
const SELECTS_CONTENT_COLUMN_RE = /SELECT[\s\S]*?\bcontent\b\s*,/;

/**
 * Matches the ISS-5029 eligibility predicate the ranking pass carries: only a
 * hash-bearing, body-bearing row may be ranked, so a row the packing loop skips
 * anyway can never occupy the truncation probe rank.
 */
const RANKS_ELIGIBLE_ROWS_ONLY_RE = /AND content IS NOT NULL/;

type ComponentRow = Record<string, unknown>;
type VersionRow = Record<string, unknown>;

function componentRow(overrides: ComponentRow = {}): ComponentRow {
  return {
    id: "cmp-1",
    component_kind: "agent",
    external_id: "reviewer",
    component_key: "reviewer",
    name: "reviewer",
    version: null,
    harness: "claude",
    description: null,
    source_url: null,
    install_path: "/home/u/.claude/agents/reviewer.md",
    pack_id: null,
    scope: "user",
    project_path: null,
    metadata: null,
    content: "PRIMARY BODY",
    content_hash: "hash-primary",
    resolved_state: "resolved",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-02T00:00:00.000Z",
    uninstalled_at: null,
    ...overrides,
  };
}

function versionRow(overrides: VersionRow = {}): VersionRow {
  return {
    component_kind: "agent",
    component_key: "reviewer",
    content_hash: "hash-variant",
    content: "VARIANT BODY",
    format: "md",
    first_seen_at: "2026-01-01T00:00:00.000Z",
    last_seen_at: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * Minimal `DesktopPrisma` stand-in that routes each raw query by the table it
 * names. Only `read` is exercised — this lane never writes.
 */
function fakePrisma(
  components: ComponentRow[],
  versions: VersionRow[]
): { prisma: DesktopPrisma; versionQueries: string[] } {
  const versionQueries: string[] = [];
  const reader = {
    $queryRawUnsafe: (sql: string, ..._params: unknown[]) => {
      if (sql.includes("FROM agent_component_versions")) {
        versionQueries.push(sql);
        // Model the ranking pass's WHERE clause rather than returning every
        // fixture row to both passes: which rows are ELIGIBLE to be ranked is
        // exactly what decides whether the probe rank means "a revision was
        // dropped", so a double that ignored the predicate would hide the
        // false-positive shape below (ISS-5029, #4391).
        if (RANKS_ELIGIBLE_ROWS_ONLY_RE.test(sql)) {
          return Promise.resolve(versions.filter(isRankableVersionRow));
        }
        return Promise.resolve(versions);
      }
      return Promise.resolve(components);
    },
  };
  const prisma = {
    read: (fn: (client: unknown) => Promise<unknown>) =>
      Promise.resolve().then(() => fn(reader)),
  } as unknown as DesktopPrisma;
  return { prisma, versionQueries };
}

test("omits `variants` entirely when the component has no retained revisions", async () => {
  // Only the PRIMARY revision exists locally — the overwhelmingly common case.
  const { prisma } = fakePrisma(
    [componentRow()],
    [versionRow({ content_hash: "hash-primary", content: "PRIMARY BODY" })]
  );
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);
  // Preserve OMISSION for an absent optional cross-repo field — never `[]`,
  // never `null` — so the payload is byte-identical to today's for every
  // unaffected component and older cloud builds see no change at all.
  assert.equal(
    Object.hasOwn(component, "variants"),
    false,
    "variants must be omitted, not an empty array"
  );
});

test("carries a retained variant and never re-sends the primary revision", async () => {
  const { prisma } = fakePrisma(
    [componentRow()],
    [
      versionRow({ content_hash: "hash-primary", content: "PRIMARY BODY" }),
      versionRow({ content_hash: "hash-variant", content: "VARIANT BODY" }),
    ]
  );
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);
  assert.deepEqual(
    component.variants?.map((variant) => variant.contentHash),
    ["hash-variant"],
    "only the non-primary revision rides along"
  );
  assert.equal(component.variants?.[0].content, "VARIANT BODY");
  assert.equal(component.variants?.[0].format, "md");
  // The hash is the desktop's stored value forwarded VERBATIM — this lane never
  // re-derives or widens a content-hash preimage (FEA-4335 content identity).
  assert.equal(component.contentHash, "hash-primary");
});

test("stops filling variants at the serialized-byte budget instead of over-filling the component", async () => {
  // Two revisions that each nearly exhaust the variant budget: the first fits,
  // the second must be dropped rather than pushing the component past the
  // chunker's per-component ceiling (which would dead-letter it entirely).
  const big = "x".repeat(
    Math.floor(SYNCED_COMPONENT_VARIANTS_MAX_SERIALIZED_BYTES * 0.9)
  );
  const { prisma } = fakePrisma(
    [componentRow()],
    [
      versionRow({ content_hash: "hash-a", content: big }),
      versionRow({ content_hash: "hash-b", content: big }),
    ]
  );
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);
  assert.equal(
    component.variants?.length,
    1,
    "the over-budget variant is dropped"
  );
  const spent = (component.variants ?? []).reduce(
    (total, variant) =>
      total +
      serializedJsonUtf8ByteSize(variant.content) +
      serializedJsonUtf8ByteSize(variant.contentHash),
    0
  );
  assert.ok(
    spent <= SYNCED_COMPONENT_VARIANTS_MAX_SERIALIZED_BYTES,
    `variant payload ${spent} must stay within the budget`
  );
});

test("caps the variant count so a pathological identity cannot inflate a batch", async () => {
  const versions = Array.from(
    { length: SYNCED_COMPONENT_VARIANTS_MAX + 5 },
    (_, index) =>
      versionRow({ content_hash: `hash-${index}`, content: `body-${index}` })
  );
  const { prisma } = fakePrisma([componentRow()], versions);
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);
  assert.equal(component.variants?.length, SYNCED_COMPONENT_VARIANTS_MAX);
});

test("carries an EMPTY retained revision — it is a real hash, not a missing body", async () => {
  const { prisma } = fakePrisma(
    [componentRow()],
    [
      versionRow({ content_hash: "hash-empty", content: "" }),
      versionRow({ content_hash: "hash-real", content: "REAL" }),
    ]
  );
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);
  // The collector hashes and persists an empty definition as a valid version
  // row, so a falsy-body skip silently withheld a real retained hash from the
  // cloud. Only a NULL column means "no body" (wongk, #4295).
  assert.deepEqual(
    component.variants?.map((variant) => variant.contentHash),
    ["hash-empty", "hash-real"]
  );
});

test("skips a revision whose body column is NULL rather than shipping a hollow row", async () => {
  const { prisma } = fakePrisma(
    [componentRow()],
    [
      versionRow({ content_hash: "hash-null", content: null }),
      versionRow({ content_hash: "hash-real", content: "REAL" }),
    ]
  );
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);
  assert.deepEqual(
    component.variants?.map((variant) => variant.contentHash),
    ["hash-real"]
  );
});

test("caps candidates per family IN SQL, before any body column is read", async () => {
  const { prisma, versionQueries } = fakePrisma(
    [componentRow()],
    [versionRow({ content_hash: "hash-variant", content: "VARIANT BODY" })]
  );
  await loadSyncedComponentRows(prisma, ["cmp-1"]);

  // agent_component_versions is append-only per hash, so a churned definition
  // can accumulate unboundedly many full bodies. The first pass must rank and
  // cut per family WITHOUT selecting `content`; only the survivors get bodies
  // fetched (wongk, #4295).
  const [identityQuery, bodyQuery] = versionQueries;
  assert.ok(identityQuery?.includes("ROW_NUMBER() OVER"));
  assert.ok(
    identityQuery?.includes("PARTITION BY component_kind, component_key")
  );
  assert.ok(identityQuery?.includes("family_rank <="));
  assert.equal(
    SELECTS_CONTENT_COLUMN_RE.test(identityQuery ?? ""),
    false,
    "the ranking pass must not select the body column"
  );
  assert.ok(bodyQuery?.includes("content"));
});

test("stops at the first over-budget revision instead of skipping to an older smaller one", async () => {
  const huge = "x".repeat(SYNCED_COMPONENT_VARIANTS_MAX_SERIALIZED_BYTES);
  const { prisma } = fakePrisma(
    [componentRow()],
    [
      versionRow({ content_hash: "hash-newest", content: "SMALL" }),
      versionRow({ content_hash: "hash-huge", content: huge }),
      versionRow({ content_hash: "hash-older", content: "ALSO SMALL" }),
    ]
  );
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);

  // A `continue` here would ship hash-newest + hash-older, a non-contiguous
  // greedy subset whose membership shifts between syncs as bodies grow. The
  // documented contract — and the reason the loader orders newest-first — is the
  // N most RECENT that fit (closedloop-ai-stage, #4295).
  assert.deepEqual(
    component.variants?.map((variant) => variant.contentHash),
    ["hash-newest"]
  );
});

test("forwards the PRIMARY revision's own first-observation date", async () => {
  const { prisma } = fakePrisma(
    [componentRow()],
    [
      versionRow({
        content_hash: "hash-primary",
        content: "PRIMARY BODY",
        first_seen_at: "2026-01-04T00:00:00.000Z",
      }),
      versionRow({ content_hash: "hash-variant", content: "VARIANT BODY" }),
    ]
  );
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);

  // So the cloud seeds the primary version row with the same meaning the
  // variants carry, instead of stamping it with the sync time.
  assert.equal(component.contentFirstSeenAt, "2026-01-04T00:00:00.000Z");
});

test("omits contentFirstSeenAt when no version row matches the primary hash", async () => {
  const { prisma } = fakePrisma(
    [componentRow()],
    [versionRow({ content_hash: "hash-variant", content: "VARIANT BODY" })]
  );
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);
  assert.equal(Object.hasOwn(component, "contentFirstSeenAt"), false);
});

test("does not query the versions table when the batch loaded no components", async () => {
  const { prisma, versionQueries } = fakePrisma([], []);
  const components = await loadSyncedComponentRows(prisma, []);
  assert.deepEqual(components, []);
  assert.equal(versionQueries.length, 0);
});

test("matches variants to the component family, not across identities", async () => {
  // A second component in the same batch must not inherit the first's revisions.
  const { prisma } = fakePrisma(
    [
      componentRow(),
      componentRow({
        id: "cmp-2",
        external_id: "planner",
        component_key: "planner",
        content_hash: "hash-planner",
      }),
    ],
    [versionRow({ content_hash: "hash-variant", component_key: "reviewer" })]
  );
  const components = await loadSyncedComponentRows(prisma, ["cmp-1", "cmp-2"]);
  const byExternalId = new Map(
    components.map((component) => [component.externalId, component])
  );
  assert.equal(byExternalId.get("reviewer")?.variants?.length, 1);
  assert.equal(
    Object.hasOwn(byExternalId.get("planner") ?? {}, "variants"),
    false,
    "an unrelated identity gains no variants"
  );
});

// ---------------------------------------------------------------------------
// ISS-5029 — the truncation marker
// ---------------------------------------------------------------------------

test("ISS-5029: states `variantsTruncated: false` when no cap bound", async () => {
  // Two revisions, both shipped. Nothing was dropped, so the marker must be
  // explicitly FALSE — a flag that is always set is as useless as one that never
  // is. #4391 (wongk): a marker-aware packer STATES the negative rather than
  // omitting it, because the cloud writer reserves omission for a desktop that
  // predates the marker and leaves such a row's stored value untouched. Omitting
  // here would make this packer indistinguishable from that one and strand a
  // stale `true` forever.
  const { prisma } = fakePrisma(
    [componentRow()],
    [
      versionRow({ content_hash: "hash-primary", content: "PRIMARY BODY" }),
      versionRow({ content_hash: "hash-variant", content: "VARIANT BODY" }),
    ]
  );
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);
  assert.equal(component.variants?.length, 1);
  assert.equal(
    component.variantsTruncated,
    false,
    "an untruncated component must state the negative, not claim truncation"
  );
  assert.equal(
    Object.hasOwn(component, "variantsTruncatedReason"),
    false,
    "the reason rides only with `true`"
  );
});

test("ISS-5029: states `variantsTruncated: false` when the component has no retained revisions", async () => {
  const { prisma } = fakePrisma(
    [componentRow()],
    [versionRow({ content_hash: "hash-primary", content: "PRIMARY BODY" })]
  );
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);
  assert.equal(component.variantsTruncated, false);
});

test("ISS-5029: sets `variantsTruncated` when the per-family ENTRY cap binds", async () => {
  // MAX + 1 eligible revisions: the last one cannot be emitted, so the cap
  // BOUND and the component's variant set is provably partial.
  const versions = Array.from(
    { length: SYNCED_COMPONENT_VARIANTS_MAX + 1 },
    (_, index) =>
      versionRow({ content_hash: `hash-${index}`, content: `body-${index}` })
  );
  const { prisma } = fakePrisma([componentRow()], versions);
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);
  assert.equal(component.variants?.length, SYNCED_COMPONENT_VARIANTS_MAX);
  assert.equal(component.variantsTruncated, true);
  // #4391 (wongk): the entry cap, like the SQL rank cap, cannot bind unless the
  // family holds more revisions than one sync can carry — so it reports
  // `family_cap`, the one reason the cloud can reconcile into a proof.
  assert.equal(
    component.variantsTruncatedReason,
    SyncedComponentVariantsTruncatedReason.FamilyCap
  );
});

test("ISS-5029: sets `variantsTruncated` when the SQL rank cap binds even though the entry cap alone would not", async () => {
  // The SQL pass admits VERSION_CANDIDATES_PER_FAMILY (= MAX + 1) identities so
  // the PRIMARY can occupy one slot. Here the primary IS among them, so exactly
  // MAX variants ship and the packing loop never runs out of entries — yet the
  // family plainly has more retained revisions than the ranking pass admitted.
  // A count-based marker would call this component complete.
  const versions = [
    versionRow({ content_hash: "hash-primary", content: "PRIMARY BODY" }),
    ...Array.from({ length: SYNCED_COMPONENT_VARIANTS_MAX + 3 }, (_, index) =>
      versionRow({ content_hash: `hash-${index}`, content: `body-${index}` })
    ),
  ];
  const { prisma } = fakePrisma([componentRow()], versions);
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);
  assert.equal(component.variantsTruncated, true);
  assert.equal(
    component.variantsTruncatedReason,
    SyncedComponentVariantsTruncatedReason.FamilyCap
  );
});

test("ISS-5029: sets `variantsTruncated` when the serialized-byte budget binds", async () => {
  const big = "x".repeat(
    Math.floor(SYNCED_COMPONENT_VARIANTS_MAX_SERIALIZED_BYTES * 0.9)
  );
  const { prisma } = fakePrisma(
    [componentRow()],
    [
      versionRow({ content_hash: "hash-a", content: big }),
      versionRow({ content_hash: "hash-b", content: big }),
    ]
  );
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);
  assert.equal(component.variants?.length, 1);
  assert.equal(component.variantsTruncated, true);
  // #4391 (wongk): reported DISTINCTLY from a family cap. This stop says nothing
  // about how many revisions the device holds — here it binds at ONE shipped
  // revision out of two — so the cloud must not reconcile it into a proof that
  // it is missing something. Labelling it `family_cap` would resurrect the false
  // positive the one-sync ceiling exists to prevent.
  assert.equal(
    component.variantsTruncatedReason,
    SyncedComponentVariantsTruncatedReason.ByteBudget
  );
});

test("ISS-5029: a rank-capped family that ALSO stops on budget keeps the stronger family-cap reason", async () => {
  // #4391 (wongk): both caps can bind on one component, and the two are not
  // equally informative. `family_cap` bounds the device's holdings and is the
  // only reason the cloud can prove anything from; `byte_budget` bounds nothing.
  // The budget stop happens LAST in the packer, so a naive last-writer-wins
  // would downgrade provable partiality to unprovable and silently lose the
  // marker on exactly the fat, churny components that need it most.
  const big = "x".repeat(
    Math.floor(SYNCED_COMPONENT_VARIANTS_MAX_SERIALIZED_BYTES * 0.9)
  );
  const versions = Array.from(
    { length: SYNCED_COMPONENT_VARIANTS_MAX + 3 },
    (_, index) => versionRow({ content_hash: `hash-${index}`, content: big })
  );
  const { prisma } = fakePrisma([componentRow()], versions);
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);

  // The budget really did bind — only one variant fits — so this is the
  // precedence case and not a family-cap-only one.
  assert.equal(component.variants?.length, 1);
  assert.equal(component.variantsTruncated, true);
  assert.equal(
    component.variantsTruncatedReason,
    SyncedComponentVariantsTruncatedReason.FamilyCap
  );
});

// The two rows the packing loop skips unconditionally. Ordered LAST so they sit
// exactly where the entry cap would misread them as a dropped revision, and kept
// to one per case so the family stays within the SQL rank cap (which is its own,
// separately-asserted truncation source).
const SKIPPED_ANYWAY_TRAILERS = [
  { content: "PRIMARY BODY", content_hash: "hash-primary", label: "PRIMARY" },
  { content: null, content_hash: "hash-null", label: "NULL-body" },
] as const;

for (const trailer of SKIPPED_ANYWAY_TRAILERS) {
  test(`ISS-5029: a trailing ${trailer.label} row is not a dropped revision`, async () => {
    // Exactly MAX eligible revisions, then one row the loop never emits anyway.
    // Checking the entry cap BEFORE the eligibility filters (as the loop used
    // to) would report a drop here that never happened.
    const versions = [
      ...Array.from({ length: SYNCED_COMPONENT_VARIANTS_MAX }, (_, index) =>
        versionRow({ content_hash: `hash-${index}`, content: `body-${index}` })
      ),
      versionRow({
        content: trailer.content,
        content_hash: trailer.content_hash,
      }),
    ];
    const { prisma } = fakePrisma([componentRow()], versions);
    const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);
    assert.equal(component.variants?.length, SYNCED_COMPONENT_VARIANTS_MAX);
    assert.equal(
      component.variantsTruncated,
      false,
      "a row that is skipped anyway must not be reported as truncation"
    );
    assert.equal(
      Object.hasOwn(component, "variantsTruncatedReason"),
      false,
      "no cap bound, so no reason rides along"
    );
  });
}

test("ISS-5029: a NULL-body row parked at the PROBE rank is not a dropped revision either", async () => {
  // #4391 review: the same row the case above proves is not a drop, moved one
  // rank later so it lands on the truncation probe instead of inside the
  // admitted set. The rank cap counts identities and cannot see bodies, so
  // ranking a row the packing loop skips anyway made the two signals reach
  // OPPOSITE verdicts about one row: `partitionCappedFamilies` called the family
  // capped while `selectSyncedVariants` reported nothing dropped, and the panel
  // then printed "this history is partial" over a complete list.
  //
  // The primary occupies one admitted slot, so exactly MAX eligible revisions
  // ship, the entry cap never binds and the byte budget never binds — nothing
  // shippable was dropped.
  const versions = [
    versionRow({ content_hash: "hash-primary", content: "PRIMARY BODY" }),
    ...Array.from({ length: SYNCED_COMPONENT_VARIANTS_MAX }, (_, index) =>
      versionRow({ content_hash: `hash-${index}`, content: `body-${index}` })
    ),
    versionRow({ content_hash: "hash-null", content: null }),
  ];
  const { prisma } = fakePrisma([componentRow()], versions);
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);

  assert.equal(component.variants?.length, SYNCED_COMPONENT_VARIANTS_MAX);
  assert.equal(
    component.variantsTruncated,
    false,
    "a row that could never ship must not be ranked, at any rank"
  );
});

test("ISS-5029: the ranking pass admits only rows that could actually ship", async () => {
  const { prisma, versionQueries } = fakePrisma(
    [componentRow()],
    [versionRow({ content_hash: "hash-variant", content: "VARIANT BODY" })]
  );
  await loadSyncedComponentRows(prisma, ["cmp-1"]);

  // The eligibility narrowing is what makes the identity-only rank cap a sound
  // truncation signal, and it must stay a PREDICATE — the pass still may not
  // select the body column (the whole point of the two-pass split).
  const [identityQuery] = versionQueries;
  assert.ok(
    RANKS_ELIGIBLE_ROWS_ONLY_RE.test(identityQuery ?? ""),
    "the ranking pass must exclude rows the packing loop skips anyway"
  );
  assert.ok(identityQuery?.includes("content_hash <> ''"));
  assert.equal(
    SELECTS_CONTENT_COLUMN_RE.test(identityQuery ?? ""),
    false,
    "eligibility is a predicate, not a projection"
  );
});

test("ISS-5029: the truncation probe reads one identity past the cap and never fetches its body", async () => {
  const versions = Array.from(
    { length: SYNCED_COMPONENT_VARIANTS_MAX + 6 },
    (_, index) =>
      versionRow({ content_hash: `hash-${index}`, content: `body-${index}` })
  );
  const { prisma, versionQueries } = fakePrisma([componentRow()], versions);
  await loadSyncedComponentRows(prisma, ["cmp-1"]);
  const [identityQuery, bodyQuery] = versionQueries;
  // The sentinel row still rides the BODY-FREE ranking pass...
  assert.equal(
    SELECTS_CONTENT_COLUMN_RE.test(identityQuery ?? ""),
    false,
    "the ranking pass must still not select the body column"
  );
  // ...and is discarded before pass 2, so the body fetch is bounded by the cap,
  // not by the probe.
  const bodyPredicates = (bodyQuery?.match(/component_kind = \$/g) ?? [])
    .length;
  assert.equal(
    bodyPredicates,
    SYNCED_COMPONENT_VARIANTS_MAX + 1,
    "pass 2 must fetch bodies for the capped set only, never the probe row"
  );
});

test("ISS-5029: truncation is per family — an untruncated sibling in the same batch stays unmarked", async () => {
  const versions = [
    ...Array.from({ length: SYNCED_COMPONENT_VARIANTS_MAX + 1 }, (_, index) =>
      versionRow({
        component_key: "reviewer",
        content_hash: `hash-${index}`,
        content: `body-${index}`,
      })
    ),
    versionRow({ component_key: "planner", content_hash: "hash-planner-var" }),
  ];
  const { prisma } = fakePrisma(
    [
      componentRow(),
      componentRow({
        id: "cmp-2",
        external_id: "planner",
        component_key: "planner",
        content_hash: "hash-planner",
      }),
    ],
    versions
  );
  const components = await loadSyncedComponentRows(prisma, ["cmp-1", "cmp-2"]);
  const byExternalId = new Map(
    components.map((component) => [component.externalId, component])
  );
  assert.equal(byExternalId.get("reviewer")?.variantsTruncated, true);
  assert.equal(
    byExternalId.get("planner")?.variantsTruncated,
    false,
    "an unrelated identity must not inherit the marker"
  );
});

test("ISS-5029: a capped family whose bodies all vanish between the two passes is still reported truncated", async () => {
  // `loadAgentComponentVersions` documents that a revision can disappear between
  // the identity pass and the body pass (a retention prune races the packer), and
  // skips it. When EVERY kept identity loses its body the family gets no grouped
  // bucket at all — so a marker evaluated after the "no bucket" guard would report
  // this identity as untruncated, even though pass 1 definitively saw more
  // revisions than the rank cap admits. That is the exact "capped set presented as
  // complete" failure this ticket removes, so the SQL-rank signal is applied
  // before the guard (closedloop-ai review, ISS-5029).
  const versions = Array.from(
    { length: SYNCED_COMPONENT_VARIANTS_MAX + 6 },
    (_, index) =>
      versionRow({ content_hash: `hash-${index}`, content: `body-${index}` })
  );
  const { prisma } = fakePrismaWithVanishingBodies([componentRow()], versions);
  const [component] = await loadSyncedComponentRows(prisma, ["cmp-1"]);

  assert.equal(
    Object.hasOwn(component, "variants"),
    false,
    "no body survived, so nothing ships"
  );
  assert.equal(component.variantsTruncated, true);
});

/**
 * Like {@link fakePrisma}, but pass 2 (the body fetch) returns NOTHING — the
 * retention-prune race the loader documents. Pass 1 still sees the full identity
 * set, so the SQL rank cap genuinely bound.
 */
function fakePrismaWithVanishingBodies(
  components: ComponentRow[],
  versions: VersionRow[]
): { prisma: DesktopPrisma } {
  let versionQueryCount = 0;
  const reader = {
    $queryRawUnsafe: (sql: string, ..._params: unknown[]) => {
      if (sql.includes("FROM agent_component_versions")) {
        versionQueryCount += 1;
        // Pass 1 = identities; pass 2 = bodies, which the prune took.
        return Promise.resolve(versionQueryCount === 1 ? versions : []);
      }
      return Promise.resolve(components);
    },
  };
  const prisma = {
    read: (fn: (client: unknown) => Promise<unknown>) =>
      Promise.resolve().then(() => fn(reader)),
  } as unknown as DesktopPrisma;
  return { prisma };
}

/**
 * The ranking pass's SQL eligibility predicate, in TypeScript: a row is ranked
 * only when it carries a hash AND a non-NULL body — i.e. only when the packing
 * loop could actually emit it. Mirrors
 * `AND content IS NOT NULL AND content_hash IS NOT NULL AND content_hash <> ''`.
 */
function isRankableVersionRow(row: VersionRow): boolean {
  const contentHash = row.content_hash;
  return (
    row.content !== null &&
    row.content !== undefined &&
    typeof contentHash === "string" &&
    contentHash.length > 0
  );
}
