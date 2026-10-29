/**
 * ISS-10316 — the credential cards on the Settings v2 API Keys panel, driven
 * through the LAUNCHED desktop app.
 *
 * The component suites mount each card with its hooks mocked, and
 * `cloud-api-fetch-ipc-api-keys-panel.test.ts` drives the bridge with no
 * renderer. Neither proves the chain this spec walks: desktop hash routing to
 * `?panel=api-keys`, the admin gate read from `/settings/view-model`, the
 * PostHog assignment that opens the Pensero card, and each write leaving the
 * renderer over the `cloud-api-fetch` IPC bridge as a PUT or DELETE that the
 * main process must allowlist and sign. A write the bridge refused would never
 * reach the stand-in below, so every captured request is also proof it cleared
 * `NON_GET_ALLOWLIST`, and its bearer token is proof main injected it (the
 * renderer never holds that token).
 *
 * The stand-in is STATEFUL on purpose: a write that did not change what the
 * next GET returns would let a card that never refetched pass every
 * set-state assertion. Its FIRST Pensero PUT fails with 400, so the card's
 * failure toast is proven through the same bridge (ISS-11410).
 *
 * Prerequisites:
 *   - Build first: `pnpm -C apps/desktop build`
 *   - Run via: CODEX_HOME="$(mktemp -d)" pnpm -C apps/desktop test:e2e
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  PENSERO_INTEGRATION_PATH,
  type PenseroCredentialInfoResponse,
  type SetPenseroCredentialRequest,
} from "@repo/api/src/types/pensero-integration.ts";
import { PENSERO_INTEGRATION_FLAG_KEY } from "@repo/api/src/types/pensero-integration-flag.ts";
import {
  SettingsActorRole,
  SettingsActorRoleStatus,
} from "@repo/api/src/types/settings-actor-role.ts";
import {
  SETTINGS_PANEL_LABEL,
  SettingsPanelId,
} from "@repo/api/src/types/settings-panel.ts";
import { projectSettingsViewModel } from "@repo/api/src/types/settings-view-model.ts";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  createAuthenticatedDesktopSessionRecord,
  rejectUnauthorized,
  startAuthenticatedBranchCloudServer,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import {
  drainedCloudReadReadiness,
  openSettingsPanel,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import { routeConnectedDevicesRequest } from "./helpers/settings-v2-connected-devices-cloud";

/** The platform-key list the panel's first card reads (`use-platform-api-keys.ts`). */
const PLATFORM_API_KEYS_PATH = "/api-keys";
const VIEW_MODEL_PATH = "/settings/view-model";

/**
 * Hook and card modules are NOT imported for these: `@repo/app` modules use
 * extension-less internal specifiers that do not resolve under Playwright's
 * ESM loader, and a spec-level import failure aborts the WHOLE desktop-e2e
 * suite at load time (`apps/desktop/test/AGENTS.md`). Each value names the
 * source it mirrors.
 */
/** `TOKEN_FIELD_ID` in `pensero-credential-card.tsx`. */
const PENSERO_TOKEN_FIELD_ID = "pensero-api-token";
/** `STORED_TITLE` / `NOT_STORED_TITLE` in `pensero-credential-card.tsx`. */
const PENSERO_STORED_TITLE = "Credential stored";
const PENSERO_NOT_STORED_TITLE = "No credential stored";
const SAVE_BUTTON = "Save";
/** The sonner toast root (`@closedloop-ai/design-system/components/ui/sonner`). */
const TOAST_ROOT = "[data-sonner-toast]";
const DISCONNECT_BUTTON = "Disconnect";
/** The design-system `Card` root each credential card renders. */
const CARD_ROOT = '[data-slot="card"]';

const PENSERO_TOKEN = "tk_e2epublic:sk_e2esecret9876";
const PENSERO_LAST_FOUR = "9876";
/**
 * The stand-in's refusal message. The card toasts the server's own message
 * (`reportWriteFailure` in `pensero-credential-card.tsx`).
 */
const PENSERO_SAVE_REFUSED_ERROR = "invalid key";
const BAD_REQUEST = 400;
const SET_AT = "2026-01-01T00:00:00.000Z";

/**
 * DataSyncLevel wire value (`src/shared/contracts.ts`), a literal for the same
 * load-abort reason as above. Persisted so the settings migration keeps this
 * cloud profile instead of re-deriving one from the standard seed.
 */
const METADATA_LEVEL = "metadata";

const MOUNT_TIMEOUT_MS = 30_000;
const E2E_BUDGET_MS = 240_000;

type CapturedWrite = {
  authorization: string | null;
  body: unknown;
  method: string;
  pathname: string;
};

