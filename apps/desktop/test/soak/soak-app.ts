/**
 * @file soak-app.ts
 * @description Electron app lifecycle for the soak harness: seeding a
 * throwaway profile from the snapshot clone, bootstrapping safeStorage-encrypted
 * auth blobs, launching the REAL built app against a mocked cloud, and the
 * in-app probes the harness measures (auth state, relay hello, the Sessions
 * page-data IPC) plus db-host process discovery for crash injection.
 */

import { type ChildProcess, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { finished } from "node:stream/promises";
import { _electron as electron, type Page } from "@playwright/test";
import {
  closeElectronApp,
  discardPartialLaunch,
} from "../e2e/helpers/desktop-app";
import {
  firstWindowOrExplainExit,
  launchElectronOrExplain,
} from "../e2e/helpers/electron-launch-attribution";
import { DESKTOP_MAIN_BUNDLE } from "../e2e/helpers/electron-launch-preflight";
import { captureProcessGroupId } from "../e2e/helpers/process-group-kill";
import type { MockCloudServer } from "./mock-cloud-server";
import {
  MOCK_GATEWAY_ID,
  MOCK_ORGANIZATION_ID,
  MOCK_REFRESH_TOKEN,
  MOCK_USER_ID,
} from "./soak-cloud-fixture";
import {
  establishPageReadPopulation,
  type PageReadRendererMark,
  type PageReadSample,
  raceReadAgainstDeadline,
  recordPageReadSample,
} from "./soak-page-read";
import { log, sleep } from "./soak-support";
import type { AuthBlobs, LaunchedSoakApp, PageReadStats } from "./soak-types";

export type SoakElectronLauncher = typeof electron.launch;
type SoakCloudOrigins = Pick<MockCloudServer, "apiOrigin" | "relayOrigin">;

type LaunchSoakAppDependencies = {
  launchElectron: SoakElectronLauncher;
  firstWindowTimeoutMs?: number;
};

const REAL_LAUNCH_SOAK_APP_DEPENDENCIES: LaunchSoakAppDependencies = {
  launchElectron: (options = {}) =>
    launchElectronOrExplain(options, (prepared) => electron.launch(prepared)),
};

export const MAIN_JS = DESKTOP_MAIN_BUNDLE;

const TOKEN_EXPIRY = "2027-12-31T00:00:00.000Z";
/**
 * ISS-6102 — where the renderer publishes its in-flight page-read mark. A
 * harness-only property on `window`, written by the probe's own evaluation and
 * read by nothing in the app.
 */
const RENDERER_PAGE_READ_MARK_KEY = "__soakPageReadMark";
/**
 * Distinguishes each read's mark from the one the previous read left at the same
 * `window` key. A read whose CDP dispatch has not landed yet has published no
 * mark of its own, and the stale one still sitting there is about a different
 * read entirely.
 */
let pageReadSeq = 0;
const AUTH_DEADLINE_MS = 60_000;
const HELLO_DEADLINE_MS = 60_000;
/**
 * How long to wait for the app's first window. Deliberately far above any
 * healthy boot: this bound exists to stop a hung cycle running forever, NOT to
 * judge boot speed — {@link launchSoakApp} logs the measured wait so a slow boot
 * is reported as a number instead of silently becoming a harness FATAL.
 *
 * Playwright's own default is 30s, which against a seeded 2.1 GB profile on a
 * loaded box turned a SLOW boot into no information at all: the cycle was lost
 * to `electronApplication.firstWindow: Timeout 30000ms exceeded` and nothing was
 * learned about how slow.
 *
 * ISS-10066: the wait is raced against the child's own `exit`, so this budget is
 * only ever spent on an app that is still ALIVE. A boot that dies costs its exit
 * code immediately instead of three minutes and the same empty timeout — the
 * same trade the e2e suite takes at 30s, worth six times more here.
 */
const FIRST_WINDOW_TIMEOUT_MS = 180_000;

const OOM_SIGNATURES = [
  "Ineffective mark-compacts",
  "JavaScript heap out of memory",
  "Reached heap limit",
  "FATAL ERROR",
];
/**
 * Overlap kept between output chunks when scanning for {@link OOM_SIGNATURES},
 * so a signature split across a chunk boundary is still matched. Comfortably
 * longer than the longest signature.
 */
const OOM_SIGNATURE_CARRY_CHARS = 128;

function failedFirstWindowError(
  failure: unknown,
  oomHits: ReadonlySet<string>,
  userDataDir: string
): Error {
  const diagnosis =
    failure instanceof Error
      ? (failure.stack ?? failure.message)
      : String(failure);
  const signatures = [...oomHits];
  return new Error(
    `${diagnosis}\n[desktop-soak] OOM signatures observed before first window: ${signatures.length > 0 ? signatures.join(", ") : "none"}\n[desktop-soak] Cycle-owned profile: ${userDataDir}`,
    { cause: failure }
  );
}

/**
 * One bootstrap launch against a throwaway profile to safeStorage-encrypt the
 * fake desktop session + Ed25519 signing key. macOS keys safeStorage off the
 * Keychain per app, so the encrypted blobs decrypt in every later launch of
 * the same build and can be copied into each cycle's fresh profile.
 */
export async function bootstrapAuthBlobs(
  workRoot: string,
  homes: Record<string, string>
): Promise<AuthBlobs> {
  const cacheDir = path.join(workRoot, "auth-template");
  const sessionFile = path.join(cacheDir, "desktop-session.json");
  const signingKeysFile = path.join(
    cacheDir,
    "desktop-gateway-signing-keys.json"
  );
  if (fs.existsSync(sessionFile) && fs.existsSync(signingKeysFile)) {
    log("auth blobs: reusing cached template");
    return { sessionFile, signingKeysFile };
  }
  fs.mkdirSync(cacheDir, { recursive: true });
  const bootProfile = fs.mkdtempSync(path.join(workRoot, "auth-boot-"));
  log("auth blobs: bootstrap launch to encrypt session via safeStorage");
  const app = await launchElectronOrExplain(
    {
      args: [MAIN_JS, `--user-data-dir=${bootProfile}`],
      env: {
        ...process.env,
        ...homes,
        CLOSEDLOOP_DISABLE_AUTO_UPDATE: "1",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        OTEL_SDK_DISABLED: "1",
      },
    },
    (prepared) => electron.launch(prepared)
  );
  try {
    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyPkcs8Pem = privateKey
      .export({ format: "pem", type: "pkcs8" })
      .toString();
    const encrypted = await app.evaluate(
      ({ safeStorage }, payload) => {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error("safeStorage unavailable — cannot seed auth");
        }
        return {
          session: safeStorage
            .encryptString(payload.serializedSession)
            .toString("base64"),
          signingKey: safeStorage
            .encryptString(payload.privateKeyPkcs8Pem)
            .toString("base64"),
        };
      },
      {
        privateKeyPkcs8Pem,
        serializedSession: JSON.stringify({
          refreshToken: MOCK_REFRESH_TOKEN,
          refreshTokenExpiresAt: TOKEN_EXPIRY,
          userId: MOCK_USER_ID,
          organizationId: MOCK_ORGANIZATION_ID,
          gatewayId: MOCK_GATEWAY_ID,
        }),
      }
    );
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ encryptedSession: encrypted.session }),
      "utf8"
    );
    fs.writeFileSync(
      signingKeysFile,
      JSON.stringify({
        encryptedPrivateKeysByGatewayId: {
          [MOCK_GATEWAY_ID]: encrypted.signingKey,
        },
      }),
      "utf8"
    );
  } finally {
    await app.close().catch(() => undefined);
    fs.rmSync(bootProfile, { recursive: true, force: true });
  }
  return { sessionFile, signingKeysFile };
}

