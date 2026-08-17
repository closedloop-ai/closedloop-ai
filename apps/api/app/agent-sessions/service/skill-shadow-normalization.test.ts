/**
 * ISS-4923 — the exact invocation-generation ingest lane must normalize a
 * skill-shadowed phantom `command` POST-HASH.
 *
 * The load-bearing property is that the generation still ACTIVATES: the
 * `externalGenerationId` content hash is re-derived from the stored rows in
 * `completeGenerationIfReady`, and `componentKind`/`componentKey`/
 * `normalizedName` are all in that preimage. A drop-at-ingest or
 * rewrite-at-ingest guard (the shape the other two ISS-4778 lanes use) would
 * make the re-derivation diverge and reject the generation with
 * `GenerationConflict` forever, because the part ledger is already recorded.
 * These tests drive the REAL service so a future guard added on the wrong side
 * of the hash check fails here.
 */

import {
  AgentComponentKind,
  ComponentResolvedState,
} from "@repo/api/src/types/agent-component";
import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationKind,
  AgentComponentInvocationSyncAckState,
} from "@repo/api/src/types/agent-component-invocation";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: vi.fn(),
  ensureDefinitionVersion: vi.fn(),
  recordDefinitionSourceOccurrence: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  });
  const withDb = Object.assign(vi.fn(), { tx: mocks.tx });
  return {
    Prisma: { sql },
    SourceAccessState: { accessible: "accessible" },
    SourceOccurrenceType: {
      local: "local",
      repository: "repository",
      pack: "pack",
    },
    withDb,
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError },
}));

vi.mock("@/app/definition-registry/service", () => ({
  ensureDefinitionVersion: mocks.ensureDefinitionVersion,
  recordDefinitionSourceOccurrence: mocks.recordDefinitionSourceOccurrence,
}));

import {
  buildItem,
  buildPart,
  COMPUTE_TARGET_ID,
  installStatefulDb as installStatefulDbStore,
  ORGANIZATION_ID,
  resolutionUpdatesFrom,
} from "@/__tests__/support/agent-sessions/service/component-invocations.test-db";
import { agentComponentInvocationsService } from "./component-invocations";

const SKILL_COMPONENT_ID = "44444444-4444-4444-8444-444444444444";
const COMMAND_COMPONENT_ID = "55555555-5555-4555-8555-555555555555";

/** The RESOLVED `review` skill a `/review` slash invocation shadows. */
const reviewSkillComponent = {
  id: SKILL_COMPONENT_ID,
  componentKind: AgentComponentKind.Skill,
  componentKey: "review",
  externalComponentId: "external-skill-review",
  resolvedState: ComponentResolvedState.Resolved,
  content: null,
};

/** A GENUINE `.claude/commands/deploy.md` command that resolved. */
const deployCommandComponent = {
  id: COMMAND_COMPONENT_ID,
  componentKind: AgentComponentKind.Command,
  componentKey: "/deploy",
  externalComponentId: "external-command-deploy",
  resolvedState: ComponentResolvedState.Resolved,
  content: "---\nname: deploy\n---\nShip it.",
};

/**
 * ISS-4923 (wongk review): the SAME genuine `/deploy` command, synced with its
 * definition text but NOT yet promoted to `resolved`. This is the row the old
 * `resolvedCommandKeys`-only predicate could not see.
 */
const unresolvedDeployCommandWithContent = {
  id: COMMAND_COMPONENT_ID,
  componentKind: AgentComponentKind.Command,
  componentKey: "/deploy",
  externalComponentId: "external-command-deploy",
  resolvedState: ComponentResolvedState.Unresolved,
  content: "---\nname: deploy\n---\nShip it.",
};

/**
 * The PHANTOM shape: a slash-keyed command with NO definition text and no
 * resolution — the row a slash-invoked skill mints.
 */
const unresolvedDeployCommandWithoutContent = {
  id: COMMAND_COMPONENT_ID,
  componentKind: AgentComponentKind.Command,
  componentKey: "/deploy",
  externalComponentId: "external-command-deploy",
  resolvedState: ComponentResolvedState.Unresolved,
  content: null,
};

