/**
 * @file shared-agent-sessions-request-validation.test.ts
 * @description ISS-9428 — the Zod validation of the `desktop:shared-agent-sessions:*`
 * request, and the PRODUCTION WIRING proving it is what the real channels run.
 *
 * The unit half pins the three properties the schema module calls load-bearing:
 * an unknown key is STRIPPED rather than rejected, a malformed modelled field
 * degrades to absent rather than throwing, and a malformed ARRAY entry degrades
 * only itself rather than taking its whole facet with it. The wiring half pins
 * that the real channel runs THIS schema: each wiring case dies under the same
 * schema mutation as its unit twin — `z.object` → `z.strictObject` kills the
 * unknown-key cases, `sorts` tidied into `.catch(undefined)` kills the refusal
 * case, and `optionalStringArray` reverted to a whole-array
 * `z.array(z.string())` kills the mixed-array cases — so the properties are
 * proven where the renderer actually reaches them, not only on the coercer in
 * isolation.
 *
 * Every one of the four read channels is exercised through the registrar, not
 * just the thinnest one. The four do NOT share a coercer — `usage` takes
 * `coerceSharedAgentSessionsQuery` and `list`/`analytics`/`pageData` take
 * `coerceSharedAgentSessionsListRequest` — so a bypass or a swapped coercer on
 * one channel is a defect no other channel's case can see.
 *
 * What NO case here pins, deliberately: removing the coercion at the registrar
 * and handing `sanitizeQuery` the raw payload leaves all twelve green. That is
 * not a gap, it is the thesis — the swap is semantics-preserving at the channel.
 * An unknown key is ignored downstream either way, `limit: "50"` floors to the
 * default under `clampLimit` either way, `Object.hasOwn(request, "ids")`
 * survives both, and `coerceStringArray`/`sanitizeIds` drop a bad entry either
 * way. The coercion's value is that the payload stops being `unknown` wearing a
 * type before it reaches that code, which is a property of the SHAPE and is why
 * the mutations above are the ones worth killing.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranscriptDisposition } from "@repo/api/src/types/transcript-disposition-constants";
import { TranscriptSkipReason } from "@repo/api/src/types/transcript-skip-reason-constants";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { CLAUDE_DESKTOP_SESSIONS_HOME_ENV } from "../src/main/collectors/claude/claude-desktop-origin.js";
import {
  coerceSharedAgentSessionsListRequest,
  coerceSharedAgentSessionsQuery,
} from "../src/main/dashboard/agent-dashboard-ipc-coercion.js";
import type { WithDb } from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import type { DbHostAgentDatabase } from "../src/main/database/sqlite.js";
import { SharedAgentSessionsInputError } from "../src/main/session/shared-agent-sessions-query.js";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../src/shared/session-date-window-contract.js";
import {
  SHARED_AGENT_SESSIONS_IPC_CHANNELS,
  type SharedAgentSessionDetail,
} from "../src/shared/shared-agent-sessions-contract.js";
import { TranscriptSyncStatus } from "../src/shared/transcript-sync-status-contract.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";
import {
  createFakeSource,
  session as sessionFixture,
} from "./shared-agent-sessions-test-helpers.js";

/** The refusal `parseSortRules` raises for a non-array `sorts`. */
const NOT_A_LIST_PATTERN = /sorts is not a list/;

const STUB_OPTIONS = {
  getWindow: () => null,
  isTrustedSender: () => true,
  onTerminalFailure: () => undefined,
} as unknown as AgentDashboardDesignSystemRuntimeOptions;

const TRUSTED_EVENT = { sender: {} };

