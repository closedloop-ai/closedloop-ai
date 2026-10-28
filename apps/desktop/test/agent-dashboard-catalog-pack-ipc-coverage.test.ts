/**
 * @file agent-dashboard-catalog-pack-ipc-coverage.test.ts
 * @description ISS-10514: the argument guards of the catalog, installed-pack,
 * plan, and pull-request channels, driven through the production registration
 * pass (`registerDesignSystemDbIpcHandlers`) over a real migrated SQLite store.
 *
 * The only faked boundaries are Electron (`shell` records what it would open)
 * and the db-host `invokeStoreOp` hop, which records the op name and args it was
 * asked to dispatch.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { registerDesignSystemDbIpcHandlers } from "../src/main/dashboard/agent-dashboard-db-ipc-registration.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { upsertCatalogSeed } from "../src/main/packs/catalog-store.js";
import { PackStoreReadOp } from "../src/main/packs/pack-store.js";
import { makeCapture, upsertPlan } from "../src/main/plans/plan-store.js";
import { StreamRunErrorCode } from "../src/shared/install-run-contract.js";
import {
  openedExternalUrls,
  openedPaths,
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

vi.mock("electron", async () => {
  const stub = await import("./helpers/electron-module-stub.js");
  return { ...stub, default: stub.default };
});

type Db = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;
type StoreOpCall = { name: string; args: unknown[] | undefined };

const TRUSTED_EVENT = { sender: {} };
const PACK_ID = "iss-10514-pack";
const PR_ALLOWED_ID = "pr-allowed";
const PR_DISALLOWED_ID = "pr-disallowed";
const PR_ALLOWED_URL = "https://github.com/acme/web/pull/7";
const REFUSED_PLAN_PATH_RE = /Refused to open plan path outside allowed roots/;

let dir: string;
let db: Db;
let claudeHome: string;
let outsideDir: string;
const originalClaudeHome = process.env.CLAUDE_HOME;
const originalHome = process.env.HOME;
const NUMERIC_PACK_ID = 10_514;
// The SQLite adapter binds a JS number as REAL, whose TEXT form is "10514.0",
// so this row is what an unguarded numeric id would reach.
const NUMERIC_PACK_ROW_ID = "10514.0";
const SCOPED_INSTALL_PACK_ID = "iss-10514-scoped-install";
const SCOPED_UNINSTALL_PACK_ID = "iss-10514-scoped-uninstall";
const MISSING_CWD = "/iss-10514-no-such-directory";

let storeOpCalls: StoreOpCall[];
let storeOpResult: unknown;
let logLines: string[];

beforeAll(async () => {
  // Canonical, because `open-plan` realpaths a path before opening it and the
  // assertions below compare against these fixture paths: on macOS
  // `os.tmpdir()` is `/var/folders/...`, a symlink to `/private/var/folders/...`,
  // so the lexical form never equals what the handler reports.
  dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "iss-10514-catalog-pack-"))
  );
  claudeHome = path.join(dir, "claude-home");
  outsideDir = path.join(dir, "outside");
  mkdirSync(path.join(claudeHome, "plans"), { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.sqlite"),
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });
  await upsertCatalogSeed(db.prisma, {
    seed_version: 1,
    packs: [
      {
        pack_id: PACK_ID,
        display_name: "ISS-10514 Pack",
        github_url: "https://github.com/acme/pack",
      },
    ],
  });
  for (const [id, url] of [
    [PR_ALLOWED_ID, PR_ALLOWED_URL],
    [PR_DISALLOWED_ID, "javascript:alert(1)"],
  ]) {
    await db.prisma.write((client) =>
      client.$executeRawUnsafe(
        `INSERT INTO artifacts (id, identity_key, kind, url, created_at, last_seen_at)
       VALUES ($1, $2, 'pull_request', $3, $4, $4)`,
        id,
        `ik-${id}`,
        url,
        "2026-06-07T00:00:00.000Z"
      )
    );
  }
});

afterAll(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  process.env.CLAUDE_HOME = claudeHome;
  storeOpCalls = [];
  storeOpResult = undefined;
  logLines = [];
  registerDesignSystemDbIpcHandlers(
    () => Promise.resolve(db),
    buildOptions(),
    (name, args) => {
      storeOpCalls.push({ name, args });
      return Promise.resolve(storeOpResult);
    },
    () => undefined
  );
});

afterEach(() => {
  resetElectronModuleStub();
  if (originalClaudeHome === undefined) {
    Reflect.deleteProperty(process.env, "CLAUDE_HOME");
  } else {
    process.env.CLAUDE_HOME = originalClaudeHome;
  }
  if (originalHome === undefined) {
    Reflect.deleteProperty(process.env, "HOME");
  } else {
    process.env.HOME = originalHome;
  }
});

function buildOptions(): AgentDashboardDesignSystemRuntimeOptions {
  return {
    getWindow: () => null,
    isTrustedSender: () => true,
    onTerminalFailure: () => undefined,
    setAgentMonitorRuntimeStatus: () => undefined,
    log: (_scope, message) => {
      logLines.push(message);
    },
  };
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return Promise.resolve(
    registeredInvokeHandler(channel)(TRUSTED_EVENT, ...args)
  );
}

async function seedPlan(
  sessionId: string,
  filePath: string | null,
  sourceLogPath: string | null
): Promise<string> {
  await upsertPlan(
    db.prisma,
    makeCapture({
      harness: "claude",
      source: "file",
      captureMethod: "file",
      sessionId,
      content: `# Plan for ${sessionId}`,
      filePath,
      sourceLogPath,
      confidence: 1,
    })
  );
  const row = await db.prisma.client.plan.findFirst({
    where: { createdFromSessionId: sessionId },
    select: { id: true },
  });
  if (!row) {
    throw new Error(`plan for ${sessionId} was not persisted`);
  }
  return row.id;
}

describe("catalog channels", () => {
  it("entry and history reject a non-string pack id", async () => {
    expect(await invoke("desktop:db:get-catalog-entry", 1)).toBeNull();
    expect(await invoke("desktop:db:get-catalog-history", 1)).toEqual([]);

    const entry = (await invoke("desktop:db:get-catalog-entry", PACK_ID)) as {
      packId: string;
    };
    expect(entry.packId).toBe(PACK_ID);
    expect(await invoke("desktop:db:get-catalog-history", PACK_ID)).toEqual([]);
  });

  it("contents refresh runs only for a known pack and passes through only an array", async () => {
    expect(await invoke("desktop:db:get-catalog-contents", 1)).toBeNull();
    expect(
      await invoke("desktop:db:get-catalog-contents", "missing")
    ).toBeNull();
    expect(storeOpCalls).toEqual([]);

    storeOpResult = [{ name: "skill-a" }];
    expect(await invoke("desktop:db:get-catalog-contents", PACK_ID)).toEqual([
      { name: "skill-a" },
    ]);
    expect(storeOpCalls.map((call) => call.name)).toEqual([
      "catalog.contents.refresh",
    ]);
    expect(storeOpCalls[0].args?.[0]).toMatchObject({ packId: PACK_ID });

    storeOpResult = null;
    expect(await invoke("desktop:db:get-catalog-contents", PACK_ID)).toBeNull();
  });

  it("install and uninstall refuse non-string arguments without starting a run", async () => {
    for (const channel of [
      "desktop:db:catalog-install",
      "desktop:db:catalog-uninstall",
    ]) {
      expect(await invoke(channel, 1, "claude")).toEqual({ started: false });
      expect(await invoke(channel, PACK_ID, 1)).toEqual({ started: false });
    }
  });

  it("install and uninstall for an unknown pack report not_found, with or without a cwd", async () => {
    for (const channel of [
      "desktop:db:catalog-install",
      "desktop:db:catalog-uninstall",
    ]) {
      for (const cwd of ["/tmp", 42]) {
        const result = (await invoke(channel, "missing", "claude", cwd)) as {
          started: boolean;
          error: { code: string };
        };
        expect(result.started).toBe(false);
        expect(result.error.code).toBe(StreamRunErrorCode.NotFound);
      }
    }
  });

  it("install runs filter by pack only for a string pack id", async () => {
    await db.prisma.write((client) =>
      client.packInstallRun.create({
        data: {
          packId: PACK_ID,
          harness: "claude",
          action: "install",
          command: "echo",
          startedAt: "2026-06-07T00:00:00.000Z",
        },
      })
    );
    const filtered = (await invoke(
      "desktop:db:get-install-runs",
      "other-pack"
    )) as unknown[];
    expect(filtered).toEqual([]);
    const unfiltered = (await invoke(
      "desktop:db:get-install-runs",
      7
    )) as unknown[];
    expect(unfiltered).toHaveLength(1);
  });
});

describe("installed-pack channels", () => {
  it("pack detail, sessions, and invocations reject non-string ids without a store op", async () => {
    expect(await invoke("desktop:db:get-pack-detail", 1)).toBeNull();
    expect(await invoke("desktop:db:get-pack-sessions", 1)).toEqual([]);
    expect(await invoke("desktop:db:get-skill-invocations", 1)).toEqual([]);
    expect(storeOpCalls).toEqual([]);
  });

  it("pack detail reads an installed pack from the store", async () => {
    await db.prisma.write((client) =>
      client.agentPack.create({
        data: {
          packId: PACK_ID,
          harness: "claude",
          installPath: "/packs/iss-10514",
        },
      })
    );
    const detail = (await invoke("desktop:db:get-pack-detail", PACK_ID)) as {
      packId: string;
    };
    expect(detail.packId).toBe(PACK_ID);
    expect(storeOpCalls).toEqual([]);
  });

  it("valid session and skill ids dispatch the matching pack-store read op", async () => {
    storeOpResult = [];
    await invoke("desktop:db:get-pack-sessions", PACK_ID);
    await invoke("desktop:db:get-skill-invocations", "skill-a");
    expect(storeOpCalls).toEqual([
      { name: PackStoreReadOp.ListPackSessions, args: [PACK_ID] },
      { name: PackStoreReadOp.ListSkillInvocations, args: ["skill-a"] },
    ]);
  });
});

describe("plan channels", () => {
  it("plan list forwards only well-typed filters", async () => {
    const planId = await seedPlan("plan-list-session", null, null);

    const scoped = (await invoke("desktop:db:get-plans-list", {
      sessionId: "plan-list-session",
      needsConfirmation: false,
    })) as { id: string }[];
    expect(scoped.map((plan) => plan.id)).toEqual([planId]);

    const needsConfirmation = (await invoke("desktop:db:get-plans-list", {
      sessionId: "plan-list-session",
      needsConfirmation: true,
    })) as unknown[];
    expect(needsConfirmation).toEqual([]);

    const malformedFilters = (await invoke("desktop:db:get-plans-list", {
      sessionId: 7,
      needsConfirmation: "yes",
    })) as { id: string }[];
    expect(malformedFilters.map((plan) => plan.id)).toContain(planId);

    const noOpts = (await invoke("desktop:db:get-plans-list")) as {
      id: string;
    }[];
    expect(noOpts.map((plan) => plan.id)).toContain(planId);
  });

  it("plan, versions, confirm, and reject guard a non-string id", async () => {
    const planId = await seedPlan("plan-guard-session", null, null);

    expect(await invoke("desktop:db:get-plan", 1)).toBeNull();
    expect(await invoke("desktop:db:get-plan-versions", 1)).toEqual([]);
    expect(await invoke("desktop:db:confirm-plan", 1)).toBeUndefined();
    expect(await invoke("desktop:db:reject-plan", 1)).toBeUndefined();
    expect(storeOpCalls).toEqual([]);

    expect(
      ((await invoke("desktop:db:get-plan", planId)) as { id: string }).id
    ).toBe(planId);
    expect(
      (await invoke("desktop:db:get-plan-versions", planId)) as unknown[]
    ).toHaveLength(1);
    await invoke("desktop:db:confirm-plan", planId);
    await invoke("desktop:db:reject-plan", planId);
    expect(storeOpCalls).toEqual([
      { name: "plans.confirm", args: [planId] },
      { name: "plans.reject", args: [planId] },
    ]);
  });

  it("open-plan opens the file or log path inside an allowed root", async () => {
    const planFile = path.join(claudeHome, "plans", "open-me.md");
    const logFile = path.join(claudeHome, "plans", "open-me.log");
    writeFileSync(planFile, "# plan");
    writeFileSync(logFile, "log");
    const planId = await seedPlan("plan-open-session", planFile, logFile);

    await invoke("desktop:db:open-plan", planId);
    await invoke("desktop:db:open-plan", planId, "log");

    expect(openedPaths()).toEqual([planFile, logFile]);
    expect(logLines).toEqual([]);
  });

  it("open-plan refuses and logs a path outside the allowed roots", async () => {
    const outside = path.join(outsideDir, "elsewhere.md");
    writeFileSync(outside, "# plan");
    const planId = await seedPlan("plan-outside-session", outside, null);

    await invoke("desktop:db:open-plan", planId);

    expect(openedPaths()).toEqual([]);
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toMatch(REFUSED_PLAN_PATH_RE);
  });

  it("open-plan does nothing for a bad id, a missing plan, or a null path", async () => {
    const planId = await seedPlan("plan-null-path-session", null, null);

    await invoke("desktop:db:open-plan", 1);
    await invoke("desktop:db:open-plan", "no-such-plan");
    await invoke("desktop:db:open-plan", planId);
    await invoke("desktop:db:open-plan", planId, "log");

    expect(openedPaths()).toEqual([]);
    expect(logLines).toEqual([]);
  });
});

describe("pull-request channels", () => {
  it("pr list forwards only string filters", async () => {
    const all = (await invoke("desktop:db:get-pr-list")) as { id: string }[];
    expect(all.map((pr) => pr.id).sort()).toEqual(
      [PR_ALLOWED_ID, PR_DISALLOWED_ID].sort()
    );

    const malformed = (await invoke("desktop:db:get-pr-list", {
      sessionId: 1,
      repo: 2,
    })) as unknown[];
    expect(malformed).toHaveLength(2);

    const byRepo = (await invoke("desktop:db:get-pr-list", {
      repo: "acme/none",
    })) as unknown[];
    expect(byRepo).toEqual([]);

    const bySession = (await invoke("desktop:db:get-pr-list", {
      sessionId: "no-such-session",
    })) as unknown[];
    expect(bySession).toEqual([]);

    const nullOpts = (await invoke(
      "desktop:db:get-pr-list",
      null
    )) as unknown[];
    expect(nullOpts).toHaveLength(2);

    const nonObject = (await invoke(
      "desktop:db:get-pr-list",
      "opts"
    )) as unknown[];
    expect(nonObject).toHaveLength(2);
  });

  it("open-pr opens only an allowlisted URL of a known PR", async () => {
    await invoke("desktop:db:open-pr", 1);
    await invoke("desktop:db:open-pr", "no-such-pr");
    await invoke("desktop:db:open-pr", PR_DISALLOWED_ID);
    expect(openedExternalUrls()).toEqual([]);

    await invoke("desktop:db:open-pr", PR_ALLOWED_ID);
    expect(openedExternalUrls()).toEqual([PR_ALLOWED_URL]);
  });
});

describe("guards whose rejected input would otherwise reach a real row", () => {
  beforeAll(async () => {
    await upsertCatalogSeed(db.prisma, {
      seed_version: 1,
      packs: [
        {
          pack_id: NUMERIC_PACK_ROW_ID,
          display_name: "Numeric-id pack",
          github_url: "https://github.com/acme/numeric",
        },
        {
          pack_id: SCOPED_INSTALL_PACK_ID,
          display_name: "Scoped install pack",
          github_url: "https://github.com/acme/scoped-install",
          project_scoped: true,
          install_commands: { claude: "true" },
        },
        {
          pack_id: SCOPED_UNINSTALL_PACK_ID,
          display_name: "Scoped uninstall pack",
          github_url: "https://github.com/acme/scoped-uninstall",
          project_scoped: true,
          uninstall_commands: { claude: "true" },
        },
      ],
    });
    await db.prisma.write(async (client) => {
      await client.packCatalogHistory.createMany({
        data: [
          {
            packId: NUMERIC_PACK_ROW_ID,
            fetchedAt: new Date().toISOString(),
            stars: 3,
            forks: 1,
          },
        ],
      });
    });
  });

  it("a numeric pack id matches a row at the SQL layer, and the string guard still answers null", async () => {
    const rows = await db.prisma.client.$queryRawUnsafe<{ pack_id: string }[]>(
      "SELECT pack_id FROM pack_catalog WHERE pack_id = $1",
      NUMERIC_PACK_ID
    );
    expect(rows.map((row) => row.pack_id)).toEqual([NUMERIC_PACK_ROW_ID]);

    expect(
      await invoke("desktop:db:get-catalog-entry", NUMERIC_PACK_ID)
    ).toBeNull();
    expect(
      await invoke("desktop:db:get-catalog-contents", NUMERIC_PACK_ID)
    ).toBeNull();
    expect(storeOpCalls).toEqual([]);

    expect(
      await invoke("desktop:db:get-catalog-entry", NUMERIC_PACK_ROW_ID)
    ).toMatchObject({ packId: NUMERIC_PACK_ROW_ID });
  });

  it("catalog history returns stored rows for a string id and [] for a numeric one", async () => {
    expect(
      await invoke("desktop:db:get-catalog-history", NUMERIC_PACK_ROW_ID)
    ).toEqual([{ fetchedAt: expect.any(String), stars: 3, forks: 1 }]);
    expect(
      await invoke("desktop:db:get-catalog-history", NUMERIC_PACK_ID)
    ).toEqual([]);
  });

  it("install names its action in the no-command reply", async () => {
    const result = (await invoke(
      "desktop:db:catalog-install",
      SCOPED_INSTALL_PACK_ID,
      "codex",
      MISSING_CWD
    )) as { started: boolean; error: { code: string; message: string } };
    expect(result).toEqual({
      started: false,
      error: {
        code: StreamRunErrorCode.NoCommand,
        message: `no install command for harness 'codex' on pack '${SCOPED_INSTALL_PACK_ID}'`,
      },
    });
  });

  it("install forwards a string cwd, which a missing directory rejects before any spawn", async () => {
    const withCwd = (await invoke(
      "desktop:db:catalog-install",
      SCOPED_INSTALL_PACK_ID,
      "claude",
      MISSING_CWD
    )) as { started: boolean; error: { code: string } };
    expect(withCwd.started).toBe(false);
    expect(withCwd.error.code).toBe(StreamRunErrorCode.BadCwd);

    const withoutCwd = (await invoke(
      "desktop:db:catalog-install",
      SCOPED_INSTALL_PACK_ID,
      "claude",
      42
    )) as { started: boolean; error: { code: string } };
    expect(withoutCwd.started).toBe(false);
    expect(withoutCwd.error.code).toBe(StreamRunErrorCode.CwdRequired);
  });

  it("uninstall resolves the uninstall command map and forwards a string cwd", async () => {
    const withCwd = (await invoke(
      "desktop:db:catalog-uninstall",
      SCOPED_UNINSTALL_PACK_ID,
      "claude",
      MISSING_CWD
    )) as { started: boolean; error: { code: string } };
    expect(withCwd.started).toBe(false);
    expect(withCwd.error.code).toBe(StreamRunErrorCode.BadCwd);

    const withoutCwd = (await invoke(
      "desktop:db:catalog-uninstall",
      SCOPED_UNINSTALL_PACK_ID,
      "claude"
    )) as { started: boolean; error: { code: string } };
    expect(withoutCwd.error.code).toBe(StreamRunErrorCode.CwdRequired);

    const installOnlyPack = (await invoke(
      "desktop:db:catalog-uninstall",
      SCOPED_INSTALL_PACK_ID,
      "claude",
      MISSING_CWD
    )) as { started: boolean; error: { code: string } };
    expect(installOnlyPack.error.code).toBe(StreamRunErrorCode.NoCommand);
  });

  it("installed-pack and all-skills reads return the store op result", async () => {
    const sentinel = [{ name: "sentinel-row" }];
    storeOpResult = sentinel;
    expect(await invoke("desktop:db:get-all-skills")).toEqual(sentinel);
    expect(await invoke("desktop:db:get-installed-packs")).toEqual(sentinel);
    expect(storeOpCalls).toEqual([
      { name: PackStoreReadOp.ListSkills, args: undefined },
      { name: PackStoreReadOp.ListPacks, args: undefined },
    ]);
  });

  it("plan list honors a session filter among several plans and accepts null opts", async () => {
    const first = await seedPlan("plan-filter-a", null, null);
    const second = await seedPlan("plan-filter-b", null, null);

    const scoped = (await invoke("desktop:db:get-plans-list", {
      sessionId: "plan-filter-a",
    })) as { id: string }[];
    expect(scoped.map((plan) => plan.id)).toEqual([first]);

    const nullOpts = (await invoke("desktop:db:get-plans-list", null)) as {
      id: string;
    }[];
    expect(nullOpts.map((plan) => plan.id)).toEqual(
      expect.arrayContaining([first, second])
    );
  });

  it("open-plan skips a stored path that stringifies to 'undefined'", async () => {
    const planId = await seedPlan("plan-undefined-path", "undefined", null);

    await invoke("desktop:db:open-plan", planId);

    expect(openedPaths()).toEqual([]);
    expect(logLines).toEqual([]);
  });

  it("open-plan accepts a file under the app home's .claude and refuses one beside it", async () => {
    const appHome = path.join(dir, "app-home");
    mkdirSync(path.join(appHome, ".claude", "plans"), { recursive: true });
    process.env.HOME = appHome;
    const inside = path.join(appHome, ".claude", "plans", "home-plan.md");
    const beside = path.join(appHome, "beside.md");
    writeFileSync(inside, "# plan");
    writeFileSync(beside, "# plan");
    const insideId = await seedPlan("plan-app-home-inside", inside, null);
    const besideId = await seedPlan("plan-app-home-beside", beside, null);

    await invoke("desktop:db:open-plan", insideId);
    await invoke("desktop:db:open-plan", besideId);

    expect(openedPaths()).toEqual([inside]);
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toMatch(REFUSED_PLAN_PATH_RE);
  });
});