const PENSERO_NOT_STORED: PenseroCredentialInfoResponse = {
  baseUrl: null,
  isSet: false,
  lastFour: null,
  setAt: null,
};

test.describe("Settings v2 API Keys credential cards (desktop, ISS-10316)", () => {
  test("an admin stores and disconnects the Pensero credential over the cloud bridge", async () => {
    test.setTimeout(E2E_BUDGET_MS);

    const cloud = createCredentialCloud();
    const claudeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-10316-claude-")
    );
    const codexHome = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-10316-codex-")
    );
    const userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "iss-10316-udd-")
    );
    const server = await startAuthenticatedBranchCloudServer({
      extraRoutes: (request, response) =>
        cloud.route(request, response) ||
        routeConnectedDevicesRequest(request, response),
    });

    try {
      const { page, pageErrors, cleanup } = await launchAuthenticatedDesktopApp(
        {
          sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
          beforeLaunch: (launchUserDataDir) => {
            seedDesktopSettings(launchUserDataDir, {
              ...cloudProfileSettings(server.origin),
              dataSyncLevel: METADATA_LEVEL,
            });
            seedDesktopFeatureFlags(launchUserDataDir, {
              [PENSERO_INTEGRATION_FLAG_KEY]: true,
            });
          },
          cloudReadReadiness: drainedCloudReadReadiness(),
          env: {
            CLAUDE_HOME: claudeHome,
            CL_AUTH_API_ORIGIN: server.origin,
            CODEX_HOME: codexHome,
          },
          userDataDir,
        }
      );

      try {
        const shell = await openApiKeysPanel(page);

        await exercisePenseroCredential(page, shell, cloud.writes);

        expect(
          cloud.writes.map(({ method, pathname }) => ({ method, pathname }))
        ).toEqual([
          { method: "PUT", pathname: PENSERO_INTEGRATION_PATH },
          { method: "PUT", pathname: PENSERO_INTEGRATION_PATH },
          { method: "DELETE", pathname: PENSERO_INTEGRATION_PATH },
        ]);
        for (const write of cloud.writes) {
          expect(write.authorization).toBe(
            `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
          );
        }
        expect(pageErrors).toEqual([]);
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
});

/**
 * Open the panel and prove it is THE panel: its rail entry is current. A deep
 * link that fell back to another panel would satisfy a bare shell check and
 * then fail on a missing input, naming the wrong cause.
 */
async function openApiKeysPanel(page: Page): Promise<Locator> {
  const shell = await openSettingsPanel(page, {
    panel: SettingsPanelId.ApiKeys,
    timeoutMs: MOUNT_TIMEOUT_MS,
  });
  await expect(
    shell.getByRole("link", {
      exact: true,
      name: SETTINGS_PANEL_LABEL[SettingsPanelId.ApiKeys],
    })
  ).toHaveAttribute("aria-current", "page", { timeout: MOUNT_TIMEOUT_MS });
  return shell;
}

async function exercisePenseroCredential(
  page: Page,
  shell: Locator,
  writes: readonly CapturedWrite[]
): Promise<void> {
  const tokenField = shell.locator(`#${PENSERO_TOKEN_FIELD_ID}`);
  // Present only when the `pensero-integration` assignment resolved ON and the
  // Connections admin gate resolved Ready + admin.
  await expect(tokenField).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  // `has` is resolved inside each card, so it must not carry the shell scope.
  const card = shell.locator(CARD_ROOT, {
    has: page.locator(`#${PENSERO_TOKEN_FIELD_ID}`),
  });
  const notStored = card.getByText(PENSERO_NOT_STORED_TITLE, { exact: true });
  const stored = card.getByText(PENSERO_STORED_TITLE, { exact: true });
  const disconnect = card.getByRole("button", {
    exact: true,
    name: DISCONNECT_BUTTON,
  });

  await expect(notStored).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await expect(stored).toHaveCount(0);

  const saveButton = card.getByRole("button", {
    exact: true,
    name: SAVE_BUTTON,
  });

  // The stand-in refuses the first save with a 400: the card's own toast, once,
  // and the card stays unset with the typed token kept for a retry.
  await tokenField.fill(PENSERO_TOKEN);
  await saveButton.click();
  await expect(
    page.getByText(PENSERO_SAVE_REFUSED_ERROR, { exact: true })
  ).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await expect(
    page.locator(TOAST_ROOT).filter({ hasText: PENSERO_SAVE_REFUSED_ERROR })
  ).toHaveCount(1);
  await expect(notStored).toBeVisible();
  await expect(stored).toHaveCount(0);
  await expect(tokenField).toHaveValue(PENSERO_TOKEN);

  await saveButton.click();

  await expect(stored).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await expect(card.getByText(`****${PENSERO_LAST_FOUR}`)).toBeVisible();
  await expect(disconnect).toBeVisible();
  await expect(tokenField).toHaveValue("");
  // `teamIdentifiers` is OMITTED while its own flag is off, and a blank
  // endpoint goes out as null. Exact equality pins both.
  const expectedBody: SetPenseroCredentialRequest = {
    baseUrl: null,
    token: PENSERO_TOKEN,
  };
  expect(
    writes.find(
      (write) =>
        write.method === "PUT" && write.pathname === PENSERO_INTEGRATION_PATH
    )?.body
  ).toEqual(expectedBody);

  await disconnect.click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { exact: true, name: DISCONNECT_BUTTON })
    .click();

  await expect(notStored).toBeVisible({ timeout: MOUNT_TIMEOUT_MS });
  await expect(stored).toHaveCount(0);
  await expect(disconnect).toHaveCount(0);
  expect(
    writes.some(
      (write) =>
        write.method === "DELETE" && write.pathname === PENSERO_INTEGRATION_PATH
    )
  ).toBe(true);
}

/**
 * The cloud routes the API Keys panel reads and writes, holding the state a
 * write changes. `route` answers synchronously that it OWNS a request; a write
 * body is read and answered asynchronously after that.
 */
function createCredentialCloud() {
  const writes: CapturedWrite[] = [];
  let pensero: PenseroCredentialInfoResponse = PENSERO_NOT_STORED;
  let penseroSaveRefused = false;

  const applyWrite = (method: string): unknown => {
    if (method === "PUT") {
      pensero = {
        baseUrl: null,
        isSet: true,
        lastFour: PENSERO_LAST_FOUR,
        setAt: SET_AT,
      };
      return pensero;
    }
    pensero = PENSERO_NOT_STORED;
    return { deleted: true };
  };

  const route = (request: IncomingMessage, response: ServerResponse) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const method = request.method ?? "GET";
    if (!OWNED_PATHS.has(pathname)) {
      return false;
    }
    if (
      request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
    ) {
      rejectUnauthorized(response);
      return true;
    }
    if (method === "GET") {
      writeApiResult(response, readFor(pathname, pensero));
      return true;
    }
    if (!WRITE_PATHS.has(pathname)) {
      return false;
    }
    readJsonBody(request)
      .then((body) => {
        writes.push({
          authorization: request.headers.authorization ?? null,
          body,
          method,
          pathname,
        });
        if (method === "PUT" && !penseroSaveRefused) {
          penseroSaveRefused = true;
          response.statusCode = BAD_REQUEST;
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              error: PENSERO_SAVE_REFUSED_ERROR,
              success: false,
            })
          );
          return;
        }
        writeApiResult(response, applyWrite(method));
      })
      .catch(() => {
        // A stand-in fault must fail the write the card reports, not hang it.
        response.statusCode = 500;
        response.end();
      });
    return true;
  };

  return { route, writes };
}

