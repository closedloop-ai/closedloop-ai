/**
 * Mock-Prisma builders for the non-empty-org guard suites.
 *
 * Extracted from non-empty-org-guard.test.ts when a second suite
 * (non-empty-org-guard-ownership.test.ts) needed the same seed-owned org, per
 * the repo rule on nontrivial fixtures shared across files.
 *
 * This is NOT the `--reset` boundary. `seed.ts` short-circuits the preflight to
 * `Clean` without calling `detectOrgConflicts` when `reset.requested` is true
 * (scripts/seed.ts, the `cliResult.options.reset.requested ? ... : await
 * detectOrgConflicts(...)` ternary), so nothing here gates a wipe. What the
 * guard gates is seeding INTO an org that already has rows: `Conflicted` makes
 * `seed.ts` throw unless `SEED_FORCE_OVERWRITE=1`, while `SeedOwned` lets the
 * run proceed as an idempotent re-seed. So the shape below is the reference for
 * what the guard must recognise as its own prior output — and a false positive
 * means the seed upserts over real customer rows with no force flag.
 *
 * `buildSeedOwnedOrgMock` therefore has to be a state the seed can actually
 * produce. Notably it leaves `linearIntegration` null: the seed never creates
 * one (`scripts/seed/` has no `linearIntegration.create`/`.upsert` — only
 * `reset.ts` deletes and counts it), so a seeded org has no such row.
 *
 * No database: every Prisma call is mocked.
 */

import { type DeepMockProxy, mockDeep } from "vitest-mock-extended";
import {
  type ArtifactSubtype,
  DocumentStatus,
  type FeatureStatus,
  type PrismaClient,
} from "../../../../generated/client";
import { deterministicUuid } from "../../helpers";
import { BASELINE_ORG_ID } from "./baseline-org";
import {
  artifactEvaluationRow,
  artifactRow,
  commentRow,
  customFieldRow,
  gitHubInstallationRow,
  linearIntegrationRow,
  projectRow,
  slackIntegrationRow,
  teamRow,
} from "./org-guard-rows";

const KEY_TOKEN_SEPARATOR_PATTERN = /_/g;
const ORG_SLUG_PREFIX_LENGTH = 8;

/** A sampled `artifact.findMany` row as the guard selects it. */
export type SeedArtifactRow = { id: string; slug: string };

export type OrgGuardPrismaMock = DeepMockProxy<PrismaClient>;

/**
 * Builds a mock PrismaClient where no integrations exist and all
 * entity counts are zero — representing a clean, empty org.
 */
export function buildEmptyOrgMock(): OrgGuardPrismaMock {
  const prisma = createGuardPrismaMock();

  // No integrations
  prisma.gitHubInstallation.findUnique.mockResolvedValue(null);
  prisma.linearIntegration.findUnique.mockResolvedValue(null);
  prisma.slackIntegration.findUnique.mockResolvedValue(null);

  // No entity rows
  prisma.project.count.mockResolvedValue(0);
  prisma.team.count.mockResolvedValue(0);

  return prisma;
}

/**
 * Builds a mock PrismaClient where all 6 models have pre-existing data —
 * representing a fully non-empty org.
 */
export function buildFullyConflictedOrgMock(): OrgGuardPrismaMock {
  const prisma = createGuardPrismaMock();

  prisma.gitHubInstallation.findUnique.mockResolvedValue(
    gitHubInstallationRow({ id: "gh-install-1" })
  );
  prisma.linearIntegration.findUnique.mockResolvedValue(
    linearIntegrationRow({ id: "linear-1" })
  );
  prisma.slackIntegration.findUnique.mockResolvedValue(
    slackIntegrationRow({ id: "slack-1" })
  );
  prisma.project.count.mockResolvedValue(3);
  prisma.team.count.mockResolvedValue(2);

  return prisma;
}

