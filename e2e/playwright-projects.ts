/**
 * Playwright project routing constants shared by `playwright.config.ts` and the
 * tooling that has to reason about which project a spec lands in.
 *
 * This exists so there is exactly one declaration of the `chromium` project's
 * exclusion set. The ISS-5214 `@smoke` guard needs it to enforce "the subset
 * must keep at least one `chromium` spec" — `chromium` is the browser lane that
 * carries the bulk of the suite AND declares the FEA-4124 `cleanup` teardown, so
 * a subset drifting to only `auth` / `unit` / `secondary` / `visual` / `admin`
 * specs would run without teardown and leak each run's seeded data.
 * (`chromium-clerk`, `chromium-secondary` and the stage-only `chromium-stage`
 * declare that teardown too, for the data their own lanes create; what the
 * guard is protecting is that the subset does not lose the one that owns most
 * of it.) Re-declaring the pattern in the
 * guard would make that check silently wrong the moment the config's routing
 * changed, which is the failure this module removes.
 *
 * Deliberately dependency-free (no `@playwright/test` import): the guard runs
 * under plain `node --experimental-strip-types`, with no bundler and no
 * Playwright runtime.
 */

/**
 * Specs the `chromium` project ignores, each owned by a dedicated project:
 * `auth.spec.ts` (live-Clerk sign-in), `*.unit.spec.ts` (offline pure-logic
 * guards), `visual-regression.spec.ts` (the local_trusted `visual` project),
 * `*.secondary.spec.ts` (the ISS-5119 second persona), `*.admin.spec.ts`
 * (the ISS-6096 org-admin persona, the second local_trusted project), and
 * `*.local-trusted.spec.ts` (the ISS-8470 `local-trusted` project).
 *
 * `*.admin.spec.ts` is here for the same reason `*.secondary.spec.ts` is: it
 * names an IDENTITY the primary storageState does not provide. `chromium` rides
 * the shared Clerk e2e account, whose org role is not `org:admin` on every
 * target, so an admin-gated surface renders its member treatment there and the
 * spec times out on a control that was never going to exist.
 *
 * `*.local-trusted.spec.ts` names a HOST instead: a spec whose project points it
 * at the local_trusted app rather than at the `BASE_URL` under test. Routing it
 * by filename is what keeps the choice visible to the config, to this module,
 * and to a lane that has to decide whether it can run the spec at all —
 * `branches-eligibility-truth` made that choice silently, with a file-level
 * `test.use({ baseURL })` from inside a `chromium` spec, and every stage
 * dispatch ran it against a host that was not listening (ISS-8470).
 */
/** Every `.` in a spec filename, escaped before it reaches a derived RegExp. */
const SPEC_NAME_DOT_PATTERN = /\./g;

export const CHROMIUM_IGNORED_SPEC_PATTERN =
  /(auth\.spec\.ts|\.unit\.spec\.ts|visual-regression\.spec\.ts|\.secondary\.spec\.ts|\.admin\.spec\.ts|\.local-trusted\.spec\.ts)/;

/**
 * True when a top-level `e2e/*.spec.ts` filename routes to the `chromium`
 * project — i.e. it runs on the Clerk-free pair and, load-bearingly, declares
 * the `cleanup` teardown.
 *
 * ISS-10335 added the second clause. `chromium` and `chromium-clerk` partition
 * the same population, so a spec named by {@link CHROMIUM_CLERK_SPECS} is
 * ignored here as surely as an `*.admin.spec.ts` is — without it both projects
 * would collect it and every one of those specs would run twice.
 */
export function isChromiumProjectSpec(fileName: string): boolean {
  return !(
    CHROMIUM_IGNORED_SPEC_PATTERN.test(fileName) ||
    CHROMIUM_CLERK_SPEC_PATTERN.test(fileName)
  );
}

