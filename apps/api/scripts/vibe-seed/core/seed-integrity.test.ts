import { ArtifactType } from "@repo/api/src/types/artifact";
import type { PrismaClient } from "@repo/database";
import { describe, expect, it } from "vitest";
import { VIBE_SEED_ORGANIZATION } from "./seed-identity";
import {
  assertSeedIntegrity,
  checkSeedIntegrity,
  containsBannedWording,
  SeedIntegrityIssueCode,
} from "./seed-integrity";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const OTHER_ORG = "00000000-0000-4000-8000-0000000000b2";
const OWNER = "00000000-0000-4000-8000-000000000001";
const TEAMMATE = "00000000-0000-4000-8000-000000000002";
const OUTSIDER = "00000000-0000-4000-8000-000000000003";
const BRANCH = "00000000-0000-4000-8000-000000000010";
const PUSHED_AT = new Date("2026-09-01T10:00:00.000Z");

type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;

describe("containsBannedWording", () => {
  it.each([
    "seed-org/seed-repo",
    "E2E Local Trusted",
    "Scaled Seed Document 4",
    "sampleProject",
    "TEST workspace",
    "Dummy account",
    "mock_user",
    "fixtures",
    "testuser2",
  ])("flags %j", (text) => {
    expect(containsBannedWording(text)).toBe(true);
  });

  it.each([
    "Acme Co",
    "maya.okafor@acmeco.example",
    "latest",
    "Contest entries",
    "ui-feature-flag-attestation",
    "Seedling",
    "",
    null,
    undefined,
  ])("leaves %j alone", (text) => {
    expect(containsBannedWording(text)).toBe(false);
  });
});