export function seedProfile(
  userDataDir: string,
  snapshot: string,
  mock: MockCloudServer,
  auth: AuthBlobs
): void {
  fs.mkdirSync(userDataDir, { recursive: true });
  // APFS clonefile: instant, near-free copy of the 2.1 GB golden master. The
  // master itself is never opened by the app.
  const clone = spawnSync("cp", [
    "-c",
    snapshot,
    path.join(userDataDir, "agent-dashboard.sqlite"),
  ]);
  if (clone.status !== 0) {
    throw new Error(`cp -c snapshot failed: ${clone.stderr?.toString()}`);
  }
  fs.copyFileSync(
    auth.sessionFile,
    path.join(userDataDir, "desktop-session.json")
  );
  fs.copyFileSync(
    auth.signingKeysFile,
    path.join(userDataDir, "desktop-gateway-signing-keys.json")
  );
  // Coherent Data & Sync config (metadata tier: the session-metadata lane —
  // the oracle — is on; the transcript lane stays off so Stage 0 measures one
  // protocol). `dataSyncLevel` MUST be present or the settings migration
  // re-derives everything from legacy booleans and undoes the seed.
  const settings = {
    activeConfigId: "soak-profile",
    apiOrigin: mock.apiOrigin,
    relayOrigin: mock.relayOrigin,
    webAppOrigin: "http://127.0.0.1:3000",
    cloudConnectionEnabled: true,
    cloudCommandsPaused: false,
    transcriptSyncEnabled: false,
    dataSyncLevel: "metadata",
    syncObservabilityTier: "metadata",
    onboardingCompleted: true,
    savedConfigs: [
      {
        apiOrigin: mock.apiOrigin,
        gatewayId: MOCK_GATEWAY_ID,
        id: "soak-profile",
        name: "Soak Harness",
        relayOrigin: mock.relayOrigin,
        webAppOrigin: "http://127.0.0.1:3000",
      },
    ],
  };
  fs.writeFileSync(
    path.join(userDataDir, "desktop-settings.json"),
    JSON.stringify(settings, null, 2),
    "utf8"
  );
}

