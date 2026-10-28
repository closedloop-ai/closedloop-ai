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
import {
  INDEX_KEY_MAX_BYTES,
  projectIndexKey,
} from "@/lib/index-key-projection";
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

  it("finds a stored skill whose key the index-key budget projected", async () => {
    // ISS-8201. A skill's STORED `componentKey` is the projected key, not the
    // raw wire value, so a lookup built from raw bare names alone misses it and
    // the phantom command it shadows is admitted. Removing the 512-CHARACTER
    // wire cap made this reachable for plain ASCII; the char cap never bounded
    // the multibyte case anyway.
    const longBareName = `review-${"x".repeat(600)}`;
    const storedKey = projectIndexKey(longBareName).value;
    const { db, findMany } = fakeDb([storedKey]);

    const kept = await dropSkillShadowedCommands(
      db,
      [
        buildComponent({
          componentKey: `/${longBareName}`,
          componentKind: AgentComponentKind.Command,
          resolvedState: ComponentResolvedState.Unresolved,
        }),
      ],
      COMPUTE_TARGET_ID
    );

    expect(kept).toEqual([]);
    // Both forms are offered, so the row is reachable whichever one it was
    // written under — a row stored RAW before this repo projected the column
    // still resolves.
    expect(findMany.mock.calls[0][0].where.componentKey.in).toEqual([
      storedKey,
      longBareName,
    ]);
  });
});

/**
 * ISS-8200: the guard reads `componentKey`, which ISS-8069 re-keyed. A skill
 * whose bare name is over the byte budget is STORED under its projected key, so
 * the equality `in` over bare names returned nothing and the guard concluded
 * "no skill shadows this command" — not from evidence, but from a lookup that
 * could not see the row.
 */
const OVER_BUDGET_SKILL_NAME = "x".repeat(INDEX_KEY_MAX_BYTES + 1);

describe("dropSkillShadowedCommands — re-keyed skill names (ISS-8200)", () => {
  it("drops the phantom when the shadowing skill is stored under its PROJECTED key", async () => {
    // The store holds what the write actually put there: the projected key.
    const { db, findMany } = fakeDb([
      projectIndexKey(OVER_BUDGET_SKILL_NAME).value,
    ]);
    const phantom = buildComponent({
      componentKey: `/${OVER_BUDGET_SKILL_NAME}`,
      componentKind: AgentComponentKind.Command,
      resolvedState: ComponentResolvedState.Unresolved,
    });

    const kept = await dropSkillShadowedCommands(
      db,
      [phantom],
      COMPUTE_TARGET_ID
    );

    // Asking only for the bare name leaves the phantom in the payload.
    expect(kept).toEqual([]);
    // The widened lookup must actually ASK for the projected key — otherwise
    // this passes for the wrong reason on a store that returns everything.
    const askedFor = findMany.mock.calls[0][0].where.componentKey.in;
    expect(askedFor).toContain(projectIndexKey(OVER_BUDGET_SKILL_NAME).value);
    expect(askedFor).toContain(OVER_BUDGET_SKILL_NAME);
  });

  it("keeps a genuine command whose over-budget name has no stored skill", async () => {
    // The widening must not become "drop anything long": with no skill row the
    // command is genuine and survives.
    const { db } = fakeDb([]);
    const genuine = buildComponent({
      componentKey: `/${OVER_BUDGET_SKILL_NAME}`,
      componentKind: AgentComponentKind.Command,
      resolvedState: ComponentResolvedState.Unresolved,
    });

    expect(
      await dropSkillShadowedCommands(db, [genuine], COMPUTE_TARGET_ID)
    ).toEqual([genuine]);
  });
});
