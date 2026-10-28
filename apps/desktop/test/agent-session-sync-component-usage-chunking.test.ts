/**
 * @file agent-session-sync-component-usage-chunking.test.ts
 * @description ISS-6884 — a session's component-usage set is PAGINATED across
 * sync parts, never truncated to a permanent subset. `MAX_SYNCED_COMPONENT_USAGE`
 * is the cloud's PER-PAYLOAD wire bound; before this ticket the desktop reader
 * applied it as a population bound, and because the read is deterministic and the
 * local table carries no sync cursor, the same subset was re-sent on every resend
 * and the remainder never reached the cloud at all.
 *
 * These tests pin:
 *   - full fidelity: an over-cap set ships in full across parts, every
 *     `(componentKind, componentKey, gitBranch)` row present EXACTLY once;
 *   - whole-group parts: a `(kind,key)` group is never split across two parts —
 *     the cloud prune treats a present group's branch set as authoritative and
 *     deletes the buckets that part omits, so a split group loses branches;
 *   - every part honors the per-payload cap the cloud wire schema enforces;
 *   - one-part fusion for the `command`/`skill` rows the cloud RE-KEYS before it
 *     prunes, whose payload-local merges cannot see across parts;
 *   - a paginated pass never delivers fewer rows than the prefix it replaced;
 *   - the at-or-below-cap set still ships whole in one payload, unpaginated.
 */
import assert from "node:assert/strict";
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import {
  MAX_SYNCED_COMPONENT_USAGE,
  type SyncedComponentUsage,
} from "@repo/api/src/types/agent-session";
import { describe, test } from "vitest";
import { gzipSyncPayloadSizer } from "../src/main/agent-sync/agent-session-sync-compression.js";
import type { SyncedAgentSession } from "../src/main/agent-sync/agent-session-sync-contract.js";
import {
  type PreparedAgentSessionPayload,
  prepareAgentSessionPayload,
} from "../src/main/agent-sync/agent-session-sync-payload.js";

// Far above anything these fixtures serialize to, so the BYTE cap can never be
// what forces chunking: only the component-usage row cap may. A fixture that
// chunked on bytes would pass with or without the fix.
const ROOMY_MAX_BYTES = 8 * 1024 * 1024;

const COMMAND_KIND = AgentComponentKind.Command;
const SKILL_KIND = AgentComponentKind.Skill;

// One event fills a chunk on its own at this cap, so an event COUNT is a chunk
// count and the shared MAX_SESSION_SYNC_CHUNKS budget is reachable without a
// multi-hundred-megabyte fixture.
const BUDGET_FILLING_CHUNK_BYTES = 140_000;
const BUDGET_FILLING_EVENT_BYTES = 70_000;

function buildBudgetFillingEvents(
  count: number,
  eventBytes: number = BUDGET_FILLING_EVENT_BYTES
): SyncedAgentSession["events"] {
  return Array.from({ length: count }, (_, index) => ({
    externalEventId: `evt-${index}-${"p".repeat(eventBytes)}`,
    agentExternalId: null,
    eventType: "tool_use",
    toolName: "Read",
    createdAt: "2026-06-10T10:00:00.000Z",
  }));
}

function buildSession(
  components: SyncedComponentUsage[] | undefined
): SyncedAgentSession {
  return {
    externalSessionId: "sess-component-usage",
    name: "Component usage session",
    status: "active",
    harness: "claude",
    cwd: "/tmp/wt",
    model: "claude-opus-4",
    startedAt: "2026-06-10T10:00:00.000Z",
    updatedAt: "2026-06-10T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    ...(components ? { components } : {}),
  };
}

function buildUsage(
  componentKey: string,
  gitBranch: string | null = null
): SyncedComponentUsage {
  return {
    componentKind: "tool",
    componentKey,
    externalComponentId: null,
    harness: "claude",
    invocations: 1,
    errorCount: 0,
    firstInvokedAt: "2026-06-10T10:00:00.000Z",
    lastInvokedAt: "2026-06-10T10:30:00.000Z",
    gitBranch,
    componentVersionHash: null,
  };
}

