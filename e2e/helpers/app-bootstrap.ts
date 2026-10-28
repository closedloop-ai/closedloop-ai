import {
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";
import { WORKSPACE_MENU_TRIGGER_LABEL } from "@repo/api/src/types/workspace-menu";
import { WEB_CANONICAL_LANDING_HREF } from "@repo/app/shared/lib/primary-nav-destinations";
import { getApiBaseUrl } from "./api-url";
import { isClerkFreeRun } from "./clerk-free";

// The legacy (V1) AccountMenu trigger. `account-menu.tsx` spells it inline, so
// this is its only constant. Exported because a spec driving THAT menu must use
// this name. It is not a shell-readiness signal on its own; that is
// `authenticatedShellTrigger`, which also accepts V2.
const V1_SHELL_TRIGGER_NAME = "Open organization switcher";
export const RE_OPEN_ORGANIZATION_SWITCHER = new RegExp(
  V1_SHELL_TRIGGER_NAME,
  "i"
);
const NO_SHELL_TRIGGER_RENDERED = `neither V1 "${V1_SHELL_TRIGGER_NAME}" nor V2 "${WORKSPACE_MENU_TRIGGER_LABEL}" rendered`;
/**
 * The nav row this gate reads as "the sidebar's navigation is on screen".
 *
 * Dashboard, because it is the one destination no flag can remove: operator
 * direction 2026-09-01 keeps it outside Labs on every shape, and it carries no
 * per-item flag of its own. Anchored by name rather than by href so the org slug
 * this helper has not resolved yet cannot enter the locator.
 *
 * It replaced Your Teams and Add Team here (ISS-11248). Those were never
 * flag-independent: both are emitted only by `sidebar-teams.tsx`, which now
 * renders inside the Labs container and nowhere else — and an unpinned
 * `labs-nav-section` resolves DISABLED in the containerized lane, which is this
 * gate's own default condition. Anchoring shell readiness on a Labs-gated
 * affordance would time out against a perfectly rendered shell.
 */
const RE_DASHBOARD_NAV = /^Dashboard$/;
const RE_GET_STARTED = /get started/i;
const RE_SKIP_FOR_NOW = /skip for now/i;
const RE_SKIP_ANYWAY = /skip anyway/i;
const RE_TEAM_NAME = /team name/i;
const RE_CREATE_TEAM = /create team/i;
const RE_PROJECT_NAME = /project name/i;
const RE_CREATE_PROJECT = /create project/i;
const RE_GO_TO_MY_TASKS = /go to my tasks/i;
const AUTHENTICATED_ENTRY_TIMEOUT_MS = 30_000;
const AUTHENTICATED_ENTRY_POLL_MS = 250;
/** What a blocking dialog with no readable heading is reported as. */
export const UNNAMED_BLOCKING_DIALOG = "unnamed dialog";
/**
 * `aria-modal`, not `role="dialog"` alone. A non-modal Radix popover carries
 * the same role and can carry a heading, but it does not aria-hide the shell,
 * so it is not what the entry poll ran out against — reporting one would name
 * the wrong thing, or hide the real modal behind it.
 */
const MODAL_DIALOG_SELECTOR = '[role="dialog"][aria-modal="true"]';
/**
 * How long the heading read may take before the dialog is reported as unnamed.
 *
 * Bounded because it MUST be. `innerText()` auto-waits for its element and this
 * repo sets no `actionTimeout`, so Playwright's default of 0 applies: on a
 * modal with no heading the read never settles, the `.catch()` below never
 * fires, and the test dies at the 60s test timeout carrying neither the
 * diagnosis nor {@link AUTHENTICATED_ENTRY_FAILURE}. A helper whose whole job
 * is to explain an entry timeout cannot be allowed to swallow the explanation.
 *
 * Generous against the only work it bounds and cheap against what it protects:
 * the dialog has already passed `isVisible()`, so a heading it does have is
 * attached and painted, and a read of one is a single evaluate call.
 */
const HEADING_READ_TIMEOUT_MS = 2000;
/** The failure every entry timeout carries, with or without a dialog behind it. */
export const AUTHENTICATED_ENTRY_FAILURE = `Authenticated app did not render shell or onboarding: ${NO_SHELL_TRIGGER_RENDERED}`;
const SHELL_NOT_RENDERED = "Authenticated shell did not render";
/**
 * What each shell affordance says when IT is the missing one.
 *
 * Derived from the locators rather than restating their copy, and separate
 * because one message threaded through every assertion makes the rest of them
 * lie: a shell whose trigger is on screen and whose nav is not was reporting
 * `NO_SHELL_TRIGGER_RENDERED` (marisolashgrove, PR #7485).
 */
const NO_DASHBOARD_NAV_RENDERED = `no nav link matching ${RE_DASHBOARD_NAV} rendered`;
export const NO_CONTENT_RENDERED = "the main region rendered nothing";
/** How long each shell affordance gets to render. */
const SHELL_AFFORDANCE_TIMEOUT_MS = 30_000;
const TRAILING_SLASHES_REGEX = /\/+$/;

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

const bridgedContexts = new WeakSet<BrowserContext>();

function stripTrailingSlashes(url: string) {
  return url.replace(TRAILING_SLASHES_REGEX, "");
}

function isPreviewApiOrigin(origin: string) {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return (
    (hostname.includes(".preview.") || hostname.includes(".vercel.app")) &&
    hostname.startsWith("api-")
  );
}

export async function installConfiguredApiOriginBridge(
  page: Page,
  configuredApiOrigin: string,
  browserApiOrigin: string | null = resolveDefaultBrowserApiOrigin()
) {
  const context = page.context();
  if (bridgedContexts.has(context)) {
    return;
  }
  bridgedContexts.add(context);

  const targetApiOrigin = stripTrailingSlashes(configuredApiOrigin);
  await context.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    // The request is REPLAYED upstream carrying its own headers and body, so it
    // may only be the origin the app itself asks for — derived from its own
    // hostname on a preview alias, or the origin baked into the image on the
    // ISS-10335 Clerk-free lane. A host that merely looks like a preview API —
    // a third party, or a mocked dependency — falls through instead of having
    // this suite's credentials sent to `targetApiOrigin` (davetho, PR #6921).
    if (
      requestUrl.origin === targetApiOrigin ||
      requestUrl.origin !== browserApiOrigin
    ) {
      await route.fallback();
      return;
    }

    // Keep the browser-facing URL unchanged while Playwright performs the
    // upstream request against API_BASE_URL. This preserves method, headers,
    // post data, status, response headers, and body without browser CORS drift.
    const proxiedUrl = `${targetApiOrigin}${requestUrl.pathname}${requestUrl.search}${requestUrl.hash}`;
    try {
      const response = await fetchUpstream(route, proxiedUrl);
      await route.fulfill({ response });
    } catch {
      await route.abort().catch(() => undefined);
    }
  });
}

