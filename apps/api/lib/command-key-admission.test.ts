/**
 * ISS-4795 / ISS-4796 — the cloud trust boundary must enforce the same command
 * key rules the desktop producers do.
 *
 * wongk (PR #4322): "Every producer is the contract here, but this helper only
 * reaches the new Desktop paths. Older supported Desktop builds still send
 * //clear and /... through the API component and usage schemas, where those keys
 * are accepted and persisted verbatim, so cloud inventory can be repolluted
 * after this lands."
 */
import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import type { SyncedComponentUsage } from "@repo/api/src/types/agent-session";
import { describe, expect, it } from "vitest";
import {
  admitComponentKey,
  admitSyncedCommandComponents,
  admitSyncedCommandUsage,
} from "./command-key-admission";
import type { DesktopAgentComponentsPayload } from "./desktop-agent-sessions-schema";

/**
 * The rows the guard actually sees: the INGEST schema's parsed shape, not the
 * `SyncedComponent` wire mirror. Every nullable field is already folded to
 * `null` by zod at this point, so an "absent" key reaches the guard as `null`
 * and never as `undefined` — the fixtures have to say that or they test a
 * shape the boundary cannot produce.
 */
type SyncedComponentRow = DesktopAgentComponentsPayload["components"][number];

const component = (
  overrides: Partial<SyncedComponentRow> &
    Pick<SyncedComponentRow, "externalId">
): SyncedComponentRow => ({
  componentKind: AgentComponentKind.Command,
  harness: null,
  name: null,
  componentKey: null,
  version: null,
  description: null,
  sourceUrl: null,
  installPath: null,
  packId: null,
  scope: null,
  projectPath: null,
  metadata: null,
  contentHash: null,
  definitionHash: null,
  ...overrides,
});

const usage = (
  overrides: Partial<SyncedComponentUsage> &
    Pick<SyncedComponentUsage, "componentKey">
): SyncedComponentUsage => ({
  componentKind: AgentComponentKind.Command,
  invocations: 1,
  errorCount: 0,
  ...overrides,
});

describe("admitComponentKey", () => {
  it("collapses a skewed client's doubled slash onto the one identity", () => {
    expect(admitComponentKey(AgentComponentKind.Command, "//clear")).toBe(
      "/clear"
    );
  });

  it("leaves a correctly-keyed command untouched", () => {
    expect(admitComponentKey(AgentComponentKind.Command, "/clear")).toBe(
      "/clear"
    );
  });

  it.each([
    ["/..."],
    ["/…"],
    ["/"],
    ["//"],
    ["   "],
  ])("rejects the placeholder %j", (key) => {
    expect(admitComponentKey(AgentComponentKind.Command, key)).toBeNull();
  });

  it("does not touch a non-command kind, even a slash-leading key", () => {
    // A skill keyed on `/name` is a legitimate identity and none of this
    // guard's business — rewriting it would re-key a real component.
    expect(admitComponentKey(AgentComponentKind.Skill, "//odd-skill")).toBe(
      "//odd-skill"
    );
  });
});

describe("admitSyncedCommandComponents", () => {
  it("normalizes BOTH externalId and componentKey", () => {
    // The writer's identity is `componentKey ?? externalId`, so normalizing one
    // and not the other would leave the duplicate identity reachable.
    const [admitted] = admitSyncedCommandComponents([
      component({ externalId: "//clear", componentKey: "//clear" }),
    ]);

    expect(admitted?.externalId).toBe("/clear");
    expect(admitted?.componentKey).toBe("/clear");
  });

  it("normalizes externalId when componentKey is absent", () => {
    const [admitted] = admitSyncedCommandComponents([
      component({ externalId: "//build" }),
    ]);

    expect(admitted?.externalId).toBe("/build");
    // An absent key stays absent: the guard must not invent `"/build"` as a
    // componentKey, because the writer's identity is `componentKey ?? externalId`
    // and minting one would change which column the row is keyed on.
    expect(admitted?.componentKey).toBeNull();
  });

  it("keeps a well-keyed command whose componentKey is absent", () => {
    // The guard's own regression. `admitComponentKey` returns `null` for "names
    // no command", and the ingest schema folds an OMITTED `componentKey` to
    // `null` too. Collapsing the two dropped every ordinary command row — the
    // vast majority, since the writer keys on `componentKey ?? externalId` —
    // deleting real inventory on the first sync instead of the placeholders
    // this guard targets.
    expect(
      admitSyncedCommandComponents([component({ externalId: "/clear" })])
    ).toHaveLength(1);
  });

  it("drops a truncated palette string so it never mints an inventory row", () => {
    expect(
      admitSyncedCommandComponents([component({ externalId: "/..." })])
    ).toEqual([]);
  });

  it("drops a row whose PRESENT componentKey names no command", () => {
    // The other side of the same split: a key that is there and inadmissible is
    // the field the writer would key on, so the row must not be ingested.
    expect(
      admitSyncedCommandComponents([
        component({ externalId: "/clear", componentKey: "/..." }),
      ])
    ).toEqual([]);
  });

  it("keeps non-command components exactly as received", () => {
    const skill = component({
      externalId: "review",
      componentKind: AgentComponentKind.Skill,
    });

    expect(admitSyncedCommandComponents([skill])[0]).toBe(skill);
  });
});

