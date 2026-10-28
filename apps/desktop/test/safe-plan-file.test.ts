import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, test } from "vitest";
import type {
  WithDb,
  WithPrisma,
} from "../src/main/dashboard/agent-dashboard-ipc-handler-wrappers.js";
import type { AgentDashboardDesignSystemRuntimeOptions } from "../src/main/dashboard/agent-dashboard-runtime-options.js";
import { resolveOpenablePlanFilePath } from "../src/main/plans/safe-plan-file.js";
import {
  type ElectronModuleMock,
  registerElectronModuleMock,
} from "./helpers/electron-module-mock.js";
import {
  openedPaths,
  registeredInvokeHandler,
  resetElectronModuleStub,
} from "./helpers/electron-module-stub.js";

// OPEN_PATH_UNVALIDATED guardrail. `desktop:db:open-plan` hands a store-derived
// path to `shell.openPath`, which delegates to the OS file association — so a
// `.command`/`.app`/script row would be executed. resolveOpenablePlanFilePath
// must only return paths that are real files inside the agent homes
// (~/.claude, ~/.cursor) carrying a non-executable, allowlisted extension.
describe("resolveOpenablePlanFilePath", () => {
  let claudeHome: string;
  let cursorHome: string;
  let outsideDir: string;
  let prevClaudeHome: string | undefined;
  let prevCursorHome: string | undefined;

  beforeAll(() => {
    const root = mkdtempSync(path.join(tmpdir(), "safe-plan-file-"));
    claudeHome = path.join(root, ".claude");
    cursorHome = path.join(root, ".cursor");
    outsideDir = path.join(root, "outside");
    mkdirSync(path.join(claudeHome, "plans"), { recursive: true });
    mkdirSync(path.join(cursorHome, "projects"), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    prevClaudeHome = process.env.CLAUDE_HOME;
    prevCursorHome = process.env.CURSOR_HOME;
    process.env.CLAUDE_HOME = claudeHome;
    process.env.CURSOR_HOME = cursorHome;
  });

  afterAll(() => {
    if (prevClaudeHome === undefined) {
      delete process.env.CLAUDE_HOME;
    } else {
      process.env.CLAUDE_HOME = prevClaudeHome;
    }
    if (prevCursorHome === undefined) {
      delete process.env.CURSOR_HOME;
    } else {
      process.env.CURSOR_HOME = prevCursorHome;
    }
  });

  test("accepts a markdown plan inside the Claude home", () => {
    const fp = path.join(claudeHome, "plans", "my-plan.md");
    writeFileSync(fp, "# plan");
    assert.equal(resolveOpenablePlanFilePath(fp), realpathSync(fp));
  });

  test("accepts a jsonl transcript inside the Cursor home", () => {
    const fp = path.join(cursorHome, "projects", "session.jsonl");
    writeFileSync(fp, "{}");
    assert.equal(resolveOpenablePlanFilePath(fp), realpathSync(fp));
  });

  test("rejects an executable extension even inside an allowed root", () => {
    const fp = path.join(claudeHome, "plans", "evil.command");
    writeFileSync(fp, "#!/bin/sh\nopen -a Calculator\n");
    assert.equal(resolveOpenablePlanFilePath(fp), null);
  });

  test("rejects a path outside the allowed roots", () => {
    const fp = path.join(outsideDir, "loot.md");
    writeFileSync(fp, "# nope");
    assert.equal(resolveOpenablePlanFilePath(fp), null);
  });

  test("rejects a traversal escape out of an allowed root", () => {
    const fp = path.join(claudeHome, "plans", "..", "..", "outside", "loot.md");
    assert.equal(resolveOpenablePlanFilePath(fp), null);
  });

  test("accepts a file under a caller-supplied extra root", () => {
    const fp = path.join(outsideDir, "extra.md");
    writeFileSync(fp, "# extra");
    assert.equal(resolveOpenablePlanFilePath(fp), null);
    assert.equal(
      resolveOpenablePlanFilePath(fp, [outsideDir]),
      realpathSync(fp)
    );
  });

  test("rejects a non-existent file", () => {
    assert.equal(
      resolveOpenablePlanFilePath(path.join(claudeHome, "plans", "ghost.md")),
      null
    );
  });
});

// ---------------------------------------------------------------------------
// ISS-8143 — the HANDLER's decision, not just the resolver's.
//
// Every case above exercises `resolveOpenablePlanFilePath` in isolation. None
// reached `desktop:db:open-plan`, so deleting the resolver call and handing the
// raw store row straight to `shell.openPath` left this whole file green — while
// the header above says that path would *execute* a `.command`/`.app`/script
// the row points at. These cases drive the REAL registrar through the recording
// Electron stub and assert on whether `shell.openPath` was called at all.
// ---------------------------------------------------------------------------

describe("desktop:db:open-plan only opens a resolver-approved path", () => {
  const OPEN_PLAN_CHANNEL = "desktop:db:open-plan";
  const TRUSTED_EVENT = { sender: {} };
  const PLAN_ID = "plan-1";

  let root: string;
  let claudeHome: string;
  let outsideDir: string;
  let prevClaudeHome: string | undefined;
  let mock: ElectronModuleMock;
  let registerCatalogAndPackIpcHandlers: (deps: {
    withDb: WithDb;
    withPrisma: WithPrisma;
    options: AgentDashboardDesignSystemRuntimeOptions;
    invokeStoreOp: (name: string, args?: unknown[]) => Promise<unknown>;
  }) => void;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "open-plan-handler-"));
    claudeHome = path.join(root, ".claude");
    outsideDir = path.join(root, "outside");
    mkdirSync(path.join(claudeHome, "plans"), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });
    prevClaudeHome = process.env.CLAUDE_HOME;
    process.env.CLAUDE_HOME = claudeHome;

    mock = registerElectronModuleMock();
    const registrar = await import(
      "../src/main/dashboard/agent-dashboard-catalog-pack-ipc.js"
    );
    registerCatalogAndPackIpcHandlers =
      registrar.registerCatalogAndPackIpcHandlers as typeof registerCatalogAndPackIpcHandlers;
  });

  afterAll(() => {
    mock.deregister();
    if (prevClaudeHome === undefined) {
      delete process.env.CLAUDE_HOME;
    } else {
      process.env.CLAUDE_HOME = prevClaudeHome;
    }
    rmSync(root, { recursive: true, force: true });
  });

  afterEach(() => {
    resetElectronModuleStub();
  });

  /**
   * Registers the real handlers over a store row carrying these two paths,
   * counting the reads so a case can assert the id guard refused BEFORE the
   * lookup. `openedPaths()` alone cannot see that: a read that returns an
   * unopenable row also opens nothing.
   */
  function registerWithPlanRow(row: {
    filePath: string | null;
    sourceLogPath: string | null;
  }): { reads: () => number } {
    let reads = 0;
    const prisma = {
      client: {
        plan: {
          findUnique: () => {
            reads += 1;
            return Promise.resolve({
              id: PLAN_ID,
              title: null,
              status: "draft",
              source: null,
              captureMethod: null,
              harness: null,
              createdFromSessionId: null,
              filePath: row.filePath,
              sourceLogPath: row.sourceLogPath,
              needsConfirmation: false,
              confidence: 0,
              createdAt: null,
              updatedAt: null,
              versions: [],
              _count: { versions: 0 },
            });
          },
        },
      },
    };
    const withPrisma: WithPrisma =
      (handler) =>
      async (_event, ...args) =>
        await handler(
          prisma as unknown as Parameters<typeof handler>[0],
          ...args
        );
    const withDb: WithDb =
      (handler) =>
      async (_event, ...args) =>
        await handler(
          undefined as unknown as Parameters<typeof handler>[0],
          ...args
        );
    registerCatalogAndPackIpcHandlers({
      withDb,
      withPrisma,
      options: {} as AgentDashboardDesignSystemRuntimeOptions,
      invokeStoreOp: () => Promise.resolve(undefined),
    });
    return { reads: () => reads };
  }

  test("a path outside the allowed roots is never opened", async () => {
    const fp = path.join(outsideDir, "elsewhere.md");
    writeFileSync(fp, "# plan");
    registerWithPlanRow({ filePath: fp, sourceLogPath: null });

    await registeredInvokeHandler(OPEN_PLAN_CHANNEL)(TRUSTED_EVENT, PLAN_ID);

    assert.deepEqual(openedPaths(), []);
  });

  test("an executable extension inside an allowed root is never opened", async () => {
    const fp = path.join(claudeHome, "plans", "payload.command");
    writeFileSync(fp, "#!/bin/sh\necho pwned");
    registerWithPlanRow({ filePath: fp, sourceLogPath: null });

    await registeredInvokeHandler(OPEN_PLAN_CHANNEL)(TRUSTED_EVENT, PLAN_ID);

    assert.deepEqual(openedPaths(), []);
  });

  test("a traversal escape out of an allowed root is never opened", async () => {
    const fp = path.join(outsideDir, "escape.md");
    writeFileSync(fp, "# plan");
    registerWithPlanRow({
      filePath: path.join(
        claudeHome,
        "plans",
        "..",
        "..",
        "outside",
        "escape.md"
      ),
      sourceLogPath: null,
    });

    await registeredInvokeHandler(OPEN_PLAN_CHANNEL)(TRUSTED_EVENT, PLAN_ID);

    assert.deepEqual(openedPaths(), []);
  });

  // The `filePath !== "null" && filePath !== "undefined"` guard is a `String(null)`
  // artifact: the handler stringifies the column before testing it, so a null row
  // arrives as the four-character string "null". Nothing asserted the OUTCOME,
  // which these cases now do.
  //
  // What they deliberately do NOT claim is that the guard itself is load-bearing.
  // It is not: `resolveOpenablePlanFilePath` rejects the literal path "null" on
  // its own (no allowlisted extension, not a real file), so deleting the guard
  // changes nothing observable here. Naming that is the honest version — a case
  // titled "never reaches the resolver" would be asserting a call this suite has
  // no seam to observe.
  for (const stringified of [null, undefined]) {
    test(`a ${String(stringified)} filePath opens nothing`, async () => {
      registerWithPlanRow({
        filePath: stringified as string | null,
        sourceLogPath: null,
      });

      await registeredInvokeHandler(OPEN_PLAN_CHANNEL)(TRUSTED_EVENT, PLAN_ID);

      assert.deepEqual(openedPaths(), []);
    });
  }

  test("target=log with a null sourceLogPath opens nothing", async () => {
    // The row HAS a legitimate filePath; only the log column is empty. A
    // handler that fell back to `filePath` when `sourceLogPath` was missing
    // would open the wrong file, so the assertion is that nothing opens.
    const fp = path.join(claudeHome, "plans", "real.md");
    writeFileSync(fp, "# plan");
    registerWithPlanRow({ filePath: fp, sourceLogPath: null });

    await registeredInvokeHandler(OPEN_PLAN_CHANNEL)(
      TRUSTED_EVENT,
      PLAN_ID,
      "log"
    );

    assert.deepEqual(openedPaths(), []);
  });

  test("an approved plan opens exactly once, at the RESOLVED path", async () => {
    // The positive control. Without it every assertion above is satisfied by a
    // handler that opens nothing at all.
    const fp = path.join(claudeHome, "plans", "approved.md");
    writeFileSync(fp, "# plan");
    registerWithPlanRow({ filePath: fp, sourceLogPath: null });

    await registeredInvokeHandler(OPEN_PLAN_CHANNEL)(TRUSTED_EVENT, PLAN_ID);

    assert.deepEqual(openedPaths(), [realpathSync(fp)]);
  });

  test("a non-string plan id is refused BEFORE the store is read", async () => {
    // The read count is the load-bearing half: with the `typeof id !== "string"`
    // guard deleted, `openedPaths()` would still be empty because the row this
    // fixture returns is unopenable anyway.
    const { reads } = registerWithPlanRow({
      filePath: null,
      sourceLogPath: null,
    });

    await registeredInvokeHandler(OPEN_PLAN_CHANNEL)(TRUSTED_EVENT, 42);

    assert.equal(reads(), 0, "the guard must return before getPlan");
    assert.deepEqual(openedPaths(), []);
  });
});
