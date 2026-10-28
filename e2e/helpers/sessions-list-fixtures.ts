import type { Page } from "@playwright/test";
import type {
  AgentSessionListItem,
  AgentSessionUsageSummary,
} from "@repo/api/src/types/agent-session";
import { ArtifactType } from "@repo/api/src/types/artifact.ts";
import { listRequestUrl } from "@repo/api/src/types/list-query-request-params";
import type { ProjectWithDetails } from "@repo/api/src/types/project";
import { SESSION_STATUS } from "@repo/api/src/types/session-status.ts";
import {
  SessionSortDir,
  SessionSortKey,
} from "@repo/app/agents/lib/session-sort-group";
import type { SessionsColumnId } from "@repo/app/agents/lib/sessions-table-columns";
import { SESSIONS_COLUMN_SPECS } from "@repo/app/agents/lib/sessions-table-columns";
import { z } from "zod";
import { currentUser, success } from "./mock-users";
import { installMockedFeatureFlags } from "./shell-fixtures";

/**
 * Shared route mocks, row/summary builders, and the request/column readers for
 * specs that drive the REAL Sessions list route with a synthetic corpus, rather
 * than seeding a database. Extracted so the ISS-4891 / ISS-4888 / ISS-4770
 * layout+semantics spec and its siblings share one fixture instead of each
 * carrying a copy of the same 30-field `AgentSessionListItem` builder
 * (`packages/app/AGENTS.md` — shared test fixtures live in the nearest shared
 * module).
 *
 * Modeled on `sessions-cost-unknown.spec.ts`, which stubs the platform reads with
 * `page.route` and asserts rendered output, so no containerized DB seeding is
 * needed for a list-shape regression.
 */

/** Only the field the echo above needs; the spec asserts the whole body. */
const MOVE_BODY_SCHEMA = z.object({ artifactId: z.string() });

/**
 * The two platform paths {@link installProjectWriteMocks} claims, exactly.
 *
 * A doubly-wildcarded `projects` glob claims every URL with that word anywhere in it —
 * `/projects/favorites`, a `POST /projects` create, a `/teams/x/projects/y` read
 * — and would answer all of them with this two-row list and a 200 (tamsinb
 * review). `e2e/AGENTS.md` wants a route mock to claim a CLOSED set, and the
 * source gate does not inspect string globs, so the glob is only the cheap
 * prefilter: the handler re-checks method AND exact pathname and `fallback()`s
 * anything else, the same shape `agent-component-inventory-page.ts` uses.
 */
const PROJECTS_PATH = "/projects";
const BATCH_MOVE_PATH = "/artifact-links/batch-move";
const PROJECTS_URL_GLOB = `**${PROJECTS_PATH}**`;
const BATCH_MOVE_URL_GLOB = `**${BATCH_MOVE_PATH}**`;

/** Strip the `/api` proxy prefix so one predicate matches both origins. */
function platformPath(pathname: string): string {
  return pathname.startsWith("/api/")
    ? pathname.slice("/api".length)
    : pathname;
}

const BASE_TIME = "2026-06-10T12:00:00.000Z";
const SESSIONS_FIXTURE_ORG = "closedloop-ai";

/** The real authenticated Sessions list route these fixtures are built for. */
export const SESSIONS_LIST_URL = `/${SESSIONS_FIXTURE_ORG}/sessions`;

export type SessionRowOverrides = Partial<AgentSessionListItem> & {
  /** Distinguishes generated ids/timestamps when building a cohort. */
  index?: number;
};

/**
 * One synthetic Sessions row. Every field the list renders is populated with a
 * deterministic value so a rendered assertion cannot drift with the clock; pass
 * overrides for the dimension under test.
 */