describe("admitSyncedCommandUsage", () => {
  it("merges the split population instead of letting one row clobber the other", () => {
    // The regression this guard exists for: `/clear` (133) and `//clear` (111)
    // arriving in one skewed payload. A filter alone would normalize both onto
    // the same natural key and let the second upsert overwrite the first,
    // losing 133 invocations — the opposite of reuniting them.
    const merged = admitSyncedCommandUsage([
      usage({
        componentKey: "/clear",
        invocations: 133,
        errorCount: 2,
        firstInvokedAt: "2026-02-01T00:00:00.000Z",
        lastInvokedAt: "2026-02-05T00:00:00.000Z",
      }),
      usage({
        componentKey: "//clear",
        invocations: 111,
        errorCount: 1,
        firstInvokedAt: "2026-01-20T00:00:00.000Z",
        lastInvokedAt: "2026-02-09T00:00:00.000Z",
      }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.componentKey).toBe("/clear");
    expect(merged[0]?.invocations).toBe(244);
    expect(merged[0]?.errorCount).toBe(3);
    // The window widens to cover both buckets, not just the surviving row's.
    expect(merged[0]?.firstInvokedAt).toBe("2026-01-20T00:00:00.000Z");
    expect(merged[0]?.lastInvokedAt).toBe("2026-02-09T00:00:00.000Z");
  });

  it("keeps distinct branch buckets separate while merging within one", () => {
    const merged = admitSyncedCommandUsage([
      usage({ componentKey: "//clear", gitBranch: "main", invocations: 3 }),
      usage({ componentKey: "/clear", gitBranch: "main", invocations: 4 }),
      usage({ componentKey: "//clear", gitBranch: "feat/a", invocations: 5 }),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged.find((row) => row.gitBranch === "main")?.invocations).toBe(7);
    expect(merged.find((row) => row.gitBranch === "feat/a")?.invocations).toBe(
      5
    );
    for (const row of merged) {
      expect(row.componentKey).toBe("/clear");
    }
  });

  it("drops a placeholder usage rollup", () => {
    expect(
      admitSyncedCommandUsage([usage({ componentKey: "/...", invocations: 9 })])
    ).toEqual([]);
  });

  it("keeps a usage row whose externalComponentId is absent", () => {
    // The usage twin of the inventory absent-vs-rejected split. A usage row
    // reported with no `externalComponentId` resolves by `componentKey` and is
    // the ordinary case; the session-sync schema folds that omission to `null`,
    // so reading `null` as a rejection silently dropped every such row and the
    // whole per-session usage fan-out with it.
    const merged = admitSyncedCommandUsage([
      usage({ componentKey: "/clear", externalComponentId: null }),
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.externalComponentId).toBeNull();
  });

  it("drops a usage row whose PRESENT externalComponentId names no command", () => {
    expect(
      admitSyncedCommandUsage([
        usage({ componentKey: "/clear", externalComponentId: "/..." }),
      ])
    ).toEqual([]);
  });

  it("normalizes externalComponentId alongside the key", () => {
    const [admitted] = admitSyncedCommandUsage([
      usage({ componentKey: "//clear", externalComponentId: "//clear" }),
    ]);

    expect(admitted?.externalComponentId).toBe("/clear");
  });

  it("passes non-command usage through untouched", () => {
    const skillUsage = usage({
      componentKey: "review",
      componentKind: AgentComponentKind.Skill,
      invocations: 12,
    });

    expect(admitSyncedCommandUsage([skillUsage])).toEqual([
      { ...skillUsage, externalComponentId: undefined },
    ]);
  });

  it("keeps a version hash from whichever merged side carried one", () => {
    const [admitted] = admitSyncedCommandUsage([
      usage({ componentKey: "/clear", componentVersionHash: null }),
      usage({ componentKey: "//clear", componentVersionHash: "abc123" }),
    ]);

    expect(admitted?.componentVersionHash).toBe("abc123");
  });
});
