import { SlugPrefix } from "@repo/api/src/types/slug-prefix";
import {
  ArtifactSubtype,
  ArtifactType,
  DocumentStatus,
  FeatureStatus,
  GitHubInstallationStatus,
  Priority,
  ProjectStatus,
  TeamRole,
} from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import { pickRequired } from "./allocations";
import {
  createSeedBatchTransactionRunner,
  createUpsertCounts,
  deterministicUuid,
  forEachSeedBatch,
  logUpsertSummary,
  seedLog,
  upsertRow,
} from "./helpers";
import type { SeedContext } from "./index";
import { resolveSeedRunPlan, SeedRngMode, type SeedRunPlan } from "./profiles";
import { buildLongTailIndexSequence } from "./rng";

/**
 * All slug type prefixes used by generated artifacts. Pulled from the
 * canonical `SlugPrefix` const in `packages/api/src/types/slug-prefix.ts`
 * so the seed cannot drift out of sync with the rest of the codebase.
 * SlugCounter rows must exist before any artifact-generating code
 * increments them.
 */
const SLUG_TYPE_PREFIXES = Object.values(SlugPrefix);

/**
 * Shape of the data returned by seedCoreEntities so downstream seed modules
 * (e.g. documents, loops, GitHub integrations) can reference stable IDs
 * without re-deriving or re-querying. Downstream modules MUST consume these
 * IDs rather than recompute via deterministicUuid() — that pattern previously
 * created two owners for the same rows and let payloads silently drift.
 */
export type CoreSeedResult = {
  teamId: string;
  projectIds: readonly string[];
  artifactIds: readonly string[];
  /** The single seeded GitHubInstallation row, owned by seedCoreEntities. */
  githubInstallationId: string;
  /** The single seeded GitHubInstallationRepository row. */
  githubRepositoryId: string;
  /** The single seeded BRANCH-type artifact (anchors PullRequestDetail). */
  branchArtifactId: string;
};

/**
 * Seeds the core organizational entities:
 * - One Team with the seed user as OWNER
 * - Two Projects under the organization, both assigned to the seed user
 * - SlugCounter rows for all artifact type prefixes
 *
 * All operations are idempotent: re-running the seed against an existing
 * database updates in place rather than inserting duplicates.
 *
 * @param prisma - Initialized PrismaClient connected to the target database.
 * @param context - Resolved organization and user identifiers.
 * @returns IDs for the seeded team and projects for use by downstream modules.
 */