export function sessionListRow(
  overrides: SessionRowOverrides = {}
): AgentSessionListItem {
  const { index = 1, ...rest } = overrides;
  const timestamp = new Date(Date.parse(BASE_TIME) + index * 60_000);
  return {
    agentCount: 1,
    awaitingInputSince: null,
    baseBranch: "main",
    billingMode: "api",
    branch: "sessions-fixture",
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    computeTarget: {
      id: "compute-target-sessions-fixture",
      isOnline: true,
      lastSeenAt: timestamp,
      machineName: "MacBook Pro",
    },
    cwd: "/workspace/closedloop-ai",
    endedAt: timestamp,
    errorCount: 0,
    estimatedCost: 12.5,
    externalSessionId: `external-sessions-fixture-${index}`,
    harness: "claude",
    id: `sessions-fixture-${index}`,
    inputTokens: 240_000,
    lastActivityAt: timestamp,
    model: "claude-opus-5",
    name: `Sessions fixture session ${index}`,
    outputTokens: 60_000,
    project: null,
    repositoryFullName: "closedloop-ai/closedloop-ai",
    slug: null,
    sourceArtifact: null,
    sourceArtifactId: null,
    sourceLoopId: null,
    startedAt: new Date(BASE_TIME),
    status: SESSION_STATUS.INACTIVE,
    toolUseCount: 12,
    updatedAt: timestamp,
    user: {
      avatarUrl: null,
      email: "sessions-fixture@example.com",
      firstName: "Sessions",
      id: "user-sessions-fixture",
      lastName: "Fixture",
    },
    worktreePath: "/workspace/closedloop-ai-fixture",
    ...rest,
  };
}

/**
 * FEA-4209 / FEA-4210: the slug of the linked issue {@link linkedEntitiesRow}
 * carries, and the project it is parented to.
 *
 * Exported because a spec asserting the `Linked issues` chip's destination has
 * to build the same `/documents/{slug}` route the page's own builder produces, and
 * a hand-typed second copy is what lets the two drift.
 */
export const SESSIONS_FIXTURE_ISSUE_SLUG = "FEA-4210";
export const SESSIONS_FIXTURE_ISSUE_TITLE = "Linked issues column";
export const SESSIONS_FIXTURE_PROJECT_NAME = "Platform Core";
export const SESSIONS_FIXTURE_PROJECT_ID = "project-sessions-fixture";

/**
 * The slice of the real `/projects` row that the Owning project cell reads.
 *
 * `Pick` of `ProjectWithDetails` rather than a hand-rolled shape (tamsinb
 * review): the fixture is then checked against the type the route really
 * returns, so renaming a field on the API type reds this file, while the fixture
 * still claims only the three fields under test instead of fabricating the rest.
 */
type SessionsFixtureProject = Pick<ProjectWithDetails, "id" | "name" | "slug">;

/**
 * A SECOND project, so a spec can file a row somewhere else. One project cannot
 * tell a picker that writes the chosen id from one that writes the shown id.
 */
export const SESSIONS_FIXTURE_TARGET_PROJECT: SessionsFixtureProject = {
  id: "project-sessions-fixture-target",
  name: "Developer Tooling",
  slug: "developer-tooling",
};
/** The org these fixtures' rows and routes belong to. */
export const SESSIONS_FIXTURE_ORG_SLUG = SESSIONS_FIXTURE_ORG;

/**
 * A row that actually POPULATES the two linked-entity dimensions.
 *
 * `sessionListRow` leaves `project` null and omits `linkedArtifacts` entirely —
 * honest defaults for the rows most specs need, but it meant no web E2E ever
 * entered the `Owning project` cell, the `Linked issues` cell, or the page's
 * production issue-route builder (whitlockk review). Lives here rather than inline
 * in one spec so the next spec that needs a linked row does not re-derive the
 * shape.
 */
export function linkedEntitiesRow(
  overrides: SessionRowOverrides = {}
): AgentSessionListItem {
  return sessionListRow({
    linkedArtifacts: [
      {
        documentType: "FEATURE",
        id: "artifact-sessions-fixture-issue",
        name: SESSIONS_FIXTURE_ISSUE_TITLE,
        role: "referenced",
        slug: SESSIONS_FIXTURE_ISSUE_SLUG,
      },
    ],
    project: {
      id: SESSIONS_FIXTURE_PROJECT_ID,
      name: SESSIONS_FIXTURE_PROJECT_NAME,
      slug: "platform-core",
    },
    ...overrides,
  });
}

/** A zeroed usage summary; pass the few figures the assertion depends on. */
export function sessionsUsageSummary(
  overrides: Partial<AgentSessionUsageSummary> = {}
): AgentSessionUsageSummary {
  return {
    apiEstimatedCost: 0,
    byHarness: [],
    byModel: [],
    byRepository: [],
    byUser: [],
    earliestSessionAt: null,
    lastSyncTargets: [],
    latestSessionAt: null,
    subscriptionEstimatedCost: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalEstimatedCost: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalSessions: 0,
    viewerScope: "organization",
    ...overrides,
  };
}

/**
 * Route-mock the authenticated shell plus the Sessions list + usage reads.
 *
 * `listRequests`, when supplied, collects each list request URL so a spec can
 * assert what the surface asked the server for AFTER an awaited UI state proves
 * the handler ran — the route handler itself stays side-effect-only.
 */
