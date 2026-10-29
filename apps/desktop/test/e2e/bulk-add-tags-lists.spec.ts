import type { IncomingMessage, ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { AgentSessionViewerScope } from "@repo/api/src/types/agent-session.ts";
import {
  BATCH_ITEM_FAILURE_MESSAGE,
  BatchItemAppliedOutcome,
  BatchItemFailureCode,
  batchItemApplied,
  batchItemAppliedWithOutcome,
  batchItemFailed,
} from "@repo/api/src/types/batch-mutation-result.ts";
import { BranchMetricAvailability } from "@repo/api/src/types/branch-metrics.ts";
import { SESSIONS_ARTIFACT_TAGS_FLAG_KEY } from "@repo/api/src/types/sessions-artifact-tags-flag.ts";
import {
  ArtifactTagAvailability,
  type BatchApplyTagInput,
  type Tag,
  TagColor,
  TagEntityType,
} from "@repo/api/src/types/tag.ts";
import { z } from "zod";
import {
  BASE_TIME,
  makeBranchRow,
  makeListResponse,
} from "../../../../e2e/helpers/branches-surface-fixtures";
import {
  sessionListRow,
  sessionsUsageSummary,
} from "../../../../e2e/helpers/sessions-list-fixtures";
import { SESSIONS_NOUN } from "../../../../packages/app/agents/lib/sessions-noun";
import { BRANCHES_NOUN } from "../../../../packages/app/branches/lib/branches-noun";
import { canonicalBranchProjectionFixture } from "../../../../packages/app/branches/test-fixtures/canonical-branch-projection";
import { selectionSentence } from "../../../../packages/app/shared/components/generic-artifact-surface/bulk-action-bar";
import { ArtifactFlag } from "../../../../packages/app/shared/lib/artifact-flags";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "../../../../packages/app/shared/lib/feature-flags";
import {
  BULK_REMOVE_TAG_ACTION_LABEL,
  BULK_TAG_ACTION_LABEL,
} from "../../../../packages/app/tags/lib/bulk-tag-labels";
import { launchAuthenticatedDesktopApp } from "./helpers/authenticated-desktop-app";
import {
  AUTHENTICATED_ACCESS_TOKEN,
  AUTHENTICATED_GATEWAY_ID,
  seedAuthenticatedDesktopSession,
  startAuthenticatedBranchCloudServer,
  writeApiResult,
} from "./helpers/branch-details-authenticated-cloud";
import { readJsonBody } from "./helpers/branches-cloud-fixture";
import {
  clickDesktopDateRange,
  DesktopDateRangeLabel,
  drainedCloudReadReadiness,
  gotoNav,
  seedDesktopFeatureFlags,
  seedDesktopSettings,
} from "./helpers/desktop-app";
import {
  cleanupSeededSessionsDirs,
  makeSeededSessionsDirs,
  seededSessionsEnv,
} from "./helpers/seeded-sessions-list";

const IDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
const TAG: Tag = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "backend",
  color: TagColor.Blue,
  organizationId: "org-e2e",
  createdById: "user-e2e",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};
const INPUT_SCHEMA = z.object({
  tagId: z.string(),
  entityType: z.literal(TagEntityType.Artifact),
  entityIds: z.array(z.string()),
});
const PROFILE_ID = "bulk-add-tags-e2e";