/**
 * The one `AUTH_MODE=local_trusted` app instance (the `app-visual` compose
 * service). Declared here rather than in `playwright.config.ts` so the projects
 * that target it cannot name the host independently of one another — a second
 * literal is how `branches-eligibility-truth.spec.ts` came to name port 3003
 * independently of the config that owns it (ISS-8470).
 *
 * A FUNCTION rather than a module-level constant, and that is load-bearing
 * (tamsinb, PR #6198). `playwright.config.ts` loads `apps/app/.env.local` with
 * `config({ path })` in its module body, but a static `import` is hoisted above
 * every module-body statement, so this module finishes initializing BEFORE that
 * dotenv call runs. A constant here would therefore read `process.env` too early
 * and always take the fallback, silently ignoring a `VISUAL_BASE_URL` set in
 * `.env.local` — which is exactly the override this doc promises. Reading at
 * call time puts the read back after the dotenv load, where the config's
 * `defineConfig({ … })` and every spec module already are.
 *
 * The env var keeps its `VISUAL_` name because `e2e/global.setup.ts` reads that
 * exact name to enforce the non-CI localhost-only guard; renaming it here
 * without renaming it there would drop every local_trusted spec out of that
 * guard.
 */
export function localTrustedBaseUrl(): string {
  return process.env.VISUAL_BASE_URL ?? LOCAL_TRUSTED_FALLBACK_BASE_URL;
}

/**
 * The `api-local` compose service — the Clerk-free API every project in
 * {@link CLERK_FREE_PROJECTS} reads (ISS-10335).
 *
 * A function, for the same hoisting reason {@link localTrustedBaseUrl} is one:
 * `playwright.config.ts` loads `apps/app/.env.local` in its module body, and a
 * module-level constant here would be initialized before that runs.
 */
export function localTrustedApiBaseUrl(): string {
  return (
    process.env.E2E_LOCAL_TRUSTED_API_BASE_URL ??
    LOCAL_TRUSTED_FALLBACK_API_BASE_URL
  );
}

/**
 * The `storybook` compose service (ISS-10535) — a static Storybook, and the one
 * host that serves a `GridTableV2` mounted with both `enableRowRangeDrag` and
 * `onGroupDrop`. Only the containerized lane starts it.
 *
 * Declared HERE rather than in the spec that reads it, for the reason this
 * module's own docblocks give one service over: a host named independently of
 * the compose file that publishes it is how `branches-eligibility-truth.spec.ts`
 * came to carry its own copy of port 3003 (ISS-8470). The override variable is
 * the same one `e2e/compose.yml` publishes through, so the two cannot disagree.
 *
 * A FUNCTION for the hoisting reason {@link localTrustedBaseUrl} states:
 * `playwright.config.ts` loads `apps/app/.env.local` in its module body, after
 * every static import has already been evaluated.
 */
export function storybookBaseUrl(): string {
  const port =
    process.env.E2E_STORYBOOK_HOST_PORT || STORYBOOK_FALLBACK_HOST_PORT;
  return `http://localhost:${port}`;
}

/** The repository's mock-data prototype app on its container-published port. */
export function prototypeBaseUrl(): string {
  const port = process.env.E2E_PROTOTYPE_HOST_PORT || "53030";
  return `http://localhost:${port}`;
}

/**
 * Projects whose `baseURL` is the local_trusted app, NOT the `BASE_URL` under
 * test. They need a server on {@link localTrustedBaseUrl}, which only the
 * containerized lane (`e2e/compose.yml`) starts — so a lane pointed at a
 * deployed app must not select them, and `STAGE_PROJECTS` below is that
 * selection rather than its complement.
 */
export const LOCAL_TRUSTED_PROJECTS = [
  "visual",
  "admin",
  "local-trusted",
] as const;

export type LocalTrustedProject = (typeof LOCAL_TRUSTED_PROJECTS)[number];

/**
 * EVERY project whose `baseURL` is the local_trusted app — the three above plus
 * `chromium`, which ISS-10335 moved onto the Clerk-free pair.
 *
 * Deliberately a superset rather than a widened {@link LOCAL_TRUSTED_PROJECTS}:
 * that one is keyed to {@link LOCAL_TRUSTED_SPEC_PATTERNS}, and `chromium` is
 * the one project with no `testMatch` at all, so it has no pattern to declare
 * there. What a lane pointed at a DEPLOYED app must not select is this list; it
 * is `STAGE_PROJECTS` that says what it may.
 */
