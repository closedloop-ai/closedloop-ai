import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import {
  HealthCheckRepairAction,
  type HealthCheckRepairStep,
  HealthCheckRepairStepStatus,
} from "@closedloop-ai/loops-api/compute-target";
import { Observability } from "../src/main/telemetry/observability.js";
import {
  _setPluginEnableCommandForTesting,
  _setPluginMarketplaceUpdateCommandForTesting,
  _setPluginRemediationDeadlineMsForTesting,
  _setPluginUpdateCommandForTesting,
  _setRunCommandForTesting,
  runHealthCheck,
} from "../src/server/operations/health-check.js";
import {
  _setMcpRepairDeadlineMsForTesting,
  annotateMcpRepairability,
  applyMcpConfigureRemediation,
  CLOSEDLOOP_MCP_SERVER_NAME,
  isConfigurableMcpUrl,
  MCP_PROJECT_LOCAL_ERROR,
  type McpConfigureRuntime,
} from "../src/server/operations/health-check-mcp-repair.js";
import {
  _resetHealthCheckRepairStateForTesting,
  type HealthCheckRepairDeps,
  repairHealthCheck,
} from "../src/server/operations/health-check-repair.js";
import { CODEX_CLI_CHECK_ID } from "../src/server/operations/health-check-types.js";
import type { McpDetectionResult } from "../src/server/operations/mcp-detection.js";
import type { ProcessManager } from "../src/server/process-manager.js";
import {
  buildPluginListJson,
  cleanupTempDirs,
  makeTempHome,
  tempDirs,
  writeAllUserScopedPlugins,
} from "./helpers/health-check-fixtures.js";

const EXPECTED_MCP_URL = "https://mcp.example.com/mcp";
const RE_CODEX_CLI = /Codex CLI/;
const RE_CLAUDE_CLI = /Claude CLI/;
const RE_GH_AUTH_LOGIN = /gh auth login/;
const RE_SIGN_IN = /sign-in/;
const RE_PROJECT_LOCAL = /project-local entry/;
const RE_STILL_DOES_NOT_RESOLVE = /still does not resolve after this repair/;
const RE_USABLE_ADDRESS = /not a usable http\(s\) address/;
const RE_RAN_OUT_OF_TIME = /ran out of time/;

const originalHome = process.env.HOME;
const originalFetch = globalThis.fetch;

afterEach(async () => {
  _resetHealthCheckRepairStateForTesting();
  _setPluginEnableCommandForTesting();
  _setPluginMarketplaceUpdateCommandForTesting();
  _setPluginRemediationDeadlineMsForTesting();
  _setMcpRepairDeadlineMsForTesting();
  _setPluginUpdateCommandForTesting();
  _setRunCommandForTesting();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  await cleanupTempDirs();
  await Observability.shutdown();
  Observability.reset();
});

function makeDetection(
  overrides: Partial<McpDetectionResult> = {}
): McpDetectionResult {
  const available = overrides.available ?? false;
  return {
    available,
    serverName: null,
    matchedUrl: null,
    checkedAt: "2026-04-12T00:00:00.000Z",
    closedloopAvailable: available,
    ...overrides,
  };
}

type McpHarness = {
  deps: HealthCheckRepairDeps;
  /** Ordered `<provider>:<url>` log of every `mcp add` the gateway issued. */
  addCalls: string[];
  binaryPaths: { claude?: string; codex?: string };
};

/**
 * A gateway whose MCP probe reports both providers unconfigured until an
 * `mcp add` lands for that provider, at which point it reports connected. That
 * is the whole loop the user was previously stuck in by hand.
 */
