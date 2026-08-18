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

import {
  type ArtifactSubtype,
  DocumentStatus,
  type FeatureStatus,
} from "../../../../generated/client";
import { deterministicUuid } from "../../helpers";
import { BASELINE_ORG_ID } from "./baseline-org";
import { createMockPrisma } from "./mock-prisma";

// Shorthand to access mock call records without fighting Prisma's fluent types.
export type AnyDelegate = any;

const KEY_TOKEN_SEPARATOR_PATTERN = /_/g;
const ORG_SLUG_PREFIX_LENGTH = 8;

/** A sampled `artifact.findMany` row as the guard selects it. */
export type SeedArtifactRow = { id: string; slug: string };

/**
 * Builds a mock PrismaClient where no integrations exist and all
 * entity counts are zero — representing a clean, empty org.
 */
export function buildEmptyOrgMock() {
  const prisma = createMockPrisma();
  const p = prisma as AnyDelegate;

  // No integrations
  p.gitHubInstallation.findUnique.mockResolvedValue(null);
  p.linearIntegration.findUnique.mockResolvedValue(null);
  p.slackIntegration.findUnique.mockResolvedValue(null);

  // No entity rows
  p.project.count.mockResolvedValue(0);
  p.team.count.mockResolvedValue(0);

  return prisma;
}

/**
 * Builds a mock PrismaClient where all 6 models have pre-existing data —
 * representing a fully non-empty org.
 */
export function buildFullyConflictedOrgMock() {
  const prisma = createMockPrisma();
  const p = prisma as AnyDelegate;

  p.gitHubInstallation.findUnique.mockResolvedValue({ id: "gh-install-1" });
  p.linearIntegration.findUnique.mockResolvedValue({ id: "linear-1" });
  p.slackIntegration.findUnique.mockResolvedValue({ id: "slack-1" });
  p.project.count.mockResolvedValue(3);
  p.team.count.mockResolvedValue(2);

  return prisma;
}

export function buildSeedOwnedOrgMock() {
  const prisma = createMockPrisma();
  const p = prisma as AnyDelegate;

  p.gitHubInstallation.findUnique.mockResolvedValue({
    id: deterministicUuid(`github-installation:${BASELINE_ORG_ID}:seed`),
  });
  // The seed creates no LinearIntegration — see the module header. A seeded org
  // has no row here, so any row the guard finds is customer-owned.
  p.linearIntegration.findUnique.mockResolvedValue(null);
  p.slackIntegration.findUnique.mockResolvedValue({
    id: deterministicUuid(`slack-integration:${BASELINE_ORG_ID}:seed`),
  });
  p.project.count.mockResolvedValue(2);
  p.project.findMany.mockResolvedValue([
    {
      id: deterministicUuid(`project:${BASELINE_ORG_ID}:platform-foundation`),
      slug: "platform-foundation",
    },
    {
      id: deterministicUuid(`project:${BASELINE_ORG_ID}:developer-experience`),
      slug: "developer-experience",
    },
  ]);
  p.team.count.mockResolvedValue(1);
  p.team.findMany.mockResolvedValue([
    {
      id: deterministicUuid(`team:${BASELINE_ORG_ID}:default`),
      slug: "default",
    },
  ]);
  p.artifact.count.mockResolvedValue(4);
  p.artifact.findMany.mockResolvedValue(seedArtifactRows());
  p.loop.count.mockResolvedValue(1);
  p.loop.findMany.mockResolvedValue([
    {
      id: deterministicUuid(`loop:${BASELINE_ORG_ID}:plan-generation`),
      prompt: "Generate an implementation plan for the seed workstream",
    },
  ]);
  p.comment.count.mockResolvedValue(5);
  p.comment.findMany.mockResolvedValue([
    {
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:seed`),
      plainText: "Seed baseline comment",
    },
    {
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:native`),
      plainText: "Initial feedback on this document.",
    },
    {
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:native-reply`),
      plainText: "Follow-up: looks good after review.",
    },
    {
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:liveblocks`),
      plainText: "Liveblocks collaborative comment.",
    },
    {
      id: deterministicUuid(`comment:${BASELINE_ORG_ID}:github`),
      plainText:
        "GitHub PR review comment — please address the naming convention.",
    },
  ]);
  p.customField.count.mockResolvedValue(1);
  p.customField.findMany.mockResolvedValue([
    {
      id: deterministicUuid(`custom-field:${BASELINE_ORG_ID}:notes`),
      name: "Notes",
    },
  ]);
  p.artifactEvaluation.count.mockResolvedValue(1);
  p.artifactEvaluation.findMany.mockResolvedValue([
    {
      id: deterministicUuid(`artifact-evaluation:${BASELINE_ORG_ID}:plan`),
      reportId: `seed-report-plan-${BASELINE_ORG_ID}`,
    },
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