export const LOCAL_TRUSTED_HOSTED_PROJECTS = [
  ...LOCAL_TRUSTED_PROJECTS,
  "chromium",
] as const;

/**
 * Browser projects that run against the Clerk-free app/API pair, where the
 * synthetic server-side session is the identity and `window.Clerk` never
 * hydrates a user (ISS-10335).
 *
 * The suite reads this to decide five things, all of which are the same
 * decision: skip the live Clerk testing-token install, resolve the API origin
 * to the Clerk-free api, hand back the inert placeholder bearer instead of
 * minting a Clerk one, refuse to wait for a `window.Clerk` user that is never
 * coming, and scope a saved-view storage key by the synthetic ids rather than
 * that user. The Clerk FAPI fixtures are deliberately NOT on that list; since
 * ISS-12054 this lane mounts no `ClerkProvider`, so they intercept nothing here
 * and stay only so a page that does load Clerk cannot reach live FAPI (see
 * `clerkMembershipFixture` in `e2e/test.ts`).
 *
 * `unit` is deliberately absent even though it touches no Clerk instance: its
 * specs assert the PREVIEW-alias behaviour of the API-origin bridge, so
 * re-pointing their API origin would change what they measure.
 */
export const CLERK_FREE_PROJECTS = [
  "chromium",
  ...LOCAL_TRUSTED_PROJECTS,
] as const;

export type ClerkFreeProject = (typeof CLERK_FREE_PROJECTS)[number];

/** True when `projectName` runs against the Clerk-free app/API pair. */
export function isClerkFreeProject(projectName: string | undefined): boolean {
  return CLERK_FREE_PROJECTS.some((project) => project === projectName);
}

/**
 * The env var that declares a run to BE the stage lane, and the only
 * declaration of that name: `staging-integration-tests.yml` sets it on its
 * Playwright step, `playwright.config.ts` appends `chromium-stage` when it is
 * set, and nothing else sets it.
 *
 * A switch rather than an unconditional project, and that is the whole reason
 * it exists. Every other lane — the containerized runner and every merge group
 * — invokes `playwright test` with no `--project` at all, which runs EVERY
 * declared project; `chromium-stage` collects everything `chromium` collects
 * (and the `chromium-clerk` allowlist besides), so an unconditional declaration
 * would run the entire browser suite a second time on every one of those runs.
 */
export const STAGE_LANE_ENV = "E2E_STAGE_LANE";

/** The value {@link STAGE_LANE_ENV} must carry for `chromium-stage` to exist. */
export const STAGE_LANE_ENV_VALUE = "1";

/**
 * True when this process is the stage lane, so `chromium-stage` is declared.
 *
 * Takes the environment rather than reading `process.env` itself, for the
 * hoisting reason {@link localTrustedBaseUrl} states: `playwright.config.ts`
 * loads `apps/app/.env.local` in its module body, after every static import has
 * already been evaluated.
 */
export function isStageLaneRun(env: NodeJS.ProcessEnv): boolean {
  return env[STAGE_LANE_ENV] === STAGE_LANE_ENV_VALUE;
}