export async function launchSoakApp(
  userDataDir: string,
  mock: SoakCloudOrigins,
  homes: Record<string, string>,
  stdioLogPath: string,
  dependencies: LaunchSoakAppDependencies = REAL_LAUNCH_SOAK_APP_DEPENDENCIES
): Promise<LaunchedSoakApp> {
  const oomHits = new Set<string>();
  // Appended, never rotated or capped: a relaunch after an appkill continues
  // the same cycle's file rather than replacing it.
  const stdioLog = fs.createWriteStream(stdioLogPath, { flags: "a" });
  // A signature can straddle a chunk boundary, so each scan sees the tail of
  // the previous chunk. Bounded by the longest signature, not by output volume.
  let carry = "";
  const record = (chunk: Buffer): void => {
    const text = chunk.toString("utf8");
    stdioLog.write(text);
    const scanned = carry + text;
    for (const signature of OOM_SIGNATURES) {
      if (scanned.includes(signature)) {
        oomHits.add(signature);
      }
    }
    carry = scanned.slice(-OOM_SIGNATURE_CARRY_CHARS);
  };
  const app = await dependencies.launchElectron({
    args: [MAIN_JS, `--user-data-dir=${userDataDir}`],
    env: {
      ...process.env,
      ...homes,
      CLOSEDLOOP_DISABLE_AUTO_UPDATE: "1",
      ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      OTEL_SDK_DISABLED: "1",
      CL_AUTH_API_ORIGIN: mock.apiOrigin,
      CL_RELAY_ORIGIN: mock.relayOrigin,
      // The relay socket authenticates with an sk_live key; ApiKeyStore reads
      // this env var first, so no safeStorage secret seeding is needed.
      CLOSEDLOOP_API_KEY: "sk_live_soak_harness_fake_key",
    },
  });
  const child: ChildProcess = app.process();
  const groupId = captureProcessGroupId(child);
  // Subscribe before firstWindow can reject: exit does not mean the pipes
  // have delivered their final buffered bytes, but close does.
  const childClosed = new Promise<void>((resolve) =>
    child.once("close", resolve)
  );
  child.stderr?.on("data", record);
  // OOM signatures can land on stdout depending on the crash path.
  child.stdout?.on("data", record);
  const windowWaitStart = Date.now();
  let page: Page;
  try {
    page = await firstWindowOrExplainExit(
      app.firstWindow({
        timeout: dependencies.firstWindowTimeoutMs ?? FIRST_WINDOW_TIMEOUT_MS,
      }),
      child
    );
  } catch (failure) {
    await discardPartialLaunch(async () => {
      let closeTimeout: NodeJS.Timeout | undefined;
      try {
        await closeElectronApp(app, child, groupId);
        await Promise.race([
          childClosed,
          new Promise<never>((_resolve, reject) => {
            closeTimeout = setTimeout(
              () =>
                reject(
                  new Error("Soak child stdio did not close within 5000ms")
                ),
              5000
            );
          }),
        ]);
      } finally {
        clearTimeout(closeTimeout);
        // Keep recording through process death: a fatal signature can be the
        // child's last output, and losing it would erase the soak diagnosis.
        child.stderr?.off("data", record);
        child.stdout?.off("data", record);
        stdioLog.end();
        await finished(stdioLog);
      }
    });
    // runCycle still needs the profile's final outbox state and main.log after
    // an appkill relaunch fails. Only that owner can decide when to remove it.
    throw failedFirstWindowError(failure, oomHits, userDataDir);
  }
  await page.waitForLoadState("domcontentloaded");
  log(`app window ready in ${Date.now() - windowWaitStart}ms`);
  return { app, page, oomHits, child };
}