export async function seedCoreEntities(
  prisma: TransactionClient,
  context: SeedContext,
  plan: SeedRunPlan = resolveSeedRunPlan()
): Promise<CoreSeedResult> {
  const { organizationId, userId } = context;
  const counts = createUpsertCounts();

  seedLog("Seeding core entities (Team, Projects, SlugCounters)…");

  // -------------------------------------------------------------------------
  // Team
  // -------------------------------------------------------------------------

  const teamId = deterministicUuid(`team:${organizationId}:default`);
  const teamMemberId = deterministicUuid(`team-member:${teamId}:${userId}`);

  const team = await upsertRow({
    model: "Team",
    id: teamId,
    upsert: () =>
      prisma.team.upsert({
        where: { id: teamId },
        create: {
          id: teamId,
          organizationId,
          name: "Default Team",
          slug: "default",
        },
        update: {
          name: "Default Team",
        },
      }),
    counts,
  });

  // Add the seed user as OWNER of the team.
  await upsertRow({
    model: "TeamMember",
    id: teamMemberId,
    upsert: () =>
      prisma.teamMember.upsert({
        where: { id: teamMemberId },
        create: {
          id: teamMemberId,
          teamId: team.id,
          userId,
          role: TeamRole.OWNER,
        },
        update: {
          role: TeamRole.OWNER,
        },
      }),
    counts,
  });

  // -------------------------------------------------------------------------
  // Projects
  // -------------------------------------------------------------------------

  const baseProjectDefinitions = [
    {
      key: `project:${organizationId}:platform-foundation`,
      name: "Platform Foundation",
      slug: "platform-foundation",
      description:
        "Core infrastructure, authentication, and shared service layer.",
      priority: Priority.HIGH,
      status: ProjectStatus.IN_PROGRESS,
    },
    {
      key: `project:${organizationId}:developer-experience`,
      name: "Developer Experience",
      slug: "developer-experience",
      description:
        "Tooling, documentation, and workflows that accelerate engineering velocity.",
      priority: Priority.MEDIUM,
      status: ProjectStatus.NOT_STARTED,
    },
  ] as const;

  const projectDefinitions = Array.from(
    { length: plan.targets.projects },
    (_unused, index) => {
      const base =
        baseProjectDefinitions[index % baseProjectDefinitions.length];
      if (index < baseProjectDefinitions.length) {
        return base;
      }
      const suffix = index + 1;
      return {
        key: `project:${organizationId}:scaled-${suffix}`,
        name: `Scaled Seed Project ${suffix}`,
        slug: `scaled-seed-project-${suffix}`,
        description: "Generated seed project for profile scale coverage.",
        priority: index % 2 === 0 ? Priority.HIGH : Priority.MEDIUM,
        status:
          index % 3 === 0
            ? ProjectStatus.IN_PROGRESS
            : ProjectStatus.NOT_STARTED,
      };
    }
  );

  const projectIds = projectDefinitions.map((def) =>
    deterministicUuid(def.key)
  );

  for (let i = 0; i < projectDefinitions.length; i++) {
    const def = projectDefinitions[i];
    const projectId = projectIds[i];

    await upsertRow({
      model: "Project",
      id: projectId,
      upsert: () =>
        prisma.project.upsert({
          where: { id: projectId },
          create: {
            id: projectId,
            organizationId,
            name: def.name,
            slug: def.slug,
            description: def.description,
            priority: def.priority,
            status: def.status,
            createdById: userId,
            assigneeId: userId,
          },
          update: {
            name: def.name,
            description: def.description,
            priority: def.priority,
          },
        }),
      counts,
    });
  }

  // -------------------------------------------------------------------------
  // SlugCounters — one row per type prefix, per organization
  // -------------------------------------------------------------------------

  for (const typePrefix of SLUG_TYPE_PREFIXES) {
    const slugCounterId = deterministicUuid(
      `slug-counter:${organizationId}:${typePrefix}`
    );

    await upsertRow({
      model: "SlugCounter",
      id: slugCounterId,
      upsert: () =>
        prisma.slugCounter.upsert({
          where: {
            organizationId_typePrefix: {
              organizationId,
              typePrefix,
            },
          },
          create: {
            id: slugCounterId,
            organizationId,
            typePrefix,
            currentValue: 0,
          },
          // Do not reset the counter if it already exists — preserve current value.
          update: {},
        }),
      counts,
    });
  }

  logUpsertSummary(counts);

  // -------------------------------------------------------------------------
  // Artifacts — one per ArtifactType, covering all DocumentStatus and
  // ArtifactSubtype values for DOCUMENT type
  // -------------------------------------------------------------------------

  const artifactResult = await seedArtifacts(prisma, context, projectIds, plan);

  return {
    teamId: team.id,
    projectIds,
    artifactIds: artifactResult.artifactIds,
    githubInstallationId: artifactResult.githubInstallationId,
    githubRepositoryId: artifactResult.githubRepositoryId,
    branchArtifactId: artifactResult.branchArtifactId,
  };
}