/**
 * The projects a lane aimed at a DEPLOYED app may run — every project whose
 * specs actually resolve against `BASE_URL`, plus the offline `unit` guards.
 *
 * `cleanup` is deliberately absent: it is a teardown of `chromium-stage` and
 * `chromium-secondary`, and Playwright schedules a selected project's
 * dependencies and teardown itself. Naming it here would not add coverage and
 * would invite it being run without the projects it exists to clean up after.
 *
 * ISS-8470: `staging-integration-tests.yml` builds its `--project` arguments
 * from this list, and `scripts/deploy/staging-integration-project-scope.test.ts`
 * pins the two together in both directions.
 *
 * ISS-10335 moved `chromium` onto the Clerk-free pair on localhost, which no
 * deploy serves, so it cannot be selected here at all — the same constraint the
 * three local_trusted projects have always had. `chromium-stage` is what takes
 * its place, and it is a re-hosting rather than a reduction: everything
 * `chromium` collects, under the live Clerk session, against the deployed app.
 * So the stage lane keeps the whole `@smoke` browser set it had before that
 * ticket. It exists only while {@link STAGE_LANE_ENV} is set, which is this lane
 * and nothing else.
 *
 * `chromium-clerk` is deliberately NOT here. Its allowlist is a SUBSET of what
 * `chromium-stage` collects — that project's only `testIgnore` is
 * {@link CHROMIUM_IGNORED_SPEC_PATTERN}, because on a deployed target every spec
 * is a live-Clerk spec — so naming both would run every allowlisted spec twice.
 */
export const STAGE_PROJECTS = [
  "setup",
  "auth",
  "unit",
  "chromium-stage",
  "setup-secondary",
  "chromium-secondary",
] as const;

/**
 * The tag naming the `@smoke` subset, and the ONLY declaration of that literal —
 * `scripts/deploy/e2e-smoke-list.ts` re-exports this as `DEFAULT_SMOKE_TAG`
 * rather than spelling it a second time.
 *
 * It lives beside {@link STAGE_PROJECTS} because the two are the two halves of
 * one question: what does a lane pointed at a DEPLOYED app run? `--project`
 * answers which projects may resolve against `BASE_URL`; this answers which
 * tests within them are worth a per-deploy signal. Splitting the halves across
 * two modules is what would make "what does the stage lane run" a two-file
 * question with no single place to reason about the answer (ISS-8471).
 *
 * ISS-8471: `staging-integration-tests.yml` selects with `--grep` on this tag,
 * because the stage lane cannot finish its suite and never could. 486 tests at
 * one worker need ~29 minutes against a 10-minute step budget, so every dispatch
 * ran an alphabetical PREFIX (136 of 486 on run 33903265987) and then reddened
 * on the timeout — all 16 executions measured over the three hours to
 * 2026-09-04T17:57Z did exactly that. The `@smoke` subset is what the PR tier
 * already runs, already bounded (`SMOKE_MAX_SPECS`, `SMOKE_MAX_TAG_SITES`) and
 * already documented per member; reusing it buys a lane that can conclude
 * instead of a second subset to govern.
 *
 * It DOES add a second BOUND, which is not the same thing and is worth saying
 * plainly: `staging-integration-timeout-budget.test.ts` prices the selection
 * against the stage step budget and fails at 26 selected tests, which is tighter
 * than either ceiling above and is stated beside them in
 * `scripts/deploy/e2e-smoke-list.ts` and `e2e/AGENTS.md`. One subset, one
 * membership contract — but three numbers now bound it.
 *
 * NOTHING IS DROPPED FROM THE SUITE BY THIS. `merge_group` remains the
 * authoritative full-suite gate and the ISS-4519 nightly still runs everything;
 * what the stage lane gives up is the per-deploy signal on the specs outside
 * this subset — a signal it was never completing anyway.
 */
export const SMOKE_TAG = "@smoke";

/**
 * The specs that stay on a LIVE Clerk session (ISS-10335), and the only
 * declaration of that set — `playwright.config.ts` builds `chromium-clerk`'s
 * `testMatch` from it and `isChromiumProjectSpec` subtracts it, so the two
 * projects partition the population from one list.
 *
 * Membership rule, applied per file: the spec signs in, asserts Clerk session
 * behaviour (token refresh, 401 recovery, the FAPI bootstrap), exercises
 * Clerk-backed data (invitations, org memberships, a second org), or sets
 * `realExternalDeps`. Everything else runs on the Clerk-free pair, where the
 * identity is the synthetic server-side session. When a file was genuinely
 * ambiguous it was LEFT HERE — this list is the conservative side.
 */
