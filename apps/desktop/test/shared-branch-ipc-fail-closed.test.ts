import assert from "node:assert/strict";
import { encodeBranchId } from "@repo/api/src/types/branch";
import {
  BRANCH_LIST_SERVER_PAGE_SIZE,
  BranchListPageMode,
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract.js";
import { afterAll, afterEach, beforeAll, test } from "vitest";
import { ZodError } from "zod";
import type { WithDb } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import type { registerSharedSessionAndBranchIpcHandlers as RegisterSharedSessionAndBranchIpcHandlers } from "../src/main/dashboard/agent-dashboard-shared-read-ipc.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import {
  LOCAL_BRANCH_READ,
  SHARED_BRANCHES_IPC_CHANNELS,
  SHARED_BRANCHES_SOURCE_ERROR_CODE,
} from "../src/shared/shared-branches-contract.js";
import { seeder, withAcDb } from "./branch-reads-ac-test-helpers.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

const options: AgentDashboardDesignSystemRuntimeOptions = {
  getWindow: () => null,
  isTrustedSender: () => true,
  onTerminalFailure: () => undefined,
  setAgentMonitorRuntimeStatus: () => undefined,
};

let electronMock: ElectronModuleMock;
let registerSharedHandlers: typeof RegisterSharedSessionAndBranchIpcHandlers;

beforeAll(async () => {
  electronMock = registerElectronModuleMock();
  const module = await import(
    "../src/main/dashboard/agent-dashboard-shared-read-ipc.js"
  );
  registerSharedHandlers = module.registerSharedSessionAndBranchIpcHandlers;
});

afterEach(() => {
  resetElectronModuleStub();
});

afterAll(() => {
  electronMock.deregister();
});

test("ISS-5828: production Branch IPC answers every read without a repository-default authority", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    await seed.session("session-ipc-fail-closed");
    for (const branch of ["main", "feature/eligible"]) {
      const artifactId = await seed.branch({ branch, repo: "acme/web" });
      await seed.link({
        session: "session-ipc-fail-closed",
        artifactId,
        method: "git_push",
      });
    }
    // Commit-only, so a row that is decisively NOT a Branch is in the corpus.
    // GitHub is not what decides publication, so this one stays excluded even
    // for a guest, and it is what keeps the assertions below non-vacuous.
    const commitOnlyArtifactId = await seed.branch({
      branch: "feature/commit-only",
      repo: "acme/web",
    });
    await seed.link({
      session: "session-ipc-fail-closed",
      artifactId: commitOnlyArtifactId,
      method: "git_commit",
    });

    registerSharedHandlers({
      withDb: makeWithDb(db),
      options,
      invokeStoreOp: async () =>
        assert.fail("store op must remain unreachable"),
      cancelDbHostRead: () => assert.fail("cancel must remain unreachable"),
    });

    const defaultId = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "main",
    });

    // ISS-10864: Desktop holds no repository-default authority, which removes
    // the default-branch enrichment, not the branch corpus, so the LIST-shaped
    // channels answer instead of blanking a screen that holds branches.
    //
    // Both halves are asserted over the SAME channel set, so neither can pass
    // by naming a channel that no longer exists.
    const resolvingCalls = [
      [SHARED_BRANCHES_IPC_CHANNELS.list, {}],
      [SHARED_BRANCHES_IPC_CHANNELS.pageData, {}],
      [SHARED_BRANCHES_IPC_CHANNELS.analytics, {}],
      [SHARED_BRANCHES_IPC_CHANNELS.detail, defaultId],
    ] as const;
    for (const [channel, input] of resolvingCalls) {
      await assert.doesNotReject(
        invoke(channel, input),
        `${channel} must answer a guest rather than fail closed`
      );
    }

    // …and the corpus is really there, not an empty success. Both seeded
    // branches are published, and `main` is among them precisely BECAUSE no
    // authority exists to call it a repository default.
    const list = await invoke(SHARED_BRANCHES_IPC_CHANNELS.list, {});
    assert.deepEqual(
      readArray(list, "items")
        .map((item) => readString(item, "branchName"))
        .sort(),
      ["feature/eligible", "main"]
    );

    // The fail-closed arm that SURVIVES, and it is the one that publishes a
    // cohort NUMBER: token and cost totals over a corpus that can still contain
    // a repository default would be inflated by an unknown amount.
    await assert.rejects(
      invoke(SHARED_BRANCHES_IPC_CHANNELS.usage, {}),
      isBranchSourceError,
      `${SHARED_BRANCHES_IPC_CHANNELS.usage} must refuse a cohort total when eligibility authority is unavailable`
    );

    // The trace follows the same corpus: `main` is a row a guest can open, so
    // its linked session travels with it. The publication-excluded row is the
    // negative on the SAME channel, so this pair cannot pass by returning an
    // empty trace for everything.
    const defaultTrace = await invoke(
      SHARED_BRANCHES_IPC_CHANNELS.trace,
      defaultId
    );
    assert.equal(readArray(defaultTrace, "sessions").length, 1);
    const commitOnlyId = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "feature/commit-only",
    });
    assert.equal(
      await invoke(SHARED_BRANCHES_IPC_CHANNELS.detail, commitOnlyId),
      null
    );
    const commitOnlyTrace = await invoke(
      SHARED_BRANCHES_IPC_CHANNELS.trace,
      commitOnlyId
    );
    assert.deepEqual(readArray(commitOnlyTrace, "sessions"), []);
  }));