function makeMcpHarness(
  options: {
    claudeOverride?: string;
    codexOverride?: string;
    /** Detection BEFORE any add, per provider. Defaults to "not configured". */
    initial?: Partial<Record<"claude" | "codex", McpDetectionResult>>;
    /** Detection AFTER a successful add. Defaults to connected. */
    afterAdd?: Partial<Record<"claude" | "codex", McpDetectionResult>>;
    addFails?: boolean;
  } = {}
): McpHarness {
  const addCalls: string[] = [];
  const added = new Set<string>();
  const binaryPaths: { claude?: string; codex?: string } = {
    claude: options.claudeOverride,
    codex: options.codexOverride,
  };

  _setRunCommandForTesting((_cmd, args) => {
    if (args.join(" ") === "plugin list --json") {
      return Promise.resolve({ stdout: buildPluginListJson() });
    }
    return Promise.resolve({ stdout: "1.0.0" });
  });
  // Every plugin is installed in these fixtures, which opens the plugin VERSION
  // sweep — and that sweep shells out to the real `claude` binary and reaches
  // raw.githubusercontent.com over the network. Stub both so this suite is
  // hermetic and deterministic offline (the hazard ISS-5389's review documented).
  _setPluginMarketplaceUpdateCommandForTesting(() =>
    Promise.resolve({ outcome: "success" as const, stdout: "", elapsedMs: 1 })
  );
  _setPluginUpdateCommandForTesting(() =>
    Promise.resolve({ outcome: "success" as const, stdout: "", elapsedMs: 1 })
  );
  globalThis.fetch = (() =>
    Promise.resolve(Response.json({ version: "1.0.0" }))) as typeof fetch;

  const detect = (provider: "claude" | "codex"): McpDetectionResult => {
    if (added.has(provider)) {
      return (
        options.afterAdd?.[provider] ??
        makeDetection({
          available: true,
          serverName: CLOSEDLOOP_MCP_SERVER_NAME,
          matchedUrl: EXPECTED_MCP_URL,
        })
      );
    }
    return options.initial?.[provider] ?? makeDetection();
  };

  const mcpConfigureRuntime: McpConfigureRuntime = {
    addServer: (provider, _serverName, url) => {
      addCalls.push(`${provider}:${url}`);
      if (options.addFails) {
        return Promise.resolve({ ok: false, detail: "exit status 1" });
      }
      added.add(provider);
      return Promise.resolve({ ok: true });
    },
    redetect: (provider) => Promise.resolve(detect(provider)),
  };

  return {
    addCalls,
    binaryPaths,
    deps: {
      processManager: {} as unknown as ProcessManager,
      getSymphonyDir: () => os.tmpdir(),
      detectMcp: (provider) => Promise.resolve(detect(provider)),
      getBinaryPaths: () => ({ ...binaryPaths }),
      applyBinaryPathPatch: (patch) => {
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) {
            delete binaryPaths[key as "claude" | "codex"];
          } else {
            binaryPaths[key as "claude" | "codex"] = value;
          }
        }
        return binaryPaths;
      },
      mcpConfigureRuntime,
    },
  };
}

async function makeStaleOverridePath(name: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stale-mcp-override-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}

function findMcpSteps(steps: HealthCheckRepairStep[]): HealthCheckRepairStep[] {
  return steps.filter(
    (step) => step.action === HealthCheckRepairAction.ConfigureMcp
  );
}