export const CHROMIUM_CLERK_SPECS = [
  // ISS-11826: real email signup creates a fresh pending, orgless Clerk session.
  "desktop-signup-orgless.spec.ts",
  // ISS-11253: the first user's editable organization name renders only where
  // the session has an ACTIVE organization, and `useOrganization()` is not
  // lane-aware — the Clerk-free pair reports none, so the step falls back to its
  // pending row and the surface under test does not exist there.
  "guided-onboarding-first-user-rename.spec.ts",
  // Asserts the worker memo over Clerk's `/v1/environment` bootstrap: the
  // contract IS live-FAPI request volume.
  "clerk-environment-memo.spec.ts",
  // Proves the universal Clerk membership fixture shields a live-FAPI outage.
  // That fixture is not installed on a Clerk-free project, so the spec would be
  // asserting the absence of something that was never there.
  "external-dependency-isolation.spec.ts",
  // The org-member persona plus 401-recovery: a Clerk membership ROLE decides
  // what renders, and the synthetic session reports exactly one fixed role.
  "org-member-shell-integrity.spec.ts",
  // Mints, spends and revokes a real API key through the product while
  // authenticated as the Clerk session — nothing on that path is mocked.
  "settings-api-key-lifecycle.spec.ts",
  // Spends a real API key on routes that must refuse it (ISS-11409); the
  // synthetic session would answer those routes for any bearer.
  "api-key-route-authority.spec.ts",
  // Team creation and the Clerk-backed invite flow.
  "teams.spec.ts",
  // Creates project documents through the live API and verifies their
  // hierarchy through the authenticated Project Detail surface.
  "project-hierarchical-gridview.spec.ts",
  // The invite spotlight anchors to a Clerk invitation row. Kept here as the
  // conservative call: its fixtures are local, but the row it measures is not.
  "invite-spotlight.spec.ts",
  // Crossing between two Clerk orgs; the synthetic session has exactly one.
  "cross-org-nav-identity.spec.ts",
  // Asserts that a SIGNED-OUT `/` redirects to sign-up, which cannot happen on
  // an app whose server always resolves a session.
  "landing.spec.ts",
  // Drives the desktop authorize/consent page, which mints a desktop session
  // from the Clerk session it is standing on.
  "desktop-authorize.spec.ts",
  // Asserts the SIGNED-OUT deep link: `clearCookies()` is how it signs out, and
  // on the Clerk-free pair the identity is decided server-side, so clearing
  // cookies cannot produce a signed-out request at all. (PR #7370: both of its
  // signed-out cases failed on the Clerk-free lane, one tripping the session
  // guard on a live `/v1/client/sign_ins`.)
  "github-connect-deep-link.spec.ts",
  // Asserts the SIGNED-OUT transition routes with a real Clerk call held open
  // past the stall ceiling (ISS-10564). `clearCookies()` is how it signs out,
  // which the Clerk-free pair cannot produce, and the phase it asserts exists
  // only while a live FAPI request is genuinely outstanding.
  "auth-transition-stall-ceiling.spec.ts",
  // Holds a real Clerk linking call open past the stall ceiling (ISS-10411).
  // The phase it asserts exists only while createExternalAccount or the
  // registry sync is genuinely outstanding, and the Clerk-free pair has no live
  // Clerk client to leave one outstanding, so the still-connecting panel never
  // renders. Measured on PR #7459: two merge-queue ejections, the same
  // element-not-found on all three attempts, because the spec predates this
  // split and inherited the Clerk-free pair by default.
  "github-clerk-link-slow-request.spec.ts",
] as const;

/**
 * {@link CHROMIUM_CLERK_SPECS} as one matcher, derived rather than written out
 * so the list stays the single declaration. Anchored at the end so a longer
 * filename ending in a member's name cannot be swallowed by it.
 */
export const CHROMIUM_CLERK_SPEC_PATTERN = new RegExp(
  `(?:^|/)(?:${CHROMIUM_CLERK_SPECS.map((spec) => spec.replace(SPEC_NAME_DOT_PATTERN, String.raw`\.`)).join("|")})$`
);

