import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import {
  ArtifactSubtype,
  ArtifactType,
  LinkType,
} from "@repo/api/src/types/artifact.ts";
import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status.ts";
import { ARTIFACT_STATUS_DISPLAY_LABELS } from "@repo/api/src/types/artifact-status-display.ts";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document.ts";
import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag.ts";
import { ProjectStatus } from "@repo/api/src/types/project.ts";
import {
  ProjectArtifactBoardGroup,
  projectArtifactBoardPagePath,
} from "@repo/api/src/types/project-artifact-board-page.ts";
import {
  type PlaceProjectArtifactsRequest,
  ProjectArtifactPlacementGroupField,
  ProjectArtifactPlacementKind,
  ProjectArtifactPlacementPosition,
  ProjectArtifactPlacementSource,
  projectArtifactPlacementValidator,
  type UndoProjectArtifactPlacementRequest,
} from "@repo/api/src/types/project-artifact-placement.ts";
import { type TeamMember, TeamRole } from "@repo/api/src/types/teams.ts";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag.ts";
import { ARTIFACT_PLACEMENT_UNDO_LABEL } from "@repo/app/projects/lib/artifact-placement-copy.ts";
import { ARTIFACT_BOARD_LABEL } from "@repo/app/shared/components/generic-artifact-surface/artifact-board/artifact-board-model.ts";
import { PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags.ts";
import { MANUAL_REORDER_HANDLE_NAME_PATTERN } from "@repo/app/shared/lib/manual-reorder-handle-label.ts";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_ORGANIZATION_ID,
  AUTHENTICATED_USER_ID,
  createAuthenticatedDesktopSessionRecord,
  rejectUnauthorized,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import { drainedCloudReadReadiness } from "./helpers/desktop-app";
import {
  mapInactiveLinuxCiWindow,
  selectInactiveLinuxCiMapping,
} from "./helpers/inactive-linux-ci-window";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
} from "./helpers/seeded-sessions-list";
import {
  seedCloudSessionDetailProfile,
  startAuthenticatedSessionDetailCloudServer,
} from "./helpers/session-detail-authenticated-cloud";

const teamId = "019c24dc-9445-75ec-8136-c4e6d83147fa";
const projectId = "01a10c52-ee2a-7191-a067-46eed1548d1c";
const rootId = "01a10c52-ee2a-7191-a067-46eed1548d1d";
const childId = "01a10c52-ee2a-7191-a067-46eed1548d1e";
const grandchildId = "01a10c52-ee2a-7191-a067-46eed1548d1f";
const leafId = "01a10c52-ee2a-7191-a067-46eed1548d20";
const otherId = "01a10c52-ee2a-7191-a067-46eed1548d21";
const firstNeighborId = "01a10c52-ee2a-7191-a067-46eed1548d22";
const secondNeighborId = "01a10c52-ee2a-7191-a067-46eed1548d23";
const projectPath = `/teams/${teamId}/projects/${projectId}`;
const placementPath = `/projects/${projectId}/artifacts/placement`;
const boardPath = new URL(
  projectArtifactBoardPagePath(projectId, {
    groupBy: ProjectArtifactBoardGroup.Status,
    pageSize: 1,
  }),
  "http://127.0.0.1"
).pathname;
const placementTransactionId = "01a15547-3d84-7691-bade-5b1fb07a9136";
const boardOrganizationId = "00000000-0000-4000-8000-000000000001";
const boardUserId = "00000000-0000-4000-8000-000000000002";
const currentUser = {
  id: AUTHENTICATED_USER_ID,
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com",
  avatarUrl: null,
};
const team = {
  id: teamId,
  organizationId: AUTHENTICATED_ORGANIZATION_ID,
  name: "Platform",
  slug: "platform",
  memberCount: 1,
  projectCount: 1,
  createdAt: "2026-10-19T00:00:00Z",
  updatedAt: "2026-10-19T00:00:00Z",
};
const project = {
  id: projectId,
  organizationId: AUTHENTICATED_ORGANIZATION_ID,
  name: "Sprint",
  description: "",
  priority: null,
  status: ProjectStatus.InProgress,
  assigneeId: null,
  createdById: AUTHENTICATED_USER_ID,
  slug: null,
  targetDate: null,
  codebaseSummary: null,
  lastIndexedAt: null,
  settings: {},
  sortOrder: null,
  createdAt: team.createdAt,
  updatedAt: team.updatedAt,
  completionPercentage: 0,
  teams: [{ id: teamId, name: team.name }],
};
const root = artifact(rootId, "PRD-1", "Delivery plan", ArtifactSubtype.Prd);
const child = {
  ...artifact(
    childId,
    "ISS-1",
    "Implement project surface",
    ArtifactSubtype.Feature
  ),
  parentId: rootId,
  linkType: LinkType.Produces,
  depth: 1,
};
const grandchild = {
  ...artifact(
    grandchildId,
    "ISS-2",
    "Wire production data",
    ArtifactSubtype.Feature
  ),
  parentId: childId,
  linkType: LinkType.Produces,
  depth: 2,
};
const leaf = {
  ...artifact(leafId, "ISS-3", "Verify both shells", ArtifactSubtype.Feature),
  parentId: grandchildId,
  linkType: LinkType.Produces,
  depth: 3,
};
const second = artifact(
  otherId,
  "ISS-4",
  "Independent issue",
  ArtifactSubtype.Feature
);
const firstNeighbor = artifact(
  firstNeighborId,
  "ISS-5",
  "First neighboring issue",
  ArtifactSubtype.Feature
);
const secondNeighbor = artifact(
  secondNeighborId,
  "ISS-6",
  "Second neighboring issue",
  ArtifactSubtype.Feature
);