/**
 * Seeds Artifact rows covering every ArtifactType and, for DOCUMENT artifacts,
 * every DocumentStatus value and every ArtifactSubtype value.
 *
 * For BRANCH and DEPLOYMENT artifact types a seed GitHub installation and
 * repository are created first (these are required FKs for BranchDetail).
 * PullRequestDetail rows are not seeded as a standalone artifact type — in the
 * schema, PullRequestDetail is a sub-record of BRANCH artifacts, not its own
 * ArtifactType.
 *
 * templateForType uniqueness (one template document per subtype per org) is
 * enforced by design: only a single TEMPLATE document is created per
 * ArtifactSubtype value, with a deterministic ID that is stable across reruns.
 *
 * All operations are idempotent — re-running the seed updates in place.
 *
 * @param prisma - Initialized PrismaClient connected to the target database.
 * @param context - Resolved organization and user identifiers.
 * @param projectIds - The two project IDs from the project seed step.
 * @returns Array of all seeded artifact IDs for use by downstream modules.
 */
async function seedArtifacts(
  prisma: TransactionClient,
  context: SeedContext,
  projectIds: readonly string[],
  plan: SeedRunPlan
): Promise<{
  artifactIds: string[];
  githubInstallationId: string;
  githubRepositoryId: string;
  branchArtifactId: string;
}> {
  const { organizationId, userId } = context;
  const counts = createUpsertCounts();
  const artifactIds: string[] = [];

  seedLog(
    `Seeding artifacts (${plan.targets.artifacts} target rows for ${plan.profile})...`
  );

  // -------------------------------------------------------------------------
  // Seed GitHub installation + repository required by BranchDetail FK
  // -------------------------------------------------------------------------

  const githubInstallationId = deterministicUuid(
    `github-installation:${organizationId}:seed`
  );
  const githubRepositoryId = deterministicUuid(
    `github-repository:${organizationId}:seed`
  );

  await upsertRow({
    model: "GitHubInstallation",
    id: githubInstallationId,
    upsert: () =>
      prisma.gitHubInstallation.upsert({
        where: { id: githubInstallationId },
        create: {
          id: githubInstallationId,
          organizationId,
          installationId: `seed-installation-${organizationId}`,
          accountId: "seed-account-id",
          accountLogin: "seed-org",
          accountType: "Organization",
          senderLogin: "seed-user",
          senderId: "seed-sender-id",
          status: GitHubInstallationStatus.ACTIVE,
        },
        update: {
          status: GitHubInstallationStatus.ACTIVE,
        },
      }),
    counts,
  });

  await upsertRow({
    model: "GitHubInstallationRepository",
    id: githubRepositoryId,
    upsert: () =>
      prisma.gitHubInstallationRepository.upsert({
        where: { id: githubRepositoryId },
        create: {
          id: githubRepositoryId,
          installationId: githubInstallationId,
          githubRepoId: `seed-repo-${organizationId}`,
          fullName: "seed-org/seed-repo",
          name: "seed-repo",
          owner: "seed-org",
          private: false,
        },
        update: {
          fullName: "seed-org/seed-repo",
        },
      }),
    counts,
  });

  // -------------------------------------------------------------------------
  // DOCUMENT artifacts — one per DocumentStatus, plus one per ArtifactSubtype
  // as a TEMPLATE (one template per subtype, satisfying the templateForType
  // uniqueness requirement).
  //
  // Statuses: DRAFT, IN_PROGRESS, IN_REVIEW, APPROVED, EXECUTED, DONE, OBSOLETE
  // Subtypes seeded as regular docs: PRD, IMPLEMENTATION_PLAN, FEATURE
  // Subtypes seeded as templates:   PRD, IMPLEMENTATION_PLAN, TEMPLATE, FEATURE
  // -------------------------------------------------------------------------

  type DocumentArtifactDefinition = {
    key: string;
    name: string;
    slug: string;
    subtype: ArtifactSubtype;
    // Documents and Features have disjoint status vocabularies (PRD-495).
    status: DocumentStatus | FeatureStatus;
    // When set this doc is a TEMPLATE for the given subtype.
    templateForType?: ArtifactSubtype;
    projectIndex: number;
  };

  const documentStatuses = Object.values(DocumentStatus);
  const featureStatuses = Object.values(FeatureStatus);

  // Regular (non-template) Document definitions — one per DocumentStatus,
  // distributed across the Document subtypes (PRD / IMPLEMENTATION_PLAN) so
  // every Document status is represented. FEATURE rows are seeded separately
  // below with the Feature vocabulary.
  const documentSubtypes: ArtifactSubtype[] = [
    ArtifactSubtype.PRD,
    ArtifactSubtype.IMPLEMENTATION_PLAN,
  ];

  const documentDefinitions: DocumentArtifactDefinition[] =
    documentStatuses.map((status, i) => ({
      key: `artifact:document:${organizationId}:status-${status.toLowerCase()}`,
      name: `Seed Document (${status})`,
      slug: `seed-doc-${status.toLowerCase().replace(/_/g, "-")}`,
      subtype: documentSubtypes[i % documentSubtypes.length],
      status,
      templateForType: undefined,
      projectIndex: i,
    }));

  // Feature-specific definitions — one per FeatureStatus (AC-005). Dedicated
  // FEATURE subtype artifacts covering every Feature status value so the seed
  // reliably exercises Feature rendering across all delivery-lifecycle states.
  const featureDefinitions: DocumentArtifactDefinition[] = featureStatuses.map(
    (status, i) => ({
      key: `artifact:feature:${organizationId}:status-${status.toLowerCase()}`,
      name: `Seed Feature (${status})`,
      slug: `seed-feature-${status.toLowerCase().replace(/_/g, "-")}`,
      subtype: ArtifactSubtype.FEATURE,
      status,
      templateForType: undefined,
      projectIndex: i + documentStatuses.length,
    })
  );

  // Template definitions — one per concrete ArtifactSubtype (satisfies the
  // templateForType uniqueness constraint: one template per subtype per org).
  // ArtifactSubtype.TEMPLATE itself is excluded — a "template for TEMPLATE" is
  // semantically nonsensical (templates document the shape of concrete
  // artifact subtypes, not of the template kind).
  const templateDefinitions: DocumentArtifactDefinition[] = Object.values(
    ArtifactSubtype
  )
    .filter((subtype) => subtype !== ArtifactSubtype.TEMPLATE)
    .map((subtype, i) => ({
      key: `artifact:template:${organizationId}:${subtype.toLowerCase()}`,
      name: `Seed Template (${subtype})`,
      slug: `seed-template-${subtype.toLowerCase().replace(/_/g, "-")}`,
      subtype: ArtifactSubtype.TEMPLATE,
      status: DocumentStatus.APPROVED,
      templateForType: subtype,
      projectIndex: i,
    }));

  const baseDocumentDefinitions = [
    ...documentDefinitions,
    ...featureDefinitions,
    ...templateDefinitions,
  ];
  // Reserve slots for the fixed non-document artifacts seeded below — one
  // BRANCH, one DEPLOYMENT, and one SESSION — so the total artifact count
  // lands on the profile target rather than overshooting it.
  const documentTarget = Math.max(0, plan.targets.artifacts - 3);
  const scaledDocumentCount = Math.max(
    0,
    documentTarget - baseDocumentDefinitions.length
  );
  const projectLongTailIndexes =
    plan.rngMode === SeedRngMode.Perf
      ? buildLongTailIndexSequence(scaledDocumentCount, projectIds.length)
      : null;
  const allDocumentDefinitions: DocumentArtifactDefinition[] = Array.from(
    { length: documentTarget },
    (_unused, index) => {
      const base =
        baseDocumentDefinitions[index % baseDocumentDefinitions.length];
      if (index < baseDocumentDefinitions.length) {
        return base;
      }
      const scaledIndex = index - baseDocumentDefinitions.length;
      // Scaled filler rows are Documents (PRD/IMPLEMENTATION_PLAN) carrying the
      // Document status vocabulary (PRD-495).
      const status = documentStatuses[index % documentStatuses.length];
      const subtype = documentSubtypes[index % documentSubtypes.length];
      return {
        key: `artifact:document:${organizationId}:scaled-${index + 1}`,
        name: `Scaled Seed Document ${index + 1}`,
        slug: `scaled-seed-document-${index + 1}`,
        subtype,
        status,
        templateForType: undefined,
        projectIndex: projectLongTailIndexes
          ? projectLongTailIndexes[scaledIndex]
          : index,
      };
    }
  );

  await forEachSeedBatch({
    items: allDocumentDefinitions,
    batchSize: plan.transaction.batchSize,
    label: "document artifacts",
    runBatch: createSeedBatchTransactionRunner(prisma, plan.transaction),
    run: async (def, _index, batchClient) => {
      const batchPrisma = batchClient ?? prisma;
      const artifactId = deterministicUuid(def.key);
      const projectId = pickRequired(
        projectIds,
        def.projectIndex,
        "seedArtifacts.projectIds"
      );

      await upsertRow({
        model: "Artifact",
        id: artifactId,
        upsert: () =>
          batchPrisma.artifact.upsert({
            where: { id: artifactId },
            create: {
              id: artifactId,
              organizationId,
              projectId,
              type: ArtifactType.DOCUMENT,
              subtype: def.subtype,
              name: def.name,
              slug: def.slug,
              status: def.status,
              priority: Priority.MEDIUM,
              createdById: userId,
              assigneeId: userId,
              document: {
                create: {
                  templateForType: def.templateForType ?? null,
                  repositorySnapshot: {},
                },
              },
            },
            update: {
              name: def.name,
              status: def.status,
            },
          }),
        counts,
      });

      // DocumentVersion row for `latestVersion = 1`. Without this, the
      // production document-loading code path (which fetches the version row
      // matching `DocumentDetail.latestVersion`) returns "Artifact version not
      // found" when an operator opens a seeded artifact in the UI. The schema
      // has a unique index on (documentId, version), so upsert by that pair.
      const documentVersionId = deterministicUuid(
        `document-version:${def.key}:v1`
      );
      await upsertRow({
        model: "DocumentVersion",
        id: documentVersionId,
        upsert: () =>
          batchPrisma.documentVersion.upsert({
            where: {
              documentId_version: { documentId: artifactId, version: 1 },
            },
            create: {
              id: documentVersionId,
              documentId: artifactId,
              version: 1,
              content: `# ${def.name}\n\nSynthetic seed content for development and testing. Replace via the document editor when exercising real authoring flows.\n`,
              createdById: userId,
            },
            update: {
              content: `# ${def.name}\n\nSynthetic seed content for development and testing. Replace via the document editor when exercising real authoring flows.\n`,
            },
          }),
        counts,
      });

      artifactIds.push(artifactId);
    },
  });

  // -------------------------------------------------------------------------
  // BRANCH artifact with BranchDetail
  // -------------------------------------------------------------------------

  const branchArtifactId = deterministicUuid(
    `artifact:branch:${organizationId}:seed-feature-branch`
  );

  await upsertRow({
    model: "Artifact",
    id: branchArtifactId,
    upsert: () =>
      prisma.artifact.upsert({
        where: { id: branchArtifactId },
        create: {
          id: branchArtifactId,
          organizationId,
          projectId: pickRequired(
            projectIds,
            0,
            "seedArtifacts.branch.projectIds"
          ),
          type: ArtifactType.BRANCH,
          subtype: null,
          name: "seed/feature-branch",
          slug: `seed-branch-${organizationId.slice(0, 8)}`,
          status: "open",
          createdById: userId,
          branch: {
            create: {
              // FR13: write-once org copy from the parent Artifact; D2 identity
              // via normalized repositoryFullName (matches the seed repo).
              organizationId,
              repositoryId: githubRepositoryId,
              repositoryFullName: "seed-org/seed-repo",
              branchName: "seed/feature-branch",
              baseBranch: "main",
            },
          },
        },
        update: {
          name: "seed/feature-branch",
        },
      }),
    counts,
  });

  artifactIds.push(branchArtifactId);

  // -------------------------------------------------------------------------
  // DEPLOYMENT artifact with DeploymentDetail
  // -------------------------------------------------------------------------

  const deploymentArtifactId = deterministicUuid(
    `artifact:deployment:${organizationId}:seed-preview`
  );

  await upsertRow({
    model: "Artifact",
    id: deploymentArtifactId,
    upsert: () =>
      prisma.artifact.upsert({
        where: { id: deploymentArtifactId },
        create: {
          id: deploymentArtifactId,
          organizationId,
          projectId: pickRequired(
            projectIds,
            1,
            "seedArtifacts.deployment.projectIds"
          ),
          type: ArtifactType.DEPLOYMENT,
          subtype: null,
          name: "Preview Deployment (seed)",
          slug: `seed-deployment-${organizationId.slice(0, 8)}`,
          status: "success",
          createdById: userId,
          deployment: {
            create: {
              environment: "preview",
              ref: "seed/feature-branch",
              sha: "abc1234",
              transient: true,
              production: false,
              branchArtifactId,
            },
          },
        },
        update: {
          name: "Preview Deployment (seed)",
        },
      }),
    counts,
  });

  artifactIds.push(deploymentArtifactId);

  // -------------------------------------------------------------------------
  // SESSION artifact with SessionDetail (FEA-1699)
  //
  // The session needs an owning ComputeTarget (Restrict FK), so seed one
  // first. The artifact id is the SessionDetail primary key (class-table
  // inheritance), and the session is left unparented to exercise the nullable
  // Artifact.projectId column the SESSION artifact type introduced.
  // -------------------------------------------------------------------------

  const computeTargetId = deterministicUuid(
    `compute-target:${organizationId}:seed`
  );

  await upsertRow({
    model: "ComputeTarget",
    id: computeTargetId,
    upsert: () =>
      prisma.computeTarget.upsert({
        where: { id: computeTargetId },
        create: {
          id: computeTargetId,
          organizationId,
          userId,
          machineName: "seed-machine",
          platform: "darwin",
        },
        update: {
          machineName: "seed-machine",
        },
      }),
    counts,
  });

  const sessionArtifactId = deterministicUuid(
    `artifact:session:${organizationId}:seed-session`
  );
  const sessionStartedAt = new Date("2026-01-01T10:00:00.000Z");
  const sessionUpdatedAt = new Date("2026-01-01T11:00:00.000Z");

  await upsertRow({
    model: "Artifact",
    id: sessionArtifactId,
    upsert: () =>
      prisma.artifact.upsert({
        where: { id: sessionArtifactId },
        create: {
          id: sessionArtifactId,
          organizationId,
          projectId: null,
          type: ArtifactType.SESSION,
          subtype: null,
          name: "Seed Agent Session",
          slug: `seed-session-${organizationId.slice(0, 8)}`,
          status: "active",
          createdById: userId,
          session: {
            create: {
              computeTargetId,
              userId,
              externalSessionId: `seed-session-${organizationId}`,
              harness: "claude",
              model: "claude-opus",
              cwd: "/workspace/seed-worktree",
              repositoryFullName: "seed-org/seed-repo",
              sessionStartedAt,
              sessionUpdatedAt,
            },
          },
        },
        update: {
          name: "Seed Agent Session",
        },
      }),
    counts,
  });

  artifactIds.push(sessionArtifactId);

  logUpsertSummary(counts);

  return {
    artifactIds,
    githubInstallationId,
    githubRepositoryId,
    branchArtifactId,
  };
}