/** Liveness straight off the saved child handle — no Playwright round-trip. */
export function isAppAlive(launched: LaunchedSoakApp): boolean {
  return launched.child.exitCode === null && launched.child.signalCode === null;
}

export async function waitForAuthenticated(page: Page): Promise<void> {
  const deadline = Date.now() + AUTH_DEADLINE_MS;
  for (;;) {
    const state = await page
      .evaluate(() =>
        (
          window as unknown as {
            desktopApi: {
              getDesktopAuthState: () => Promise<{ status: string }>;
            };
          }
        ).desktopApi.getDesktopAuthState()
      )
      .catch(() => null);
    if (state?.status === "authenticated") {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `auth did not reach authenticated within ${AUTH_DEADLINE_MS}ms (last: ${JSON.stringify(state)})`
      );
    }
    await sleep(1000);
  }
}

export async function waitForHello(mock: MockCloudServer): Promise<void> {
  const deadline = Date.now() + HELLO_DEADLINE_MS;
  for (;;) {
    if (mock.stats().helloCount > 0) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`relay hello not received within ${HELLO_DEADLINE_MS}ms`);
    }
    await sleep(1000);
  }
}

/**
 * The raw page-data read, raced against the deadline. This is the ONLY part of
 * the page-read probe that needs Electron/Playwright; grading, population
 * establishment and stats folding all live in `soak-page-read.ts` so they can
 * be tested without a runtime.
 */
function readPageDataOnce(page: Page): Promise<PageReadSample> {
  const startedAt = Date.now();
  pageReadSeq += 1;
  const readId = `page-read-${pageReadSeq}`;
  const evaluation = page.evaluate(
    async ({ markKey, readId: id }) => {
      const w = window as unknown as {
        desktopApi: {
          agentSessionsApi: { pageData: (query: unknown) => Promise<unknown> };
        };
      } & Record<string, PageReadRendererMark | undefined>;
      // `Date.now()`, not `performance.now()`: the runner compares both of the
      // mark's instants against its own, and only the wall clock is shared
      // between the two processes.
      const startedAt = Date.now();
      // Published BEFORE the await so a read that is still outstanding when the
      // runner's deadline fires is readable as exactly that. `startedAt` rides
      // along so a read that had not BEGUN by the deadline is distinguishable
      // from one that began on time and ran long — the two lose their deadline
      // on opposite sides of the renderer boundary.
      const mark: PageReadRendererMark = {
        readId: id,
        settledAt: null,
        startedAt,
      };
      w[markKey] = mark;
      const rendererStartedAt = performance.now();
      try {
        const value = await w.desktopApi.agentSessionsApi.pageData({
          quality: "all",
        });
        mark.settledAt = Date.now();
        return {
          value,
          rendererMs: performance.now() - rendererStartedAt,
          rendererStartedAt: startedAt,
        };
      } catch (error) {
        mark.settledAt = Date.now();
        throw error;
      }
    },
    { markKey: RENDERER_PAGE_READ_MARK_KEY, readId }
  );
  return raceReadAgainstDeadline({
    evaluation,
    readId,
    startedAt,
    now: () => Date.now(),
    sleep,
    readRendererMark: () => readRendererMark(page),
  });
}

