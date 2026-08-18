/**
 * ISS-4778 (Part 2 of ISS-4775) — unit coverage for the component-sync skew
 * guard. Pins the exact predicate so the guard can never widen into deleting a
 * genuine command: only a slash-keyed, content-less, non-`resolved` `command`
 * with a RESOLVED same-named `skill` on the same compute target is dropped.
 */
import {
  AgentComponentKind,
  ComponentResolvedState,
} from "@repo/api/src/types/agent-component";
import type { TransactionClient } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import type { DesktopAgentComponentsPayload } from "@/lib/desktop-agent-sessions-schema";
import { dropSkillShadowedCommands } from "./skill-shadow-guard";

type SyncedComponent = DesktopAgentComponentsPayload["components"][number];

const COMPUTE_TARGET_ID = "target-1";

function buildComponent(
  overrides: Partial<SyncedComponent> & Pick<SyncedComponent, "componentKind">
): SyncedComponent {
  return {
    externalId: overrides.componentKey ?? "external-1",
    harness: "claude",
    name: null,
    componentKey: null,
    version: null,
    description: null,
    sourceUrl: null,
    installPath: null,
    packId: null,
    scope: null,
    projectPath: null,
    content: null,
    contentHash: null,
    firstSeenAt: null,
    lastSeenAt: null,
    uninstalledAt: null,
    definitionHash: null,
    ...overrides,
  } as SyncedComponent;
}

function fakeDb(storedResolvedSkillKeys: string[]) {
  const findMany = vi
    .fn()
    .mockResolvedValue(
      storedResolvedSkillKeys.map((componentKey) => ({ componentKey }))
    );
  return {
    db: { agentComponent: { findMany } } as unknown as TransactionClient,
    findMany,
  };
}

const phantomCommand = buildComponent({
  componentKey: "/review",
  componentKind: AgentComponentKind.Command,
  resolvedState: ComponentResolvedState.Unresolved,
});

describe("dropSkillShadowedCommands", () => {
  it("drops the phantom command when a stored resolved skill shadows it", async () => {
    const { db } = fakeDb(["review"]);

    const kept = await dropSkillShadowedCommands(
      db,
      [phantomCommand],
      COMPUTE_TARGET_ID
    );

    expect(kept).toEqual([]);
  });

  it("keeps a command whose stored skill sibling is not resolved", async () => {
    const { db } = fakeDb([]);

    const kept = await dropSkillShadowedCommands(
      db,
      [phantomCommand],
      COMPUTE_TARGET_ID
    );

    expect(kept).toEqual([phantomCommand]);
  });

  it("keeps a command that resolved against a real definition of its own", async () => {
    const { db } = fakeDb(["review"]);
    const resolvedCommand = buildComponent({
      componentKey: "/review",
      componentKind: AgentComponentKind.Command,
      content: "# Real command",
      resolvedState: ComponentResolvedState.Resolved,
    });

    const kept = await dropSkillShadowedCommands(
      db,
      [resolvedCommand],
      COMPUTE_TARGET_ID
    );

    expect(kept).toEqual([resolvedCommand]);
  });

  it("keeps an unresolved command that nonetheless carries definition text", async () => {
    const { db } = fakeDb(["review"]);
    const command = buildComponent({
      componentKey: "/review",
      componentKind: AgentComponentKind.Command,
      content: "# Captured but not promoted",
      resolvedState: ComponentResolvedState.Unresolved,
    });

    const kept = await dropSkillShadowedCommands(
      db,
      [command],
      COMPUTE_TARGET_ID
    );

    expect(kept).toEqual([command]);
  });

  it("treats an omitted resolvedState from a stale client as unresolved", async () => {
    const { db } = fakeDb(["review"]);
    const legacyCommand = buildComponent({
      componentKey: "/review",
      componentKind: AgentComponentKind.Command,
    });

    const kept = await dropSkillShadowedCommands(
      db,
      [legacyCommand],
      COMPUTE_TARGET_ID
    );

    expect(kept).toEqual([]);
  });

  it("never touches a non-command kind or a command with no leading slash", async () => {
    const { db, findMany } = fakeDb(["review"]);
    const skill = buildComponent({
      componentKey: "review",
      componentKind: AgentComponentKind.Skill,
      resolvedState: ComponentResolvedState.Resolved,
    });
    const keylessCommand = buildComponent({
      componentKey: "review",
      componentKind: AgentComponentKind.Command,
      resolvedState: ComponentResolvedState.Unresolved,
    });

    const kept = await dropSkillShadowedCommands(
      db,
      [skill, keylessCommand],
      COMPUTE_TARGET_ID
    );

    expect(kept).toEqual([skill, keylessCommand]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("scopes the stored-skill lookup to the caller's compute target and bare names", async () => {
    const { db, findMany } = fakeDb([]);

    await dropSkillShadowedCommands(db, [phantomCommand], COMPUTE_TARGET_ID);

    expect(findMany).toHaveBeenCalledWith({
      where: {
        computeTargetId: COMPUTE_TARGET_ID,
        componentKind: AgentComponentKind.Skill,
        resolvedState: ComponentResolvedState.Resolved,
        componentKey: { in: ["review"] },
      },
      select: { componentKey: true },
    });
  });
});