describe("System Check repair — MCP (both providers)", () => {
  test("configures BOTH Claude and Codex MCP through the gateway and returns them connected", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const harness = makeMcpHarness();

    const result = await repairHealthCheck(harness.deps, {
      expectedMcpUrl: EXPECTED_MCP_URL,
    });

    // Both providers were configured, each exactly once, at the URL the caller
    // asked about — not just Claude, which is the whole point of ISS-5435.
    assert.deepEqual(harness.addCalls, [
      `claude:${EXPECTED_MCP_URL}`,
      `codex:${EXPECTED_MCP_URL}`,
    ]);

    // The RE-CHECKED state, not the pre-repair one: the rows the user was
    // looking at are green in place, and a green row carries no repair verdict.
    assert.equal(result.result.mcpServers.claude.available, true);
    assert.equal(result.result.mcpServers.codex.available, true);
    assert.equal(result.result.mcpServers.claude.repair, undefined);
    assert.equal(result.result.mcpServers.codex.repair, undefined);

    const mcpSteps = findMcpSteps(result.steps);
    assert.equal(mcpSteps.length, 2);
    for (const step of mcpSteps) {
      assert.equal(step.status, HealthCheckRepairStepStatus.Succeeded);
    }
    assert.deepEqual(
      mcpSteps.flatMap((step) => step.checkIds),
      ["claude-mcp", "codex-mcp"]
    );
  });

  test("a plain health check annotates the MCP rows but NEVER writes MCP config", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const harness = makeMcpHarness();

    const response = await runHealthCheck({
      processManager: {} as unknown as ProcessManager,
      configDir: () => path.join(os.tmpdir(), "config"),
      detectMcp: () => Promise.resolve(makeDetection()),
      paths: {},
      expectedMcpUrl: EXPECTED_MCP_URL,
      // Even with plugin auto-remediation requested — the setting that DOES let
      // a plain check mutate the machine — an MCP server is never registered.
      requestedPluginAutoUpdate: true,
    });

    assert.deepEqual(harness.addCalls, []);
    // The verdict is still published, so the panel can offer Repair.
    assert.equal(response.mcpServers.codex.repair?.repairable, true);
    assert.equal(
      response.mcpServers.codex.repair?.action,
      HealthCheckRepairAction.ConfigureMcp
    );
  });

  test("an already-connected provider is left alone while its missing peer is configured", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const harness = makeMcpHarness({
      initial: {
        claude: makeDetection({
          available: true,
          serverName: CLOSEDLOOP_MCP_SERVER_NAME,
          matchedUrl: EXPECTED_MCP_URL,
        }),
      },
    });

    const result = await repairHealthCheck(harness.deps, {
      expectedMcpUrl: EXPECTED_MCP_URL,
    });

    // Only the provider that needed it. A green row is never re-added, and the
    // peer assertion keeps this from passing vacuously on a Repair that does
    // nothing at all.
    assert.deepEqual(harness.addCalls, [`codex:${EXPECTED_MCP_URL}`]);
    assert.equal(result.result.mcpServers.claude.repair, undefined);
    assert.equal(result.result.mcpServers.codex.available, true);
    assert.equal(findMcpSteps(result.steps).length, 1);
  });

  test("a configured-but-disconnected provider is NOT repairable and says why", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const harness = makeMcpHarness({
      initial: {
        codex: makeDetection({
          serverName: "closedloop",
          matchedUrl: EXPECTED_MCP_URL,
        }),
      },
    });

    const result = await repairHealthCheck(harness.deps, {
      expectedMcpUrl: EXPECTED_MCP_URL,
    });

    // Claude was still missing and got configured; Codex was already there, so
    // re-adding it would fix nothing and no command was sent for it.
    assert.deepEqual(harness.addCalls, [`claude:${EXPECTED_MCP_URL}`]);
    const codexRepair = result.result.mcpServers.codex.repair;
    assert.equal(codexRepair?.repairable, false);
    assert.match(codexRepair?.reason ?? "", RE_SIGN_IN);
  });

  test("a project-local MCP config is NOT repairable and names the shadowing entry", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const harness = makeMcpHarness({
      initial: {
        claude: makeDetection({
          serverName: "closedloop",
          matchedUrl: EXPECTED_MCP_URL,
          error: MCP_PROJECT_LOCAL_ERROR,
        }),
      },
    });

    const result = await repairHealthCheck(harness.deps, {
      expectedMcpUrl: EXPECTED_MCP_URL,
    });

    assert.deepEqual(harness.addCalls, [`codex:${EXPECTED_MCP_URL}`]);
    const claudeRepair = result.result.mcpServers.claude.repair;
    assert.equal(claudeRepair?.repairable, false);
    assert.match(claudeRepair?.reason ?? "", RE_PROJECT_LOCAL);
  });

  test("an add that lands but does not connect reports FAILED rather than claiming success", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const harness = makeMcpHarness({
      afterAdd: {
        claude: makeDetection({
          serverName: CLOSEDLOOP_MCP_SERVER_NAME,
          matchedUrl: EXPECTED_MCP_URL,
        }),
        codex: makeDetection({
          serverName: CLOSEDLOOP_MCP_SERVER_NAME,
          matchedUrl: EXPECTED_MCP_URL,
        }),
      },
    });

    const result = await repairHealthCheck(harness.deps, {
      expectedMcpUrl: EXPECTED_MCP_URL,
    });

    const steps = findMcpSteps(result.steps);
    // Demand the steps EXIST before asserting their status — a `for` over an
    // empty list would let a Repair that ran nothing satisfy this test.
    assert.equal(steps.length, 2);
    for (const step of steps) {
      assert.equal(step.status, HealthCheckRepairStepStatus.Failed);
    }
    // And the row still reports the truth about itself.
    assert.equal(result.result.mcpServers.claude.available, false);
    // The add DID land, so the row is no longer "not configured" — it is
    // configured-and-disconnected, which is a different, honest verdict.
    assert.deepEqual(harness.addCalls, [
      `claude:${EXPECTED_MCP_URL}`,
      `codex:${EXPECTED_MCP_URL}`,
    ]);
  });

  test("an `mcp add` that fails is reported with the command's own detail", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const harness = makeMcpHarness({ addFails: true });

    const result = await repairHealthCheck(harness.deps, {
      expectedMcpUrl: EXPECTED_MCP_URL,
    });

    const steps = findMcpSteps(result.steps);
    assert.equal(steps.length, 2);
    for (const step of steps) {
      assert.equal(step.status, HealthCheckRepairStepStatus.Failed);
      assert.equal(step.detail, "exit status 1");
    }
  });

  test("with no expected MCP URL the rows are not repairable and no command runs", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const harness = makeMcpHarness({
      // Without a URL the row is only rendered when detection saw something, so
      // give it a name to keep the row on screen.
      initial: {
        claude: makeDetection({ serverName: "someone-elses-server" }),
      },
    });

    const result = await repairHealthCheck(harness.deps);

    assert.deepEqual(harness.addCalls, []);
    assert.equal(result.result.mcpServers.claude.repair?.repairable, false);
    // Codex had no detection context at all, so no row is rendered for it and
    // annotating one would be a verdict on a failure nobody is looking at.
    assert.equal(result.result.mcpServers.codex.repair, undefined);
  });

  test("root before cascade: an MCP row blocked by a broken provider CLI is skipped, not attempted", async () => {
    // `applyMcpConfigureRemediation` is driven directly here with a base-check
    // set whose provider CLI rows are failing and un-repairable, which is the
    // one shape a sweep on this host cannot manufacture (the harness's own
    // `codex`/`claude` binaries genuinely resolve).
    const addCalls: string[] = [];
    const runtime: McpConfigureRuntime = {
      addServer: (provider) => {
        addCalls.push(provider);
        return Promise.resolve({ ok: true });
      },
      redetect: () => Promise.resolve(makeDetection()),
    };

    const outcome = await applyMcpConfigureRemediation(
      { claude: makeDetection(), codex: makeDetection() },
      {
        expectedMcpUrl: EXPECTED_MCP_URL,
        checks: [
          {
            id: "claude-cli",
            passed: false,
            repair: { repairable: false, reason: "not installed" },
          },
          {
            id: CODEX_CLI_CHECK_ID,
            passed: false,
            repair: { repairable: false, reason: "not installed" },
          },
        ],
      },
      runtime
    );

    // Not one doomed `mcp add` was sent.
    assert.deepEqual(addCalls, []);
    const steps = findMcpSteps(outcome.steps);
    assert.equal(steps.length, 2);
    assert.equal(steps[0]?.status, HealthCheckRepairStepStatus.Skipped);
    assert.match(steps[0]?.detail ?? "", RE_CLAUDE_CLI);
    assert.match(steps[1]?.detail ?? "", RE_CODEX_CLI);
    assert.equal(outcome.mcpServers.codex.repair?.repairable, false);
    assert.equal(
      outcome.mcpServers.codex.repair?.blockedByCheckId,
      CODEX_CLI_CHECK_ID
    );
  });

  test("a root whose own repair did NOT land skips the cascade instead of firing it", async () => {
    // The annotation is forward-looking ("the root is repairable, so Repair can
    // fix this"), but if the root's remediation does not actually land the row
    // is STILL failing when the cascade would run. Trusting the label there
    // fires `mcp add` against a tool that does not work — the exact
    // root-before-cascade violation this gate exists to prevent (ISS-5435
    // review, HIGH).
    const addCalls: string[] = [];
    const runtime: McpConfigureRuntime = {
      addServer: (provider) => {
        addCalls.push(provider);
        return Promise.resolve({ ok: true });
      },
      redetect: () => Promise.resolve(makeDetection()),
    };

    const outcome = await applyMcpConfigureRemediation(
      { claude: makeDetection(), codex: makeDetection() },
      {
        expectedMcpUrl: EXPECTED_MCP_URL,
        checks: [
          // Annotated repairable (a stale override the sweep meant to clear)
          // yet still failing, because the clear did not take effect.
          {
            id: "claude-cli",
            passed: false,
            repair: {
              repairable: true,
              action: HealthCheckRepairAction.ClearBinaryOverride,
            },
          },
          { id: CODEX_CLI_CHECK_ID, passed: true },
        ],
      },
      runtime
    );

    // Codex was fine and got configured; Claude did not, and was skipped.
    assert.deepEqual(addCalls, ["codex"]);
    const claudeStep = findMcpSteps(outcome.steps).find((step) =>
      step.checkIds.includes("claude-mcp")
    );
    assert.equal(claudeStep?.status, HealthCheckRepairStepStatus.Skipped);
    assert.match(claudeStep?.detail ?? "", RE_STILL_DOES_NOT_RESOLVE);
    // And the row stops claiming to be repairable, naming the root instead.
    assert.equal(outcome.mcpServers.claude.repair?.repairable, false);
    assert.equal(
      outcome.mcpServers.claude.repair?.blockedByCheckId,
      "claude-cli"
    );
  });

  test("an MCP URL that is not a usable http(s) address is refused, not registered", async () => {
    // `expectedMcpUrl` arrives as a query parameter on the repair route and
    // ends up both as an argv entry and as the endpoint the user's MCP client
    // will talk to, so the gateway validates it rather than trusting the caller
    // (ISS-5435 review). A value starting with `-` also cannot be mistaken for
    // a flag by the provider CLI once this rejects it.
    const addCalls: string[] = [];
    const runtime: McpConfigureRuntime = {
      addServer: (provider) => {
        addCalls.push(provider);
        return Promise.resolve({ ok: true });
      },
      redetect: () => Promise.resolve(makeDetection()),
    };

    for (const badUrl of [
      "--oauth-client-id=evil",
      "file:///etc/passwd",
      "not a url",
      "/relative/mcp",
    ]) {
      const outcome = await applyMcpConfigureRemediation(
        { claude: makeDetection(), codex: makeDetection() },
        {
          expectedMcpUrl: badUrl,
          checks: [
            { id: "claude-cli", passed: true },
            { id: CODEX_CLI_CHECK_ID, passed: true },
          ],
        },
        runtime
      );

      assert.equal(
        outcome.mcpServers.claude.repair?.repairable,
        false,
        `${badUrl} must not be repairable`
      );
      assert.match(
        outcome.mcpServers.claude.repair?.reason ?? "",
        RE_USABLE_ADDRESS
      );
    }

    // Not one `mcp add` was issued for any of them.
    assert.deepEqual(addCalls, []);
    // The guard is a genuine allow-list, not a blanket refusal: a real https
    // URL still passes, so these assertions cannot succeed vacuously.
    assert.equal(isConfigurableMcpUrl(EXPECTED_MCP_URL), true);
    assert.equal(isConfigurableMcpUrl("http://localhost:3010/mcp"), true);
  });

  test("a provider CLI that is itself repairable keeps its MCP row offered", () => {
    // The stale override is cleared FIRST in the same sweep, so the add really
    // can land in one press — the same rule ISS-5389 applied to plugin rows.
    const annotated = annotateMcpRepairability(
      { claude: makeDetection(), codex: makeDetection() },
      {
        expectedMcpUrl: EXPECTED_MCP_URL,
        checks: [
          {
            id: CODEX_CLI_CHECK_ID,
            passed: false,
            repair: {
              repairable: true,
              action: HealthCheckRepairAction.ClearBinaryOverride,
            },
          },
        ],
      }
    );

    assert.equal(annotated.codex.repair?.repairable, true);
    assert.equal(
      annotated.codex.repair?.action,
      HealthCheckRepairAction.ConfigureMcp
    );
    assert.equal(annotated.codex.repair?.blockedByCheckId, CODEX_CLI_CHECK_ID);
  });

  test("runs the two providers concurrently rather than one after the other", async () => {
    // `claude mcp add` and `codex mcp add` touch different CLIs and different
    // config files, so nothing orders them. Run sequentially they cost their two
    // worst cases ADDED UP, on top of the plugin remediation earlier in the same
    // sweep — which is what can overrun the 120s the browser's relay client
    // waits before abandoning the command (ISS-5435 review).
    // Concurrency is a HAPPENS-BEFORE property, not a duration: both adds must
    // be in flight at once. Recording the start/end edges proves that directly
    // and deterministically — run sequentially the log reads
    // start,end,start,end, and no amount of runner load can reorder it.
    const order: string[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const runtime: McpConfigureRuntime = {
      addServer: async () => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        order.push("add:start");
        await new Promise((resolve) => setTimeout(resolve, 50));
        inFlight -= 1;
        order.push("add:end");
        return { ok: true };
      },
      redetect: () => Promise.resolve(makeDetection({ available: true })),
    };

    const outcome = await applyMcpConfigureRemediation(
      { claude: makeDetection(), codex: makeDetection() },
      { expectedMcpUrl: EXPECTED_MCP_URL, checks: [] },
      runtime
    );

    // Both were open at the same instant, and neither add had finished when the
    // second one began — the stage costs the worse of the two, not their sum.
    assert.equal(peakInFlight, 2);
    assert.deepEqual(order, ["add:start", "add:start", "add:end", "add:end"]);
    // Concurrency must not make the narration's order depend on which CLI
    // answered first: still Claude then Codex.
    const steps = findMcpSteps(outcome.steps);
    assert.equal(steps.length, 2);
    assert.deepEqual(
      steps.map((step) => step.checkIds[0]),
      ["claude-mcp", "codex-mcp"]
    );
    for (const step of steps) {
      assert.equal(step.status, HealthCheckRepairStepStatus.Succeeded);
    }
  });

  test("a provider that overruns the stage deadline fails with something to say", async () => {
    // The bound the concurrency above only estimates. Shrunk so the suite proves
    // it without waiting out the real 70s budget.
    _setMcpRepairDeadlineMsForTesting(30);
    // Flipped only when the wedged add finally settles, far past the deadline.
    // "Bounded" is the happens-before claim that the stage resolves WITHOUT
    // waiting for it — asserting that ordering is exact, where a wall-clock
    // ceiling would only estimate it.
    let wedgedAddSettled = false;
    const runtime: McpConfigureRuntime = {
      // Never settles within the deadline — a wedged `mcp add`.
      addServer: () =>
        new Promise((resolve) => {
          const timer = setTimeout(() => {
            wedgedAddSettled = true;
            resolve({ ok: true });
          }, 5000);
          timer.unref();
        }),
      redetect: () => Promise.resolve(makeDetection({ available: true })),
    };

    const outcome = await applyMcpConfigureRemediation(
      { claude: makeDetection(), codex: makeDetection() },
      { expectedMcpUrl: EXPECTED_MCP_URL, checks: [] },
      runtime
    );

    // The response comes back while the browser is still listening, instead of
    // being abandoned mid-flight along with its snapshot.
    assert.equal(
      wedgedAddSettled,
      false,
      "the stage must resolve on its deadline, not wait out the wedged add"
    );
    const steps = findMcpSteps(outcome.steps);
    assert.equal(steps.length, 2);
    for (const step of steps) {
      assert.equal(step.status, HealthCheckRepairStepStatus.Failed);
      assert.match(step.detail ?? "", RE_RAN_OUT_OF_TIME);
    }
  });
});

