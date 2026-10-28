/**
 * ISS-8193: `loadSkillShadowInventory`'s statement bound.
 *
 * The lookup binds TWO parameters per distinct shadow bare name — one slot in
 * the skill `componentKey: { in: … }` list and one in the command list's
 * `/${name}` — and the `components[]` payload it derives those names from loses
 * its receive-side `.max()` in ISS-8051. Past the ceiling the statement is not
 * slow, it is refused: the session-upsert transaction rolls back and the whole
 * session's usage is lost rather than truncated, and the desktop retries the
 * identical permanently-failing payload.
 *
 * The failure this suite exists to catch on the OTHER side is silent. Slicing a
 * lookup is only safe if every slice's rows are merged back: a loop that drops
 * its last partial slice, or that lets a later slice's higher-`id` duplicate win
 * the skill tie-break, produces a plausible inventory rather than an error — and
 * a wrong inventory rewrites a GENUINE `/deploy` into `skill:deploy`.
 *
 * Both `in` lists are UNIONs over the same names, which is what makes slicing
 * exactly equivalent here; the sibling FEA-2990 branch-bucket prune is an
 * intersective `notIn` and could not be split at all.
 */
import {
  AgentComponentKind,
  ComponentResolvedState,
} from "@repo/api/src/types/agent-component";
import type { TransactionClient } from "@repo/database";
import { describe, expect, it, vi } from "vitest";
import { POSTGRES_MAX_BIND_PARAMETERS } from "@/lib/postgres-bind-parameters";
import {
  isSkillShadowedPhantom,
  loadSkillShadowInventory,
  SKILL_SHADOW_BARE_NAME_CHUNK_SIZE,
} from "./skill-shadow";

const COMPUTE_TARGET_ID = "22222222-2222-4222-8222-222222222222";

/**
 * `resolvedState` is the canonical {@link ComponentResolvedState} union rather
 * than `string` (davetho review), so a fixture that drifts from the contract
 * fails typecheck instead of silently seeding a state the production filter can
 * never match.
 */
type StoredRow = {
  componentKey: string;
  componentKind: string;
  content: string | null;
  externalComponentId: string;
  id: string;
  resolvedState: ComponentResolvedState;
};

type FindManyArgs = {
  where: {
    computeTargetId: string;
    OR: [
      { componentKey: { in: string[] } },
      { componentKey: { in: string[] } },
    ];
  };
};

function skillRow(overrides: Partial<StoredRow> & { componentKey: string }) {
  return {
    componentKind: AgentComponentKind.Skill,
    content: null,
    externalComponentId: `skill:${overrides.componentKey}`,
    id: `id-${overrides.componentKey}`,
    resolvedState: ComponentResolvedState.Resolved,
    ...overrides,
  } satisfies StoredRow;
}

function commandRow(overrides: Partial<StoredRow> & { componentKey: string }) {
  return {
    componentKind: AgentComponentKind.Command,
    content: null,
    externalComponentId: `command:${overrides.componentKey}`,
    id: `id-${overrides.componentKey}`,
    resolvedState: ComponentResolvedState.Unresolved,
    ...overrides,
  } satisfies StoredRow;
}

function matchesSlice(row: StoredRow, args: FindManyArgs): boolean {
  const [skillArm, commandArm] = args.where.OR;
  if (row.componentKind === AgentComponentKind.Command) {
    return commandArm.componentKey.in.includes(row.componentKey);
  }
  return (
    row.resolvedState === ComponentResolvedState.Resolved &&
    skillArm.componentKey.in.includes(row.componentKey)
  );
}

/**
 * A store read per statement rather than captured once, so a test can commit a
 * write BETWEEN slices the way a concurrent component sync does. `onStatement`
 * runs after each slice's rows are filtered, which is the only interleaving
 * point `READ COMMITTED` actually exposes to this loop.
 */
function makeFakeDb(
  rows: readonly StoredRow[],
  onStatement?: (statementIndex: number, store: StoredRow[]) => void
) {
  const store = [...rows];
  const calls: FindManyArgs[] = [];
  let inFlight = 0;
  let peakConcurrent = 0;
  const findMany = vi.fn(async (args: FindManyArgs) => {
    calls.push(args);
    inFlight += 1;
    peakConcurrent = Math.max(peakConcurrent, inFlight);
    await Promise.resolve();
    inFlight -= 1;
    const matched = store.filter((row) => matchesSlice(row, args));
    onStatement?.(calls.length, store);
    return matched;
  });
  return {
    calls,
    db: { agentComponent: { findMany } } as unknown as TransactionClient,
    findMany,
    peakConcurrent: () => peakConcurrent,
  };
}

function namesOfLength(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `shadow-${index}`);
}

/**
 * The bind parameters ONE emitted statement's predicate carries, counted off the
 * `where` the production code actually handed the client rather than recomputed
 * from the input. Prisma additionally appends an `OFFSET` bind to every
 * `findMany`, which the production slice size reserves alongside these; the
 * assertion below is therefore a lower bound on the real cost, which is the safe
 * direction for a ceiling test.
 */