// Per-wait bound for a single Clerk-hydration attempt. Exported so a caller
// that arms a response listener *before* driving `waitForClerkUser` can size
// its own wait to cover the full bounded self-heal instead of racing it
// (see `waitForDocumentEditorHydrated` in document-page).
export const CLERK_USER_WAIT_TIMEOUT_MS = 15_000;
// Shared bound for the bounded-reload Clerk self-heal. Exported so the
// sign-in probe (hasExistingClerkSession) reuses the SAME value instead of a
// silently-drifting copy (FEA-2298 review).
export const CLERK_USER_RELOAD_ATTEMPTS = 3;

async function waitForClerkUserHydrated(page: Page) {
  await page.waitForFunction(
    () => (window as ClerkWindow).Clerk !== undefined,
    undefined,
    { timeout: CLERK_USER_WAIT_TIMEOUT_MS }
  );
  await page.waitForFunction(
    () =>
      Boolean(
        (window as ClerkWindow).Clerk?.loaded &&
          (window as ClerkWindow).Clerk?.user?.id
      ),
    undefined,
    {
      timeout: CLERK_USER_WAIT_TIMEOUT_MS,
    }
  );
}

// The Clerk SDK hydrates `window.Clerk` from live FAPI (`/v1/client`,
// `/v1/environment`). When that bootstrap is transiently slow or rate-limited
// (HTTP 429) on the shared dev instance, the waits below time out (FEA-2288).
// Recover in place with a bounded `page.reload()`, which re-issues the bootstrap
// far more cheaply than letting the spec fail onto Playwright's `retries: 2` — a
// full retry re-runs every fixture, including the Clerk testing-token install,
// adding *more* FAPI load during the exact window the instance is degraded. A
// genuinely-down FAPI still fails fast after the bounded attempts.
export async function waitForClerkUser(page: Page) {
  // ISS-10335: a Clerk-free project has no Clerk session, so `window.Clerk.user`
  // never hydrates and every wait below would burn its full bounded retry before
  // failing. The shell readiness signal on that lane is the rendered trigger the
  // callers already assert on; the SESSION is server-side and was decided before
  // the document was sent.
  if (isClerkFreeRun()) {
    return;
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= CLERK_USER_RELOAD_ATTEMPTS; attempt += 1) {
    try {
      await waitForClerkUserHydrated(page);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < CLERK_USER_RELOAD_ATTEMPTS) {
        await page.reload({ waitUntil: "domcontentloaded" });
      }
    }
  }
  throw lastError;
}

