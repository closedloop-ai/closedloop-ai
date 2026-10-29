import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level.ts";
import {
  WORKSPACE_MENU_ENTRY_LABEL,
  WorkspaceMenuEntryId,
} from "@repo/api/src/types/workspace-menu";
import {
  DESKTOP_LOCAL_READ_REASON_COPY,
  DesktopLocalReadReason,
} from "../../src/renderer/shared-agent-sessions/desktop-app-core-mode.js";
import { DesktopAuthStatus } from "../../src/shared/contracts.js";
import {
  ClaudeTelemetryUploadKind,
  readClaudeTelemetryWatermarks,
  seedClaudeDropCounter,
  seedClaudeSessionSignal,
} from "../e2e/helpers/claude-code-telemetry-sync-fixture.js";
import {
  gotoNavSettled,
  launchDesktopApp,
  seedDesktopSettings,
} from "../e2e/helpers/desktop-app.js";
import { startAuthenticatedCloudRelay } from "../e2e/helpers/fake-cloud-relay.js";
import {
  seedNoPullRequestBranch,
  seedSessionsList,
} from "../e2e/helpers/seed-branches-db.js";
import {
  assertAuthStatus,
  assertEqualNumber,
  assertFreshSecrets,
  assertNoForbiddenRequests,
  assertNoManagedMetadata,
  assertNoRetainedSecrets,
  assertOfflineRequestsDeferred,
  assertPreservedDatabaseState,
  assertProjectionEvidence,
  assertRelayUnchanged,
  measureGuestSessions,
  readJsonFile,
  readPreservedSettings,
  readProjectionEvidence,
  recordPhase,
  withDeadline,
} from "./desktop-operating-mode-evidence.js";
import {
  awaitBootstrappedDesktopSchema,
  isCleanupPending,
  MANUAL_ASSERTION_DEADLINE_MS,
  readPreservedDatabaseState,
  relayLedger,
  SYNTHETIC_BRANCH,
  SYNTHETIC_REPO,
  SYNTHETIC_SESSION_ID,
  seedEncryptedApiKeys,
  seedPendingCleanupJournal,
  seedPreservedDatabaseState,
  seedProfile,
  seedSyntheticDesktopSession,
  startSyntheticBff,
  waitForCondition,
} from "./desktop-operating-mode-fixtures.js";
import {
  cleanupCommand,
  cleanupDesktopOperatingModeRun,
  createDesktopOperatingModeRun,
} from "./desktop-operating-mode-root.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (runCleanupCommand(args)) {
    return;
  }
  await runHarness(args);
}

function runCleanupCommand(args: string[]): boolean {
  const cleanupIndex = args.indexOf("--cleanup");
  if (cleanupIndex < 0) {
    return false;
  }
  const target = args[cleanupIndex + 1];
  const runId = stringArg(args, "--run-id");
  if (!(target && runId)) {
    throw new Error("--cleanup requires the exact printed root and run id");
  }
  cleanupDesktopOperatingModeRun(target, runId);
  return true;
}