function boundValuesInPredicate(args: FindManyArgs): number {
  const [skillArm, commandArm] = args.where.OR;
  return (
    1 + // computeTargetId
    1 + // skill disjunct's componentKind
    skillArm.componentKey.in.length +
    1 + // skill disjunct's resolvedState
    1 + // command disjunct's componentKind
    commandArm.componentKey.in.length
  );
}

describe("loadSkillShadowInventory statement bound (ISS-8193)", () => {
  // Every other assertion here is expressed RELATIVE to the slice size, so they
  // would all stay green if it were raised past the ceiling — the exact defect
  // this suite exists to prevent. This is the one absolute pin.
  it("keeps a full slice's predicate under the bind-parameter ceiling", async () => {
    const { db, calls } = makeFakeDb([]);

    await loadSkillShadowInventory(
      db,
      COMPUTE_TARGET_ID,
      namesOfLength(SKILL_SHADOW_BARE_NAME_CHUNK_SIZE)
    );

    expect(calls).toHaveLength(1);
    expect(boundValuesInPredicate(calls[0])).toBeLessThan(
      POSTGRES_MAX_BIND_PARAMETERS
    );
  });

  it("stays bind-safe for a name set far past the bind ceiling", async () => {
    const names = namesOfLength(POSTGRES_MAX_BIND_PARAMETERS * 2);
    const { db, calls } = makeFakeDb([]);

    await loadSkillShadowInventory(db, COMPUTE_TARGET_ID, names);

    const widest = Math.max(...calls.map(boundValuesInPredicate));
    expect(widest).toBeLessThan(POSTGRES_MAX_BIND_PARAMETERS);
  });

  it("queries every name exactly once across the slices", async () => {
    const names = namesOfLength(SKILL_SHADOW_BARE_NAME_CHUNK_SIZE * 2 + 1);
    const { db, calls } = makeFakeDb([]);

    await loadSkillShadowInventory(db, COMPUTE_TARGET_ID, names);

    const queried = calls.flatMap((args) => args.where.OR[0].componentKey.in);
    // Pinned by set identity AND by length: a slice loop that re-queries a
    // boundary name still returns the right inventory, so only the length
    // catches it, while a dropped tail is only visible in the set.
    expect(queried).toHaveLength(names.length);
    expect(new Set(queried)).toEqual(new Set(names));
    expect(calls.every((args) => args.where.computeTargetId)).toBe(true);
  });

  it("derives the command slash keys from the same slice as the skill names", async () => {
    const names = namesOfLength(SKILL_SHADOW_BARE_NAME_CHUNK_SIZE * 2 + 1);
    const { db, calls } = makeFakeDb([]);

    await loadSkillShadowInventory(db, COMPUTE_TARGET_ID, names);

    for (const args of calls) {
      const [skillArm, commandArm] = args.where.OR;
      expect(commandArm.componentKey.in).toEqual(
        skillArm.componentKey.in.map((name) => `/${name}`)
      );
    }
  });

  it("merges every slice's rows into one inventory", async () => {
    const names = namesOfLength(SKILL_SHADOW_BARE_NAME_CHUNK_SIZE * 2 + 1);
    const firstSliceName = names[0];
    const lastSliceName = names.at(-1) as string;
    const middleSliceName = names[SKILL_SHADOW_BARE_NAME_CHUNK_SIZE];
    const { db } = makeFakeDb([
      skillRow({ componentKey: firstSliceName }),
      skillRow({ componentKey: middleSliceName }),
      skillRow({ componentKey: lastSliceName }),
      commandRow({
        componentKey: `/${lastSliceName}`,
        resolvedState: ComponentResolvedState.Resolved,
      }),
      commandRow({
        componentKey: `/${middleSliceName}`,
        content: "  # real  ",
      }),
    ]);

    const inventory = await loadSkillShadowInventory(
      db,
      COMPUTE_TARGET_ID,
      names
    );

    expect([...inventory.resolvedSkills.keys()].sort()).toEqual(
      [firstSliceName, middleSliceName, lastSliceName].sort()
    );
    expect(inventory.resolvedCommandKeys).toEqual(
      new Set([`/${lastSliceName}`])
    );
    expect(inventory.definedCommandKeys).toEqual(
      new Set([`/${middleSliceName}`])
    );
    expect(inventory.evidence.vouchedCommandKeys).toEqual(
      new Set([`/${lastSliceName}`, `/${middleSliceName}`])
    );
  });

  it("keeps the lowest-id tie-break for a skill installed at two scopes", async () => {
    const names = namesOfLength(SKILL_SHADOW_BARE_NAME_CHUNK_SIZE + 3);
    const duplicated = names.at(-1) as string;
    const { db } = makeFakeDb([
      skillRow({
        componentKey: duplicated,
        externalComponentId: "skill:high",
        id: "id-b-higher",
      }),
      skillRow({
        componentKey: duplicated,
        externalComponentId: "skill:low",
        id: "id-a-lower",
      }),
    ]);

    const inventory = await loadSkillShadowInventory(
      db,
      COMPUTE_TARGET_ID,
      names
    );

    expect(inventory.resolvedSkills.get(duplicated)).toEqual({
      externalComponentId: "skill:low",
      id: "id-a-lower",
    });
  });

  it("runs the slices sequentially inside the caller's transaction", async () => {
    const names = namesOfLength(SKILL_SHADOW_BARE_NAME_CHUNK_SIZE * 3);
    const { db, calls, peakConcurrent } = makeFakeDb([]);

    await loadSkillShadowInventory(db, COMPUTE_TARGET_ID, names);

    expect(calls.length).toBeGreaterThan(1);
    // Not a pool bound: inside the caller's interactive transaction a fan-out
    // costs ONE connection however wide it is, because every `tx.*` call queues
    // on the pinned connection (`apps/api/AGENTS.md`). Sequential is pinned
    // because the slice count is unbounded, so a fan-out would buy no
    // parallelism while holding every slice's rows at once.
    expect(peakConcurrent()).toBe(1);
  });

  /**
   * davetho review: slicing one read into N awaited reads means each takes its
   * OWN `READ COMMITTED` snapshot, so a component sync committing mid-loop IS
   * visible to later slices. The harm that would follow is a TORN name — one
   * read as "resolved skill present" but "command row absent", which is the
   * exact shape {@link isSkillShadowedPhantom} calls a phantom, so a GENUINE
   * command would be folded onto the skill.
   *
   * A name cannot tear while its skill disjunct and its `/${name}` command
   * disjunct travel in ONE statement, and this is the executable proof. The
   * fixture installs each seeded name as a skill AND a vouching command
   * together, then uninstalls both between slices; rows that only ever exist
   * together must therefore only ever be SEEN together, whichever side of the
   * commit a slice landed on. Reading the two disjuncts as separate statements
   * puts the uninstall between them and fails this.
   */
  it("never tears a name's skill and command evidence across a mid-loop commit", async () => {
    const names = namesOfLength(SKILL_SHADOW_BARE_NAME_CHUNK_SIZE * 2 + 1);
    const seeded = [names[0], names.at(-1) as string];
    const installed = seeded.flatMap((name) => [
      skillRow({ componentKey: name }),
      commandRow({
        componentKey: `/${name}`,
        resolvedState: ComponentResolvedState.Resolved,
      }),
    ]);
    const { db, calls } = makeFakeDb(installed, (statementIndex, store) => {
      // A component sync uninstalls both rows atomically, after the first slice
      // has already read them.
      if (statementIndex === 1) {
        store.length = 0;
      }
    });

    const inventory = await loadSkillShadowInventory(
      db,
      COMPUTE_TARGET_ID,
      names
    );

    expect(calls.length).toBeGreaterThan(1);
    for (const name of seeded) {
      const sawSkill = inventory.evidence.resolvedSkillNames.has(name);
      const sawCommand = inventory.evidence.vouchedCommandKeys.has(`/${name}`);
      expect(sawSkill).toBe(sawCommand);
      expect(isSkillShadowedPhantom(inventory, name, `/${name}`)).toBe(false);
    }
    // Both sides of the commit are actually exercised, so the invariant above is
    // not passing merely because every slice happened to read the same state.
    expect(inventory.evidence.resolvedSkillNames.has(seeded[0])).toBe(true);
    expect(inventory.evidence.resolvedSkillNames.has(seeded[1])).toBe(false);
  });

  it("bounds by DISTINCT names, so repeats cost no extra statement", async () => {
    const distinct = namesOfLength(SKILL_SHADOW_BARE_NAME_CHUNK_SIZE);
    const { db, calls } = makeFakeDb([]);

    await loadSkillShadowInventory(db, COMPUTE_TARGET_ID, [
      ...distinct,
      ...distinct,
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0].where.OR[0].componentKey.in).toHaveLength(distinct.length);
  });

  it("issues no query for an empty name list", async () => {
    const { db, findMany } = makeFakeDb([]);

    const inventory = await loadSkillShadowInventory(db, COMPUTE_TARGET_ID, []);

    expect(findMany).not.toHaveBeenCalled();
    expect(inventory.resolvedSkills.size).toBe(0);
    expect(inventory.evidence.vouchedCommandKeys.size).toBe(0);
  });

  it("propagates a rejecting slice instead of returning a partial inventory", async () => {
    const names = namesOfLength(SKILL_SHADOW_BARE_NAME_CHUNK_SIZE * 2);
    const { db, findMany } = makeFakeDb([]);
    findMany.mockRejectedValueOnce(new Error("statement refused"));

    await expect(
      loadSkillShadowInventory(db, COMPUTE_TARGET_ID, names)
    ).rejects.toThrow("statement refused");
  });
});