const OWNED_PATHS = new Set([
  PENSERO_INTEGRATION_PATH,
  PLATFORM_API_KEYS_PATH,
  VIEW_MODEL_PATH,
]);
const WRITE_PATHS = new Set([PENSERO_INTEGRATION_PATH]);

function readFor(
  pathname: string,
  pensero: PenseroCredentialInfoResponse
): unknown {
  if (pathname === VIEW_MODEL_PATH) {
    // An ADMIN, so `Connections` grants the admin rung the card gates its
    // write controls on.
    return projectSettingsViewModel({
      resolution: {
        role: SettingsActorRole.Admin,
        status: SettingsActorRoleStatus.Resolved,
      },
      staleSessionRole: false,
    });
  }
  if (pathname === PENSERO_INTEGRATION_PATH) {
    return pensero;
  }
  return [];
}

/**
 * The body as JSON, or the raw text when it is not JSON, so a malformed body
 * fails the exact-equality assertion by value instead of hanging the request.
 */
function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", () => resolve(null));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

function cloudProfileSettings(origin: string): Record<string, unknown> {
  return {
    activeConfigId: "iss-10316-cloud-profile",
    apiOrigin: origin,
    cloudConnectionEnabled: true,
    savedConfigs: [
      {
        apiOrigin: origin,
        gatewayId: AUTHENTICATED_GATEWAY_ID,
        id: "iss-10316-cloud-profile",
        name: "ISS-10316 Cloud E2E",
        relayOrigin: "http://127.0.0.1:9",
        webAppOrigin: "http://127.0.0.1:3000",
      },
    ],
  };
}