test("Projects shares populated hierarchy and the grouped board through authenticated Electron IPC", async () => {
  test.setTimeout(180_000);
  const fixture = projectCloudRoutes();
  const server = await startAuthenticatedSessionDetailCloudServer({
    extraRoutes: fixture.route,
  });
  const dirs = makeSeededSessionsDirs("projects-parity");
  try {
    const { app, page, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      cloudReadReadiness: drainedCloudReadReadiness(),
      beforeLaunch: (profile) =>
        seedCloudSessionDetailProfile(profile, server.origin, {
          labsNav: true,
          [MANUAL_ARTIFACT_ORDERING_FLAG_KEY]: true,
          [PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY]: true,
          [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY]: false,
        }),
      userDataDir: dirs.userDataDir,
      harnessHomesRoot: dirs.harnessHomesRoot,
      env: {
        CLAUDE_HOME: dirs.claudeHome,
        CLOSEDLOOP_API_KEY: "",
        CODEX_HOME: dirs.codexHome,
        CL_AUTH_API_ORIGIN: server.origin,
        SYMPHONY_API_KEY: "",
      },
    });
    const rendererErrors: string[] = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") {
        rendererErrors.push(message.text());
      }
    });
    try {
      // ISS-12843: the board-card drag below depends on the renderer processing
      // pointer-move frames between `mouse.down()` and `mouse.up()`. The owned
      // Linux CI Xvfb display can throttle an unmapped window to ~1fps
      // (apps/desktop/test/AGENTS.md "Inactive mapping in Linux Electron CI"),
      // so the drop handler's dragged-item state can still be unset when `up()`
      // fires, and the write never happens. Same pattern as the drag case in
      // sessions-v2-view-state-back.spec.ts.
      //
      // Inside this try, not next to the launch: the mapping guard and the
      // `BrowserWindow` evaluation both reject, and only this `finally` calls
      // `cleanup()` — a rejection above it left Electron running while the
      // outer `finally` removed the profile dir underneath it.
      await mapInactiveLinuxCiWindow(
        app,
        page,
        selectInactiveLinuxCiMapping(
          { platform: process.platform, env: process.env },
          true
        )
      );
      const inviteDismiss = page.getByRole("button", { name: "Maybe later" });
      if (await inviteDismiss.isVisible()) {
        await inviteDismiss.click();
      }
      await page.evaluate((href) => {
        globalThis.location.hash = href;
      }, `${projectPath}?group=none&metrics=project-completion%2Cartifact-count%2Cmetric-five&range=7d`);
      for (const title of [
        "Delivery plan",
        "Implement project surface",
        "Wire production data",
      ]) {
        const row = page.getByRole("row", { name: new RegExp(title) });
        await expect(row).toBeVisible({ timeout: 30_000 });
        const expand = row.getByRole("button", { name: "Expand row" });
        if (await expand.isVisible()) {
          await expand.click();
        }
      }
      const leafTitle = page.getByText("Verify both shells", { exact: true });
      await expect(leafTitle).toBeVisible();
      // ISS-13035: a tree row names its artifact by ID as well as by title.
      await expect(
        page.getByRole("link", { name: "ISS-3 Verify both shells" })
      ).toBeVisible();
      await expect(page).not.toHaveURL(staleRangePattern);
      const handles = page.getByRole("button", {
        name: MANUAL_REORDER_HANDLE_NAME_PATTERN,
      });
      await expect(handles).toHaveCount(5);
      await handles.last().focus();
      await page.keyboard.press("Control+ArrowUp");
      await expect.poll(() => fixture.placementRequests()).toHaveLength(1);
      expect(fixture.placementRequests()[0]).toMatchObject({
        kind: ProjectArtifactPlacementKind.Place,
        sourceArtifactIds: [otherId],
        destinationProjectId: projectId,
        position: ProjectArtifactPlacementPosition.Before,
        targetArtifactId: rootId,
        expectedProjectVersions: { [projectId]: "version-1" },
        source: ProjectArtifactPlacementSource.Keyboard,
      });
      await expect
        .poll(() =>
          handles.evaluateAll((elements) =>
            elements.map(
              (element) => element.closest('[role="row"]')?.textContent ?? ""
            )
          )
        )
        .toEqual([
          expect.stringContaining("Independent issue"),
          expect.stringContaining("Delivery plan"),
          expect.stringContaining("Implement project surface"),
          expect.stringContaining("Wire production data"),
          expect.stringContaining("Verify both shells"),
        ]);
      await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
      expect(fixture.treeReads()).toBeGreaterThan(1);
      await page.getByRole("button", { name: "Collapse row" }).first().click();
      await expect(
        page.getByRole("link", { name: "ISS-3 Verify both shells" })
      ).toHaveCount(0);
      await page.getByRole("radio", { name: "Board view" }).first().click();
      await expect(
        page.getByText("Delivery plan", { exact: true })
      ).toBeVisible();
      await expect(
        page.getByText("Independent issue", { exact: true })
      ).toBeVisible();
      const cards = page.locator("[data-artifact-board-card]");
      await expect(cards).toHaveCount(2);
      await expect(
        cards.filter({ hasText: "Implement project surface" })
      ).toHaveCount(0);
      await expect(
        cards.filter({ hasText: "Wire production data" })
      ).toHaveCount(0);
      await expect(cards.filter({ hasText: "Verify both shells" })).toHaveCount(
        0
      );
      // ISS-12644 consolidation ruling: with manual-artifact-ordering on, the
      // portable page's board is the PRD-724 Artifact Board.
      await expect(
        page.getByRole("group", { name: ARTIFACT_BOARD_LABEL })
      ).toBeVisible();
      await expect(page.locator("[data-artifact-board-lane]")).toHaveCount(13);
      await expect(page.locator("[data-artifact-board-card]")).toHaveCount(2);
      await expect(
        page.locator(
          `[data-artifact-board-lane="${DocumentStatus.Draft}"] [data-artifact-board-card="${rootId}"]`
        )
      ).toBeVisible();
      expect(fixture.boardReads()).toBeGreaterThan(0);
      expect(fixture.unauthorizedCount()).toBe(0);
    } finally {
      await test.info().attach("renderer-errors", {
        body: JSON.stringify(rendererErrors),
        contentType: "application/json",
      });
      await test.info().attach("unauthorized-routes", {
        body: JSON.stringify(fixture.unauthorizedRoutes()),
        contentType: "application/json",
      });
      await cleanup();
    }
  } finally {
    await server.close();
    cleanupSeededSessionsDirs(dirs);
  }
});