describe("checkSeedIntegrity", () => {
  it("reports nothing for a consistent, realistically named org", async () => {
    expect(await checkSeedIntegrity(fakePrisma(cleanTables()), ORG)).toEqual(
      []
    );
  });

  it("reports an organization that is not Acme Co", async () => {
    const tables = cleanTables();
    tables.organization = [
      { id: ORG, name: "Northwind", slug: VIBE_SEED_ORGANIZATION.slug },
    ];
    expect(codes(await checkSeedIntegrity(fakePrisma(tables), ORG))).toEqual([
      SeedIntegrityIssueCode.OrganizationNotNamed,
    ]);
  });

  it("reports an organization with a single member", async () => {
    const tables = cleanTables();
    tables.user = (tables.user ?? []).filter((user) => user.id === OWNER);
    const issues = await checkSeedIntegrity(fakePrisma(tables), ORG);
    expect(issues).toEqual([
      expect.objectContaining({
        code: SeedIntegrityIssueCode.TooFewMembers,
        count: 1,
      }),
    ]);
  });

  it("does not count an inactive member", async () => {
    const tables = cleanTables();
    tables.user = (tables.user ?? []).map((user) =>
      user.id === TEAMMATE ? { ...user, active: false } : user
    );
    expect(codes(await checkSeedIntegrity(fakePrisma(tables), ORG))).toEqual([
      SeedIntegrityIssueCode.TooFewMembers,
    ]);
  });

  it("reports a live branch with no assignee, naming it", async () => {
    const tables = cleanTables();
    tables.branchDetail = branchesAssignedTo(tables, null);
    const issues = await checkSeedIntegrity(fakePrisma(tables), ORG);
    expect(issues).toEqual([
      {
        code: SeedIntegrityIssueCode.BranchWithoutOwner,
        count: 1,
        message: expect.stringContaining("maya/saved-project-filters"),
      },
    ]);
  });

  it("ignores a deleted branch", async () => {
    const tables = cleanTables();
    tables.branchDetail = branchesAssignedTo(tables, null).map((branch) => ({
      ...branch,
      deletedAt: PUSHED_AT,
    }));
    expect(await checkSeedIntegrity(fakePrisma(tables), ORG)).toEqual([]);
  });

  it("does not take an assignee from another organization as the owner", async () => {
    const tables = cleanTables();
    tables.user = [
      ...(tables.user ?? []),
      user(OUTSIDER, OTHER_ORG, "Ola", "Nordmann"),
    ];
    tables.branchDetail = branchesAssignedTo(tables, OUTSIDER);
    expect(codes(await checkSeedIntegrity(fakePrisma(tables), ORG))).toEqual([
      SeedIntegrityIssueCode.BranchWithoutOwner,
    ]);
  });

  it("reports each seeded label carrying test-data wording", async () => {
    const tables = cleanTables();
    tables.project = [
      ...(tables.project ?? []),
      {
        organizationId: ORG,
        name: "Scaled Seed Project 3",
        slug: "PRO-9",
        description: "Generated seed project",
      },
    ];
    tables.computeTarget = [{ organizationId: ORG, machineName: "vibe-seed" }];
    const issues = await checkSeedIntegrity(fakePrisma(tables), ORG);
    expect(issues).toEqual([
      {
        code: SeedIntegrityIssueCode.BannedWording,
        count: 3,
        message: expect.stringContaining(
          'projects.name "Scaled Seed Project 3"'
        ),
      },
    ]);
  });

  it("reports branch and session names carrying fixture wording", async () => {
    const tables = cleanTables();
    tables.artifact = [
      ...(tables.artifact ?? []),
      { organizationId: ORG, type: ArtifactType.Branch, name: "ci/e2e-gate" },
      { organizationId: ORG, type: ArtifactType.Session, name: "test run" },
    ];
    expect(await checkSeedIntegrity(fakePrisma(tables), ORG)).toEqual([
      expect.objectContaining({
        code: SeedIntegrityIssueCode.BannedWording,
        count: 2,
        message: expect.stringContaining('artifacts.name "ci/e2e-gate"'),
      }),
    ]);
  });

  it("reports a branch detail name even when its artifact name is clean", async () => {
    const tables = cleanTables();
    tables.branchDetail = (tables.branchDetail ?? []).map((branch) => ({
      ...branch,
      branchName: "ci/e2e-gate",
    }));
    expect(await checkSeedIntegrity(fakePrisma(tables), ORG)).toEqual([
      expect.objectContaining({
        code: SeedIntegrityIssueCode.BannedWording,
        count: 1,
        message: expect.stringContaining(
          'branch_details.branch_name "ci/e2e-gate"'
        ),
      }),
    ]);
  });

  it("only looks at the organization it is given", async () => {
    const tables = cleanTables();
    tables.user = [
      ...(tables.user ?? []),
      user(OUTSIDER, OTHER_ORG, "E2E", "Local Trusted"),
    ];
    tables.project = [
      ...(tables.project ?? []),
      { organizationId: OTHER_ORG, name: "Seed project", slug: null },
    ];
    tables.branchDetail = [
      ...(tables.branchDetail ?? []),
      {
        organizationId: OTHER_ORG,
        artifactId: "other-branch",
        branchName: "seed/feature-branch",
        deletedAt: null,
      },
    ];
    expect(await checkSeedIntegrity(fakePrisma(tables), ORG)).toEqual([]);
  });
});

describe("assertSeedIntegrity", () => {
  it("passes when there are no issues", () => {
    expect(() => assertSeedIntegrity([])).not.toThrow();
  });

  it("throws one error listing every issue", () => {
    expect(() =>
      assertSeedIntegrity([
        {
          code: SeedIntegrityIssueCode.TooFewMembers,
          count: 1,
          message: "one member",
        },
        {
          code: SeedIntegrityIssueCode.BranchWithoutOwner,
          count: 2,
          message: "two branches",
        },
      ])
    ).toThrow(
      `seed integrity check failed:\n- ${SeedIntegrityIssueCode.TooFewMembers} (1): one member\n- ${SeedIntegrityIssueCode.BranchWithoutOwner} (2): two branches`
    );
  });
});

function codes(issues: readonly { code: string }[]): string[] {
  return issues.map((issue) => issue.code);
}

