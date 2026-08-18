/**
 * FEA-4365 — the Routines pure input→Prisma mappers.
 *
 * This module had ZERO coverage (0/58 branches) despite owning the
 * provider-capability normalization contract: a field a provider cannot emit
 * must be stored as its empty/null value, on create AND across a provider
 * switch, regardless of what the caller sent. That is the rule that stops a
 * Claude→Codex transition leaving `permissionMode`/`worktree` behind.
 *
 * Inputs are built through the real `createRoutineInputSchema`, so the fixtures
 * carry exactly the defaults production hands these mappers.
 */

import {
  createRoutineInputSchema,
  RoutineProvider,
  RoutineRunsIn,
} from "@repo/api/src/types/routine";
import { describe, expect, it } from "vitest";
import {
  buildRoutineUpdateData,
  buildRoutineWriteData,
  serializeAttempts,
  serializeInvokedComponents,
} from "./service-mappers";

const ORG = "org-1";

/** A validated create input carrying BOTH providers' capability fields. */
function createInput(provider: RoutineProvider) {
  return createRoutineInputSchema.parse({
    name: "Nightly sweep",
    provider,
    modelId: "claude-opus-4",
    // Claude-only
    folderOrRepo: "acme/web",
    connectorIds: ["conn-1"],
    permissionMode: "acceptEdits",
    worktree: true,
    // Codex-only
    project: "proj-1",
    runsIn: RoutineRunsIn.NewChat,
    reasoningEffort: "high",
  });
}

describe("buildRoutineWriteData — provider capability normalization", () => {
  it("keeps Claude-only fields and nulls Codex-only fields for a Claude routine", () => {
    const data = buildRoutineWriteData(
      ORG,
      createInput(RoutineProvider.Claude)
    );

    expect(data).toMatchObject({
      folderOrRepo: "acme/web",
      connectorIds: ["conn-1"],
      permissionMode: "acceptEdits",
      worktree: true,
    });
    expect(data.project).toBeNull();
    expect(data.runsIn).toBeNull();
    expect(data.reasoningEffort).toBeNull();
  });

  it("keeps Codex-only fields and empties Claude-only fields for a Codex routine", () => {
    const data = buildRoutineWriteData(ORG, createInput(RoutineProvider.Codex));

    expect(data).toMatchObject({
      project: "proj-1",
      runsIn: RoutineRunsIn.NewChat,
      reasoningEffort: "high",
    });
    // Note the per-field empty value differs: null, [], null, false.
    expect(data.folderOrRepo).toBeNull();
    expect(data.connectorIds).toEqual([]);
    expect(data.permissionMode).toBeNull();
    expect(data.worktree).toBe(false);
  });

  it("clears BOTH capability sets for a provider that is neither Claude nor Codex", () => {
    // RoutineProvider has three members; Opencode is neither claudeOnly nor
    // codexOnly, so every provider-conditional field normalizes away. The
    // module docstring only discusses two providers — this pins the third.
    const data = buildRoutineWriteData(
      ORG,
      createInput(RoutineProvider.Opencode)
    );

    expect(data.folderOrRepo).toBeNull();
    expect(data.connectorIds).toEqual([]);
    expect(data.permissionMode).toBeNull();
    expect(data.worktree).toBe(false);
    expect(data.project).toBeNull();
    expect(data.runsIn).toBeNull();
    expect(data.reasoningEffort).toBeNull();
  });

  it("stamps the caller's organizationId and never takes one from the input", () => {
    const data = buildRoutineWriteData(
      ORG,
      createInput(RoutineProvider.Claude)
    );

    expect(data.organizationId).toBe(ORG);
  });

  it("coerces absent optional identity fields to null rather than undefined", () => {
    const data = buildRoutineWriteData(
      ORG,
      createRoutineInputSchema.parse({
        name: "n",
        provider: RoutineProvider.Claude,
        modelId: "m",
      })
    );

    expect(data.sourceId).toBeNull();
    expect(data.teamId).toBeNull();
    expect(data.ownerId).toBeNull();
    expect(data.ownerName).toBeNull();
    expect(data.cron).toBeNull();
    expect(data.hostMachine).toBeNull();
    expect(data.route).toBeNull();
    expect(data.passKind).toBeNull();
    expect(data.pass).toBeNull();
  });

  it("carries the crewd fields through with their schema defaults", () => {
    const data = buildRoutineWriteData(
      ORG,
      createRoutineInputSchema.parse({
        name: "n",
        provider: RoutineProvider.Codex,
        modelId: "m",
      })
    );

    expect(data).toMatchObject({
      catchUp: true,
      recurring: true,
      durable: true,
      crew: "",
    });
    expect(data.harnessCascade).toEqual([]);
    expect(data.meta).toEqual({});
  });
});