/**
 * Read back the renderer's in-flight mark after the deadline has already been
 * lost. Deliberately a SEPARATE, tiny evaluation: it carries one number rather
 * than a page-data payload, so the probe that measures the transport segment
 * does not itself pay it.
 *
 * Returns `null` on any failure — a mark we could not read is recorded as
 * `unknown`, never guessed into one of the real phases. This `try/catch` bounds
 * a REJECTION only; a wedged renderer never answers at all, and that case is
 * bounded by the caller (see `RENDERER_MARK_PROBE_DEADLINE_MS`).
 */
async function readRendererMark(
  page: Page
): Promise<PageReadRendererMark | null> {
  try {
    const mark = await page.evaluate(
      (markKey) =>
        (window as unknown as Record<string, PageReadRendererMark | undefined>)[
          markKey
        ] ?? null,
      RENDERER_PAGE_READ_MARK_KEY
    );
    return mark === null
      ? null
      : {
          readId: mark.readId,
          settledAt: mark.settledAt,
          // `?? null` rather than a spread: the mark crosses a CDP structured
          // clone, and a shape missing the field must arrive as an explicit
          // "not reported" so the classifier falls back to the settle-instant
          // rule instead of reading `undefined` as a usable instant.
          startedAt: mark.startedAt ?? null,
        };
  } catch {
    return null;
  }
}

/** ISS-6100 — establish this cycle's page-read population. */
export function establishSoakPageReadPopulation(
  page: Page,
  stats: PageReadStats
): Promise<number | null> {
  return establishPageReadPopulation(() => readPageDataOnce(page), stats);
}

/**
 * One sample of the production Sessions page-data IPC, raced against the read
 * deadline. A read that answers late still counts as a timeout — the invariant
 * is that the page answers WITHIN the deadline while the drain runs.
 *
 * ISS-6100: answering is no longer enough. The grade is on CONTENT (see
 * `soak-page-read.ts`) — an empty list, or a total that has fallen below the
 * established population, is a distinct recorded failure instead of an `ok`.
 */
export async function probePageRead(
  page: Page,
  stats: PageReadStats
): Promise<void> {
  try {
    recordPageReadSample(stats, await readPageDataOnce(page));
  } catch {
    stats.errors += 1;
  }
}

/** PIDs of utility processes holding the profile's DB (the db-host worker). */
export function findDbHostPids(
  userDataDir: string,
  appPid: number | undefined
): number[] {
  const db = path.join(userDataDir, "agent-dashboard.sqlite");
  const lsof = spawnSync("lsof", ["-t", "--", db, `${db}-wal`, `${db}-shm`], {
    encoding: "utf8",
  });
  const pids = [
    ...new Set(
      (lsof.stdout ?? "")
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== appPid)
    ),
  ];
  return pids.filter((pid) => {
    const ps = spawnSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    });
    const command = ps.stdout ?? "";
    // Electron 43's utilityProcess argv carries neither the worker path nor
    // the serviceName (observed empirically) — the db-host presents as a
    // generic Node service. It is still unambiguous: it is the ONLY utility
    // process holding this profile's sqlite (which lsof already scoped).
    return (
      command.includes("--type=utility") &&
      command.includes("node.mojom.NodeService") &&
      command.includes(userDataDir)
    );
  });
}