export async function installSessionsListMocks(
  page: Page,
  input: {
    rows: AgentSessionListItem[];
    usage?: AgentSessionUsageSummary;
    featureFlags?: Record<string, boolean>;
    listRequests?: string[];
    /**
     * ISS-5579: serve `rows` as one PAGE of a larger corpus, honoring the
     * request's `limit`/`offset` and reporting {@link total} as the population.
     *
     * Off by default so every existing caller keeps the whole-corpus behavior it
     * was written against. A pagination or rows-per-page assertion needs the
     * mock to actually slice, or the control under test can stop sending
     * `limit`/`offset` entirely and the spec stays green.
     */
    paginate?: boolean;
    /** Apply the request's status facet before slicing a synthetic page. */
    honorStatusFilter?: boolean;
    /** Return Autonomy descending rows only when the route actually asks for it. */
    honorAutonomyDescending?: boolean;
    /** Reported population size; defaults to `rows.length`. */
    total?: number;
    /** Fails the list read with this status instead of serving rows. */
    listErrorStatus?: number;
  }
): Promise<void> {
  await installMockedFeatureFlags(page, { ...input.featureFlags });

  const user = currentUser();
  await page.route("**/users/me**", async (route) => {
    await route.fulfill({
      body: JSON.stringify(success(user)),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.route("**/agent-sessions/usage**", async (route) => {
    await route.fulfill({
      body: JSON.stringify(
        success(
          input.usage ??
            sessionsUsageSummary({ totalSessions: input.rows.length })
        )
      ),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.route("**/agent-sessions?**", async (route) => {
    const url = listRequestUrl(new URL(route.request().url())).toString();
    input.listRequests?.push(url);

    if (input.listErrorStatus) {
      await route.fulfill({
        body: JSON.stringify({ error: "sessions read failed", success: false }),
        contentType: "application/json",
        status: input.listErrorStatus,
      });
      return;
    }

    const params = new URL(url).searchParams;
    const selectedStatuses = params.getAll("statuses");
    const scopedRows =
      input.honorStatusFilter && selectedStatuses.length > 0
        ? input.rows.filter((row) => selectedStatuses.includes(row.status))
        : input.rows;
    const orderedRows =
      input.honorAutonomyDescending &&
      params.get("sortBy") === SessionSortKey.Autonomy &&
      params.get("sortDir") === SessionSortDir.Desc
        ? [...scopedRows].sort((left, right) => {
            const leftScore = Number.isFinite(left.autonomy)
              ? (left.autonomy ?? -1)
              : -1;
            const rightScore = Number.isFinite(right.autonomy)
              ? (right.autonomy ?? -1)
              : -1;
            const scoreOrder = rightScore - leftScore;
            if (scoreOrder !== 0) {
              return scoreOrder;
            }
            const naturalIdOrder = left.id.localeCompare(right.id, "en", {
              numeric: true,
            });
            return naturalIdOrder || left.id.localeCompare(right.id);
          })
        : scopedRows;

    await route.fulfill({
      body: JSON.stringify(
        success({
          items: pageOfRows(orderedRows, url, input.paginate === true),
          total: input.honorStatusFilter
            ? scopedRows.length
            : (input.total ?? input.rows.length),
          viewerScope: "organization",
        })
      ),
      contentType: "application/json",
      status: 200,
    });
  });
}

/**
 * ISS-12454 (davetho review): the two routes the `Owning project` cell needs
 * to be WRITABLE on the web host — the org's projects, and the canonical mover.
 *
 * Separate from {@link installSessionsListMocks} because only a spec that drives
 * the write wants them: a `/projects` mock on every Sessions spec would make the
 * gated menu fetch look harmless everywhere.
 *
 * `moves` collects each body the route received. The handler stays
 * side-effect-only beyond that collection, and the spec asserts from its own
 * body after an awaited state proves the handler ran.
 */
export async function installProjectWriteMocks(
  page: Page,
  moves: unknown[]
): Promise<void> {
  const projects: readonly SessionsFixtureProject[] = [
    {
      id: SESSIONS_FIXTURE_PROJECT_ID,
      name: SESSIONS_FIXTURE_PROJECT_NAME,
      slug: "platform-core",
    },
    SESSIONS_FIXTURE_TARGET_PROJECT,
  ];

  await page.route(PROJECTS_URL_GLOB, async (route) => {
    const request = route.request();
    if (
      request.method() !== "GET" ||
      platformPath(new URL(request.url()).pathname) !== PROJECTS_PATH
    ) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      body: JSON.stringify(success(projects)),
      contentType: "application/json",
      status: 200,
    });
  });

  await page.route(BATCH_MOVE_URL_GLOB, async (route) => {
    const request = route.request();
    if (
      request.method() !== "POST" ||
      platformPath(new URL(request.url()).pathname) !== BATCH_MOVE_PATH
    ) {
      await route.fallback();
      return;
    }
    const body: unknown = request.postDataJSON();
    moves.push(body);
    // Echoed from the request rather than pinned to a row id: the response only
    // has to name what moved, and a fixture id here would be a second copy of
    // the one the spec's own row already carries.
    const moved = MOVE_BODY_SCHEMA.safeParse(body);
    await route.fulfill({
      body: JSON.stringify(
        success({
          movedArtifacts: moved.success
            ? [{ id: moved.data.artifactId, type: ArtifactType.Session }]
            : [],
        })
      ),
      contentType: "application/json",
      status: 200,
    });
  });
}

/**
 * The slice of `rows` this request asked for, or the whole corpus when the
 * caller did not opt into pagination.
 *
 * A missing/unparseable `limit` or `offset` degrades to the whole corpus rather
 * than an empty page, so a request shape this helper does not recognize renders
 * rows and fails a downstream assertion loudly instead of looking like an empty
 * list.
 */
function pageOfRows(
  rows: AgentSessionListItem[],
  requestUrl: string,
  paginate: boolean
): AgentSessionListItem[] {
  if (!paginate) {
    return rows;
  }
  const params = new URL(requestUrl).searchParams;
  const limit = Number.parseInt(params.get("limit") ?? "", 10);
  const offset = Number.parseInt(params.get("offset") ?? "", 10);
  if (!Number.isFinite(limit)) {
    return rows;
  }
  const start = Number.isFinite(offset) ? offset : 0;
  return rows.slice(start, start + limit);
}

/**
 * The `offset` the most recent list request asked for, or `null` when there is
 * no such request or it carried no `offset` at all.
 *
 * Reads the URLs {@link installSessionsListMocks} collects into `listRequests`,
 * so a spec asserts the page the surface actually ASKED THE SERVER for rather
 * than the number the paginator drew.
 *
 * ABSENT AND PAGE ONE ARE DIFFERENT ANSWERS, and `Number(null)` is `0`, so the
 * presence check is load-bearing rather than defensive: without it a surface
 * that dropped `offset` entirely would read as page one and satisfy a
 * `.toBe(0)` page-reset assertion it should fail. The page emits the param
 * unconditionally (`offset: safePageIndex * pageSize`, so page one sends a
 * literal `offset=0` that `buildSearchParams` keeps — it skips only `null` and
 * `undefined`), which is exactly why an absent one means the surface changed.
 */
export function offsetOfLastRequest(
  listRequests: readonly string[]
): number | null {
  const raw = listRequests.at(-1);
  if (raw === undefined) {
    return null;
  }
  const params = new URL(raw).searchParams;
  if (!params.has("offset")) {
    return null;
  }
  const offset = Number(params.get("offset"));
  return Number.isFinite(offset) ? offset : null;
}

/**
 * The rendered label of `columnId`, read from the spec list the toolbar menus
 * and the grid header are both built from, so a relabelled column cannot leave
 * a spec clicking a control that no longer carries that name.
 *
 * `SessionsColumnId` catches a removed or misspelled id at typecheck; the throw
 * is the runtime backstop `find` forces, and it fails loudly rather than
 * returning a placeholder a locator would then silently miss.
 */
export function columnSpecLabelOrThrow(columnId: SessionsColumnId): string {
  const spec = SESSIONS_COLUMN_SPECS.find(
    (candidate) => candidate.id === columnId
  );
  if (!spec) {
    throw new Error(
      `No column spec for ${columnId}; no menu or header can offer it.`
    );
  }
  return spec.label;
}

/**
 * The Sessions summary strip, addressed by the custom property `SummaryCardRow`
 * publishes inline.
 *
 * A structural handle rather than a class name or an `@repo/app` component
 * import: the inline custom property is the only thing the row publishes that a
 * spec can hold, and it survives a restyle that a class name would not. Shared
 * because three specs address the same strip — the two `sessions-summary-*`
 * suites and `sessions-v2-options-menu` — and a fourth copy of the literal is
 * how they drift apart.
 */
export const SUMMARY_STRIP_SELECTOR = '[style*="--summary-card-min"]';