/** Read only by {@link localTrustedBaseUrl}, so the read stays lazy. */
const LOCAL_TRUSTED_FALLBACK_BASE_URL = "http://localhost:3003";

/** Read only by {@link localTrustedApiBaseUrl}, so the read stays lazy. */
const LOCAL_TRUSTED_FALLBACK_API_BASE_URL = "http://localhost:3004";

/** Read only by {@link storybookBaseUrl}, so the read stays lazy. */
const STORYBOOK_FALLBACK_HOST_PORT = "56006";

/**
 * The `testMatch` each local_trusted project collects by, and the ONLY
 * declaration of them — `playwright.config.ts` builds its three project
 * definitions from this record rather than restating the patterns.
 *
 * Typed `Record<LocalTrustedProject, RegExp>` so it cannot be written without
 * naming every member: a fourth local_trusted project fails `tsc` here until its
 * pattern is declared, instead of compiling and quietly widening
 * {@link isStageCollectedSpec} to report a spec that legitimately chooses the
 * local_trusted host as an override (davetho, PR #6198).
 */
export const LOCAL_TRUSTED_SPEC_PATTERNS: Record<LocalTrustedProject, RegExp> =
  {
    visual: /visual-regression\.spec\.ts/,
    admin: /\.admin\.spec\.ts/,
    "local-trusted": /\.local-trusted\.spec\.ts/,
  };

/**
 * True when a test file under `e2e/` can reach a lane that selects
 * {@link STAGE_PROJECTS} — which is the same question as "does it run on the
 * host its PROJECT was given", so selecting its own `baseURL` from inside the
 * file is a defect. Both callers ask one of those two, and they are one
 * predicate: everything except the three local_trusted projects' specs.
 *
 * ISS-10335 briefly split this in two, when `chromium` moved to the Clerk-free
 * pair and its specs stopped reaching any deployed lane. `chromium-stage`
 * re-hosts that same population on stage, so the two questions coincide again
 * and one function answers both rather than two drifting apart.
 *
 * Deliberately the COMPLEMENT of the local_trusted set rather than a union of
 * per-project `testMatch` patterns. `chromium` and `chromium-stage` are
 * `testIgnore`-shaped, so a union would be a set of matchers that have to be
 * kept right, and an under-modelled one silently drops files out of the
 * population — the guard would then pass by looking at less. The complement can
 * only ever over-include, so a new project needs no edit here (whitlockk /
 * davetho, PR #6198).
 *
 * Scoped claim, because the first version of this doc overclaimed. The
 * complement is sound over the PROJECT axis only; it says nothing about what
 * feeds it. A caller that decides collectibility with too narrow a filename
 * test never presents the file here at all, and this function cannot see the
 * difference — which is exactly how a `*.spec.tsx` selecting the local_trusted
 * host stayed invisible to the guard. {@link isCollectibleTestFile} is the half
 * that has to mirror Playwright's own matching.
 *
 * Takes a path RELATIVE to `e2e/`, not a bare filename: Playwright collects
 * recursively from `testDir`, so a nested spec is as reachable as a top-level
 * one.
 */
export function isStageCollectedSpec(specPath: string): boolean {
  return !Object.values(LOCAL_TRUSTED_SPEC_PATTERNS).some((pattern) =>
    pattern.test(specPath)
  );
}

/**
 * True when Playwright can collect this file into ANY project in
 * `playwright.config.ts` — i.e. when it can carry a `test.use({ baseURL })`.
 *
 * TWO halves, because the config has two kinds of project. `chromium` — and
 * `chromium-stage`, which the stage lane adds — declare no `testMatch`, so they
 * take Playwright's DEFAULT ({@link matchesDefaultTestMatch}). The other TEN
 * each declare one, and every one of those is unioned in here from the same
 * constant the config itself uses — {@link EXPLICIT_TEST_MATCH_PATTERNS}.
 *
 * Both halves have already been got wrong. Writing `*.spec.ts` for the default
 * missed a `*.spec.tsx` and a nested `*.test.ts`; unioning only two of the nine
 * explicit patterns missed `auth.spec.ts-helpers/probe.ts`, which the `auth`
 * project collects because its `testMatch` is an UNANCHORED regex run against
 * the absolute path, so it matches a DIRECTORY carrying the same substring.
 * Both reached the stage lane past a green guard.
 *
 * What still is not proven here: a tenth project added with an inline regex
 * rather than a shared constant. Nothing in this module can see that, but the
 * `playwright-spec-outside-testdir` source gate fails on ANY change to the
 * config's `testMatch`/`testIgnore` set and prints the derived list, so an
 * inline literal shows up as a literal in the re-pin it forces.
 */