test("ISS-12908 Desktop Board groups shared roots and toast Undo restores the raw lane and position", async () => {
  test.setTimeout(180_000);
  const fixture = projectCloudRoutes({ statusParity: true });
  const server = await startAuthenticatedSessionDetailCloudServer({
    extraRoutes: fixture.route,
  });
  const dirs = makeSeededSessionsDirs("projects-shared-status-parity");
  try {
    const { page, cleanup } = await launchAuthenticatedDesktopApp({
      sameProcessSessionSeed: createAuthenticatedDesktopSessionRecord(),
      cloudReadReadiness: drainedCloudReadReadiness(),
      beforeLaunch: (profile) =>
        seedCloudSessionDetailProfile(profile, server.origin, {
          labsNav: true,
          [MANUAL_ARTIFACT_ORDERING_FLAG_KEY]: true,
          [PROJECTS_PORTABLE_SURFACE_FEATURE_FLAG_KEY]: true,
          [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY]: true,
        }),
      userDataDir: dirs.userDataDir,
      harnessHomesRoot: dirs.harnessHomesRoot,
      env: {
        CLAUDE_HOME: dirs.claudeHome,
        CLOSEDLOOP_API_KEY: "",
        CODEX_HOME: dirs.codexHome,
        CL_AUTH_API_ORIGIN: server.origin,
        SYMPHONY_API_KEY: "",
      },
    });
    try {
      await page.evaluate((href) => {
        globalThis.location.hash = href;
      }, `${projectPath}?group=status`);
      await page.getByRole("radio", { name: "Board view" }).first().click();
      await expect(
        page.getByRole("group", { name: ARTIFACT_BOARD_LABEL })
      ).toBeVisible();
      const lanes = page.locator("[data-artifact-board-lane]");
      await expect(lanes).toHaveCount(5);
      expect(
        await lanes.evaluateAll((elements) =>
          elements.map((element) =>
            element.getAttribute("data-artifact-board-lane")
          )
        )
      ).toEqual(Object.values(ARTIFACT_STATUS_ROOT));
      const todoCards = page.locator(
        `[data-artifact-board-lane="${ARTIFACT_STATUS_ROOT.Todo}"] [data-artifact-board-card]`
      );
      await expect(todoCards).toHaveCount(3);
      const originalOrder = [otherId, firstNeighborId, secondNeighborId];
      expect(await todoCards.evaluateAll(boardCardIds)).toEqual(originalOrder);
      await expect(
        page.locator(
          `[data-artifact-board-card="${otherId}"] [data-artifact-board-field="status"]`
        )
      ).toContainText("Todo");

      await page
        .getByRole("button", { name: "Actions for Independent issue" })
        .click();
      await page
        .getByRole("menuitem", {
          name: `Move to ${ARTIFACT_STATUS_DISPLAY_LABELS[ARTIFACT_STATUS_ROOT.InReview]}`,
        })
        .click();
      await expect.poll(() => fixture.placementRequests()).toHaveLength(1);
      expect(fixture.placementRequests()[0]).toMatchObject({
        lanePatch: {
          field: ProjectArtifactPlacementGroupField.Status,
          value: IssueStatus.InReview,
        },
        sourceArtifactIds: [otherId],
      });
      await expect(
        page.locator(
          `[data-artifact-board-lane="${ARTIFACT_STATUS_ROOT.InReview}"] [data-artifact-board-card="${otherId}"]`
        )
      ).toBeVisible();
      const undo = page.getByRole("button", {
        name: ARTIFACT_PLACEMENT_UNDO_LABEL,
      });
      await expect(undo).toHaveCount(1);
      await undo.click();
      await expect.poll(() => fixture.undoRequests()).toHaveLength(1);
      await expect(todoCards).toHaveCount(3);
      expect(await todoCards.evaluateAll(boardCardIds)).toEqual(originalOrder);
      expect(fixture.boardReads()).toBeGreaterThan(2);
      expect(fixture.unauthorizedCount()).toBe(0);
    } finally {
      await cleanup();
    }
  } finally {
    await server.close();
    cleanupSeededSessionsDirs(dirs);
  }
});