describe("shared agent sessions request validation", () => {
  it("keeps modelled fields and strips an unknown newer key", () => {
    const query = coerceSharedAgentSessionsQuery({
      search: "deploy",
      userIds: ["user-alex"],
      quality: "substantive",
      // A newer `apps/app` bundle sends these through the browser bridge; this
      // contract does not model them.
      viewerScope: "org",
      projectIds: ["project-1"],
    });

    assert.equal(query.search, "deploy");
    assert.deepEqual(query.userIds, ["user-alex"]);
    assert.equal(query.quality, "substantive");
    assert.equal(Object.hasOwn(query, "viewerScope"), false);
    assert.equal(Object.hasOwn(query, "projectIds"), false);
  });

  it("degrades a malformed modelled field to absent without throwing", () => {
    const query = coerceSharedAgentSessionsQuery({
      search: "deploy",
      limit: "50",
      quality: "bogus",
      statuses: "active",
    });

    // The neighbouring good field survives: a bad value degrades ITSELF, it does
    // not sink the payload the way a rejecting schema would.
    assert.equal(query.search, "deploy");
    assert.equal(query.limit, undefined);
    assert.equal(query.quality, undefined);
    assert.equal(query.statuses, undefined);
  });

  it("falls back to an empty request for a non-object payload", () => {
    assert.deepEqual(coerceSharedAgentSessionsListRequest("nope"), {});
    assert.deepEqual(coerceSharedAgentSessionsListRequest(null), {});
    assert.deepEqual(coerceSharedAgentSessionsListRequest(undefined), {});
  });

  it("preserves the three-way `ids` distinction", () => {
    // `explicitIdsFromRequest` discriminates on `Object.hasOwn`, so absent and
    // present-but-malformed mean DIFFERENT things: no id narrowing versus narrow
    // to nothing. A `.default([])` on this field would collapse the first into
    // the second and silently empty every unfiltered list.
    assert.equal(
      Object.hasOwn(coerceSharedAgentSessionsListRequest({}), "ids"),
      false
    );

    const malformed = coerceSharedAgentSessionsListRequest({
      ids: "session-1",
    });
    assert.equal(Object.hasOwn(malformed, "ids"), true);
    assert.equal(malformed.ids, undefined);

    assert.deepEqual(
      coerceSharedAgentSessionsListRequest({ ids: ["session-1"] }).ids,
      ["session-1"]
    );
  });

  it("keeps the valid entries of a mixed array instead of dropping the facet", () => {
    // Rejecting the array whole would be the DANGEROUS direction on both of
    // these fields, and in opposite ways: a lost `userIds` widens the read to
    // every owner (`resolveUserScope` applies no `in` constraint for an empty
    // facet), while a lost `ids` becomes an explicit EMPTY selection, because
    // `explicitIdsFromRequest` reads a present-but-`undefined` `ids` as "narrow
    // to nothing". `coerceStringArray`/`sanitizeIds` fold per entry downstream,
    // so the boundary must too.
    const request = coerceSharedAgentSessionsListRequest({
      userIds: ["user-alex", 7],
      ids: ["session-1", 7],
      statuses: ["active", null, "completed"],
    });

    assert.deepEqual(request.userIds, ["user-alex"]);
    assert.deepEqual(request.ids, ["session-1"]);
    assert.deepEqual(request.statuses, ["active", "completed"]);
  });

  it("keeps an all-invalid array present and empty rather than absent", () => {
    // The `ids` three-way distinction again, at its narrowest: every entry is
    // junk, so the caller selected nothing selectable. That must stay an
    // explicit empty selection (key present, empty array → `sanitizeIds` → no
    // rows), never a dropped key, which would widen it into "no id narrowing".
    const request = coerceSharedAgentSessionsListRequest({ ids: [7, null] });

    assert.equal(Object.hasOwn(request, "ids"), true);
    assert.deepEqual(request.ids, []);
  });

  it("passes `sorts` through untouched rather than validating it", () => {
    // `parseSortRules` owns this field by REFUSING what it cannot read, so the
    // boundary must hand it the value exactly as it arrived — including the
    // malformed shapes whose refusal is the point.
    assert.equal(
      Object.hasOwn(coerceSharedAgentSessionsQuery({}), "sorts"),
      false
    );
    assert.equal(
      coerceSharedAgentSessionsQuery({ sorts: "nope" }).sorts,
      "nope"
    );
    assert.deepEqual(
      coerceSharedAgentSessionsQuery({ sorts: ["startedAt:desc"] }).sorts,
      ["startedAt:desc"]
    );
  });
});

