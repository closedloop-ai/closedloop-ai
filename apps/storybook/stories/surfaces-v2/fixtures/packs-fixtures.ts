import {
  type CatalogItemDto,
  CatalogItemScope,
  CatalogItemSource,
  type DistributionDto,
  DistributionMode,
  DistributionTargetingType,
  type DistributionTargetStatusDto,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import {
  liveAppShellRoutes,
  organizationUsersFixture,
} from "./live-app-fixtures";

// The live Packs route (`apps/app/.../packs/packs-route-body.tsx`) reads the
// org's catalog (`GET /catalog`) and, for an admin, its distributions
// (`GET /distributions`). These are those responses for a workspace that
// authors four packs and distributes three of them.

const CREATED = "2026-08-04T10:00:00.000Z";
const UPDATED = "2026-10-01T15:30:00.000Z";

function catalogItem(
  overrides: Partial<CatalogItemDto> & { id: string; name: string }
): CatalogItemDto {
  return {
    agentSlug: null,
    archived: false,
    coaching: false,
    coachingConfig: null,
    componentUuid: null,
    components: [],
    content: null,
    createdAt: CREATED,
    createdById: "user_test",
    description: null,
    enabled: true,
    logoUrl: null,
    organizationId: "org_test",
    parentPackId: null,
    scope: CatalogItemScope.Org,
    sortOrder: 0,
    source: CatalogItemSource.OrgCustom,
    targetKind: "pack",
    updatedAt: UPDATED,
    version: "1.0.0",
    ...overrides,
  };
}

function component(
  packId: string,
  targetKind: string,
  name: string,
  description: string
): CatalogItemDto {
  return catalogItem({
    agentSlug: `${targetKind === "agent" ? "subagent" : targetKind}::${name}`,
    componentUuid: `cu_${packId}_${name}`,
    description,
    id: `${packId}_${name}`,
    name,
    parentPackId: packId,
    targetKind,
  });
}

export const packCatalogFixture: CatalogItemDto[] = [
  catalogItem({
    components: [
      component(
        "pk_review",
        "agent",
        "code-reviewer",
        "Reviews diffs for correctness bugs."
      ),
      component(
        "pk_review",
        "command",
        "ship",
        "Runs the pre-push gate and opens the PR."
      ),
      component(
        "pk_review",
        "hook",
        "pre-push-gate",
        "Blocks a push that fails lint or types."
      ),
    ],
    description:
      "The review agent, the ship command and the push gate every repo uses.",
    id: "pk_review",
    name: "Review & Ship",
    sortOrder: 0,
    version: "2.3.0",
  }),
  catalogItem({
    components: [
      component(
        "pk_design",
        "skill",
        "storybook-curate",
        "Writes and audits Storybook stories."
      ),
      component(
        "pk_design",
        "agent",
        "design-critic",
        "Critiques a UI diff against the design soul."
      ),
    ],
    description: "Design-system skills and the design critic for UI work.",
    id: "pk_design",
    name: "Design System",
    sortOrder: 1,
    version: "1.4.1",
  }),
  catalogItem({
    components: [
      component(
        "pk_ci",
        "skill",
        "local-ci",
        "Runs the PR gate locally in a container."
      ),
      component(
        "pk_ci",
        "mcp",
        "closedloop",
        "ClosedLoop project and document tools."
      ),
    ],
    description: "Local CI and the ClosedLoop MCP server.",
    id: "pk_ci",
    name: "Platform Tooling",
    sortOrder: 2,
    version: "1.1.0",
  }),
  catalogItem({
    components: [
      component(
        "pk_release",
        "plugin",
        "release-notes",
        "Drafts release notes from merged PRs."
      ),
    ],
    description: "Release notes drafted from the week's merged PRs.",
    id: "pk_release",
    name: "Release Notes",
    sortOrder: 3,
    version: "0.9.0",
  }),
];

function targetStatus(
  distributionId: string,
  n: number,
  status: DistributionTargetStatusDto["status"],
  version: string | null
): DistributionTargetStatusDto {
  const user = organizationUsersFixture[n % organizationUsersFixture.length];
  return {
    computeTargetId: `ct_${n}`,
    createdAt: CREATED,
    distributionId,
    enabledAt:
      status === DistributionTargetStatusValue.Enabled ? UPDATED : null,
    failureReason:
      status === DistributionTargetStatusValue.Failed
        ? "Install script exited with code 1"
        : null,
    id: `${distributionId}_ts_${n}`,
    installedAt: version ? UPDATED : null,
    installedVersion: version,
    installRunId: version ? `run_${distributionId}_${n}` : null,
    overriddenLocally: false,
    reportedAt: UPDATED,
    status,
    updatedAt: UPDATED,
    userId: user?.id ?? null,
  };
}

function distribution(
  item: CatalogItemDto,
  mode: DistributionMode,
  statuses: DistributionTargetStatusDto["status"][]
): DistributionDto {
  const id = `dist_${item.id}`;
  return {
    assetDownloadUrl: null,
    catalogItem: {
      id: item.id,
      name: item.name,
      source: item.source,
      targetKind: item.targetKind,
    },
    catalogItemId: item.id,
    createdAt: CREATED,
    desiredEnabled: true,
    id,
    mode,
    organizationId: "org_test",
    targetingEntries: [],
    targetingType: DistributionTargetingType.All,
    targetStatuses: statuses.map((status, n) =>
      targetStatus(
        id,
        n,
        status,
        status === DistributionTargetStatusValue.Pending ? null : item.version
      )
    ),
    updatedAt: UPDATED,
  };
}

const [REVIEW, DESIGN, CI] = packCatalogFixture as [
  CatalogItemDto,
  CatalogItemDto,
  CatalogItemDto,
];

export const packDistributionsFixture: DistributionDto[] = [
  distribution(REVIEW, DistributionMode.AutoInstall, [
    DistributionTargetStatusValue.Enabled,
    DistributionTargetStatusValue.Enabled,
    DistributionTargetStatusValue.Enabled,
    DistributionTargetStatusValue.Installed,
  ]),
  distribution(DESIGN, DistributionMode.OptIn, [
    DistributionTargetStatusValue.OptedIn,
    DistributionTargetStatusValue.Enabled,
    DistributionTargetStatusValue.Declined,
  ]),
  distribution(CI, DistributionMode.AutoInstall, [
    DistributionTargetStatusValue.Enabled,
    DistributionTargetStatusValue.Failed,
    DistributionTargetStatusValue.Pending,
  ]),
];

export const packsApiRoutes: FixtureRoute[] = [
  ...liveAppShellRoutes,
  { method: "GET", path: "/users", respond: () => organizationUsersFixture },
  { method: "GET", path: "/catalog", respond: () => packCatalogFixture },
  {
    method: "GET",
    path: "/catalog/*",
    respond: ({ pathname }) =>
      packCatalogFixture.find((item) => pathname.endsWith(`/${item.id}`)) ??
      null,
  },
  {
    method: "GET",
    path: "/distributions",
    respond: () => packDistributionsFixture,
  },
  {
    method: "GET",
    path: "/distributions/*",
    respond: ({ pathname }) =>
      packDistributionsFixture.find((dist) =>
        pathname.endsWith(`/${dist.id}`)
      ) ?? null,
  },
  { method: "GET", path: "/compute-targets", respond: () => [] },
];
