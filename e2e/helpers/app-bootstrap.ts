import { expect, type Page } from "@playwright/test";
import { getApiBaseUrl } from "./api-url";

const RE_OPEN_USER_MENU = /open user menu/i;
const RE_OPEN_ORGANIZATION_SWITCHER = /open organization switcher/i;
const RE_ADD_TEAM = /add team/i;
const RE_YOUR_TEAMS = /your teams/i;
const RE_GET_STARTED = /get started/i;
const RE_SKIP_FOR_NOW = /skip for now/i;
const RE_SKIP_ANYWAY = /skip anyway/i;
const RE_TEAM_NAME = /team name/i;
const RE_CREATE_TEAM = /create team/i;
const RE_PROJECT_NAME = /project name/i;
const RE_CREATE_PROJECT = /create project/i;
const RE_GO_TO_MY_TASKS = /go to my tasks/i;
const AUTHENTICATED_ENTRY_TIMEOUT_MS = 15_000;
const AUTHENTICATED_ENTRY_POLL_MS = 250;

type ClerkWindow = Window & {
  Clerk?: {
    loaded?: boolean;
    session?: {
      getToken?: () => Promise<string | null>;
    } | null;
    user?: {
      id?: string | null;
    } | null;
  };
};

type AuthApiDiagnostics = {
  appOrigin: string;
  browserResolvedApiOrigin: string | null;
  clerkLoaded: boolean;
  configuredApiOrigin: string;
  hasToken: boolean;
  userId: string | null;
};

type MeProbeResult = {
  bodyPreview: string | null;
  error: string | null;
  ok: boolean;
  status: number | null;
  url: string | null;
};

type AuthenticatedEntry = "shell" | "onboarding";

async function waitForClerkUser(page: Page) {
  await page.waitForFunction(
    () => (window as ClerkWindow).Clerk !== undefined,
    undefined,
    { timeout: 15_000 }
  );
  await page.waitForFunction(
    () =>
      Boolean(
        (window as ClerkWindow).Clerk?.loaded &&
          (window as ClerkWindow).Clerk?.user?.id
      ),
    undefined,
    {
      timeout: 15_000,
    }
  );
}

function isButtonVisible(page: Page, name: RegExp) {
  return page
    .getByRole("button", { name })
    .isVisible()
    .catch(() => false);
}

async function waitForAuthenticatedEntry(
  page: Page
): Promise<AuthenticatedEntry> {
  await waitForClerkUser(page);

  const deadline = Date.now() + AUTHENTICATED_ENTRY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isButtonVisible(page, RE_OPEN_ORGANIZATION_SWITCHER)) {
      return "shell";
    }

    if (await isButtonVisible(page, RE_GET_STARTED)) {
      return "onboarding";
    }

    await page.waitForTimeout(AUTHENTICATED_ENTRY_POLL_MS);
  }

  throw new Error("Authenticated app did not render shell or onboarding");
}

async function completeOnboarding(page: Page) {
  await page.getByRole("button", { name: RE_GET_STARTED }).click();
  await page.getByRole("button", { name: RE_SKIP_FOR_NOW }).click();
  await page.getByRole("button", { name: RE_SKIP_ANYWAY }).click();

  await page.getByLabel(RE_TEAM_NAME).fill(`E2E Test Team ${Date.now()}`);
  await page.getByRole("button", { name: RE_CREATE_TEAM }).click();

  await page.getByLabel(RE_PROJECT_NAME).fill(`E2E Test Project ${Date.now()}`);
  await page.getByRole("button", { name: RE_CREATE_PROJECT }).click();

  await page.getByRole("button", { name: RE_SKIP_FOR_NOW }).click();
  await page.getByRole("button", { name: RE_SKIP_FOR_NOW }).click();
  await page.getByRole("button", { name: RE_SKIP_FOR_NOW }).click();

  await page.getByRole("button", { name: RE_GO_TO_MY_TASKS }).click();
  await page.waitForURL("**/my-tasks**", { timeout: 30_000 });
}