const deploySkillComponent = {
  id: "66666666-6666-4666-8666-666666666666",
  componentKind: AgentComponentKind.Skill,
  componentKey: "deploy",
  externalComponentId: "external-skill-deploy",
  resolvedState: ComponentResolvedState.Resolved,
  content: null,
};

function installStatefulDb(
  input?: Parameters<typeof installStatefulDbStore>[1]
) {
  return installStatefulDbStore(mocks.tx, input);
}

function ingest(part: ReturnType<typeof buildPart>) {
  return agentComponentInvocationsService.ingestPart({
    organizationId: ORGANIZATION_ID,
    computeTargetId: COMPUTE_TARGET_ID,
    part,
  });
}

/** A slash-keyed `command` invocation — the phantom shape a skill produces. */
function slashCommandItem(
  overrides: Parameters<typeof buildItem>[0] = {}
): ReturnType<typeof buildItem> {
  return buildItem({
    kind: AgentComponentInvocationKind.Command,
    componentKey: "/review",
    normalizedName: "/review",
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensureDefinitionVersion.mockResolvedValue("definition-version-1");
  mocks.recordDefinitionSourceOccurrence.mockResolvedValue(
    "source-occurrence-1"
  );
});

describe("ISS-4923 — skill-shadowed phantom command invocations", () => {
  it("activates the generation and re-points the phantom onto the resolved skill", async () => {
    const phantom = slashCommandItem();
    const { db } = installStatefulDb({ components: [reviewSkillComponent] });

    const result = await ingest(buildPart({ allItems: [phantom] }));

    // The hash check ran against the UNMODIFIED staged rows, so the generation
    // activates. A drop/rewrite-at-ingest guard would fail this with
    // `GenerationConflict` and no retry could ever recover it.
    expect(result).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(resolutionUpdatesFrom(db.$executeRaw)).toEqual([
      expect.objectContaining({
        agentComponentId: SKILL_COMPONENT_ID,
        componentKey: "review",
        componentKind: AgentComponentKind.Skill,
        normalizedName: "review",
      }),
    ]);
  });

  it("leaves a genuine command untouched when a RESOLVED command owns the slash key", async () => {
    const genuine = slashCommandItem({
      componentKey: "/deploy",
      normalizedName: "/deploy",
    });
    // A `deploy` skill sits on the SAME target — the carve-out that matters:
    // the resolved `/deploy` command proves the slash key is genuine.
    const { db } = installStatefulDb({
      components: [deployCommandComponent, deploySkillComponent],
    });

    const result = await ingest(buildPart({ allItems: [genuine] }));

    expect(result.ok).toBe(true);
    const [update] = resolutionUpdatesFrom(db.$executeRaw);
    expect(update.componentKind).toBeUndefined();
    expect(update.componentKey).toBeUndefined();
    expect(update.normalizedName).toBeUndefined();
    expect(update.agentComponentId).toBe(COMMAND_COMPONENT_ID);
  });

  it("leaves a genuine command untouched when its inventory row carries definition text but has not resolved yet", async () => {
    // ISS-4923 (wongk review): exact command evidence must exclude the row
    // BEFORE the skill-inventory fallback. Without `definedCommandKeys` this row
    // is invisible to the lane, the invocation is rewritten to `skill:deploy`,
    // and the kind-scoped hash check then returns `GenerationConflict` on every
    // retry until the desktop dead-letters the generation.
    const genuine = slashCommandItem({
      componentKey: "/deploy",
      normalizedName: "/deploy",
    });
    const { db } = installStatefulDb({
      components: [unresolvedDeployCommandWithContent, deploySkillComponent],
    });

    const result = await ingest(buildPart({ allItems: [genuine] }));

    expect(result.ok).toBe(true);
    const [update] = resolutionUpdatesFrom(db.$executeRaw);
    expect(update.componentKind).toBeUndefined();
    expect(update.componentKey).toBeUndefined();
    expect(update.normalizedName).toBeUndefined();
  });

  it("still normalizes when the unresolved command row carries NO definition text", async () => {
    // The other side of the same widening: `definedCommandKeys` keys off real
    // definition text, so a content-less unresolved row — the phantom a
    // slash-invoked skill mints — is still folded onto the skill.
    const phantom = slashCommandItem({
      componentKey: "/deploy",
      normalizedName: "/deploy",
    });
    const { db } = installStatefulDb({
      components: [unresolvedDeployCommandWithoutContent, deploySkillComponent],
    });

    const result = await ingest(buildPart({ allItems: [phantom] }));

    expect(result.ok).toBe(true);
    const [update] = resolutionUpdatesFrom(db.$executeRaw);
    expect(update.componentKind).toBe(AgentComponentKind.Skill);
    expect(update.componentKey).toBe("deploy");
  });

  // ISS-5260 (wongk review): the ORDERING the inventory cannot cover. A genuine
  // `/deploy` generation can reach the cloud BEFORE its command inventory row
  // syncs, so nothing in `vouchedCommandKeys` protects it — but the invocation
  // carries its own definition, which is the same "this command is genuine"
  // fact. Only the `deploy` SKILL is in the inventory here, so the inventory
  // arms alone would fold it; the row-level gate is the whole assertion.
  it("leaves a genuine command untouched when the invocation carries its own definition CONTENT and no command row exists yet", async () => {
    const genuine = slashCommandItem({
      componentKey: "/deploy",
      definitionContent: "---\nname: deploy\n---\nShip it.",
      definitionFormat: "markdown",
      normalizedName: "/deploy",
    });
    const { db } = installStatefulDb({ components: [deploySkillComponent] });

    const result = await ingest(buildPart({ allItems: [genuine] }));

    // Without the gate this rewrites to `skill:deploy`, and
    // `resolveDefinitionVersion` then hashes the carried content under the SKILL
    // kind — the generation is rejected with `GenerationConflict` permanently,
    // because `partLedgerMatches` short-circuits every retry into the same call.
    expect(result.ok).toBe(true);
    const [update] = resolutionUpdatesFrom(db.$executeRaw);
    expect(update.componentKind).toBeUndefined();
    expect(update.componentKey).toBeUndefined();
    expect(update.normalizedName).toBeUndefined();
  });

  // The same ordering via the other row-level signal: a stored-row replay that
  // carries a prior `definitionHash` but no content.
  it("leaves a genuine command untouched when the invocation carries only a definition HASH", async () => {
    const genuine = slashCommandItem({
      componentKey: "/deploy",
      definitionHash: "a".repeat(64),
      normalizedName: "/deploy",
    });
    const { db } = installStatefulDb({ components: [deploySkillComponent] });

    const result = await ingest(buildPart({ allItems: [genuine] }));

    expect(result.ok).toBe(true);
    const [update] = resolutionUpdatesFrom(db.$executeRaw);
    expect(update.componentKind).toBeUndefined();
    expect(update.componentKey).toBeUndefined();
  });

  it("leaves a slash command untouched when no skill shadows it", async () => {
    const genuine = slashCommandItem({
      componentKey: "/deploy",
      normalizedName: "/deploy",
    });
    const { db } = installStatefulDb({ components: [] });

    const result = await ingest(buildPart({ allItems: [genuine] }));

    expect(result.ok).toBe(true);
    const [update] = resolutionUpdatesFrom(db.$executeRaw);
    expect(update.componentKind).toBeUndefined();
    expect(update.componentKey).toBeUndefined();
    expect(update.agentComponentId).toBeNull();
  });

  it("preserves a normalized name the producer already resolved past the slash key", async () => {
    // Mirrors the backfill migration's `CASE WHEN normalized_name = phantom_key`
    // guard: only a normalized name that IS the slash key is rewritten.
    const phantom = slashCommandItem({ normalizedName: "namespace:review" });
    const { db } = installStatefulDb({ components: [reviewSkillComponent] });

    const result = await ingest(buildPart({ allItems: [phantom] }));

    expect(result.ok).toBe(true);
    const [update] = resolutionUpdatesFrom(db.$executeRaw);
    expect(update.componentKind).toBe(AgentComponentKind.Skill);
    expect(update.componentKey).toBe("review");
    expect(update.normalizedName).toBeUndefined();
  });

  it("does not touch a non-shadowed sibling in the same generation", async () => {
    const phantom = slashCommandItem({
      externalInvocationId: "invocation-phantom",
      sequence: 0,
    });
    const realSkill = buildItem({
      externalInvocationId: "invocation-skill",
      kind: AgentComponentInvocationKind.Skill,
      componentKey: "review",
      normalizedName: "review",
      sequence: 1,
    });
    const { db } = installStatefulDb({ components: [reviewSkillComponent] });

    const result = await ingest(buildPart({ allItems: [phantom, realSkill] }));

    expect(result.ok).toBe(true);
    const updates = resolutionUpdatesFrom(db.$executeRaw);
    expect(updates).toHaveLength(2);
    // Only the phantom carries identity columns; the real skill omits them so
    // the UPDATE's COALESCE leaves its stored identity untouched.
    const carrying = updates.filter(
      (update: { componentKind?: string }) => update.componentKind !== undefined
    );
    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toEqual(
      expect.objectContaining({
        agentComponentId: SKILL_COMPONENT_ID,
        componentKey: "review",
        componentKind: AgentComponentKind.Skill,
      })
    );
  });

  it("normalizes a multipart generation only once every part has landed", async () => {
    const phantom = slashCommandItem({
      externalInvocationId: "invocation-phantom",
      sequence: 0,
    });
    const second = buildItem({
      externalInvocationId: "invocation-skill",
      kind: AgentComponentInvocationKind.Skill,
      componentKey: "review",
      normalizedName: "review",
      sequence: 1,
    });
    const allItems = [phantom, second];
    const { db } = installStatefulDb({ components: [reviewSkillComponent] });

    const staged = await ingest(
      buildPart({ allItems, items: [phantom], partIndex: 0, partCount: 2 })
    );
    expect(staged).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Staged },
    });
    // Nothing is rewritten while the generation is still staged — the hash has
    // not been checked yet, exactly like the migration's `completed_at IS NOT
    // NULL` exclusion.
    expect(resolutionUpdatesFrom(db.$executeRaw)).toEqual([]);

    const activated = await ingest(
      buildPart({ allItems, items: [second], partIndex: 1, partCount: 2 })
    );

    expect(activated).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    const rewritten = resolutionUpdatesFrom(db.$executeRaw).filter(
      (update: { componentKind?: string }) => update.componentKind !== undefined
    );
    expect(rewritten).toEqual([
      expect.objectContaining({
        agentComponentId: SKILL_COMPONENT_ID,
        attributionStatus: expect.any(String),
        componentKey: "review",
        componentKind: AgentComponentKind.Skill,
      }),
    ]);
  });

  it("degrades to a NULL component link when the skill is installed at more than one scope", async () => {
    // The migration's "an ambiguous install scope stays NULL" rule: the identity
    // repair still happens (`/review` WAS the skill `review`), but no install is
    // fabricated. NULL is the same degraded-but-valid state the resolver already
    // produces, and the next sync re-resolves it.
    const phantom = slashCommandItem();
    const { db } = installStatefulDb({
      components: [
        reviewSkillComponent,
        { ...reviewSkillComponent, id: "77777777-7777-4777-8777-777777777777" },
      ],
    });

    const result = await ingest(buildPart({ allItems: [phantom] }));

    expect(result.ok).toBe(true);
    expect(resolutionUpdatesFrom(db.$executeRaw)).toEqual([
      expect.objectContaining({
        agentComponentId: null,
        // The resolver's own honest ambiguity state — nothing is fabricated.
        attributionStatus: AgentComponentInvocationAttributionStatus.Ambiguous,
        componentKey: "review",
        componentKind: AgentComponentKind.Skill,
      }),
    ]);
  });
});
