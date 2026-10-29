import type { PrismaClient } from "@repo/database";
import { VIBE_SEED_ORGANIZATION } from "./seed-identity";

/**
 * ISS-12056 (Seed quality): the checks a finished vibe seed must pass. Each
 * returns one issue naming the gap and how many rows show it; an empty list
 * means the seeded org is internally consistent and reads like a real team.
 */

export const SeedIntegrityIssueCode = {
  OrganizationNotNamed: "organization_not_named",
  TooFewMembers: "too_few_members",
  BranchWithoutOwner: "branch_without_owner",
  BannedWording: "banned_wording",
  ProjectWithoutSlug: "project_without_slug",
  ContentCreatedAtOnce: "content_created_at_once",
  OneDocumentAuthor: "one_document_author",
  OneCommentAuthor: "one_comment_author",
  UniformPriority: "uniform_priority",
  ProjectWithFewIssues: "project_with_few_issues",
} as const;
export type SeedIntegrityIssueCode =
  (typeof SeedIntegrityIssueCode)[keyof typeof SeedIntegrityIssueCode];

export type SeedIntegrityIssue = {
  readonly code: SeedIntegrityIssueCode;
  readonly count: number;
  readonly message: string;
};

/** The ticket asks for an owner plus teammates, so one member is never enough. */
export const MIN_SEEDED_MEMBERS = 2;

const EXAMPLE_LIMIT = 5;

const BANNED_TOKENS: ReadonlySet<string> = new Set([
  "e2e",
  "test",
  "tests",
  "testing",
  "fixture",
  "fixtures",
  "dummy",
  "dummies",
  "fake",
  "fakes",
  "sample",
  "samples",
  "seed",
  "seeds",
  "seeded",
  "seeding",
  "mock",
  "mocks",
  "mocked",
  "lorem",
  "ipsum",
  "placeholder",
  "placeholders",
  "demo",
  "foo",
  "foobar",
]);

const CAMEL_BOUNDARY = /([a-z])([A-Z])/g;
const TOKEN_SEPARATOR = /[^a-z0-9]+/;
const TEST_USER_TOKEN = /^testuser\d*$/;

type LabelledText = { readonly label: string; readonly value: string | null };

/**
 * Whether `text` carries test-data wording as a whole word: the text is split
 * at every non-alphanumeric character and camelCase boundary, so `seed-repo`,
 * `E2E Local Trusted` and `sampleProject` match while `latest` or `contest`
 * do not.
 */
export function containsBannedWording(
  text: string | null | undefined
): boolean {
  if (!text) {
    return false;
  }
  return text
    .replace(CAMEL_BOUNDARY, "$1 $2")
    .toLowerCase()
    .split(TOKEN_SEPARATOR)
    .some((token) => BANNED_TOKENS.has(token) || TEST_USER_TOKEN.test(token));
}

export async function checkSeedIntegrity(
  prisma: PrismaClient,
  organizationId: string
): Promise<SeedIntegrityIssue[]> {
  const [organization, users, ownerless, labels] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, slug: true },
    }),
    prisma.user.findMany({
      where: { organizationId, active: true },
      select: { id: true },
    }),
    findBranchesWithoutOwner(prisma, organizationId),
    readSeededLabels(prisma, organizationId),
  ]);
  const issues: SeedIntegrityIssue[] = [];
  if (
    organization?.name !== VIBE_SEED_ORGANIZATION.name ||
    organization.slug !== VIBE_SEED_ORGANIZATION.slug
  ) {
    issues.push({
      code: SeedIntegrityIssueCode.OrganizationNotNamed,
      count: 1,
      message: `organization is ${JSON.stringify(organization)}, expected ${JSON.stringify(VIBE_SEED_ORGANIZATION)}`,
    });
  }
  if (users.length < MIN_SEEDED_MEMBERS) {
    issues.push({
      code: SeedIntegrityIssueCode.TooFewMembers,
      count: users.length,
      message: `organization has ${users.length} active member(s), expected at least ${MIN_SEEDED_MEMBERS}`,
    });
  }
  if (ownerless.length > 0) {
    issues.push({
      code: SeedIntegrityIssueCode.BranchWithoutOwner,
      count: ownerless.length,
      message: `branch(es) with no owner: ${formatExamples(ownerless)}`,
    });
  }
  const banned = labels.filter((label) => containsBannedWording(label.value));
  if (banned.length > 0) {
    issues.push({
      code: SeedIntegrityIssueCode.BannedWording,
      count: banned.length,
      message: `seeded identity text with test-data wording: ${formatExamples(
        banned.map((label) => `${label.label} ${JSON.stringify(label.value)}`)
      )}`,
    });
  }
  return issues;
}

export function assertSeedIntegrity(
  issues: readonly SeedIntegrityIssue[]
): void {
  if (issues.length === 0) {
    return;
  }
  const lines = issues.map(
    (issue) => `- ${issue.code} (${issue.count}): ${issue.message}`
  );
  throw new Error(`seed integrity check failed:\n${lines.join("\n")}`);
}

/**
 * Live branches the Branches Owner column would leave empty. The Owner is the
 * branch's assignee (ISS-12463), named only when that user belongs to the
 * branch's organization, the list SQL's `users` join condition.
 */