test("hinted local Branch reads admit only published rows", () =>
  withAcDb(async (db) => {
    const seed = seeder(db);
    await seed.session("session-local-branch");
    const publishedArtifactId = await seed.branch({
      branch: "feature/published",
      repo: "acme/web",
    });
    const commitOnlyArtifactId = await seed.branch({
      branch: "feature/commit-only",
      repo: "acme/web",
    });
    await seed.link({
      session: "session-local-branch",
      artifactId: publishedArtifactId,
      method: "git_push",
    });
    await seed.link({
      session: "session-local-branch",
      artifactId: commitOnlyArtifactId,
      method: "git_commit",
    });
    registerSharedHandlers({
      withDb: makeWithDb(db),
      options,
      invokeStoreOp: async () =>
        assert.fail("store op must remain unreachable"),
      cancelDbHostRead: () => assert.fail("cancel must remain unreachable"),
    });

    const publishedId = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "feature/published",
    });
    const commitOnlyId = encodeBranchId({
      repoFullName: "acme/web",
      branchName: "feature/commit-only",
    });
    const list = await invoke(
      SHARED_BRANCHES_IPC_CHANNELS.list,
      LOCAL_BRANCH_READ
    );
    assert.deepEqual(
      readArray(list, "items").map((item) => readString(item, "branchName")),
      ["feature/published"]
    );
    await assert.rejects(
      invoke(SHARED_BRANCHES_IPC_CHANNELS.usage, LOCAL_BRANCH_READ),
      isBranchSourceError
    );
    const cohort = await invoke(SHARED_BRANCHES_IPC_CHANNELS.cohortAnalytics, {
      branchIds: [publishedId, commitOnlyId],
      ...LOCAL_BRANCH_READ,
    });
    assert.deepEqual(readArray(cohort, "matchedBranchIds"), [publishedId]);

    await assert.rejects(
      invoke(SHARED_BRANCHES_IPC_CHANNELS.cohortAnalytics, {
        branchIds: [publishedId],
        ...LOCAL_BRANCH_READ,
        unknownFilter: true,
      }),
      ZodError
    );
    await assert.rejects(
      invoke(SHARED_BRANCHES_IPC_CHANNELS.cohortAnalytics, {
        branchIds: [publishedId],
        skipCloudHydration: "yes",
      }),
      ZodError
    );
  }));

test("strict server-page schema errors cross every Branch read channel unchanged", () =>
  withAcDb(async (db) => {
    let sourceReadCalls = 0;
    const sourceRead = () => {
      sourceReadCalls += 1;
      throw new Error("Branch source must remain unreachable");
    };
    const guardedDb = guardBranchSource(db, sourceRead);
    let invokeStoreOpCalls = 0;
    const invokeStoreOp = () => {
      invokeStoreOpCalls += 1;
      return Promise.reject(
        new Error("branches.listSnapshot must remain unreachable")
      );
    };

    registerSharedHandlers({
      withDb: makeWithDb(guardedDb),
      options,
      invokeStoreOp,
      cancelDbHostRead: () => assert.fail("cancel must remain unreachable"),
    });

    const request = {
      pageMode: BranchListPageMode.Server,
      limit: BRANCH_LIST_SERVER_PAGE_SIZE,
      offset: 0,
      sortKey: BranchListSortKey.LastActivity,
      sortDir: BranchListSortDirection.Desc,
      // The server-page schema is intentionally strict. This is the exact
      // version-skewed field that must remain a raw Zod refusal at the channel.
      unknownFilter: ["x"],
    };
    for (const channel of [
      SHARED_BRANCHES_IPC_CHANNELS.list,
      SHARED_BRANCHES_IPC_CHANNELS.usage,
      SHARED_BRANCHES_IPC_CHANNELS.analytics,
      SHARED_BRANCHES_IPC_CHANNELS.pageData,
    ]) {
      await assert.rejects(
        invoke(channel, request),
        (error) => error instanceof ZodError,
        `${channel} must preserve the raw schema rejection`
      );
    }

    assert.equal(
      sourceReadCalls,
      0,
      "schema refusal must happen before any Branch source read"
    );
    assert.equal(
      invokeStoreOpCalls,
      0,
      "pageData must not dispatch branches.listSnapshot after schema refusal"
    );
  }));

function makeWithDb(agentDatabase: DbHostAgentDatabase): WithDb {
  return (handler) =>
    async (_event, ...args) =>
      await handler(agentDatabase, ...args);
}

function guardBranchSource(
  db: DbHostAgentDatabase,
  onRead: () => never
): DbHostAgentDatabase {
  const guarded = Object.create(db) as DbHostAgentDatabase;
  const guardedPrisma = new Proxy(db.prisma, {
    get: onRead,
  });
  const guardedSyncSource = new Proxy(db.syncSource, {
    get: onRead,
  });
  Object.defineProperties(guarded, {
    prisma: { value: guardedPrisma },
    readBranchCanonicalActivityRows: { value: onRead },
    readBranchMetricEventEvidence: { value: onRead },
    syncSource: { value: guardedSyncSource },
  });
  return guarded;
}

async function invoke(channel: string, value: unknown): Promise<unknown> {
  return await registeredInvokeHandler(channel)({ sender: null }, value);
}

function isBranchSourceError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === SHARED_BRANCHES_SOURCE_ERROR_CODE
  );
}

function readString(value: unknown, key: string): string {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`Expected object containing ${key}`);
  }
  const result = Reflect.get(value, key);
  if (typeof result !== "string") {
    throw new TypeError(`Expected string at ${key}`);
  }
  return result;
}

function readArray(value: unknown, key: string): unknown[] {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`Expected object containing ${key}`);
  }
  const result = Reflect.get(value, key);
  if (!Array.isArray(result)) {
    throw new TypeError(`Expected array at ${key}`);
  }
  return result;
}
