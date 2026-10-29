import { BranchPushSource, LinkType } from "@repo/api/src/types/artifact";
import {
  BranchParticipationKind,
  BranchStatus,
} from "@repo/api/src/types/branch";
import {
  BranchActivityAtomVersion,
  BranchActivityAttributionKind,
  BranchActivityEvidenceCompleteness,
  BranchActivitySource,
} from "@repo/api/src/types/branch-activity";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { STAFF_EMAIL_DOMAIN } from "@repo/api/src/types/staff-email";
import { ArtifactType, withDb } from "@repo/database";
import { NextRequest } from "next/server";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  type createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";

/** Seeds and helpers for the legacy trace-comment route byte-compat suite. */

const ORIGIN = "http://localhost:3002";
export const ACTIVITY_AT = new Date("2026-07-01T00:00:00.000Z");
const UUID_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO_TIMESTAMP_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const CLIENT_SUFFIX_PATTERN = /-c3fix-[0-9a-f]{8}/g;

export type RouteHandler = (
  request: NextRequest,
  context: { params: Promise<Record<string, string>> }
) => Promise<Response>;

export type LegacyRouteFixture = {
  organizationId: string;
  author: { id: string; organizationId: string };
  staff: { id: string; organizationId: string };
  sessionArtifactId: string;
  externalSessionId: string;
  computeTargetId: string;
  branchArtifactId: string;
};

export function callLegacyRoute(
  handler: RouteHandler,
  method: string,
  params: Record<string, string>,
  options: { query?: string; body?: unknown } = {}
): Promise<Response> {
  const request = new NextRequest(`${ORIGIN}/legacy${options.query ?? ""}`, {
    method,
    ...(options.body === undefined
      ? {}
      : {
          body: JSON.stringify(options.body),
          headers: { "Content-Type": "application/json" },
        }),
  });
  return handler(request, { params: Promise.resolve(params) });
}

/** Ids and timestamps are generated per run; every other byte is compared. */
export function normalizeTranscript(lines: string[]): string {
  const ids = new Map<string, string>();
  return `${lines
    .join("\n")
    .replaceAll(UUID_PATTERN, (id) => {
      const known = ids.get(id);
      if (known) {
        return known;
      }
      const label = `<id-${ids.size + 1}>`;
      ids.set(id, label);
      return label;
    })
    .replaceAll(ISO_TIMESTAMP_PATTERN, "<ts>")
    .replaceAll(CLIENT_SUFFIX_PATTERN, "-c3fix")}\n`;
}

export function legacyTraceAnchor(index: number) {
  return {
    traceId: `trace-${index}`,
    turnId: `turn-${index}`,
    row: index,
    selectedText: "selected",
    sourceText: "selected text",
    startOffset: 0,
    endOffset: 8,
    sessionId: `session-${index}`,
    actor: { name: "Agent", human: index % 2 === 0 ? "Kerensa" : null },
  };
}

export type TestDb = Parameters<Parameters<typeof withDb>[0]>[0];

export async function seedLegacyRouteFixture(
  tracker: ReturnType<typeof createCommittedTestOrganizationTracker>,
  runSuffix: string
): Promise<LegacyRouteFixture> {
  const organizationId = await tracker.create();
  const author = await createTestUser(organizationId, {
    firstName: "Ada",
    lastName: "Author",
  });
  const staff = await createTestUser(organizationId, {
    firstName: "Sam",
    lastName: "Staff",
    email: `staff+${runSuffix}${STAFF_EMAIL_DOMAIN}`,
  });
  const externalSessionId = `ext-session-c3fix-${runSuffix}`;
  return withDb(async (db) => {
    const session = await createLegacySession(db, organizationId, staff.id, {
      name: "Legacy route session",
      externalSessionId,
    });
    const branchArtifactId = await createEligibleBranch(
      db,
      organizationId,
      staff.id,
      runSuffix
    );
    return {
      organizationId,
      author: { id: author.id, organizationId },
      staff: { id: staff.id, organizationId },
      sessionArtifactId: session.artifactId,
      externalSessionId,
      computeTargetId: session.computeTargetId,
      branchArtifactId,
    };
  });
}

export async function createLegacySession(
  db: TestDb,
  organizationId: string,
  userId: string,
  input: { name: string; externalSessionId: string }
): Promise<{ artifactId: string; computeTargetId: string }> {
  const artifact = await db.artifact.create({
    data: {
      organizationId,
      type: ArtifactType.SESSION,
      name: input.name,
      status: BranchStatus.Open,
    },
    select: { id: true },
  });
  const computeTarget = await db.computeTarget.create({
    data: {
      organizationId,
      userId,
      machineName: `machine-${input.externalSessionId}`,
      platform: "darwin",
    },
    select: { id: true },
  });
  await db.sessionDetail.create({
    data: {
      artifactId: artifact.id,
      computeTargetId: computeTarget.id,
      externalSessionId: input.externalSessionId,
      harness: "claude",
      sessionStartedAt: ACTIVITY_AT,
      sessionUpdatedAt: ACTIVITY_AT,
      lastActivityAt: ACTIVITY_AT,
    },
    select: { artifactId: true },
  });
  return { artifactId: artifact.id, computeTargetId: computeTarget.id };
}

/** A Branch that passes the cloud product-eligibility gate. */
export async function createEligibleBranch(
  db: TestDb,
  organizationId: string,
  userId: string,
  runSuffix: string
): Promise<string> {
  const branchName = `legacy-route-${runSuffix}`;
  const repositoryFullName = `acme/${branchName}`;
  const artifact = await db.artifact.create({
    data: {
      organizationId,
      type: ArtifactType.BRANCH,
      name: branchName,
      status: BranchStatus.Open,
    },
    select: { id: true },
  });
  await db.branchDetail.create({
    data: {
      artifactId: artifact.id,
      organizationId,
      repositoryFullName,
      branchName,
      firstPushedAt: ACTIVITY_AT,
      pushSource: BranchPushSource.Session,
      lastActivityAt: ACTIVITY_AT,
    },
    select: { artifactId: true },
  });
  await db.branchActivityAtom.create({
    data: {
      version: BranchActivityAtomVersion.V1,
      organizationId,
      branchArtifactId: artifact.id,
      source: BranchActivitySource.GitHead,
      sourceEventId: `fixture:${branchName}`,
      occurredAt: ACTIVITY_AT,
      attributionKind: BranchActivityAttributionKind.Branch,
      completeness: BranchActivityEvidenceCompleteness.Complete,
    },
    select: { id: true },
  });
  await db.publicRepository.create({
    data: {
      organizationId,
      ...persistedGitHubRepositoryAuthority({
        githubRepoId: `repo-${artifact.id}`,
        fullName: repositoryFullName,
      }),
      owner: "acme",
      name: branchName,
      htmlUrl: `https://github.com/${repositoryFullName}`,
    },
    select: { id: true },
  });
  const linked = await createLegacySession(db, organizationId, userId, {
    name: `session-for-${branchName}`,
    externalSessionId: `ext-${branchName}`,
  });
  await db.artifactLink.create({
    data: {
      organizationId,
      sourceId: linked.artifactId,
      targetId: artifact.id,
      linkType: LinkType.RelatesTo,
      branchParticipation: BranchParticipationKind.Wrote,
      metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
    },
    select: { id: true },
  });
  return artifact.id;
}