function isVisible(locator: Locator) {
  return locator.isVisible().catch(() => false);
}

/**
 * The authenticated shell's trigger, whichever workspace experience PostHog
 * assigned. V1 mounts the legacy AccountMenu; V2 mounts the WorkspaceMenu, whose
 * trigger is deliberately not named an organization switcher. The containerized
 * lane has no PostHog key and renders V1, while stage assigns V2, so keying on
 * one name made the entry poll run out its deadline on a rendered V2 shell
 * (ISS-10036). `.first()`: the two never co-render, and a strict-mode throw
 * would read as "not visible".
 */
export function authenticatedShellTrigger(page: Page): Locator {
  return page
    .getByRole("button", { name: RE_OPEN_ORGANIZATION_SWITCHER })
    .or(page.getByRole("button", { name: WORKSPACE_MENU_TRIGGER_LABEL }))
    .first();
}

/**
 * The heading of a modal dialog covering the shell, or `null` when none is.
 *
 * A Radix modal aria-hides the shell, so while one is open NEITHER entry
 * affordance can match and the poll below can only ever run out its full
 * deadline. ISS-9916 was exactly that: the guided-onboarding takeover opened
 * over the authenticated shell for an already-onboarded account, and 15
 * attempts each burned ~36s to report "did not render shell or onboarding" —
 * a message that names neither the dialog on screen nor its phase, and cost a
 * day of triage to get behind.
 *
 * Deliberately generic. This claims only what it can see: a blocking dialog is
 * up, and here is what it says. Keying it to the guided dialog specifically
 * would need a marker in the component and would go quiet for the next
 * takeover that is not that one.
 */
async function blockingDialogHeading(page: Page): Promise<string | null> {
  const dialog = page.locator(MODAL_DIALOG_SELECTOR).first();
  if (!(await dialog.isVisible().catch(() => false))) {
    return null;
  }
  const heading = await dialog
    .getByRole("heading")
    .first()
    .innerText({ timeout: HEADING_READ_TIMEOUT_MS })
    .catch(() => null);
  // A heading that is absent, empty, or whitespace all mean the same thing to a
  // reader — there is no name to report — so all three take the fallback.
  return heading?.trim() || UNNAMED_BLOCKING_DIALOG;
}

/**
 * `timeoutMs` is injectable for one reason, the same one `resolveApiOrigin` is
 * below: it makes the timeout branch reachable from a test in under a second
 * instead of thirty. No production caller passes it.
 */
export async function waitForAuthenticatedEntry(
  page: Page,
  timeoutMs: number = AUTHENTICATED_ENTRY_TIMEOUT_MS
): Promise<AuthenticatedEntry> {
  await waitForClerkUser(page);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isVisible(authenticatedShellTrigger(page))) {
      return "shell";
    }

    if (await isVisible(page.getByRole("button", { name: RE_GET_STARTED }))) {
      return "onboarding";
    }

    await page.waitForTimeout(AUTHENTICATED_ENTRY_POLL_MS);
  }

  const dialogHeading = await blockingDialogHeading(page);
  throw new Error(
    dialogHeading === null
      ? AUTHENTICATED_ENTRY_FAILURE
      : `${AUTHENTICATED_ENTRY_FAILURE}: a modal dialog ("${dialogHeading}") is covering it`
  );
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

/**
 * Settles the page on the authenticated shell, content region included.
 *
 * The sidebar renders outside `OnboardingGuard`, which leaves `main` empty —
 * and the command palette's `document` listener unbound — until `/onboarding`
 * answers. The Clerk-free lane's boot-rebuild wait used to cover that window
 * by accident; without it a Cmd+K pressed on a rendered sidebar reached no
 * listener (run 35689111255, `navigation.spec.ts`).
 *
 * `timeoutMs` is injectable for the same reason as
 * {@link waitForAuthenticatedEntry}'s: it makes the timeout branch reachable
 * from a test. No production caller passes it.
 */