describe("shared agent sessions request validation wiring", () => {
  let mock: ElectronModuleMock;
  let registerSharedSessionAndBranchIpcHandlers: (deps: {
    withDb: WithDb;
    options: AgentDashboardDesignSystemRuntimeOptions;
  }) => void;

  beforeAll(async () => {
    mock = registerElectronModuleMock();
    // Dynamic, because the redirect must be installed before the registrar
    // evaluates its module-scope `import { ipcMain } from "electron"`.
    const shared = await import(
      "../src/main/dashboard/agent-dashboard-shared-read-ipc.js"
    );
    registerSharedSessionAndBranchIpcHandlers =
      shared.registerSharedSessionAndBranchIpcHandlers as typeof registerSharedSessionAndBranchIpcHandlers;
  });

  afterAll(() => {
    mock.deregister();
  });

  afterEach(() => {
    resetElectronModuleStub();
  });

  /**
   * The REAL registrar over a recording source. One call registers all four
   * read channels, so each case below drives the channel it names through the
   * same production wiring the renderer reaches.
   */
  function registerSessionsChannels(
    sourceOptions: Parameters<typeof createFakeSource>[0] = {},
    wiring: {
      agentDatabase?: Record<string, unknown>;
      options?: Partial<AgentDashboardDesignSystemRuntimeOptions>;
    } = {}
  ) {
    const source = createFakeSource(sourceOptions);
    const agentDatabase = {
      syncSource: source,
      ...wiring.agentDatabase,
    } as unknown as DbHostAgentDatabase;
    const withDb: WithDb =
      (handler) =>
      (_event, ...args) =>
        Promise.resolve(handler(agentDatabase, ...args));
    registerSharedSessionAndBranchIpcHandlers({
      withDb,
      options: { ...STUB_OPTIONS, ...wiring.options },
    });
    return source;
  }

  /**
   * The analytics channel over a recording source. The thinnest of the four — a
   * plain `withDb`, no org-directory warm-up and no options builder — so what
   * its assertions observe is the request coercion and nothing else.
   */
  function registerAnalyticsChannel() {
    return registerSessionsChannels({
      aggregateAnalytics: () => ({
        byTool: [],
        byAgentType: [],
        byRepository: [],
      }),
    });
  }

  /**
   * The DISTINCT session ids `loadSyncedSessions` was asked to hydrate. Distinct
   * because a single read hydrates in more than one pass (and `pageData` runs a
   * list and a usage read), so the claim these cases make is WHICH sessions the
   * request reached, never how many passes reached them.
   */
  function hydratedIds(source: ReturnType<typeof createFakeSource>) {
    return [
      ...new Set(
        source.calls
          .filter((call) => call.kind === "loadSyncedSessions")
          .flatMap((call) => call.ids ?? [])
      ),
    ].sort();
  }

  it("applies a real filter arriving beside an unknown newer key", async () => {
    const source = registerAnalyticsChannel();

    await registeredInvokeHandler(SHARED_AGENT_SESSIONS_IPC_CHANNELS.analytics)(
      TRUSTED_EVENT,
      { userIds: ["user-alex"], viewerScope: "org", projectIds: ["project-1"] }
    );

    // The compatibility path, end to end: a version-skewed peer's extra fields
    // are dropped and the owner scope still reaches the SQL aggregate. Under a
    // `.strict()` schema the whole payload would fail to parse, the coercer would
    // return `{}`, and `userIds` would be missing from these filters.
    assert.deepEqual(source.calls[0]?.aggregateFilters, {
      dateWindowField: SESSIONS_SURFACE_DATE_WINDOW_FIELD,
      userIds: ["user-alex"],
    });
  });

  it("still refuses an unreadable `sorts` through the real channel", async () => {
    registerAnalyticsChannel();

    // The refusal path, end to end. If `sorts` were "tidied" into
    // `.catch(undefined)` like its neighbours, this resolves instead of
    // rejecting: the unreadable rule becomes "no rules" and the read is served in
    // default order while the caller believes its sort was applied.
    await assert.rejects(
      async () => {
        await registeredInvokeHandler(
          SHARED_AGENT_SESSIONS_IPC_CHANNELS.analytics
        )(TRUSTED_EVENT, { sorts: "nope" });
      },
      (error: unknown) =>
        error instanceof SharedAgentSessionsInputError &&
        NOT_A_LIST_PATTERN.test(error.message)
    );
  });

  it("keeps an explicit `ids` request off the aggregate fast path", async () => {
    const source = registerAnalyticsChannel();

    await registeredInvokeHandler(SHARED_AGENT_SESSIONS_IPC_CHANNELS.analytics)(
      TRUSTED_EVENT,
      { ids: ["session-1"], userIds: ["user-alex"] }
    );

    // `canUseAggregateSessionFilters` reads `Object.hasOwn(request, "ids")`, so
    // the key's PRESENCE must survive the schema. A `.default([])` would leave it
    // present but meaningless; dropping it would route an id-scoped read onto the
    // aggregate, which cannot narrow by id.
    assert.equal(
      source.calls.some((call) => call.kind === "aggregateAnalytics"),
      false
    );
  });

  it("narrows the LIST channel to a mixed `ids` array's valid entries", async () => {
    const source = registerSessionsChannels();

    await registeredInvokeHandler(SHARED_AGENT_SESSIONS_IPC_CHANNELS.list)(
      TRUSTED_EVENT,
      { ids: ["session-a", 7], viewerScope: "org" }
    );

    // The list channel takes `coerceSharedAgentSessionsListRequest`, and this is
    // the shape both mutations reach differently: under `z.strictObject` the
    // whole payload fails, the coercer returns `{}`, and the read hydrates the
    // entire corpus; under a whole-array `z.array(z.string())` the `ids` key
    // survives holding `undefined`, which `explicitIdsFromRequest` reads as
    // "narrow to nothing" and hydrates NOTHING.
    assert.deepEqual(hydratedIds(source), ["session-a"]);
  });

  it("narrows the PAGE-DATA channel to a mixed `ids` array's valid entries", async () => {
    // `SessionsView` reads through THIS channel, not the standalone list one, so
    // a coercer swapped or dropped here is invisible to every other case.
    const source = registerSessionsChannels();

    await registeredInvokeHandler(SHARED_AGENT_SESSIONS_IPC_CHANNELS.pageData)(
      TRUSTED_EVENT,
      { ids: ["session-a", 7], viewerScope: "org" }
    );

    assert.deepEqual(hydratedIds(source), ["session-a"]);
  });

  it("keeps the USAGE channel's owner scope from a mixed `userIds` array", async () => {
    // The usage channel is the one that takes the OTHER coercer
    // (`coerceSharedAgentSessionsQuery`, which models no `ids`), so it is the
    // channel no `ids` case can speak for. Dropping the facet here would widen
    // the summary cards to every owner's sessions under a scoped label.
    const source = registerSessionsChannels({
      aggregateUsage: () => ({
        totalSessions: 0,
        earliestSessionAt: null,
        latestSessionAt: null,
        tokenGroups: [],
        harnessSessionCounts: [],
        userSessionCounts: [],
        repoSessionCounts: [],
      }),
    });

    await registeredInvokeHandler(SHARED_AGENT_SESSIONS_IPC_CHANNELS.usage)(
      TRUSTED_EVENT,
      { userIds: ["user-alex", 7], viewerScope: "org" }
    );

    assert.deepEqual(
      source.calls.find((call) => call.kind === "aggregateUsage")
        ?.aggregateFilters,
      {
        dateWindowField: SESSIONS_SURFACE_DATE_WINDOW_FIELD,
        userIds: ["user-alex"],
      }
    );
  });

  it("feeds the DETAIL channel the list's transcript verdict inputs", async () => {
    // ISS-9884: the detail's Sync row folds its verdict PAIR from the same
    // blob-state lookup the list uses. The detail read's own test passes those
    // inputs by hand, so only this case goes red if the registrar stops
    // supplying them. The channel also runs transcript discovery, so every
    // collector root is pointed at an empty directory for the call.
    const emptyRoot = mkdtempSync(join(tmpdir(), "iss-9884-detail-wiring-"));
    const restoreEnv = pointCollectorRootsAt(emptyRoot);
    const requested: string[][] = [];
    try {
      registerSessionsChannels(
        { sessions: { "session-a": sessionFixture({ id: "session-a" }) } },
        {
          agentDatabase: {
            transcriptSync: {
              listMainBlobStates: (ids: string[]) => {
                requested.push(ids);
                return Promise.resolve([
                  {
                    externalSessionId: "session-a",
                    status: TranscriptSyncStatus.Dead,
                    syncedByteOffset: 0,
                    syncedComputeTargetId: null,
                    cloudUploadedAt: null,
                    cloudUploadedComputeTargetId: null,
                    terminalSkipReason:
                      TranscriptSkipReason.EnvironmentUnavailable,
                  },
                ]);
              },
            },
          },
          options: {
            getComputeTargetId: () => "target-123",
            userDataPath: emptyRoot,
          },
        }
      );

      const detail = (await registeredInvokeHandler(
        SHARED_AGENT_SESSIONS_IPC_CHANNELS.detail
      )(TRUSTED_EVENT, "session-a")) as SharedAgentSessionDetail | null;

      assert.deepEqual(requested, [["session-a"]]);
      assert.equal(
        detail?.transcriptDisposition,
        TranscriptDisposition.FailedTransient
      );
      assert.equal(
        detail?.transcriptDispositionReason,
        TranscriptSkipReason.EnvironmentUnavailable
      );
    } finally {
      restoreEnv();
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Every environment variable a transcript collector resolves its root from,
 * plus the HOME each one falls back to. Discovery reads them at call time.
 */
const COLLECTOR_ROOT_ENV_KEYS = [
  "HOME",
  "APPDATA",
  "XDG_CONFIG_HOME",
  "CLAUDE_HOME",
  CLAUDE_DESKTOP_SESSIONS_HOME_ENV,
  "CODEX_HOME",
  "COPILOT_HOME",
  "COPILOT_VSCODE_STORAGE_DIR",
  "CURSOR_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_DATA_DIR",
] as const;

/** Points every collector root at `root`; the returned thunk restores each key exactly. */
function pointCollectorRootsAt(root: string): () => void {
  const saved = COLLECTOR_ROOT_ENV_KEYS.map(
    (key) => [key, process.env[key]] as const
  );
  for (const key of COLLECTOR_ROOT_ENV_KEYS) {
    process.env[key] = root;
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  };
}