/** One single-branch group per key. */
function buildSingleBranchGroups(count: number): SyncedComponentUsage[] {
  return Array.from({ length: count }, (_, i) =>
    buildUsage(`tool-${String(i).padStart(4, "0")}`)
  );
}

/**
 * `groupCount` groups of `branchesPerGroup` branch rows each. Multi-branch on
 * purpose: with one branch per group a chunk's GROUP count equals its ROW count,
 * so a pagination unit that budgeted groups instead of rows would satisfy the
 * per-payload row cap by accident. These fixtures separate the two.
 */
function buildMultiBranchGroups(
  groupCount: number,
  branchesPerGroup: number
): SyncedComponentUsage[] {
  const components: SyncedComponentUsage[] = [];
  for (let group = 0; group < groupCount; group++) {
    for (let branch = 0; branch < branchesPerGroup; branch++) {
      components.push(
        buildUsage(
          `tool-${String(group).padStart(4, "0")}`,
          `feat/branch-${branch}`
        )
      );
    }
  }
  return components;
}

function usageRowKey(usage: SyncedComponentUsage): string {
  return `${usage.componentKind}|${usage.componentKey}|${usage.gitBranch ?? ""}`;
}

function usageGroupKey(usage: SyncedComponentUsage): string {
  return `${usage.componentKind}|${usage.componentKey}`;
}

function allChunks(
  prepared: PreparedAgentSessionPayload
): SyncedAgentSession[] {
  if (prepared.kind !== "chunked") {
    throw new Error(
      `an over-cap component-usage set must be paginated, not shipped or truncated whole — got "${prepared.kind}"`
    );
  }
  return [prepared.firstChunk, ...prepared.remainingChunks];
}

function collectUsage(chunks: SyncedAgentSession[]): SyncedComponentUsage[] {
  return chunks.flatMap((chunk) => chunk.components ?? []);
}