export function buildSeedOwnedOrgMock(): OrgGuardPrismaMock {
  const prisma = createGuardPrismaMock();

  prisma.gitHubInstallation.findUnique.mockResolvedValue(
    gitHubInstallationRow({
      id: deterministicUuid(`github-installation:${BASELINE_ORG_ID}:seed`),
    })
  );
  // The seed creates no LinearIntegration — see the module header. A seeded org
  // has no row here, so any row the guard finds is customer-owned.
  prisma.linearIntegration.findUnique.mockResolvedValue(null);
  prisma.slackIntegration.findUnique.mockResolvedValue(
    slackIntegrationRow({
      id: deterministicUuid(`slack-integration:${BASELINE_ORG_ID}:seed`),
    })
  );
  prisma.project.count.mockResolvedValue(2);
  prisma.project.findMany.mockResolvedValue([
    projectRow({
      id: deterministicUuid(`project:${BASELINE_ORG_ID}:platform-foundation`),
      slug: "platform-foundation",
    }),
    projectRow({
      id: deterministicUuid(`project:${BASELINE_ORG_ID}:developer-experience`),
      slug: "developer-experience",
    }),
  ]);
  prisma.team.count.mockResolvedValue(1);
  prisma.team.findMany.mockResolvedValue([
    teamRow({
      id: deterministicUuid(`team:${BASELINE_ORG_ID}:default`),
      slug: "default",
    }),
  ]);
  prisma.artifact.count.mockResolvedValue(4);
  prisma.artifact.findMany.mockResolvedValue(
    seedArtifactRows().map(artifactRow)
  );
  prisma.comment.count.mockResolvedValue(5);
  prisma.comment.findMany.mockResolvedValue([
    commentRow({
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:seed`),
      plainText: "Seed baseline comment",
    }),
    commentRow({
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:native`),
      plainText: "Initial feedback on this document.",
    }),
    commentRow({
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:native-reply`),
      plainText: "Follow-up: looks good after review.",
    }),
    commentRow({
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:liveblocks`),
      plainText: "Liveblocks collaborative comment.",
    }),
    commentRow({
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:github`),
      plainText:
        "GitHub PR review comment — please address the naming convention.",
    }),
  ]);
  prisma.customField.count.mockResolvedValue(1);
  prisma.customField.findMany.mockResolvedValue([
    customFieldRow({
      id: deterministicUuid(`custom-field:${BASELINE_ORG_ID}:notes`),
      name: "Notes",
    }),
  ]);
  prisma.artifactEvaluation.count.mockResolvedValue(1);
  prisma.artifactEvaluation.findMany.mockResolvedValue([
    artifactEvaluationRow({
      id: deterministicUuid(`artifact-evaluation:${BASELINE_ORG_ID}:plan`),
      reportId: `seed-report-plan-${BASELINE_ORG_ID}`,
    }),
  ]);

  return prisma;
}

/**
 * The slug the seed derives from a status/subtype discriminator: lowercased,
 * with `_` replaced by `-`. Mirrors the four `artifact.upsert` sites in
 * `scripts/seed/core.ts`; the guard inverts it to recover the id key.
 */
function slugToken(discriminator: string): string {
  return discriminator.toLowerCase().replace(KEY_TOKEN_SEPARATOR_PATTERN, "-");
}

/** The `(id, slug)` pair the seed mints for a regular DOCUMENT artifact. */
export function seedDocumentArtifactRow(
  status: DocumentStatus
): SeedArtifactRow {
  return {
    id: deterministicUuid(
      `artifact:document:${BASELINE_ORG_ID}:status-${status.toLowerCase()}`
    ),
    slug: `seed-doc-${slugToken(status)}`,
  };
}

/** The `(id, slug)` pair the seed mints for a FEATURE artifact. */
export function seedFeatureArtifactRow(status: FeatureStatus): SeedArtifactRow {
  return {
    id: deterministicUuid(
      `artifact:feature:${BASELINE_ORG_ID}:status-${status.toLowerCase()}`
    ),
    slug: `seed-feature-${slugToken(status)}`,
  };
}

/** The `(id, slug)` pair the seed mints for a TEMPLATE artifact. */
export function seedTemplateArtifactRow(
  subtype: ArtifactSubtype
): SeedArtifactRow {
  return {
    id: deterministicUuid(
      `artifact:template:${BASELINE_ORG_ID}:${subtype.toLowerCase()}`
    ),
    slug: `seed-template-${slugToken(subtype)}`,
  };
}

/** The `(id, slug)` pair the seed mints for a scaled filler DOCUMENT. */
export function seedScaledDocumentArtifactRow(index: number): SeedArtifactRow {
  return {
    id: deterministicUuid(
      `artifact:document:${BASELINE_ORG_ID}:scaled-${index}`
    ),
    slug: `scaled-seed-document-${index}`,
  };
}

/** The three artifacts the seed mints exactly once per org. */
export function seedBranchArtifactRow(): SeedArtifactRow {
  return {
    id: deterministicUuid(
      `artifact:branch:${BASELINE_ORG_ID}:seed-feature-branch`
    ),
    slug: `seed-branch-${BASELINE_ORG_ID.slice(0, ORG_SLUG_PREFIX_LENGTH)}`,
  };
}

export function seedDeploymentArtifactRow(): SeedArtifactRow {
  return {
    id: deterministicUuid(
      `artifact:deployment:${BASELINE_ORG_ID}:seed-preview`
    ),
    slug: `seed-deployment-${BASELINE_ORG_ID.slice(0, ORG_SLUG_PREFIX_LENGTH)}`,
  };
}

export function seedSessionArtifactRow(): SeedArtifactRow {
  return {
    id: deterministicUuid(`artifact:session:${BASELINE_ORG_ID}:seed-session`),
    slug: `seed-session-${BASELINE_ORG_ID.slice(0, ORG_SLUG_PREFIX_LENGTH)}`,
  };
}

/**
 * The four artifact rows `buildSeedOwnedOrgMock` presents. Uses a status that
 * carries an underscore (`IN_REVIEW`) so the fixture exercises the slug's
 * `_`→`-` substitution rather than only single-word statuses.
 */
export function seedArtifactRows(): SeedArtifactRow[] {
  return [
    seedDocumentArtifactRow(DocumentStatus.IN_REVIEW),
    seedBranchArtifactRow(),
    seedDeploymentArtifactRow(),
    seedSessionArtifactRow(),
  ];
}

/**
 * A deep Prisma mock whose every read the guard issues starts out answering
 * "no rows": `count` resolves 0 and `findMany` an empty array, as a real
 * client does for an empty org. Builders and tests override from there.
 */
function createGuardPrismaMock(): OrgGuardPrismaMock {
  const prisma = mockDeep<PrismaClient>();
  prisma.project.count.mockResolvedValue(0);
  prisma.project.findMany.mockResolvedValue([]);
  prisma.team.count.mockResolvedValue(0);
  prisma.team.findMany.mockResolvedValue([]);
  prisma.artifact.count.mockResolvedValue(0);
  prisma.artifact.findMany.mockResolvedValue([]);
  prisma.loop.count.mockResolvedValue(0);
  prisma.comment.count.mockResolvedValue(0);
  prisma.comment.findMany.mockResolvedValue([]);
  prisma.customField.count.mockResolvedValue(0);
  prisma.customField.findMany.mockResolvedValue([]);
  prisma.artifactEvaluation.count.mockResolvedValue(0);
  prisma.artifactEvaluation.findMany.mockResolvedValue([]);
  return prisma;
}