for (const entity of ["sessions", "branches"] as const) {
  for (const operation of [
    "addition",
    "removal",
    "removal-not-present",
    "removal-partial-retry",
  ] as const) {
    test(`Desktop cloud ${entity} sends artifact IDs and refreshes tags after a bulk ${operation} (ISS-10686 AC-009)`, async () => {
      const dirs = makeSeededSessionsDirs(`bulk-tag-${entity}`);
      const writes: BatchApplyTagInput[] = [];
      const isRemoval = operation !== "addition";
      let initiallyTaggedIds: readonly string[] = isRemoval ? IDS : [];
      if (operation === "removal-not-present") {
        initiallyTaggedIds = IDS.slice(0, 1);
      }
      const initiallyTagged = new Set(initiallyTaggedIds);
      const sessions = IDS.map((id, index) =>
        sessionListRow({
          id,
          index,
          name: `Session ${index}`,
          tags: initiallyTagged.has(id) ? [TAG] : [],
          tagAvailability: ArtifactTagAvailability.Available,
          tagPermissions: { canApply: true, canRemove: true },
        })
      );
      const branches = IDS.map((id, index) =>
        makeBranchRow({
          id: `branch-${index}`,
          branchName: `agent/branch-${index}`,
          canonicalProjection: {
            ...canonicalBranchProjectionFixture,
            common: {
              ...canonicalBranchProjectionFixture.common,
              lastActiveAt: {
                state: BranchMetricAvailability.Complete,
                value: BASE_TIME,
              },
              identity: {
                ...canonicalBranchProjectionFixture.common.identity,
                artifactId: id,
                branchName: `agent/branch-${index}`,
                repositoryFullName: "acme/app",
              },
              tags: {
                ...canonicalBranchProjectionFixture.common.tags,
                items: initiallyTagged.has(id) ? [TAG] : [],
                permissions: { canApply: true, canRemove: true },
              },
            },
          },
        })
      );
      const cloud = await startAuthenticatedBranchCloudServer({
        listFactory: () => makeListResponse(branches),
        repositoryFullNames: ["acme/app"],
        extraRoutes: routeExtra,
      });
      const env = seededSessionsEnv(dirs, { CL_AUTH_API_ORIGIN: cloud.origin });
      try {
        const seed = await launchAuthenticatedDesktopApp({
          env,
          userDataDir: dirs.userDataDir,
        });
        try {
          await seedAuthenticatedDesktopSession(seed.app, dirs.userDataDir);
        } finally {
          await seed.cleanup();
        }
        const launched = await launchAuthenticatedDesktopApp({
          env,
          userDataDir: dirs.userDataDir,
          cloudReadReadiness: drainedCloudReadReadiness(),
          beforeLaunch: (dir) => {
            seedDesktopSettings(dir, {
              activeConfigId: PROFILE_ID,
              apiOrigin: cloud.origin,
              cloudConnectionEnabled: true,
              savedConfigs: [
                {
                  id: PROFILE_ID,
                  name: PROFILE_ID,
                  apiOrigin: cloud.origin,
                  gatewayId: AUTHENTICATED_GATEWAY_ID,
                  relayOrigin: "http://127.0.0.1:9",
                  webAppOrigin: "http://127.0.0.1:3000",
                },
              ],
            });
            seedDesktopFeatureFlags(dir, {
              [ArtifactFlag.Branches]: true,
              [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]: true,
              [SESSIONS_ARTIFACT_TAGS_FLAG_KEY]: true,
            });
          },
        });
        try {
          await gotoNav(launched.page, entity);
          if (entity === "sessions") {
            await clickDesktopDateRange(
              launched.page,
              DesktopDateRangeLabel.AllTime
            );
          }
          const list = launched.page.getByTestId(`${entity}-history-list`);
          const rowIds =
            entity === "sessions" ? IDS : branches.map((row) => row.id);
          const first = list.locator(
            `[data-grid-row-id="${rowIds[0]}"], [data-grid-card-id="${rowIds[0]}"]`
          );
          const second = list.locator(
            `[data-grid-row-id="${rowIds[1]}"], [data-grid-card-id="${rowIds[1]}"]`
          );
          await expect(first).toBeVisible();
          await expect(
            list.getByRole("checkbox", { name: "Select all" })
          ).toHaveCount(0);
          await first.click({ position: { x: 2, y: 2 } });
          await second.click({
            // Control-click is a context-menu press on macOS; the toggle chord
            // there is Command, which ControlOrMeta resolves to.
            modifiers: ["ControlOrMeta"],
            position: { x: 2, y: 2 },
          });
          await launched.page
            .getByRole("button", {
              name: isRemoval
                ? BULK_REMOVE_TAG_ACTION_LABEL
                : BULK_TAG_ACTION_LABEL,
              exact: true,
            })
            .click();
          await launched.page
            .getByRole("button", { name: TAG.name, exact: true })
            .click();
          await expect.poll(() => writes.length).toBe(1);
          expect(writes).toEqual([
            {
              tagId: TAG.id,
              entityType: TagEntityType.Artifact,
              entityIds: IDS,
            },
          ]);
          const noun = entity === "sessions" ? SESSIONS_NOUN : BRANCHES_NOUN;
          const selectedCount = IDS.length;
          await expect(
            launched.page.getByRole("toolbar", {
              name: selectionSentence(selectedCount, noun),
            })
          ).toBeVisible();
          expect(
            cloud.requests
              .filter(
                (request) =>
                  request.method === "POST" &&
                  request.pathname ===
                    (isRemoval
                      ? "/entity-tags/batch-remove/v2"
                      : "/entity-tags/batch/v2")
              )
              .map((request) => request.authorization)
          ).toEqual([`Bearer ${AUTHENTICATED_ACCESS_TOKEN}`]);
          if (entity === "sessions") {
            await launched.page
              .getByRole("button", { name: "Options", exact: true })
              .click();
            await launched.page
              .getByRole("menuitem", { name: "Tags", exact: true })
              .click();
            await launched.page.keyboard.press("Escape");
          }
          if (operation === "removal-partial-retry") {
            await expect(
              first.getByText(TAG.name, { exact: true })
            ).toHaveCount(0);
            await expect(
              second.getByText(TAG.name, { exact: true })
            ).toBeVisible();
            await first.click({
              modifiers: ["ControlOrMeta"],
              position: { x: 2, y: 2 },
            });
            await expect(
              launched.page.getByRole("toolbar", {
                name: selectionSentence(1, noun),
              })
            ).toBeVisible();
            await launched.page
              .getByRole("button", { name: TAG.name, exact: true })
              .click();
            await expect.poll(() => writes.length).toBe(2);
            expect(writes[1]?.entityIds).toEqual([IDS[1]]);
          }
          if (isRemoval) {
            await expect(
              first.getByText(TAG.name, { exact: true })
            ).toHaveCount(0);
            await expect(
              second.getByText(TAG.name, { exact: true })
            ).toHaveCount(0);
            if (operation === "removal-partial-retry") {
              await expect(second).toHaveAttribute("aria-selected", "true");
              await expect(launched.page.getByRole("dialog")).toHaveCount(0);
              await expect(
                launched.page.getByText(
                  BATCH_ITEM_FAILURE_MESSAGE[
                    BatchItemFailureCode.ArtifactsNotFound
                  ],
                  { exact: true }
                )
              ).toHaveCount(0);
              await expect(
                launched.page.getByRole("toolbar", {
                  name: selectionSentence(1, noun),
                })
              ).toHaveCount(0);
            } else {
              await expect(
                launched.page.getByRole("toolbar", {
                  name: selectionSentence(selectedCount, noun),
                })
              ).toBeVisible();
            }
          } else {
            await expect(
              first.getByText(TAG.name, { exact: true })
            ).toBeVisible();
            await expect(
              second.getByText(TAG.name, { exact: true })
            ).toBeVisible();
          }
          await launched.page.context().setOffline(true);
          await expect(
            launched.page.getByRole("button", {
              name: BULK_TAG_ACTION_LABEL,
              exact: true,
            })
          ).toHaveCount(0);
          await expect(
            launched.page.getByRole("button", {
              name: BULK_REMOVE_TAG_ACTION_LABEL,
              exact: true,
            })
          ).toHaveCount(0);
          await launched.page.context().setOffline(false);
          expect(launched.pageErrors).toEqual([]);
        } finally {
          await launched.cleanup();
        }
      } finally {
        await cloud.close();
        cleanupSeededSessionsDirs(dirs);
      }

      function routeExtra(
        request: IncomingMessage,
        response: ServerResponse
      ): boolean {
        const pathname = new URL(request.url ?? "/", cloud.origin).pathname;
        if (pathname === "/tags") {
          writeApiResult(response, [TAG]);
          return true;
        }
        if (pathname === "/agent-sessions") {
          writeApiResult(response, {
            items: sessions,
            total: sessions.length,
            viewerScope: AgentSessionViewerScope.Organization,
          });
          return true;
        }
        if (pathname === "/agent-sessions/usage") {
          writeApiResult(response, sessionsUsageSummary());
          return true;
        }
        if (
          pathname ===
            (isRemoval
              ? "/entity-tags/batch-remove/v2"
              : "/entity-tags/batch/v2") &&
          request.method === "POST"
        ) {
          readJsonBody(request)
            .then((body) => {
              const input = INPUT_SCHEMA.parse(body);
              writes.push(input);
              const failedId =
                operation === "removal-partial-retry" && writes.length === 1
                  ? IDS[1]
                  : undefined;
              const applied = new Set(
                input.entityIds.filter((id) => id !== failedId)
              );
              const outcomes = new Map(
                input.entityIds.map(
                  (id) => [id, initiallyTagged.has(id)] as const
                )
              );
              for (const row of sessions) {
                if (applied.has(row.id)) {
                  row.tags = isRemoval ? [] : [TAG];
                  if (isRemoval) {
                    initiallyTagged.delete(row.id);
                  } else {
                    initiallyTagged.add(row.id);
                  }
                }
              }
              for (const row of branches) {
                if (
                  row.canonicalProjection &&
                  applied.has(
                    row.canonicalProjection.common.identity.artifactId ?? ""
                  )
                ) {
                  row.canonicalProjection.common.tags.items = isRemoval
                    ? []
                    : [TAG];
                }
              }
              writeApiResult(response, {
                results: isRemoval
                  ? input.entityIds.map((id) => {
                      if (id === failedId) {
                        return batchItemFailed(
                          id,
                          BatchItemFailureCode.ArtifactsNotFound
                        );
                      }
                      return batchItemAppliedWithOutcome(
                        id,
                        outcomes.get(id)
                          ? BatchItemAppliedOutcome.Removed
                          : BatchItemAppliedOutcome.NotPresent
                      );
                    })
                  : input.entityIds.map(batchItemApplied),
              });
            })
            .catch(() => {
              response.statusCode = 400;
              response.end();
            });
          return true;
        }
        return false;
      }
    });
  }
}