export function isCollectibleTestFile(specPath: string): boolean {
  return (
    matchesDefaultTestMatch(specPath) ||
    EXPLICIT_TEST_MATCH_PATTERNS.some((pattern) => pattern.test(specPath))
  );
}

/**
 * Playwright's default `testMatch` glob, `**\/*.@(spec|test).?(c|m)[jt]s?(x)`,
 * evaluated the way Playwright evaluates it — and it is NOT uniformly
 * case-sensitive, which is why this is a function and not one regex.
 *
 * `playwright/lib/util.js` runs the glob through `minimatch(…, { nocase: true
 * })`, so the `spec`/`test` TOKEN is case-blind: `probe.Spec.ts` and
 * `probe.TEST.tsx` are collected. The EXTENSION is not, because the runner's
 * allow-list compares it literally, so `probe.spec.TS` is NOT. `nocase` is
 * hardcoded rather than derived from `process.platform`, so this holds on the
 * Linux runner too. Pinned against the installed Playwright by the oracle case
 * in `scripts/deploy/staging-integration-project-scope.test.ts` rather than
 * left as a transcription anyone has to trust.
 */
function matchesDefaultTestMatch(specPath: string): boolean {
  return (
    DEFAULT_TEST_MATCH_TOKEN.test(specPath) &&
    DEFAULT_TEST_MATCH_EXTENSION.test(specPath)
  );
}

const DEFAULT_TEST_MATCH_TOKEN = /\.(?:spec|test)\.[cm]?[jt]sx?$/iu;
const DEFAULT_TEST_MATCH_EXTENSION = /\.[cm]?[jt]sx?$/u;

/** The `setup` `testMatch`, and its only declaration. */
export const SETUP_SPEC_PATTERN = /.*\.setup\.ts/;

/** The `auth` `testMatch`, and its only declaration. */
export const AUTH_SPEC_PATTERN = /auth\.spec\.ts/;

/** The `unit` `testMatch`, and its only declaration. */
export const UNIT_SPEC_PATTERN = /\.unit\.spec\.ts/;

/** The `setup-secondary` `testMatch` (ISS-5119), and its only declaration. */
export const SECONDARY_PERSONA_SETUP_PATTERN = /auth-secondary\.setup\.ts/;

/** The `chromium-secondary` `testMatch` (ISS-5119), and its only declaration. */
export const SECONDARY_PERSONA_SPEC_PATTERN = /\.secondary\.spec\.ts/;

/** The `cleanup` teardown `testMatch`, and its only declaration. */
export const TEARDOWN_SPEC_PATTERN = /teardown\.ts/;

/**
 * Every `testMatch` declared in `playwright.config.ts` — all ten of them.
 * `chromium` and `chromium-stage` are deliberately absent: neither declares
 * one, so both take Playwright's default.
 */
const EXPLICIT_TEST_MATCH_PATTERNS = [
  SETUP_SPEC_PATTERN,
  AUTH_SPEC_PATTERN,
  UNIT_SPEC_PATTERN,
  CHROMIUM_CLERK_SPEC_PATTERN,
  SECONDARY_PERSONA_SETUP_PATTERN,
  SECONDARY_PERSONA_SPEC_PATTERN,
  TEARDOWN_SPEC_PATTERN,
  ...Object.values(LOCAL_TRUSTED_SPEC_PATTERNS),
];