describe("System Check repair — non-Claude binary overrides", () => {
  test("a stale CODEX override is cleared in the same patch as a stale Claude one", async () => {
    // ISS-5435 asked for Codex binary-path repair as if it were missing. It is
    // not: ISS-5389's `BINARY_CHECK_OVERRIDES` already covers all five binaries.
    // This locks that in so a future narrowing to Claude cannot go unnoticed.
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const staleClaude = await makeStaleOverridePath("claude-uninstalled");
    const staleCodex = await makeStaleOverridePath("codex-uninstalled");
    const patches: Record<string, string | null>[] = [];
    const harness = makeMcpHarness({
      claudeOverride: staleClaude,
      codexOverride: staleCodex,
    });
    const applyPatch = harness.deps.applyBinaryPathPatch;
    harness.deps.applyBinaryPathPatch = (patch) => {
      patches.push({ ...patch });
      return applyPatch?.(patch);
    };

    const result = await repairHealthCheck(harness.deps, {
      expectedMcpUrl: EXPECTED_MCP_URL,
    });

    assert.deepEqual(patches, [{ claude: null, codex: null }]);
    const clearStep = result.steps.find(
      (step) => step.action === HealthCheckRepairAction.ClearBinaryOverride
    );
    assert.equal(clearStep?.status, HealthCheckRepairStepStatus.Succeeded);
    assert.deepEqual(clearStep?.checkIds, ["claude-cli", CODEX_CLI_CHECK_ID]);
  });

  test("the GitHub auth row names `gh auth login` instead of a generic manual step", async () => {
    const homeDir = await makeTempHome();
    await writeAllUserScopedPlugins(homeDir);
    const harness = makeMcpHarness();
    // `gh auth status` fails, so the credentials row fails.
    _setRunCommandForTesting((_cmd, args) => {
      if (args.join(" ") === "plugin list --json") {
        return Promise.resolve({ stdout: buildPluginListJson() });
      }
      if (args[0] === "auth") {
        return Promise.reject({
          code: "EUNKNOWN",
          stderr: "not logged in",
          message: "not logged in",
        });
      }
      return Promise.resolve({ stdout: "1.0.0" });
    });

    const result = await repairHealthCheck(harness.deps, {
      expectedMcpUrl: EXPECTED_MCP_URL,
    });
    const ghAuth = result.result.checks.find((check) => check.id === "gh-auth");

    assert.equal(ghAuth?.passed, false);
    assert.equal(ghAuth?.repair?.repairable, false);
    assert.match(ghAuth?.repair?.reason ?? "", RE_GH_AUTH_LOGIN);
  });
});