async function runHarness(args: string[]): Promise<void> {
  const keepEvidence = args.includes("--keep-evidence");
  const measure = args.includes("--measure");
  const revealWindow = !measure;
  const runCount = Math.max(7, numberArg(args, "--runs", 7));
  const run = createIsolatedRun();
  const recoveryCommand = cleanupCommand(run.root, run.runId);
  process.stdout.write(
    `RUN_ROOT=${run.root}\nRUN_ID=${run.runId}\nCLEANUP_COMMAND=${recoveryCommand}\n`
  );
  const phasePath = path.join(run.evidenceDir, "phases.jsonl");
  const manifestPath = path.join(run.evidenceDir, "manifest.json");
  const summaryPath = path.join(run.evidenceDir, "summary.json");
  const relay = await startAuthenticatedCloudRelay({ agentSessionSync: true });
  const bff = await startSyntheticBff();
  let launched: Awaited<ReturnType<typeof launchDesktopApp>> | null = null;
  const pageErrors: Error[] = [];

  try {
    recordPhase(phasePath, "preflight", "passed", {
      sourceSha: process.env.GITHUB_SHA ?? "local-checkout",
    });
    const launchEnv = {
      ...run.homes,
      CLOSEDLOOP_API_KEY: "",
      CLOSEDLOOP_PROFILE_DIR: run.profileDir,
      CLOSEDLOOP_DISABLE_AUTO_UPDATE: "1",
      OTEL_SDK_DISABLED: "1",
    };
    const bootstrap = await launchDesktopApp({
      userDataDir: run.userDataDir,
      keepUserDataDir: true,
      env: launchEnv,
    });
    try {
      await seedSyntheticDesktopSession(bootstrap.app, run.userDataDir);
      await seedEncryptedApiKeys(bootstrap.app, run.userDataDir);
      await awaitBootstrappedDesktopSchema(run.userDataDir);
    } finally {
      await bootstrap.cleanup();
    }
    const initialEncryptedKey = readJsonFile(
      path.join(run.userDataDir, "desktop-secrets.json")
    ).encryptedApiKey;
    seedProfile(run.userDataDir, bff.origin, relay.origin);
    await seedSessionsList(run.userDataDir, [
      {
        sessionId: SYNTHETIC_SESSION_ID,
        name: "ISS-10574 isolated local row",
        status: "inactive",
      },
    ]);
    await seedClaudeSessionSignal(run.userDataDir, SYNTHETIC_SESSION_ID);
    await seedNoPullRequestBranch(run.userDataDir, {
      sessionId: "iss-10574-local-branch-session",
      repoFullName: SYNTHETIC_REPO,
      branchName: SYNTHETIC_BRANCH,
      activityAt: "2026-09-21T11:20:00.000Z",
    });
    await seedPreservedDatabaseState(run.userDataDir);
    const preservedBefore = await readPreservedDatabaseState(run.userDataDir);
    const settingsBefore = readPreservedSettings(run.userDataDir);
    recordPhase(phasePath, "seed", "passed", {
      preservedBefore,
      settingsBefore,
    });

    launched = await launchDesktopApp({
      userDataDir: run.userDataDir,
      keepUserDataDir: true,
      revealWindow,
      env: launchEnv,
      beforeLaunch: seedCloudEnabledSettings,
    });
    const revealSuppressed = await launched.app.evaluate(() =>
      process.argv.includes("--e2e-no-reveal")
    );
    if (revealSuppressed !== measure) {
      throw new Error(
        "preflight_isolation_failed: Electron reveal mode drifted"
      );
    }
    await withDeadline(
      gotoNavSettled(launched.page, "sessions"),
      MANUAL_ASSERTION_DEADLINE_MS,
      "authenticated_enablement_failed: Sessions navigation exceeded 10 seconds"
    );
    await withDeadline(
      launched.page.screenshot({
        path: path.join(run.evidenceDir, "authenticated-sessions.png"),
      }),
      MANUAL_ASSERTION_DEADLINE_MS,
      "authenticated_enablement_failed: screenshot exceeded 10 seconds"
    );
    const signedIn = await withDeadline(
      launched.page.evaluate(() => window.desktopApi.getDesktopAuthState()),
      MANUAL_ASSERTION_DEADLINE_MS,
      "authenticated_enablement_failed: auth-state read exceeded 10 seconds"
    );
    assertAuthStatus(
      signedIn.status,
      DesktopAuthStatus.Authenticated,
      "authenticated_enablement_failed"
    );
    await waitForCondition(
      () => relay.helloCount() > 0,
      "authenticated_enablement_failed: relay hello was not observed"
    );
    await waitForCondition(
      () =>
        bff
          .claudeUploads()
          .some((upload) => upload.kind === ClaudeTelemetryUploadKind.Session),
      "authenticated_enablement_failed: Claude session upload was not observed",
      30_000
    );
    await waitForCondition(
      async () =>
        (
          await readClaudeTelemetryWatermarks(
            run.userDataDir,
            SYNTHETIC_SESSION_ID
          )
        ).sessionDelivered,
      "authenticated_enablement_failed: Claude session cursor did not advance after ack"
    );
    await seedClaudeDropCounter(run.userDataDir);
    await waitForCondition(
      () =>
        bff
          .claudeUploads()
          .some(
            (upload) => upload.kind === ClaudeTelemetryUploadKind.CountersOnly
          ),
      "authenticated_enablement_failed: Claude counters-only upload was not observed",
      30_000
    );
    await waitForCondition(
      async () =>
        (
          await readClaudeTelemetryWatermarks(
            run.userDataDir,
            SYNTHETIC_SESSION_ID
          )
        ).syncedCount === 1,
      "authenticated_enablement_failed: Claude drop watermark did not advance after ack"
    );
    recordPhase(phasePath, "authenticated-online", "passed", {
      userId: signedIn.userId,
      organizationId: signedIn.organizationId,
      relayHellos: relay.helloCount(),
      claudeUploads: bff.claudeUploads(),
      claudeWatermarks: await readClaudeTelemetryWatermarks(
        run.userDataDir,
        SYNTHETIC_SESSION_ID
      ),
    });

    const offlineRequestBoundary = bff.requests.length;
    bff.setOffline(true);
    await launched.page.context().setOffline(true);
    if (await launched.page.evaluate(() => navigator.onLine)) {
      throw new Error("offline_fallback_failed: renderer remained online");
    }
    await withDeadline(
      gotoNavSettled(launched.page, "branches"),
      MANUAL_ASSERTION_DEADLINE_MS,
      "offline_fallback_failed: Branches navigation exceeded 10 seconds"
    );
    await withDeadline(
      launched.page.getByRole("radio", { name: "All time" }).click(),
      MANUAL_ASSERTION_DEADLINE_MS,
      "offline_fallback_failed: All time selection exceeded 10 seconds"
    );
    await withDeadline(
      launched.page.getByText(SYNTHETIC_BRANCH).waitFor({ state: "visible" }),
      MANUAL_ASSERTION_DEADLINE_MS,
      "offline_fallback_failed: local Branch was not visible"
    );
    const offlineIndicator =
      DESKTOP_LOCAL_READ_REASON_COPY[DesktopLocalReadReason.Offline];
    const offlineStatus = launched.page.getByRole("status").filter({
      hasText: offlineIndicator,
    });
    await withDeadline(
      offlineStatus.waitFor({ state: "visible" }),
      MANUAL_ASSERTION_DEADLINE_MS,
      "offline_fallback_failed: visible offline indication was missing"
    );
    const offlineScreenshot = path.join(
      run.evidenceDir,
      "authenticated-offline-branches.png"
    );
    await withDeadline(
      launched.page.screenshot({ path: offlineScreenshot }),
      MANUAL_ASSERTION_DEADLINE_MS,
      "offline_fallback_failed: offline screenshot exceeded 10 seconds"
    );
    const offlineRequests = bff.requests.slice(offlineRequestBoundary);
    assertOfflineRequestsDeferred(offlineRequests);
    bff.setOffline(false);
    await launched.page.context().setOffline(false);
    await withDeadline(
      offlineStatus.waitFor({ state: "hidden" }),
      MANUAL_ASSERTION_DEADLINE_MS,
      "offline_fallback_failed: offline indication remained after reconnect"
    );
    recordPhase(phasePath, "authenticated-offline", "passed", {
      localBranch: SYNTHETIC_BRANCH,
      offlineIndicator,
      offlineScreenshot,
      requests: offlineRequests.map(({ method, pathname, statusCode }) => ({
        method,
        pathname,
        statusCode,
      })),
    });
    const preSignOutRequestBoundary = bff.requests.length;

    await withDeadline(
      launched.page.getByRole("button", { name: "Open account menu" }).click(),
      MANUAL_ASSERTION_DEADLINE_MS,
      "auth_boundary_timeout: account menu did not open"
    );
    await withDeadline(
      launched.page
        .getByRole("menuitem", {
          name: WORKSPACE_MENU_ENTRY_LABEL[WorkspaceMenuEntryId.LogOut],
        })
        .click(),
      MANUAL_ASSERTION_DEADLINE_MS,
      "auth_boundary_timeout: Log out exceeded 10 seconds"
    );
    await withDeadline(
      launched.page.waitForFunction(
        async (signedOutStatus) =>
          (await window.desktopApi.getDesktopAuthState()).status ===
          signedOutStatus,
        DesktopAuthStatus.SignedOut
      ),
      MANUAL_ASSERTION_DEADLINE_MS,
      "auth_boundary_timeout: signed-out state was not published"
    );
    await waitForCondition(
      () => bff.isRevokePending(),
      "auth_boundary_timeout: deferred revoke was not observed"
    );
    const relayBoundary = relayLedger(relay);
    recordPhase(phasePath, "sign-out", "passed", {
      authStatus: DesktopAuthStatus.SignedOut,
      revokePending: bff.isRevokePending(),
    });

    const guestListReadStartedAt = Date.now();
    await withDeadline(
      gotoNavSettled(launched.page, "sessions"),
      MANUAL_ASSERTION_DEADLINE_MS,
      "projection_contract_failed: Sessions navigation exceeded 10 seconds"
    );
    await withDeadline(
      launched.page
        .getByText("ISS-10574 isolated local row")
        .waitFor({ state: "visible" }),
      MANUAL_ASSERTION_DEADLINE_MS,
      "projection_contract_failed: local row was not visible"
    );
    await withDeadline(
      launched.page.screenshot({
        path: path.join(run.evidenceDir, "guest-sessions.png"),
      }),
      MANUAL_ASSERTION_DEADLINE_MS,
      "projection_contract_failed: guest screenshot exceeded 10 seconds"
    );
    const measurements = measure
      ? await measureGuestSessions(launched.page, runCount)
      : null;
    const guestListReadEndedAt = Date.now();
    const guestAuthControl = await withDeadline(
      launched.page.evaluate(() => window.desktopApi.getDesktopAuthState()),
      MANUAL_ASSERTION_DEADLINE_MS,
      "projection_contract_failed: guest auth-state read exceeded 10 seconds"
    );
    assertAuthStatus(
      guestAuthControl.status,
      DesktopAuthStatus.SignedOut,
      "projection_contract_failed"
    );
    await waitForCondition(() => {
      try {
        return (
          readProjectionEvidence(
            run.profileDir,
            guestListReadStartedAt,
            guestListReadEndedAt
          ).projectedListOps.length > 0
        );
      } catch {
        return false;
      }
    }, "projection_contract_failed: syncSource.projectSessionList was not observed");
    const projectionEvidence = readProjectionEvidence(
      run.profileDir,
      guestListReadStartedAt,
      guestListReadEndedAt
    );
    assertProjectionEvidence(projectionEvidence);
    recordPhase(phasePath, "guest-local", "passed", {
      sessionId: SYNTHETIC_SESSION_ID,
      measurements,
      projectionEvidence,
    });
    const branchesRequestBoundary = bff.requests.length;
    await withDeadline(
      gotoNavSettled(launched.page, "branches"),
      MANUAL_ASSERTION_DEADLINE_MS,
      "accountless_hydration_observed: Branches navigation exceeded 10 seconds"
    );
    await withDeadline(
      launched.page.getByRole("radio", { name: "All time" }).click(),
      MANUAL_ASSERTION_DEADLINE_MS,
      "accountless_hydration_observed: All time selection exceeded 10 seconds"
    );
    await withDeadline(
      launched.page.getByText(SYNTHETIC_BRANCH).waitFor({ state: "visible" }),
      MANUAL_ASSERTION_DEADLINE_MS,
      "accountless_hydration_observed: local Branch was not visible"
    );
    // The deadlines above prove the local row renders; only the ledger proves
    // it rendered without accountless egress. The post-revoke
    // `assertNoForbiddenRequests` below cannot cover this window — it slices
    // from the revoke boundary, which this phase precedes.
    const branchesRequests = bff.requests
      .slice(branchesRequestBoundary)
      .filter(
        (request) =>
          !(
            request.method === "POST" &&
            request.pathname === "/desktop/session/revoke"
          )
      );
    assertNoForbiddenRequests(branchesRequests);
    recordPhase(phasePath, "branches", "passed", {
      repoFullName: SYNTHETIC_REPO,
      branchName: SYNTHETIC_BRANCH,
    });
    bff.releaseRevoke();
    await waitForCondition(
      () => {
        const snapshot = readJsonFile(
          path.join(run.userDataDir, "desktop-secrets.json")
        );
        return !Object.keys(snapshot).some(
          (key) => key === "encryptedApiKey" || key.startsWith("profile:")
        );
      },
      "cleanup_replay_failed: credential deletion did not finish",
      15_000
    );
    const secrets = readJsonFile(
      path.join(run.userDataDir, "desktop-secrets.json")
    );
    const remainingSecretKeys = Object.keys(secrets).filter(
      (key) => key === "encryptedApiKey" || key.startsWith("profile:")
    );
    assertNoRetainedSecrets(remainingSecretKeys);
    assertNoManagedMetadata(run.userDataDir);
    const cleanupBoundary = bff.requests.findIndex(
      (request, index) =>
        index >= preSignOutRequestBoundary &&
        request.method === "POST" &&
        request.pathname === "/desktop/session/revoke"
    );
    if (cleanupBoundary < 0) {
      throw new Error("auth_boundary_timeout: session revoke was not observed");
    }
    const forbiddenRequests = bff.requests
      .slice(cleanupBoundary)
      .filter(
        (request) =>
          !(
            request.method === "POST" &&
            request.pathname === "/desktop/session/revoke"
          )
      );
    assertNoForbiddenRequests(forbiddenRequests);
    assertRelayUnchanged(relay, relayBoundary);
    const preservedAfter = await withDeadline(
      readPreservedDatabaseState(run.userDataDir),
      MANUAL_ASSERTION_DEADLINE_MS,
      "cleanup_replay_failed: preservation read exceeded 10 seconds"
    );
    assertPreservedDatabaseState(preservedBefore, preservedAfter);
    const settingsAfter = readPreservedSettings(run.userDataDir);
    assertPreservedDatabaseState(settingsBefore, settingsAfter);

    pageErrors.push(...launched.pageErrors);
    await launched.cleanup();
    launched = null;
    seedPendingCleanupJournal(run.userDataDir);
    const replayHelloCount = relay.helloCount();
    launched = await launchDesktopApp({
      userDataDir: run.userDataDir,
      keepUserDataDir: true,
      revealWindow,
      env: launchEnv,
      beforeLaunch: seedCloudEnabledSettings,
    });
    await waitForCondition(
      () => !isCleanupPending(run.userDataDir),
      "cleanup_replay_failed: boot replay left the cleanup marker pending"
    );
    assertEqualNumber(
      relay.helloCount(),
      replayHelloCount,
      "cleanup_replay_failed: cleanup replay revived the socket"
    );
    recordPhase(phasePath, "cleanup-replay", "passed", {});

    pageErrors.push(...launched.pageErrors);
    await launched.cleanup();
    launched = null;
    const freshBootstrap = await launchDesktopApp({
      userDataDir: run.userDataDir,
      keepUserDataDir: true,
      env: launchEnv,
    });
    await seedSyntheticDesktopSession(freshBootstrap.app, run.userDataDir, {
      userId: "iss-10574-fresh-user",
      organizationId: "iss-10574-fresh-org",
      refreshToken: "iss-10574-fresh-refresh",
    });
    await freshBootstrap.cleanup();
    seedProfile(run.userDataDir, bff.origin, relay.origin, false);
    bff.setIdentity(
      "iss-10574-fresh-user",
      "iss-10574-fresh-org",
      "iss-10574-fresh-refresh"
    );
    const freshHelloCount = relay.helloCount();
    launched = await launchDesktopApp({
      userDataDir: run.userDataDir,
      keepUserDataDir: true,
      revealWindow,
      env: launchEnv,
      beforeLaunch: seedCloudEnabledSettings,
    });
    await waitForCondition(
      async () =>
        (
          await launched?.page.evaluate(() =>
            window.desktopApi.getDesktopAuthState()
          )
        )?.status === DesktopAuthStatus.Authenticated,
      "fresh_key_provision_failed: fresh synthetic account did not authenticate"
    );
    await waitForCondition(
      () => bff.provisionCount() === 1,
      "fresh_key_provision_failed: no automatic managed-key provision"
    );
    await waitForCondition(
      () => relay.helloCount() > freshHelloCount,
      "fresh_key_provision_failed: fresh account did not reconnect"
    );
    const freshSecrets = readJsonFile(
      path.join(run.userDataDir, "desktop-secrets.json")
    );
    assertFreshSecrets(freshSecrets, initialEncryptedKey);
    recordPhase(phasePath, "fresh-sign-in", "passed", {
      userId: "iss-10574-fresh-user",
      organizationId: "iss-10574-fresh-org",
      relayHellos: relay.helloCount(),
      provisionRequests: bff.provisionCount(),
    });
    const summary = {
      root: run.root,
      cleanupCommand: recoveryCommand,
      homes: run.homes,
      bffOrigin: bff.origin,
      relayOrigin: relay.origin,
      relay: {
        connections: relay.connectionCount(),
        hellos: relay.helloCount(),
        acknowledgements: relay.ackCount(),
        commands: relay.commandCount(),
        presence: relay.presenceCount(),
      },
      bffRequests: bff.requests.map((request) => ({
        method: request.method,
        path: request.pathname,
        authClass: request.authorization ? "present" : "absent",
      })),
      measurements,
      guestAuthControl: guestAuthControl.status,
      projectionEvidence,
      remainingSecretKeys,
      preservedBefore,
      preservedAfter,
      settingsBefore,
      settingsAfter,
      pageErrors: [...pageErrors, ...launched.pageErrors].map(
        (error) => error.message
      ),
    };
    fs.writeFileSync(manifestPath, JSON.stringify(summary, null, 2), "utf8");
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");
    process.stdout.write(
      `${[
        `RUN_ROOT=${run.root}`,
        `USER_DATA_DIR=${run.userDataDir}`,
        `MAIN_LOG=${path.join(run.userDataDir, "logs", "main.log")}`,
        `EVIDENCE_JSONL=${phasePath}`,
        `DB_OPS_JSONL=${path.join(run.profileDir, "db-ops.jsonl")}`,
        `IPC_JSONL=${path.join(run.profileDir, "ipc.jsonl")}`,
        `CLEANUP_COMMAND=${recoveryCommand}`,
      ].join("\n")}\n`
    );
  } catch (error) {
    recordPhase(phasePath, "run", "failed", {
      failure: error instanceof Error ? error.message : String(error),
    });
    if (launched) {
      await launched.page
        .screenshot({ path: path.join(run.evidenceDir, "failure.png") })
        .catch(() => undefined);
      const visibleText = await launched.page
        .locator("body")
        .innerText()
        .catch(() => "snapshot unavailable");
      fs.writeFileSync(
        path.join(run.evidenceDir, "failure-visible-text.txt"),
        visibleText,
        "utf8"
      );
    }
    throw error;
  } finally {
    bff.releaseRevoke();
    await launched?.cleanup().catch(() => undefined);
    await Promise.allSettled([relay.close(), bff.close()]);
    if (!keepEvidence) {
      cleanupDesktopOperatingModeRun(run.root, run.runId);
    }
  }
}

function numberArg(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  const parsed = index >= 0 ? Number(args[index + 1]) : fallback;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringArg(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1]?.trim() : undefined;
  return value || null;
}

function createIsolatedRun(): ReturnType<typeof createDesktopOperatingModeRun> {
  try {
    return createDesktopOperatingModeRun();
  } catch (error) {
    throw new Error(
      `preflight_isolation_failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function seedCloudEnabledSettings(userDataDir: string): void {
  seedDesktopSettings(userDataDir, {
    cloudConnectionEnabled: true,
    cloudCommandsPaused: false,
    dataSyncLevel: DataSyncLevel.Full,
  });
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.stack : String(error)}\n`
    );
    process.exitCode = 1;
  });
}