export async function ensureAuthenticatedShellReady(
  page: Page,
  timeoutMs: number = SHELL_AFFORDANCE_TIMEOUT_MS
) {
  await waitForClerkUser(page);
  await expectShellRendered(page, timeoutMs);
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

/**
 * Where the authenticated root's SPA redirect actually settles. Derived from
 * the app's own landing constant rather than written out: this glob used to be
 * `**​/my-tasks**`, and because the wait that reads it swallows its own timeout,
 * a stale value did not fail here — it burned 30s of a 60s test budget inside
 * the shared bootstrap and took every storageState spec in the lane down with
 * it, none of them near a landing assertion.
 */
const CANONICAL_LANDING_URL_GLOB = `**${WEB_CANONICAL_LANDING_HREF}**`;

function waitForCurrentUserResponse(page: Page, expectedMeUrl: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      (response.url() === expectedMeUrl || response.url().endsWith("/me")) &&
      response.ok(),
    { timeout: 30_000 }
  );
}

type EnterShellOptions = {
  // When true, the landing route is reached by riding the authenticated root's
  // client-side (SPA) redirect that the caller has already triggered, instead
  // of issuing another full `page.goto`. The SPA redirect keeps
  // `window.Clerk` hydrated, so it avoids a second full-document Clerk bootstrap
  // against the shared dev FAPI (FEA-2298 AC-7a). The `/me` warm becomes
  // best-effort in this mode because the request can fire during the redirect
  // before the listener attaches — `ensureAuthenticatedShellReady` is the
  // authoritative auth gate either way.
  ride?: boolean;
};

