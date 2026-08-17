/**
 * E2E (ISS-5489 / PLN-1694 M1): the post-auth sync-consent takeover, proven
 * through the LAUNCHED app.
 *
 * The renderer suites cover the decision table and the mounted gate with auth,
 * identity, navigation and the desktop bridge all stubbed — which means they
 * inject both ends of the chain independently and cannot prove the real one
 * survives: persisted settings → `desktop:get-sync-consent-record` IPC → gate →
 * blocking dialog → Save → `desktop:record-sync-consent` → settings on disk →
 * navigate. That chain is what this spec exercises, per the "New UI surface ⇒
 * new Electron-e2e spec" rule in `apps/desktop/AGENTS.md`.
 *
 * Would fail before the change: nothing rendered for an authenticated returner
 * at all — the pre-auth overlay unmounts once auth settles, so no consent
 * surface existed on this path.
 *
 * Persistence is asserted by READING `desktop-settings.json` off disk rather
 * than echoing the IPC response back through `page.evaluate`. The response can
 * be right while the write is wrong, and the file is the thing the next launch
 * actually reads. It also avoids a second `declare global` for `window.desktopApi`,
 * which would collide with the one in `branch-delivered-selected-identity.spec.ts`
 * (desktop e2e specs ARE typechecked, via `tsconfig.e2e.json`).
 *
 * The identity route is deliberately unserved by the stand-in cloud, so
 * `useDesktopIdentity` settles to null and the dialog renders its no-org-name
 * fallback — the branch that keeps the copy from reading "You're signed in to !".
 *
 * Flag key and dialog copy are pinned as LITERALS: importing
 * `src/shared/feature-flags` from a spec aborts the whole Electron run under
 * Playwright's Node loader (same note as `guest-onboarding-gate.spec.ts`).
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop prebuild && pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  type DesktopAuthState,
  DesktopAuthStatus,
} from "../../src/shared/contracts.js";
import {
  AUTHENTICATED_GATEWAY_ID,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  launchAuthenticatedDesktopApp,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  identifiedCloudSyncProgress,
  seedDesktopSettings,
} from "./helpers/desktop-app";

declare global {
  // biome-ignore lint/style/useConsistentTypeDefinitions: Global DOM Window must be interface-merged; a type alias cannot augment it.
  interface Window {
    desktopApi: {
      getDesktopAuthState: () => Promise<DesktopAuthState>;
    };
  }
}

const GUEST_ONBOARDING_FLAG_KEY = "guest-onboarding";
const DESKTOP_SETTINGS_FILE = "desktop-settings.json";
const TAKEOVER_TITLE = /sync permissions/i;
const SAVE = /^save$/i;
const FULL_OPTION = /full transcripts/i;
const SIGNED_IN_COPY = /you're signed in/i;
const EMPTY_ORG_NAME = /signed in to\s*!/i;
// PLN-1694 M2 copy, pinned as literals for the same reason the flag key is: a
// spec that imports the renderer modules pulls React and the design system into
// Playwright's Node loader.
const SYNCING_TO_UNNAMED_WORKSPACE = "Syncing your sessions to your workspace";
const UPLOADING_FULL_TRANSCRIPTS = "Uploading full transcripts";
const INVITE_SPOTLIGHT_TITLE = "Share with your team";
const INVITE_SPOTLIGHT_BODY =
  "Invite your team to see their sessions and the agentic components they are using on this page.";
const MAYBE_LATER = /^maybe later$/i;
/** Nothing drained yet against the seeded backlog of 12. */
const PENDING_COUNTER = "0 / 12";
const SYNC_PROGRESS = "Sync progress";
const PENDING_SESSIONS = 12;
const TAKEOVER_BUDGET_MS = 30_000;
// The negative case asserts the takeover NEVER arrives. `toHaveCount(0)` would
// resolve on its first poll — while auth is still restoring, a state in which
// the gate withholds for every input — and so would stay green whether or not
// the consent record is honored. A bounded wait that must TIME OUT spends the
// whole window instead.
const TAKEOVER_NEVER_ARRIVES_MS = 15_000;

type PersistedSettings = {
  dataSyncLevel?: string;
  syncObservabilityTier?: string | null;
  syncConsentOrganizationId?: string | null;
};

function readPersistedSettings(userDataDir: string): PersistedSettings {
  return JSON.parse(
    fs.readFileSync(path.join(userDataDir, DESKTOP_SETTINGS_FILE), "utf8")
  );
}