describe("ISS-6884: component usage is paginated, never truncated", () => {
  test("ships every group of an over-cap set across parts, each row exactly once", () => {
    const components = buildSingleBranchGroups(
      MAX_SYNCED_COMPONENT_USAGE + 100
    );
    const prepared = prepareAgentSessionPayload(
      buildSession(components),
      ROOMY_MAX_BYTES
    );

    const chunks = allChunks(prepared);
    assert.ok(
      chunks.length > 1,
      "an over-cap set needs more than one part to carry it"
    );

    const delivered = collectUsage(chunks);
    const deliveredKeys = delivered.map(usageRowKey);
    assert.equal(
      deliveredKeys.length,
      components.length,
      "every local usage row is delivered — no row dropped for transport"
    );
    assert.equal(
      new Set(deliveredKeys).size,
      components.length,
      "and no row is delivered twice"
    );
    assert.deepEqual(
      [...deliveredKeys].sort(),
      components.map(usageRowKey).sort(),
      "the delivered set is exactly the local set"
    );
  });

  test("keeps every part within the per-payload wire cap, counting ROWS not groups", () => {
    // Multi-branch groups so group count and row count diverge: 400 groups of 3
    // branches is 1200 rows. A pagination unit that budgeted GROUPS would pack
    // all 400 into one part and blow the row cap the cloud schema enforces.
    const groupCount = 400;
    const branchesPerGroup = 3;
    const components = buildMultiBranchGroups(groupCount, branchesPerGroup);
    assert.ok(
      groupCount <= MAX_SYNCED_COMPONENT_USAGE &&
        components.length > MAX_SYNCED_COMPONENT_USAGE,
      "fixture must sit under the cap in groups and over it in rows, or it cannot tell the two budgets apart"
    );

    const chunks = allChunks(
      prepareAgentSessionPayload(buildSession(components), ROOMY_MAX_BYTES)
    );

    for (const chunk of chunks) {
      assert.ok(
        (chunk.components?.length ?? 0) <= MAX_SYNCED_COMPONENT_USAGE,
        "a part declaring more usage rows than the cap is rejected by the cloud schema, failing the WHOLE batch"
      );
    }
    assert.equal(
      collectUsage(chunks).length,
      components.length,
      "and the parts still carry every row"
    );
  });

  test("never splits a componentKind/componentKey group across two parts", () => {
    // Multi-branch groups sized so the cap boundary lands INSIDE a group under
    // any naive row-count slice: 170 groups of 3 branches = 510 rows > the cap.
    const groupCount = 170;
    const branchesPerGroup = 3;
    const components = buildMultiBranchGroups(groupCount, branchesPerGroup);
    assert.ok(
      components.length > MAX_SYNCED_COMPONENT_USAGE,
      "fixture must cross the cap or it proves nothing"
    );

    const chunks = allChunks(
      prepareAgentSessionPayload(buildSession(components), ROOMY_MAX_BYTES)
    );

    const partIndexByGroup = new Map<string, number>();
    const branchesByGroup = new Map<string, number>();
    chunks.forEach((chunk, index) => {
      for (const usage of chunk.components ?? []) {
        const group = usageGroupKey(usage);
        const seenIn = partIndexByGroup.get(group);
        assert.ok(
          seenIn === undefined || seenIn === index,
          `group ${group} appears in parts ${seenIn} and ${index}; the cloud prune would delete the earlier part's branches`
        );
        partIndexByGroup.set(group, index);
        branchesByGroup.set(group, (branchesByGroup.get(group) ?? 0) + 1);
      }
    });

    assert.equal(
      partIndexByGroup.size,
      groupCount,
      "every group reaches the cloud"
    );
    for (const [group, branches] of branchesByGroup) {
      assert.equal(
        branches,
        branchesPerGroup,
        `group ${group} must ship its full branch set — a partial group prunes the missing branches cloud-side`
      );
    }
  });

  test("keeps a command/skill fold family in one part, because the cloud re-keys it", () => {
    // The receiver does not prune on the identity shipped here. It normalizes a
    // command key and SUMS the rows that collapse onto one identity (`//clear`
    // and `/clear`), then folds a slash-invoked `command|/x` onto `skill|x` and
    // sums it into that bucket, and only then computes the branch-bucket prune.
    // Both merges are payload-local. Split across parts, the later part's prune
    // deletes the branches the earlier one wrote and its upsert REPLACES the
    // summed count — a silent undercount that could not happen while the whole
    // set rode one payload.
    const foldFamilies = {
      clear: [
        { ...buildUsage("//clear", "feat/one"), componentKind: COMMAND_KIND },
        { ...buildUsage("/clear", "feat/one"), componentKind: COMMAND_KIND },
      ],
      review: [
        { ...buildUsage("/review", "feat/one"), componentKind: COMMAND_KIND },
        { ...buildUsage("/review", "feat/two"), componentKind: COMMAND_KIND },
        { ...buildUsage("review", "feat/one"), componentKind: SKILL_KIND },
      ],
    };
    // Each family's members are separated by MORE than a part's worth of rows.
    // Keyed on the WIRE identity they would be distinct units far apart in the
    // pack order and land in different parts, so this fixture fails unless the
    // grouping actually uses the receiver's identity.
    const filler = buildSingleBranchGroups(MAX_SYNCED_COMPONENT_USAGE * 2);
    const components = [
      foldFamilies.review[0],
      foldFamilies.review[1],
      ...filler.slice(0, MAX_SYNCED_COMPONENT_USAGE),
      foldFamilies.review[2],
      foldFamilies.clear[0],
      ...filler.slice(MAX_SYNCED_COMPONENT_USAGE),
      foldFamilies.clear[1],
    ];

    const chunks = allChunks(
      prepareAgentSessionPayload(buildSession(components), ROOMY_MAX_BYTES)
    );
    assert.ok(chunks.length > 1, "the fixture must actually paginate");

    for (const [family, rows] of Object.entries(foldFamilies)) {
      const wanted = new Set(rows.map(usageRowKey));
      const parts = new Set<number>();
      chunks.forEach((chunk, index) => {
        for (const usage of chunk.components ?? []) {
          if (wanted.has(usageRowKey(usage))) {
            parts.add(index);
          }
        }
      });
      assert.equal(
        parts.size,
        1,
        `the ${family} fold family must ride ONE part — the receiver's payload-local merges cannot see across parts`
      );
    }
    assert.equal(
      collectUsage(chunks).length,
      components.length,
      "and grouping by the receiver's identity costs no rows"
    );
  });

  test("falls back to the bounded prefix when pagination would deliver fewer rows", () => {
    // Two packers, two behaviours: the bounded prefix SKIPS a unit that does not
    // fit and keeps scanning, while the chunk packer SEALS there. With the chunk
    // budget nearly spent, sealing early can deliver strictly less than the
    // truncation this ticket removes — the same permanent prefix, just narrower.
    // "Some parts were appended" is therefore not evidence of parity.
    const components = [
      ...Array.from({ length: 300 }, (_, i) =>
        buildUsage("tool-a", `feat/a-${i}`)
      ),
      ...Array.from({ length: 400 }, (_, i) =>
        buildUsage("tool-b", `feat/b-${i}`)
      ),
      ...Array.from({ length: 150 }, (_, i) =>
        buildUsage("tool-c", `feat/c-${i}`)
      ),
    ];
    // Sized so ONE event fills a chunk AND the bounded prefix still leaves room
    // for one beside it — otherwise the retry cannot fit and the guard correctly
    // keeps the paginated parts, which is a different branch.
    const delivered = collectUsage(
      allChunks(
        prepareAgentSessionPayload(
          {
            ...buildSession(components),
            events: buildBudgetFillingEvents(98, 130_000),
          },
          255_000
        )
      )
    );

    // 300 + 150: the prefix packs `tool-a`, SKIPS the 400-row `tool-b` that no
    // longer fits, and still takes `tool-c`. Sealing at `tool-b` delivers 300.
    assert.equal(
      new Set(delivered.map(usageGroupKey)).size,
      2,
      "the fallback must deliver the prefix's two groups, not the single group the seal reached"
    );
    assert.equal(
      new Set(delivered.map(usageRowKey)).size,
      450,
      "and every row of them — a paginated pass that delivers less than the prefix is the old defect, narrowed"
    );
  });

  test("still delivers usage when the chunk budget leaves the stream no part", () => {
    // The component stream shares one bounded chunk budget with the REQUIRED
    // events stream, which paginates first. Once events have consumed all but
    // one of it, the component stream cannot append even its first part — while
    // every chunk events built has already had `components` stripped to []. That
    // combination ships a session declaring NO usage at all, which is strictly
    // less than the truncation this ticket removes, so the split falls back to
    // the pre-ISS-6884 bounded prefix on the base instead.
    //
    // Each event is sized to fill a chunk on its own, so the event count IS the
    // chunk count and the budget boundary is reachable without a huge fixture.
    // One small group plus one that cannot join it under the per-payload cap,
    // so the bounded prefix is the small group alone.
    const components = [
      ...buildMultiBranchGroups(1, 4),
      ...Array.from({ length: MAX_SYNCED_COMPONENT_USAGE - 3 }, (_, i) =>
        buildUsage("tool-wide", `feat/wide-${i}`)
      ),
    ];
    assert.ok(
      components.length > MAX_SYNCED_COMPONENT_USAGE,
      "fixture must cross the cap or it proves nothing"
    );
    const buildFatSession = (eventCount: number): SyncedAgentSession => ({
      ...buildSession(components),
      events: buildBudgetFillingEvents(eventCount),
    });

    // Control: one event below the boundary the stream still gets its parts and
    // the WHOLE set ships. This is what pins the starved case below to the
    // budget rather than to some unrelated rejection.
    const unstarved = collectUsage(
      allChunks(
        prepareAgentSessionPayload(
          buildFatSession(98),
          BUDGET_FILLING_CHUNK_BYTES
        )
      )
    );
    assert.equal(
      unstarved.length,
      components.length,
      "with budget to spare the complete set still ships across parts"
    );

    const starvedChunks = allChunks(
      prepareAgentSessionPayload(
        buildFatSession(99),
        BUDGET_FILLING_CHUNK_BYTES
      )
    );
    const starved = collectUsage(starvedChunks);
    assert.ok(
      starved.length > 0,
      "a starved component stream must not ship a session that declares no usage at all"
    );
    assert.deepEqual(
      [...new Set(starved.map(usageGroupKey))],
      ["tool|tool-0000"],
      "the fallback is the whole-group prefix one payload can carry, never a partial group"
    );
    for (const chunk of starvedChunks) {
      assert.ok(
        (chunk.components?.length ?? 0) <= MAX_SYNCED_COMPONENT_USAGE,
        "and the fallback still honors the per-payload wire cap"
      );
    }
  });

  test("omits components entirely when the starved fallback can carry no group", () => {
    // Same starvation as above, but every remaining group is itself too wide for
    // one payload, so the bounded fallback has nothing to put on the base. It
    // must OMIT the key: an absent `components` is the cloud's documented no-op,
    // while `components: []` ships a useless key on every chunk.
    const components = Array.from(
      { length: MAX_SYNCED_COMPONENT_USAGE + 1 },
      (_, i) => buildUsage("tool-only", `feat/wide-${i}`)
    );
    const chunks = allChunks(
      prepareAgentSessionPayload(
        {
          ...buildSession(components),
          events: buildBudgetFillingEvents(99),
        },
        BUDGET_FILLING_CHUNK_BYTES
      )
    );

    assert.ok(chunks.length > 1, "the session itself still ships across parts");
    for (const chunk of chunks) {
      assert.equal(
        chunk.components,
        undefined,
        "an unsendable set omits the key rather than shipping an empty array"
      );
    }
  });

  test("a genuine command beside a same-named skill still delivers its group", () => {
    // ISS-6884 (codex review). `componentUsageMergeKey` fuses EVERY slash command
    // with the same-named skill, because the desktop cannot know whether the
    // cloud will fold them — the receiver folds only when its inventory proves
    // the command is a phantom (`isSkillShadowedPhantom`), and a genuine
    // `/deploy` beside a `deploy` skill is never folded. Over-grouping is safe
    // while the fused unit fits a part. It is NOT safe when the fusion pushes the
    // unit past what any part can carry: the unit is then unsendable and BOTH
    // groups are dropped, where the pre-ISS-6884 population cap shipped one of
    // them whole. Removing a truncation must never deliver less than the
    // truncation did.
    const branchRows = 300;
    const components = [
      ...Array.from({ length: branchRows }, (_, i) => ({
        ...buildUsage("/deploy", `feat/cmd-${i}`),
        componentKind: COMMAND_KIND,
      })),
      ...Array.from({ length: branchRows }, (_, i) => ({
        ...buildUsage("deploy", `feat/skill-${i}`),
        componentKind: SKILL_KIND,
      })),
    ];
    assert.ok(
      branchRows <= MAX_SYNCED_COMPONENT_USAGE &&
        components.length > MAX_SYNCED_COMPONENT_USAGE,
      "each group must fit a part alone while the fused unit does not, or the fixture proves nothing"
    );

    const delivered = collectUsage(
      allChunks(
        prepareAgentSessionPayload(buildSession(components), ROOMY_MAX_BYTES)
      )
    );

    assert.equal(
      delivered.length,
      branchRows,
      "the unsendable fold unit must not take both groups down with it — one whole group still ships, exactly as the population cap delivered"
    );
    assert.equal(
      new Set(delivered.map(usageGroupKey)).size,
      1,
      "and it ships as ONE whole group, never a partial one the cloud prune would trim"
    );
    for (const usage of delivered) {
      assert.equal(
        usage.componentKey,
        delivered[0].componentKey,
        "every delivered row belongs to that single group"
      );
    }
  });

  test("a byte-oversized group never starves the groups ordered after it", () => {
    // The reader bounds a group by ROWS; nothing bounds its BYTES. A group whose
    // own serialized size exceeds one chunk can therefore reach the chunker, and
    // the shared packer ABORTS its scan on an item that cannot fit alone — so
    // leaving it in the list would permanently strand every later group, the
    // exact starvation this ticket exists to remove.
    const perChunkBytes = 120_000;
    const fatKey = `tool-fat-${"k".repeat(2000)}`;
    const components = [
      ...Array.from({ length: 60 }, (_, i) =>
        buildUsage(fatKey, `feat/fat-${i}`)
      ),
      ...buildSingleBranchGroups(MAX_SYNCED_COMPONENT_USAGE + 20),
    ];
    assert.ok(
      Buffer.byteLength(
        JSON.stringify(components.filter((row) => row.componentKey === fatKey))
      ) > perChunkBytes,
      "the fat group must exceed one chunk on its own, or it proves nothing"
    );

    const delivered = collectUsage(
      allChunks(
        prepareAgentSessionPayload(buildSession(components), perChunkBytes)
      )
    );
    const deliveredKeys = new Set(delivered.map((row) => row.componentKey));
    assert.ok(
      !deliveredKeys.has(fatKey),
      "the byte-oversized group cannot be sent, whole or partial"
    );
    assert.equal(
      deliveredKeys.size,
      MAX_SYNCED_COMPONENT_USAGE + 20,
      "every other group still ships — the oversized one does not end the scan"
    );
  });

  test("honors the row cap on the gzip sizing path too", () => {
    // The gzip sizer packs by a different budget in a different function, and it
    // is the path production takes once the server negotiates decompression. The
    // group-weighted row ceiling has to reach it as well, or a compressed part
    // fits the wire cap while declaring more rows than the cloud schema accepts —
    // which rejects the WHOLE batch and re-prepares identically forever.
    const groupCount = 400;
    const branchesPerGroup = 3;
    const components = buildMultiBranchGroups(groupCount, branchesPerGroup);
    assert.ok(
      groupCount <= MAX_SYNCED_COMPONENT_USAGE &&
        components.length > MAX_SYNCED_COMPONENT_USAGE,
      "fixture must sit under the cap in groups and over it in rows"
    );

    const chunks = allChunks(
      prepareAgentSessionPayload(
        buildSession(components),
        ROOMY_MAX_BYTES,
        gzipSyncPayloadSizer
      )
    );

    for (const chunk of chunks) {
      assert.ok(
        (chunk.components?.length ?? 0) <= MAX_SYNCED_COMPONENT_USAGE,
        "a gzip part must respect the row cap the cloud schema enforces"
      );
    }
    assert.equal(
      collectUsage(chunks).length,
      components.length,
      "and the gzip parts still carry every row"
    );
  });

  test("ships an at-cap set whole in one payload, unpaginated", () => {
    const components = buildSingleBranchGroups(MAX_SYNCED_COMPONENT_USAGE);
    const prepared = prepareAgentSessionPayload(
      buildSession(components),
      ROOMY_MAX_BYTES
    );

    assert.equal(
      prepared.kind,
      "session",
      "a set that fits one payload must not be split — the cap is exclusive, not inclusive"
    );
    if (prepared.kind !== "session") {
      throw new Error("unreachable");
    }
    assert.equal(
      prepared.session.components?.length,
      MAX_SYNCED_COMPONENT_USAGE,
      "and it ships in full"
    );
  });
});