async function enterAuthenticatedShell(
  page: Page,
  options: EnterShellOptions = {}
) {
  const ride = options.ride ?? false;
  const expectedApiOrigin = getApiBaseUrl();
  const expectedMeUrl = `${expectedApiOrigin}/me`;
  await installConfiguredApiOriginBridge(page, expectedApiOrigin);

  // Only observe `/me` on paths where THIS function issues the navigation. In
  // ride mode the caller already triggered the SPA redirect to the landing
  // route, so `/me` has very likely fired before this listener could attach; a
  // `waitForResponse` would then dead-wait its full 30s timeout on every
  // storageState test. `ensureAuthenticatedShellReady` is the authoritative auth
  // gate, so the `/me` warm is simply skipped for the ride path (FEA-2298).
  let currentUserResponse: ReturnType<
    typeof waitForCurrentUserResponse
  > | null = null;

  if (ride) {
    await page
      .waitForURL(CANONICAL_LANDING_URL_GLOB, { waitUntil: "domcontentloaded" })
      .catch(() => undefined);
  } else {
    currentUserResponse = waitForCurrentUserResponse(page, expectedMeUrl);
    await page.goto(WEB_CANONICAL_LANDING_HREF);
  }

  const entry = await waitForAuthenticatedEntry(page);
  if (entry === "onboarding") {
    currentUserResponse?.catch(() => undefined);
    await completeOnboarding(page);
    // The onboarding fallback issues a real navigation, so the `/me` warm is
    // observable again here even on the ride path.
    currentUserResponse = waitForCurrentUserResponse(page, expectedMeUrl);
    await page.goto(WEB_CANONICAL_LANDING_HREF);
  }

  await ensureAuthenticatedShellReady(page);

  if (!currentUserResponse) {
    return;
  }

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

// Confirm the authenticated shell after the caller has already loaded the
// authenticated root (`/`) and pinned onboarding state. Rides the root's
// client-side redirect to the landing route rather than issuing a second full
// navigation (FEA-2298 AC-7a). Use this from the storageState sign-in flow.
export async function confirmAuthenticatedAppAfterRedirect(page: Page) {
  await enterAuthenticatedShell(page, { ride: true });
}

export async function gotoAuthenticatedApp(
  page: Page,
  path: string = WEB_CANONICAL_LANDING_HREF
) {
  await enterAuthenticatedShell(page);

  if (path !== WEB_CANONICAL_LANDING_HREF) {
    await page.goto(path);
    await ensureAuthenticatedShellReady(page);
  }
}

/**
 * The annotation the `apiOriginBridge` fixture leaves when it could not resolve
 * an API origin. Exported so a reader of a CI report and the test that pins the
 * behaviour name the same string.
 */
export const API_ORIGIN_BRIDGE_UNAVAILABLE_ANNOTATION =
  "api-origin-bridge-unavailable" as const;

/**
 * Install the API-origin bridge for one test, RECORDING a failure to resolve the
 * API origin rather than raising or swallowing it.
 *
 * Which of those three it does is the decision ISS-9799 exists to make once, and
 * it is forced by the hoist rather than by taste. `getApiBaseUrl()` throws on a
 * `BASE_URL` it cannot map to an API origin — a per-deployment hash alias with
 * no `API_BASE_URL` — and an `auto` fixture hands that dependency to every spec
 * in every project. Throwing would convert one lane's missing env var into a
 * total suite failure at fixture setup, strictly worse than the per-spec CORS
 * degradation this hoist set out to fix. Swallowing would rebuild the silence
 * that cost ISS-9783 a re-derivation from a CI trace. The annotation lands in
 * the same triage path that already carries `clerk-testing-token-unavailable`.
 *
 * ONLY the resolve step is guarded, and the narrowness is the point: a throw out
 * of `installConfiguredApiOriginBridge` itself means `context.route` failed on a
 * dying context, which is not an unresolvable origin and must not be reported as
 * one. Widening the `try` to cover both would let one annotation stand for two
 * unrelated causes, and the triage reader would chase the wrong one.
 *
 * `resolveApiOrigin` is injectable for one reason: it makes the failure branch
 * reachable from a test without mutating `process.env` in a worker that is
 * shared with every other spec in the run. `annotationSink` is `TestInfo`
 * narrowed to the one member this touches, so that test can pass a throwaway
 * array instead of pushing a real "unbridged" marker into a green run's report.
 */
export async function installApiOriginBridgeForTest(
  page: Page,
  annotationSink: Pick<TestInfo, "annotations">,
  resolveApiOrigin: () => string = getApiBaseUrl
): Promise<void> {
  let configuredApiOrigin: string;
  try {
    configuredApiOrigin = resolveApiOrigin();
  } catch (error) {
    const message = redactUrlDetails(
      error instanceof Error ? error.message : String(error)
    );
    annotationSink.annotations.push({
      type: API_ORIGIN_BRIDGE_UNAVAILABLE_ANNOTATION,
      description:
        "installConfiguredApiOriginBridge was skipped; client-side API reads run " +
        `unbridged and will be CORS-blocked on a preview alias: ${message}`,
    });
    return;
  }

  await installConfiguredApiOriginBridge(page, configuredApiOrigin);
}

const APP_ALIAS_PREFIX_REGEX = /^app-/;
const URL_IN_TEXT_REGEX = /https?:\/\/\S+/g;
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?]+$/;
const URL_DETAIL_REDACTION_MARKER = "[redacted]";

/**
 * The ONE preview API origin the bridge may replay to `API_BASE_URL`: the
 * counterpart the app itself derives from its own hostname (`app-…` → `api-…`).
 *
 * That derivation is the whole defect ISS-9799 bridges around, so reproducing it
 * exactly is what lets the proxy arm match on identity instead of on shape. A
 * non-preview app origin (localhost, the stable stage/prod hosts) derives
 * nothing and returns `null`, which is correct: no alias rewrite happens there,
 * so there is nothing to replay.
 */
/**
 * The origin the browser will ASK for, when the suite can derive it without
 * being told.
 *
 * Two shapes, and they are different problems. On a preview alias the app
 * rewrites its own hostname (`app-…` → `api-…`), so the origin is derived from
 * `BASE_URL`. On the ISS-10335 Clerk-free lane the app image has
 * `NEXT_PUBLIC_API_URL=http://localhost:3002` BAKED IN at build — the Clerk-gated
 * api — so the browser asks for that whatever host it was served from, and the
 * bridge replays it to `api-local`. Nothing in the URL says which is which,
 * which is why this is keyed on the project rather than on the origin's shape.
 */
function resolveDefaultBrowserApiOrigin(): string | null {
  if (isClerkFreeRun()) {
    return BAKED_BROWSER_API_ORIGIN;
  }
  return resolveBrowserApiOrigin(process.env.BASE_URL ?? "");
}

/**
 * `NEXT_PUBLIC_API_URL` as `e2e/compose.yml` bakes it into the app image. Its
 * one declaration on the suite side; a build arg is not readable at runtime, so
 * this is a literal by necessity rather than by choice.
 */