function cloudProfileSettings(origin: string): Record<string, unknown> {
  return {
    activeConfigId: "iss-5489-cloud-profile",
    apiOrigin: origin,
    cloudConnectionEnabled: true,
    savedConfigs: [
      {
        apiOrigin: origin,
        gatewayId: AUTHENTICATED_GATEWAY_ID,
        id: "iss-5489-cloud-profile",
        name: "ISS-5489 Cloud E2E",
        relayOrigin: "http://127.0.0.1:9",
        webAppOrigin: "http://127.0.0.1:3000",
      },
    ],
  };
}

test("ISS-5489: an authenticated device with no recorded consent is blocked until it answers, then lands on Sessions", async () => {
  test.setTimeout(180_000);

  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-5489-desktop-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-5489-desktop-codex-")
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-5489-desktop-udd-")
  );
  const server = await startAuthenticatedBranchCloudServer();

  try {
    const seedLaunch = await launchAuthenticatedDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      userDataDir,
    });
    try {
      await seedAuthenticatedDesktopSession(seedLaunch.app, userDataDir);
    } finally {
      await seedLaunch.cleanup();
    }

    const { page, cleanup } = await launchAuthenticatedDesktopApp({
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          ...cloudProfileSettings(server.origin),
          // "No recorded consent" has to be seeded EXPLICITLY, and coherently
          // with a level, or the settings migration manufactures a consent
          // record before the gate ever runs. Every E2E profile carries
          // `cloudConnectionEnabled` from the baseline seed, and that alone is
          // enough for `migrateDataSyncLevel` to read the profile as a legacy
          // install and grandfather a `metadata` tier from its connectivity —
          // at which point the gate correctly decides this device already
          // answered and no takeover renders. A present-but-null tier is the
          // product's own representation of "not consented yet" (the SyncConsent
          // UI persists exactly that), and the migration deliberately never
          // overwrites an explicit choice, so it survives the boot.
          dataSyncLevel: "metadata",
          [GUEST_ONBOARDING_FLAG_KEY]: true,
          syncObservabilityTier: null,
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      // PLN-1694 M2: an IDENTIFIED lane with real work owed, so the banner's
      // counter and bar are reachable at all. `identified` is true only while
      // the cloud socket is up with a compute target, which no E2E fixture
      // stands up — without this the card can only ever render its unmeasured
      // state and the poller chain goes unexercised.
      cloudSyncProgress: {
        ...identifiedCloudSyncProgress(),
        backfilling: true,
        caughtUp: false,
        pendingBackfillSessions: PENDING_SESSIONS,
      },
      env: {
        CL_AUTH_API_ORIGIN: server.origin,
        CLAUDE_HOME: claudeHome,
        CODEX_HOME: codexHome,
      },
      userDataDir,
    });

    try {
      const dialog = page.getByRole("alertdialog", { name: TAKEOVER_TITLE });
      await expect(dialog).toBeVisible({ timeout: TAKEOVER_BUDGET_MS });

      // The org name never resolves here (the stand-in cloud does not serve the
      // identity route), so the copy must fall back rather than leave a hole.
      const description = dialog.getByText(SIGNED_IN_COPY);
      await expect(description).toBeVisible();
      // `toContainText`, not `toHaveText`: the latter demands a FULL match, which
      // this long sentence could never satisfy, so the negation would pass no
      // matter what the copy said.
      await expect(description).not.toContainText(EMPTY_ORG_NAME);

      // Hard block: Save is the only control in the dialog, and Escape does not
      // dismiss it.
      await expect(dialog.getByRole("button")).toHaveCount(1);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();

      // Full transcripts is the takeover's pre-selection (deliberately not the
      // Settings default).
      await expect(
        dialog.getByRole("radio", { name: FULL_OPTION })
      ).toBeChecked();

      await dialog.getByRole("button", { name: SAVE }).click();
      await expect(dialog).toBeHidden({ timeout: TAKEOVER_BUDGET_MS });

      // Landed on Sessions.
      await expect
        .poll(() => page.evaluate(() => window.location.hash), {
          timeout: TAKEOVER_BUDGET_MS,
        })
        .toContain("/sessions");

      // The answer reached disk, bound to the signed-in org, through the
      // consolidated setter (which derives the tier from the level).
      await expect
        .poll(() => readPersistedSettings(userDataDir), {
          timeout: TAKEOVER_BUDGET_MS,
        })
        .toMatchObject({
          dataSyncLevel: "full",
          syncConsentOrganizationId: AUTHENTICATED_ORGANIZATION_ID,
          syncObservabilityTier: "full",
        });

      // ---- PLN-1694 M2: what the landing does with that answer ----
      //
      // Both M2 surfaces are reachable ONLY through this journey — they key off
      // an answer committed during this run — so they cannot be driven by a spec
      // of their own, and the renderer suites that cover them stub the takeover
      // out entirely. This is the only place the real chain is exercised:
      // Save → gate publishes the arrival → Sessions banner + invite spotlight.

      // The banner names the level the user actually chose (Full, not the
      // Settings default), and falls back to "your workspace" rather than
      // leaving a hole where the unresolved org name goes.
      await expect(page.getByText(SYNCING_TO_UNNAMED_WORKSPACE)).toBeVisible({
        timeout: TAKEOVER_BUDGET_MS,
      });
      await expect(page.getByText(UPLOADING_FULL_TRANSCRIPTS)).toBeVisible();

      // The COUNTER is what proves the chain, not just the copy. The launch
      // seeds an identified lane owing 12 sessions
      // (`CL_E2E_CLOUD_SYNC_PROGRESS`), so this fails if runtime-status →
      // preload → shared poller → banner is broken anywhere along it — whereas
      // the title and sub-label render off the arrival alone and would stay
      // green through a dead lane.
      //
      // The fixture is a static snapshot for the whole launch, so this asserts
      // the pending state; the drained transition and the counter's monotonicity
      // are the renderer suite's, which can step samples.
      await expect(page.getByText(PENDING_COUNTER)).toBeVisible({
        timeout: TAKEOVER_BUDGET_MS,
      });
      await expect(
        page.getByRole("progressbar", { name: SYNC_PROGRESS })
      ).toBeVisible();

      // The invite nudge fires on THIS run. It reads its own consent snapshot,
      // which the takeover's save does not refresh, so before the arrival signal
      // existed this assertion failed here and the pop-up appeared only on a
      // later launch.
      const spotlight = page.getByRole("dialog", {
        name: INVITE_SPOTLIGHT_TITLE,
      });
      await expect(spotlight).toBeVisible({ timeout: TAKEOVER_BUDGET_MS });
      await expect(spotlight.getByText(INVITE_SPOTLIGHT_BODY)).toBeVisible();

      // "Maybe later" answers it, and the answer sticks for the rest of the run.
      await spotlight.getByRole("button", { name: MAYBE_LATER }).click();
      await expect(spotlight).toBeHidden({ timeout: TAKEOVER_BUDGET_MS });
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
});