/**
 * How many tests the stage lane lets fail before it stops, and the ONLY
 * declaration of that number. `staging-integration-tests.yml` passes it as
 * `--max-failures` (pinned by equality in
 * `scripts/deploy/staging-integration-project-scope.test.ts`), and
 * `scripts/deploy/staging-integration-timeout-budget.test.ts` sizes the step's
 * failure allowance from it.
 *
 * ISS-9210. Playwright counts a test toward this only once its LAST retry has
 * failed, so a flaky pass-on-retry never moves it. Without a bound, a broadly
 * broken stage spent the whole step on retries and died on the step timeout,
 * which kills Playwright before it prints its summary or writes the HTML
 * report. With it, the run stops at the third deterministic red and reports
 * all three. The cost is the specs after that point, which do not run on a lane
 * that has already failed three times.
 */
export const STAGE_MAX_FAILURES = 3;

/**
 * Projects that need no live Clerk instance to start: the Clerk-free pair's
 * browser projects plus the offline `unit` guards.
 *
 * `unit` is here and deliberately NOT in {@link CLERK_FREE_PROJECTS} — the two
 * lists answer different questions. That one decides where a test's API reads
 * and bearer come from, which `unit` must keep taking from the live-Clerk side
 * because its own bridge spec measures the preview-alias behaviour. This one
 * decides whether the RUN has to mint a Clerk Backend API token before it can
 * start, and a pure-logic guard never does.
 */
export const CLERK_LESS_PROJECTS = [...CLERK_FREE_PROJECTS, "unit"] as const;

/**
 * True when this Playwright invocation selects at least one project that rides a
 * live Clerk session, so `e2e/global.setup.ts` must mint a testing token first.
 *
 * ISS-10335 (davetho, PR #7370). `clerkSetup()` was unconditional, which left
 * the Clerk-free lane depending on exactly the service this ticket removes from
 * its path: `--project=chromium` could not START while Clerk was rate-limited or
 * its credentials were absent, however little the specs then went on to use it.
 *
 * FAIL-SAFE in both directions, because the cost of the two mistakes is not
 * symmetric — a needless token is one Backend API call, a missing one fails
 * every live-Clerk spec on the lane. So: no `--project` at all selects EVERY
 * declared project (the containerized gate and the nightly run this way), which
 * is answered `true`; and a selected name this module does not recognise — a
 * project added later, or Playwright's `--project=chrom*` wildcard — is answered
 * `true` as well rather than assumed offline.
 *
 * Reads the RUN's argv rather than `FullConfig.projects`, which is the full
 * declared list and is NOT narrowed by `--project` (verified against the
 * installed Playwright; the guard in `e2e/clerk-free-lane.unit.spec.ts` pins the
 * parse against both spellings).
 */
export function runNeedsLiveClerk(argv: readonly string[]): boolean {
  const selected = selectedProjectNames(argv);

  if (selected.length === 0) {
    return true;
  }

  return selected.some(
    (name) => !CLERK_LESS_PROJECTS.some((project) => project === name)
  );
}

/**
 * The project names a Playwright argv selects, in both spellings the CLI
 * accepts (`--project=name` and `--project name`), repeated flags included.
 * Empty when the invocation names none.
 */
export function selectedProjectNames(argv: readonly string[]): string[] {
  const names: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === PROJECT_FLAG) {
      const value = argv[index + 1];
      // A following flag means this `--project` carried no value at all; leave
      // it to Playwright's own argument validation rather than consuming one.
      if (value !== undefined && !value.startsWith("-")) {
        names.push(value);
        index += 1;
      }
      continue;
    }

    if (arg.startsWith(PROJECT_FLAG_ASSIGNMENT)) {
      names.push(arg.slice(PROJECT_FLAG_ASSIGNMENT.length));
    }
  }

  return names;
}

/** Read only by {@link selectedProjectNames}. */
const PROJECT_FLAG = "--project";

/** Read only by {@link selectedProjectNames}. */
const PROJECT_FLAG_ASSIGNMENT = `${PROJECT_FLAG}=`;