export const BAKED_BROWSER_API_ORIGIN = "http://localhost:3002";

export function resolveBrowserApiOrigin(appOrigin: string): string | null {
  let url: URL;
  try {
    url = new URL(appOrigin);
  } catch {
    return null;
  }

  if (!url.hostname.startsWith("app-")) {
    return null;
  }

  const candidate = `${url.protocol}//${url.hostname.replace(
    APP_ALIAS_PREFIX_REGEX,
    "api-"
  )}`;
  return isPreviewApiOrigin(candidate) ? candidate : null;
}

/**
 * Strip userinfo, path, query, and fragment from every URL in `message`, keeping
 * scheme and host.
 *
 * The annotation this feeds is written into the report of every spec in the run
 * and shipped as a CI artifact, and the message it carries is `getApiBaseUrl()`'s
 * — which interpolates the configured `BASE_URL` verbatim. A signed deployment
 * path, a bypass token, or embedded credentials there would be copied into that
 * artifact once per spec (davetho, PR #6921). The host survives because it IS
 * the diagnostic; the marker is emitted only where something was actually
 * dropped, so a bare origin still reads as itself.
 */
function redactUrlDetails(message: string): string {
  return message.replace(URL_IN_TEXT_REGEX, (match) => {
    const trailing = TRAILING_PUNCTUATION_REGEX.exec(match)?.[0] ?? "";
    const candidate = match.slice(0, match.length - trailing.length);

    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return match;
    }

    const carriesDetail =
      Boolean(url.username || url.password || url.search || url.hash) ||
      (url.pathname !== "" && url.pathname !== "/");
    const origin = `${url.protocol}//${url.host}`;
    return carriesDetail
      ? `${origin}${URL_DETAIL_REDACTION_MARKER}${trailing}`
      : `${origin}${trailing}`;
  });
}

/**
 * The sidebar affordances and the content region that together mean the
 * authenticated shell is on screen: its workspace trigger, its navigation, and
 * a main region with something in it.
 *
 * Each assertion names the affordance IT looked for, so the message a reader
 * gets is about the thing that was actually missing.
 *
 * Every locator here must be reachable with NO feature flag pinned, because
 * that is the condition most callers arrive in.
 */
async function expectShellRendered(
  page: Page,
  timeoutMs: number
): Promise<void> {
  await expect(
    authenticatedShellTrigger(page),
    `${SHELL_NOT_RENDERED}: ${NO_SHELL_TRIGGER_RENDERED}`
  ).toBeVisible({ timeout: timeoutMs });
  await expect(
    page.getByRole("link", { name: RE_DASHBOARD_NAV }).first(),
    `${SHELL_NOT_RENDERED}: ${NO_DASHBOARD_NAV_RENDERED}`
  ).toBeVisible({ timeout: timeoutMs });
  await expect(
    page.getByRole("main"),
    `${SHELL_NOT_RENDERED}: ${NO_CONTENT_RENDERED}`
  ).not.toBeEmpty({ timeout: timeoutMs });
}

const STALE_SOCKET_RESET_REGEX = /socket hang up|ECONNRESET/;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `route.fetch` runs on Playwright's process-wide keep-alive agent, which never
 * expires an idle socket, while the api's Node server closes one after its 5s
 * `keepAliveTimeout`. A request handed a socket in that instant is reset before
 * the api reads it (ISS-10807), a reset Chrome itself would resend. Resend once,
 * and only a read: a reset cannot prove a write went unread.
 *
 * The warn is the only record that a resend happened, so ISS-10807's signature
 * going quiet after merge can be told apart from the race being papered over.
 * That is why this is not `route.fetch({ maxRetries })`: Playwright would resend
 * where the bridge cannot see it, and the error `code` does not cross to this
 * side (only name, message and stack do), so the message is what we can match.
 */
async function fetchUpstream(route: Route, url: string) {
  try {
    return await route.fetch({ url });
  } catch (error) {
    const method = route.request().method();
    if (
      !(
        READ_METHODS.has(method) && STALE_SOCKET_RESET_REGEX.test(String(error))
      )
    ) {
      throw error;
    }
    console.warn(
      `[ISS-10807] bridged ${method} ${new URL(url).pathname} was reset on a pooled socket; resending once: ${String(error)}`
    );
    return route.fetch({ url });
  }
}