function boardCardIds(elements: Element[]) {
  return elements.map((element) =>
    element.getAttribute("data-artifact-board-card")
  );
}

function artifact(
  id: string,
  slug: string,
  name: string,
  subtype: typeof ArtifactSubtype.Prd | typeof ArtifactSubtype.Feature,
  status?: DocumentStatus | IssueStatus
) {
  return {
    id,
    organizationId: AUTHENTICATED_ORGANIZATION_ID,
    projectId,
    type: ArtifactType.Document,
    subtype,
    name,
    slug,
    status:
      status ??
      (subtype === ArtifactSubtype.Prd
        ? DocumentStatus.Draft
        : IssueStatus.Todo),
    priority: null,
    assigneeId: null,
    assignee: null,
    dueDate: null,
    externalUrl: null,
    sortOrder: 0,
    createdById: AUTHENTICATED_USER_ID,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
    currentVersion: 1,
    tags: [],
    customFieldValues: [],
  };
}

// PRD-724's board wire validator requires UUID principals; the older Desktop
// auth fixture deliberately uses opaque principal IDs for its session seed.
function boardArtifact(source: ReturnType<typeof artifact>) {
  return {
    ...source,
    organizationId: boardOrganizationId,
    createdById: boardUserId,
  };
}

function projectCloudRoutes(options: { statusParity?: boolean } = {}) {
  let unauthorized = 0;
  let treeReads = 0;
  let boardReads = 0;
  let reversed = false;
  let sharedBoardIssueStatus: IssueStatus = IssueStatus.Todo;
  let projectVersion = "version-1";
  const placements: PlaceProjectArtifactsRequest[] = [];
  const undos: UndoProjectArtifactPlacementRequest[] = [];
  const unauthorizedPaths: string[] = [];
  const route = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const recognized =
      pathname.startsWith("/projects") ||
      pathname.startsWith("/teams") ||
      pathname === "/me" ||
      pathname === "/users" ||
      pathname.startsWith("/custom-fields") ||
      pathname === "/artifacts/favorites" ||
      pathname === "/artifacts/collaborators" ||
      pathname === "/artifacts/related-sessions" ||
      pathname === "/agent-sessions";
    if (!recognized) {
      return false;
    }
    if (
      request.headers.authorization !== `Bearer ${AUTHENTICATED_ACCESS_TOKEN}`
    ) {
      unauthorized++;
      unauthorizedPaths.push(`${request.method ?? "GET"} ${pathname}`);
      rejectUnauthorized(response);
      return true;
    }
    if (pathname === `/projects/${projectId}/tree`) {
      treeReads++;
      const nodes = [
        { root, children: [child, grandchild, leaf] },
        { root: second, children: [] },
      ];
      writeApiResult(response, {
        nodes: reversed ? [...nodes].reverse() : nodes,
        externalParents: [],
        projectVersion,
      });
    } else if (request.method === "GET" && pathname === boardPath) {
      boardReads++;
      const issueCard = {
        artifact: boardArtifact({ ...second, status: sharedBoardIssueStatus }),
        descendantCount: 0,
      };
      const todoCards = options.statusParity
        ? [
            ...(sharedBoardIssueStatus === IssueStatus.Todo ? [issueCard] : []),
            {
              artifact: boardArtifact(firstNeighbor),
              descendantCount: 0,
            },
            {
              artifact: boardArtifact(secondNeighbor),
              descendantCount: 0,
            },
          ]
        : [issueCard];
      writeApiResult(response, {
        lanes: [
          {
            cards: [{ artifact: boardArtifact(root), descendantCount: 3 }],
            complete: true,
            count: 1,
            id: DocumentStatus.Draft,
            label: "Draft",
          },
          {
            cards: todoCards,
            complete: true,
            count: todoCards.length,
            id: IssueStatus.Todo,
            label: "Todo",
          },
          ...(options.statusParity &&
          sharedBoardIssueStatus === IssueStatus.InReview
            ? [
                {
                  cards: [issueCard],
                  complete: true,
                  count: 1,
                  id: IssueStatus.InReview,
                  label:
                    ARTIFACT_STATUS_DISPLAY_LABELS[
                      ARTIFACT_STATUS_ROOT.InReview
                    ],
                },
              ]
            : []),
        ],
        populationRevision: "a".repeat(64),
        projectVersion,
        rootIds: options.statusParity
          ? [rootId, otherId, firstNeighborId, secondNeighborId]
          : [rootId, otherId],
      });
    } else if (request.method === "GET" && pathname === placementPath) {
      writeApiResult(response, {
        projectId,
        projectVersion,
        canPlaceArtifacts: true,
      });
    } else if (request.method === "POST" && pathname === placementPath) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const parsed = projectArtifactPlacementValidator.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf8"))
        );
        if (parsed.kind === ProjectArtifactPlacementKind.Undo) {
          if (!options.statusParity) {
            throw new Error("Unexpected Undo request");
          }
          undos.push(parsed);
          sharedBoardIssueStatus = IssueStatus.Todo;
          projectVersion = "version-3";
          writeApiResult(response, {
            placed: true,
            transactionId: parsed.undoOfTransactionId,
            affectedArtifactIds: [otherId],
            affectedProjectIds: [projectId],
            projectVersions: { [projectId]: projectVersion },
            placement: {
              sourceArtifactIds: [otherId],
              destinationProjectId: projectId,
              position: ProjectArtifactPlacementPosition.Before,
              targetArtifactId: firstNeighborId,
            },
            sourceRootMappings: [
              { sourceArtifactId: otherId, rootArtifactId: otherId },
            ],
            replayed: false,
            undoAvailable: false,
          });
          return;
        }
        if (parsed.kind !== ProjectArtifactPlacementKind.Place) {
          throw new Error("Expected a placement request");
        }
        placements.push(parsed);
        if (
          options.statusParity &&
          parsed.sourceArtifactIds.includes(otherId) &&
          parsed.lanePatch?.field ===
            ProjectArtifactPlacementGroupField.Status &&
          parsed.lanePatch.value === IssueStatus.InReview
        ) {
          sharedBoardIssueStatus = IssueStatus.InReview;
        }
        reversed = true;
        projectVersion = "version-2";
        writeApiResult(response, {
          placed: true,
          transactionId: placementTransactionId,
          affectedArtifactIds: parsed.sourceArtifactIds,
          affectedProjectIds: [projectId],
          projectVersions: { [projectId]: projectVersion },
          placement: {
            sourceArtifactIds: parsed.sourceArtifactIds,
            destinationProjectId: parsed.destinationProjectId,
            position: parsed.position,
            targetArtifactId: parsed.targetArtifactId,
          },
          sourceRootMappings: parsed.sourceArtifactIds.map(
            (sourceArtifactId) => ({
              sourceArtifactId,
              rootArtifactId: sourceArtifactId,
            })
          ),
          replayed: false,
          undoAvailable: true,
        });
      });
    } else if (pathname === `/projects/${projectId}`) {
      writeApiResult(response, project);
    } else if (pathname === "/projects") {
      writeApiResult(response, [project]);
    } else if (pathname === "/teams") {
      writeApiResult(response, [team]);
    } else if (pathname === `/teams/${teamId}`) {
      writeApiResult(response, team);
    } else if (pathname === `/teams/${teamId}/members`) {
      writeApiResult(response, [
        {
          id: AUTHENTICATED_USER_ID,
          teamId,
          userId: AUTHENTICATED_USER_ID,
          role: TeamRole.Member,
          createdAt: new Date(team.createdAt),
          user: currentUser,
        } satisfies TeamMember,
      ]);
    } else if (pathname === "/me") {
      writeApiResult(response, currentUser);
    } else if (pathname === "/users") {
      writeApiResult(response, [currentUser]);
    } else if (pathname === "/artifacts/collaborators") {
      writeApiResult(response, { results: [] });
    } else if (pathname === "/artifacts/related-sessions") {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        writeApiResult(response, {
          results: Object.fromEntries(
            input.artifactIds.map((id: string) => [id, { items: [], total: 0 }])
          ),
        });
      });
    } else if (pathname === "/agent-sessions") {
      writeApiResult(response, { sessions: [], total: 0 });
    } else {
      writeApiResult(response, []);
    }
    return true;
  };
  return {
    route,
    placementRequests: () => placements,
    undoRequests: () => undos,
    treeReads: () => treeReads,
    boardReads: () => boardReads,
    unauthorizedCount: () => unauthorized,
    unauthorizedRoutes: () => unauthorizedPaths,
  };
}
const staleRangePattern = /[?&]range=/;