function cleanTables(): Tables {
  return {
    organization: [{ id: ORG, ...VIBE_SEED_ORGANIZATION }],
    user: [
      user(OWNER, ORG, "Maya", "Okafor"),
      user(TEAMMATE, ORG, "Daveth", "Reyes"),
    ],
    team: [
      {
        organizationId: ORG,
        name: "Product Engineering",
        slug: "product-engineering",
      },
    ],
    project: [
      {
        organizationId: ORG,
        name: "Checkout Redesign",
        slug: "PRO-2",
        description: "Fewer steps from cart to paid order.",
      },
    ],
    artifact: [
      {
        organizationId: ORG,
        type: ArtifactType.Document,
        name: "Team workspaces",
        slug: "PRD-1",
      },
    ],
    tag: [{ organizationId: ORG, name: "billing" }],
    gitHubInstallation: [
      { organizationId: ORG, accountLogin: "acme-co", senderLogin: "maya" },
    ],
    gitHubInstallationRepository: [
      { installation: { organizationId: ORG }, fullName: "acme-co/acme-web" },
    ],
    gitHubUserConnection: [
      { organizationId: ORG, userId: OWNER, login: "mayaokafor" },
    ],
    slackIntegration: [{ organizationId: ORG, teamName: "Acme Co" }],
    computeTarget: [{ organizationId: ORG, machineName: "mayas-macbook-pro" }],
    apiKey: [{ organizationId: ORG, name: "Local tooling" }],
    customFieldValue: [
      { organizationId: ORG, textValue: null, displayValue: "Maya Okafor" },
    ],
    branchDetail: [
      {
        organizationId: ORG,
        artifactId: BRANCH,
        branchName: "maya/saved-project-filters",
        deletedAt: null,
        artifact: { assigneeId: OWNER },
      },
    ],
  };
}

function user(
  id: string,
  organizationId: string,
  firstName: string,
  lastName: string
): Row {
  return {
    id,
    organizationId,
    active: true,
    firstName,
    lastName,
    email: `${firstName}.${lastName}@acmeco.example`.toLowerCase(),
  };
}

function branchesAssignedTo(tables: Tables, assigneeId: string | null): Row[] {
  return (tables.branchDetail ?? []).map((branch) => ({
    ...branch,
    artifact: { assigneeId },
  }));
}

/**
 * A Prisma stand-in whose `where` follows Prisma's semantics for the shapes the
 * check uses (equality, `in`, `not`, nested relations); an absent key
 * constrains nothing, so a dropped org predicate shows up as a failing test.
 */
function fakePrisma(tables: Tables): PrismaClient {
  const delegate = (name: string) => ({
    findMany: ({ where }: { where?: Row } = {}) =>
      Promise.resolve(
        (tables[name] ?? []).filter((row) => matches(row, where))
      ),
    findUnique: ({ where }: { where?: Row } = {}) =>
      Promise.resolve(
        (tables[name] ?? []).find((row) => matches(row, where)) ?? null
      ),
  });
  const client = Object.fromEntries(
    [
      "organization",
      "user",
      "team",
      "project",
      "artifact",
      "tag",
      "gitHubInstallation",
      "gitHubInstallationRepository",
      "gitHubUserConnection",
      "slackIntegration",
      "computeTarget",
      "apiKey",
      "customFieldValue",
      "branchDetail",
    ].map((name) => [name, delegate(name)])
  );
  return client as unknown as PrismaClient;
}

function matches(row: unknown, where: Row | undefined): boolean {
  if (!where) {
    return true;
  }
  if (!(row && typeof row === "object")) {
    return false;
  }
  const record = row as Row;
  return Object.entries(where).every(([key, condition]) =>
    matchesCondition(record[key], condition)
  );
}

function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition === null || condition instanceof Date) {
    return value === condition;
  }
  if (typeof condition !== "object") {
    return value === condition;
  }
  const operators = condition as Row;
  if ("in" in operators && Array.isArray(operators.in)) {
    return operators.in.includes(value);
  }
  if ("not" in operators) {
    return operators.not === null ? value != null : value !== operators.not;
  }
  return matches(value, operators);
}