test("ISS-5489: a device that already answered for this org is not asked again", async () => {
  test.setTimeout(180_000);

  const claudeHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-5489-answered-claude-")
  );
  const codexHome = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-5489-answered-codex-")
  );
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "iss-5489-answered-udd-")
  );
  const server = await startAuthenticatedBranchCloudServer();

  try {
    const seedLaunch = await launchAuthenticatedDesktopApp({
      env: { CLAUDE_HOME: claudeHome, CODEX_HOME: codexHome },
      userDataDir,
    });
    try {
      await seedAuthenticatedDesktopSession(seedLaunch.app, userDataDir);
    } finally {
      await seedLaunch.cleanup();
    }

    const { page, cleanup } = await launchAuthenticatedDesktopApp({
      beforeLaunch: (launchUserDataDir) => {
        seedDesktopSettings(launchUserDataDir, {
          ...cloudProfileSettings(server.origin),
          // A COHERENT consent record: the level must be seeded alongside the
          // tier or the settings migration treats the profile as legacy and
          // re-derives both from the connectivity flags.
          dataSyncLevel: "metadata",
          [GUEST_ONBOARDING_FLAG_KEY]: true,
          syncConsentOrganizationId: AUTHENTICATED_ORGANIZATION_ID,
          syncObservabilityTier: "metadata",
        });
      },
      cloudReadReadiness: drainedCloudReadReadiness(),
      env: {
        CL_AUTH_API_ORIGIN: server.origin,
        CLAUDE_HOME: claudeHome,
        CODEX_HOME: codexHome,
      },
      userDataDir,
    });

    try {
      // Wait for auth to actually SETTLE first. Without this the negative
      // assertion below could pass for the wrong reason: the gate also withholds
      // while auth is loading, so a session that never restored would look
      // exactly like a consent record being honored.
      await expect
        .poll(
          () => page.evaluate(() => window.desktopApi.getDesktopAuthState()),
          { timeout: TAKEOVER_BUDGET_MS }
        )
        .toMatchObject({
          organizationId: AUTHENTICATED_ORGANIZATION_ID,
          status: DesktopAuthStatus.Authenticated,
          userId: AUTHENTICATED_USER_ID,
        });

      await expect(
        page
          .getByRole("alertdialog", { name: TAKEOVER_TITLE })
          .waitFor({ state: "attached", timeout: TAKEOVER_NEVER_ARRIVES_MS })
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    fs.rmSync(userDataDir, { force: true, recursive: true });
    fs.rmSync(claudeHome, { force: true, recursive: true });
    fs.rmSync(codexHome, { force: true, recursive: true });
  }
});