async function findBranchesWithoutOwner(
  prisma: PrismaClient,
  organizationId: string
): Promise<string[]> {
  const [branches, memberIds] = await Promise.all([
    prisma.branchDetail.findMany({
      where: { organizationId, deletedAt: null },
      select: {
        branchName: true,
        artifact: { select: { assigneeId: true } },
      },
    }),
    prisma.user.findMany({
      where: { organizationId },
      select: { id: true },
    }),
  ]);
  const members = new Set(memberIds.map((user) => user.id));
  return branches
    .filter((branch) => {
      const assigneeId = branch.artifact.assigneeId;
      return !(assigneeId && members.has(assigneeId));
    })
    .map((branch) => branch.branchName);
}

/** The org's people, places and seeded titles a reader sees as names. */
async function readSeededLabels(
  prisma: PrismaClient,
  organizationId: string
): Promise<LabelledText[]> {
  const [
    organization,
    users,
    teams,
    projects,
    artifacts,
    branches,
    tags,
    installation,
    repositories,
    connections,
    slack,
    computeTargets,
    apiKeys,
    customFieldValues,
  ] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, slug: true },
    }),
    prisma.user.findMany({
      where: { organizationId },
      select: { firstName: true, lastName: true, email: true },
    }),
    prisma.team.findMany({
      where: { organizationId },
      select: { name: true, slug: true },
    }),
    prisma.project.findMany({
      where: { organizationId },
      select: { name: true, slug: true, description: true },
    }),
    prisma.artifact.findMany({
      where: { organizationId },
      select: { name: true, slug: true },
    }),
    prisma.branchDetail.findMany({
      where: { organizationId, deletedAt: null },
      select: { branchName: true },
    }),
    prisma.tag.findMany({ where: { organizationId }, select: { name: true } }),
    prisma.gitHubInstallation.findUnique({
      where: { organizationId },
      select: { accountLogin: true, senderLogin: true },
    }),
    prisma.gitHubInstallationRepository.findMany({
      where: { installation: { organizationId } },
      select: { fullName: true },
    }),
    prisma.gitHubUserConnection.findMany({
      where: { organizationId },
      select: { login: true },
    }),
    prisma.slackIntegration.findUnique({
      where: { organizationId },
      select: { teamName: true },
    }),
    prisma.computeTarget.findMany({
      where: { organizationId },
      select: { machineName: true },
    }),
    prisma.apiKey.findMany({
      where: { organizationId },
      select: { name: true },
    }),
    prisma.customFieldValue.findMany({
      where: { organizationId },
      select: { textValue: true, displayValue: true },
    }),
  ]);
  return [
    ...labelled("organizations.name", [organization?.name ?? null]),
    ...labelled("organizations.slug", [organization?.slug ?? null]),
    ...labelled(
      "users.first_name",
      users.map((row) => row.firstName)
    ),
    ...labelled(
      "users.last_name",
      users.map((row) => row.lastName)
    ),
    ...labelled(
      "users.email",
      users.map((row) => row.email)
    ),
    ...labelled(
      "teams.name",
      teams.map((row) => row.name)
    ),
    ...labelled(
      "teams.slug",
      teams.map((row) => row.slug)
    ),
    ...labelled(
      "projects.name",
      projects.map((row) => row.name)
    ),
    ...labelled(
      "projects.slug",
      projects.map((row) => row.slug)
    ),
    ...labelled(
      "projects.description",
      projects.map((row) => row.description)
    ),
    ...labelled(
      "artifacts.name",
      artifacts.map((row) => row.name)
    ),
    ...labelled(
      "artifacts.slug",
      artifacts.map((row) => row.slug)
    ),
    ...labelled(
      "branch_details.branch_name",
      branches.map((row) => row.branchName)
    ),
    ...labelled(
      "tags.name",
      tags.map((row) => row.name)
    ),
    ...labelled("github_installations.account_login", [
      installation?.accountLogin ?? null,
    ]),
    ...labelled("github_installations.sender_login", [
      installation?.senderLogin ?? null,
    ]),
    ...labelled(
      "github_installation_repositories.full_name",
      repositories.map((row) => row.fullName)
    ),
    ...labelled(
      "github_user_connections.login",
      connections.map((row) => row.login)
    ),
    ...labelled("slack_integrations.team_name", [slack?.teamName ?? null]),
    ...labelled(
      "compute_targets.machine_name",
      computeTargets.map((row) => row.machineName)
    ),
    ...labelled(
      "api_keys.name",
      apiKeys.map((row) => row.name)
    ),
    ...labelled(
      "custom_field_values.text_value",
      customFieldValues.map((row) => row.textValue)
    ),
    ...labelled(
      "custom_field_values.display_value",
      customFieldValues.map((row) => row.displayValue)
    ),
  ];
}

function labelled(
  label: string,
  values: readonly (string | null)[]
): LabelledText[] {
  return values.map((value) => ({ label, value }));
}

function formatExamples(values: readonly string[]): string {
  const shown = values.slice(0, EXAMPLE_LIMIT).join(", ");
  const more = values.length - EXAMPLE_LIMIT;
  return more > 0 ? `${shown} and ${more} more` : shown;
}