export async function ensureAuthenticatedShellReady(page: Page) {
  await waitForClerkUser(page);
  await expect(
    page.getByRole("button", { name: RE_OPEN_ORGANIZATION_SWITCHER })
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("button", { name: RE_OPEN_USER_MENU })
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(RE_YOUR_TEAMS)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: RE_ADD_TEAM })).toBeVisible({
    timeout: 15_000,
  });
}

function collectAuthApiDiagnostics(
  page: Page,
  configuredApiOrigin: string
): Promise<AuthApiDiagnostics> {
  return page.evaluate(async (apiOrigin) => {
    const hostname = window.location.hostname;
    const rewrittenHostname =
      (hostname.includes(".preview.") || hostname.includes(".vercel.app")) &&
      hostname.startsWith("app-")
        ? hostname.replace("app-", "api-")
        : null;
    const token = await (window as ClerkWindow).Clerk?.session?.getToken?.();

    return {
      appOrigin: window.location.origin,
      browserResolvedApiOrigin: rewrittenHostname
        ? `${window.location.protocol}//${rewrittenHostname}`
        : null,
      clerkLoaded: Boolean((window as ClerkWindow).Clerk?.loaded),
      configuredApiOrigin: apiOrigin,
      hasToken: Boolean(token),
      userId: (window as ClerkWindow).Clerk?.user?.id ?? null,
    };
  }, configuredApiOrigin);
}

function probeAuthenticatedMe(
  page: Page,
  apiOrigin: string
): Promise<MeProbeResult> {
  return page.evaluate(async (configuredApiOrigin) => {
    const clerk = (window as ClerkWindow).Clerk;
    const token = await clerk?.session?.getToken?.();

    try {
      const response = await fetch(`${configuredApiOrigin}/me`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      return {
        bodyPreview: (await response.text()).slice(0, 500),
        error: null,
        ok: response.ok,
        status: response.status,
        url: response.url,
      };
    } catch (error) {
      return {
        bodyPreview: null,
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        status: null,
        url: `${configuredApiOrigin}/me`,
      };
    }
  }, apiOrigin);
}

async function warmCurrentUser(page: Page) {
  const expectedApiOrigin = getApiBaseUrl();
  const expectedMeUrl = `${expectedApiOrigin}/me`;
  let currentUserResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url() === expectedMeUrl &&
      response.ok(),
    { timeout: 30_000 }
  );

  await page.goto("/my-tasks");
  const entry = await waitForAuthenticatedEntry(page);
  if (entry === "onboarding") {
    currentUserResponse.catch(() => undefined);
    await completeOnboarding(page);
    currentUserResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url() === expectedMeUrl &&
        response.ok(),
      { timeout: 30_000 }
    );
    await page.goto("/my-tasks");
  }

  await ensureAuthenticatedShellReady(page);

  try {
    await currentUserResponse;
  } catch (error) {
    const [authDiagnostics, meProbe] = await Promise.all([
      collectAuthApiDiagnostics(page, expectedApiOrigin),
      probeAuthenticatedMe(page, expectedApiOrigin),
    ]);

    throw new Error(
      [
        "Failed to warm current user against preview API.",
        `expectedApiOrigin=${expectedApiOrigin}`,
        `expectedMeUrl=${expectedMeUrl}`,
        `appOrigin=${authDiagnostics.appOrigin}`,
        `configuredApiOrigin=${authDiagnostics.configuredApiOrigin}`,
        `browserResolvedApiOrigin=${authDiagnostics.browserResolvedApiOrigin ?? "null"}`,
        `clerkLoaded=${String(authDiagnostics.clerkLoaded)}`,
        `userId=${authDiagnostics.userId ?? "null"}`,
        `meProbe=${JSON.stringify(meProbe)}`,
        `cause=${error instanceof Error ? error.message : String(error)}`,
      ].join("\n")
    );
  }
}

export async function gotoAuthenticatedApp(page: Page, path = "/my-tasks") {
  await warmCurrentUser(page);

  if (path !== "/my-tasks") {
    await page.goto(path);
    await ensureAuthenticatedShellReady(page);
  }
}
