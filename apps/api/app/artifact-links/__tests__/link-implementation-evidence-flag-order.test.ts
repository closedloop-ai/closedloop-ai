/**
 * ISS-12552 (PRD-800 "Rollout"): a link write answers
 * `attribution-evidence-policy` before it looks for a branch, so with the flag
 * off it adds no branch read to main's statements. The context PRD create and
 * the Google Drive import both reach this through `createLink` with a PRODUCES
 * link onto a document, outside any transaction, and a session caller arrives
 * with the request's answer unread.
 *
 * The organization gate and PostHog are stubbed; the request scope, the memo
 * and the derive function are the real ones. `withDb` hands every read a fake
 * client whose `artifact.findFirst` is the branch lookup's delegate.
 */
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  flagOn: false,
  gateEvaluations: 0,
  inTransaction: false,
  artifactTypes: new Map<string, string>(),
  artifactFindFirst: [] as { where: { id: string; type: string } }[],
}));

const fakeDb = vi.hoisted(() => ({
  artifact: {
    findFirst: (args: { where: { id: string; type: string } }) => {
      state.artifactFindFirst.push(args);
      return Promise.resolve(
        state.artifactTypes.get(args.where.id) === args.where.type
          ? { id: args.where.id }
          : null
      );
    },
  },
}));

vi.mock("@repo/database", async () => {
  const actual =
    await vi.importActual<typeof import("@repo/database")>("@repo/database");
  return {
    ...actual,
    withDb: Object.assign(
      (run: (db: typeof fakeDb) => unknown) => Promise.resolve(run(fakeDb)),
      {
        tx: () => Promise.reject(new Error("no transaction in this suite")),
        inTransaction: () => state.inTransaction,
      }
    ),
  };
});

vi.mock("@/lib/memoized-feature-flag-gate", () => ({
  createMemoizedOrganizationFeatureFlagGate: () => ({
    resolve: () => {
      state.gateEvaluations += 1;
      return Promise.resolve(state.flagOn);
    },
    clear: () => undefined,
  }),
}));

vi.mock(
  "@/lib/feature-flags/server-feature-flag-evaluation",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolveUnmemoizedFeatureFlagValue: () => Promise.resolve(undefined),
  })
);

import { runWithAttributionEvidenceGate } from "@/lib/attribution-evidence-gate-scope";
import { readAttributionEvidenceForRequest } from "@/lib/attribution-evidence-policy-feature";
import { derivedImplementationBranchId } from "../link-implementation-evidence";

const ORG = "org-1";
const CONTEXT_PRD = "context-prd";
const SOURCE_DOCUMENT = "source-document";
const DOCUMENT_PRODUCER = "producer-document";
const BRANCH = "branch-1";

/** The link the context PRD create and the Drive import both write. */
const CONTEXT_LINK = {
  linkType: LinkType.Produces,
  sourceId: CONTEXT_PRD,
  targetId: SOURCE_DOCUMENT,
};

const BRANCH_LINK = {
  linkType: LinkType.Produces,
  sourceId: DOCUMENT_PRODUCER,
  targetId: BRANCH,
};

describe("derivedImplementationBranchId answers the flag before any branch read (ISS-12552)", () => {
  beforeEach(() => {
    state.flagOn = false;
    state.gateEvaluations = 0;
    state.inTransaction = false;
    state.artifactFindFirst = [];
    state.artifactTypes = new Map([
      [CONTEXT_PRD, ArtifactType.Document],
      [SOURCE_DOCUMENT, ArtifactType.Document],
      [DOCUMENT_PRODUCER, ArtifactType.Document],
      [BRANCH, ArtifactType.Branch],
    ]);
  });

  it("looks up no branch for a session caller's context PRD link with the flag off", async () => {
    const derived = await derivedImplementationBranchId(ORG, CONTEXT_LINK);

    expect(derived).toBeNull();
    expect(state.artifactFindFirst).toEqual([]);
    expect(state.gateEvaluations).toBe(1);
  });

  it("looks up no branch for a Drive import's link inside the route's gate scope with the flag off", async () => {
    const derived = await runWithAttributionEvidenceGate(() =>
      derivedImplementationBranchId(ORG, CONTEXT_LINK)
    );

    expect(derived).toBeNull();
    expect(state.artifactFindFirst).toEqual([]);
  });

  it("looks up no branch even when the target is one, with the flag off", async () => {
    const derived = await derivedImplementationBranchId(ORG, BRANCH_LINK);

    expect(derived).toBeNull();
    expect(state.artifactFindFirst).toEqual([]);
  });

  it("still derives a branch target with the flag on, through the memoized gate outside a transaction", async () => {
    state.flagOn = true;

    const derived = await runWithAttributionEvidenceGate(async () => [
      await derivedImplementationBranchId(ORG, BRANCH_LINK),
      await derivedImplementationBranchId(ORG, BRANCH_LINK),
    ]);

    expect(derived).toEqual([BRANCH, BRANCH]);
    expect(state.gateEvaluations).toBe(1);
    expect(state.artifactFindFirst).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({
          id: BRANCH,
          type: ArtifactType.Branch,
        }),
      }),
      expect.objectContaining({
        where: expect.objectContaining({
          id: BRANCH,
          type: ArtifactType.Branch,
        }),
      }),
    ]);
  });

  it("does not derive a document target with the flag on", async () => {
    state.flagOn = true;

    const derived = await derivedImplementationBranchId(ORG, CONTEXT_LINK);

    expect(derived).toBeNull();
    expect(state.artifactFindFirst).toHaveLength(1);
  });

  it("never evaluates inside a transaction: an unread answer looks nothing up", async () => {
    state.flagOn = true;
    state.inTransaction = true;

    const derived = await runWithAttributionEvidenceGate(() =>
      derivedImplementationBranchId(ORG, BRANCH_LINK)
    );

    expect(derived).toBeNull();
    expect(state.gateEvaluations).toBe(0);
    expect(state.artifactFindFirst).toEqual([]);
  });

  it("derives inside a transaction from an on answer the request read before it opened", async () => {
    state.flagOn = true;

    const derived = await runWithAttributionEvidenceGate(async () => {
      await readAttributionEvidenceForRequest(ORG);
      state.inTransaction = true;
      return await derivedImplementationBranchId(ORG, BRANCH_LINK);
    });

    expect(derived).toBe(BRANCH);
    expect(state.gateEvaluations).toBe(1);
    expect(state.artifactFindFirst).toHaveLength(1);
  });
});