describe("buildRoutineUpdateData — partial semantics", () => {
  it("writes ONLY the keys the caller supplied", () => {
    const data = buildRoutineUpdateData({ name: "Renamed" }, null);

    expect(data).toEqual({ name: "Renamed" });
  });

  it("leaves an absent key absent rather than writing null over the stored value", () => {
    const data = buildRoutineUpdateData({ name: "Renamed" }, null);

    // The distinction this module exists for: undefined means "don't touch",
    // and a null would clear a column the caller never mentioned.
    expect("description" in data).toBe(false);
    expect("enabled" in data).toBe(false);
  });

  it("honors an explicit null as a clear", () => {
    const data = buildRoutineUpdateData({ cron: null }, null);

    expect(data.cron).toBeNull();
    expect("cron" in data).toBe(true);
  });

  it("writes falsy values that are NOT undefined", () => {
    // `false` and `""` must survive the `!== undefined` guard.
    const data = buildRoutineUpdateData(
      { enabled: false, scheduleDetail: "" },
      null
    );

    expect(data.enabled).toBe(false);
    expect(data.scheduleDetail).toBe("");
  });

  it("applies no capability clears when the update does not change provider", () => {
    const data = buildRoutineUpdateData({ name: "Renamed" }, null);

    expect("permissionMode" in data).toBe(false);
    expect("project" in data).toBe(false);
    expect("connectorIds" in data).toBe(false);
  });
});

describe("buildRoutineUpdateData — provider transition clears", () => {
  it("clears Claude-only fields on a switch to Codex, even unmentioned ones", () => {
    const data = buildRoutineUpdateData(
      { provider: RoutineProvider.Codex },
      RoutineProvider.Codex
    );

    expect(data.folderOrRepo).toBeNull();
    expect(data.connectorIds).toEqual([]);
    expect(data.permissionMode).toBeNull();
    expect(data.worktree).toBe(false);
    // Codex-only fields are NOT cleared — they are the incoming provider's.
    expect("project" in data).toBe(false);
    expect("runsIn" in data).toBe(false);
    expect("reasoningEffort" in data).toBe(false);
  });

  it("clears Codex-only fields on a switch to Claude", () => {
    const data = buildRoutineUpdateData(
      { provider: RoutineProvider.Claude },
      RoutineProvider.Claude
    );

    expect(data.project).toBeNull();
    expect(data.runsIn).toBeNull();
    expect(data.reasoningEffort).toBeNull();
    expect("permissionMode" in data).toBe(false);
    expect("worktree" in data).toBe(false);
  });

  it("clears BOTH sets on a switch to a third provider", () => {
    const data = buildRoutineUpdateData(
      { provider: RoutineProvider.Opencode },
      RoutineProvider.Opencode
    );

    expect(data.permissionMode).toBeNull();
    expect(data.worktree).toBe(false);
    expect(data.project).toBeNull();
    expect(data.reasoningEffort).toBeNull();
  });

  it("lets the clear WIN over a value the caller supplied for the outgoing provider", () => {
    // A caller switching to Codex while still sending permissionMode must not
    // be able to smuggle the stale Claude field through — the clear runs after
    // the key-assignment loop, so ordering is the contract.
    const data = buildRoutineUpdateData(
      {
        provider: RoutineProvider.Codex,
        permissionMode: "acceptEdits",
        worktree: true,
        folderOrRepo: "acme/web",
        connectorIds: ["conn-1"],
      },
      RoutineProvider.Codex
    );

    expect(data.permissionMode).toBeNull();
    expect(data.worktree).toBe(false);
    expect(data.folderOrRepo).toBeNull();
    expect(data.connectorIds).toEqual([]);
  });

  it("keeps the incoming provider's supplied fields through the transition", () => {
    const data = buildRoutineUpdateData(
      { provider: RoutineProvider.Codex, reasoningEffort: "high" },
      RoutineProvider.Codex
    );

    expect(data.reasoningEffort).toBe("high");
  });
});

describe("serializeInvokedComponents / serializeAttempts", () => {
  it("default an absent list to an empty array", () => {
    expect(serializeInvokedComponents(undefined)).toEqual([]);
    expect(serializeAttempts(undefined)).toEqual([]);
  });

  it("return COPIES so a later mutation cannot reach the caller's objects", () => {
    // These land in a JSON column; aliasing the caller's objects would let a
    // downstream edit mutate what was persisted.
    const component = { id: "c1", kind: "agent" };
    const [copied] = serializeInvokedComponents([
      component,
    ] as unknown as Parameters<typeof serializeInvokedComponents>[0]);

    expect(copied).toEqual(component);
    expect(copied).not.toBe(component);
  });

  it("preserve list order and length", () => {
    const attempts = [{ n: 1 }, { n: 2 }, { n: 3 }] as unknown as Parameters<
      typeof serializeAttempts
    >[0];

    expect(serializeAttempts(attempts)).toHaveLength(3);
    expect(serializeAttempts(attempts)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});
