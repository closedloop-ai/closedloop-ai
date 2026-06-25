import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactType,
  LoopCommand,
  LoopStatus,
  Priority,
  ProjectStatus,
} from "../../../../generated/client";
import { runSeed } from "../../index";
import { resolveSeedRunPlan, SeedProfileName } from "../../profiles";
import {
  collectResetVerificationSnapshot,
  countResettableOrgRows,
  resetOrgData,
  SeedResetFailureReason,
  verifyResetComplete,
} from "../../reset";
import {
  BASELINE_ORG_ID,
  BASELINE_USER_ID,
  baselineContext,
  baselineOrg,
  baselineUser,
} from "../fixtures/baseline-org";
import {
  type EphemeralDbContext,
  setupEphemeralDb,
  teardownEphemeralDb,
} from "../fixtures/ephemeral-db";

const DATABASE_URL_SET = Boolean(process.env.DATABASE_URL);
const MINIMAL_PLAN = resolveSeedRunPlan({ profile: SeedProfileName.Minimal });
const COMMAND_TIMEOUT_MS = 120_000;
const WORKSPACE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../../.."
);
const DATABASE_PACKAGE_DIR = path.join(WORKSPACE_ROOT, "packages/database");
const PRIVATE_OUTPUT_VALUES = [
  baselineOrg.name,
  baselineOrg.slug,
  baselineUser.email,
  "Other Reset Test Org",
  "secret-user-key",
  "secret-org-key",
  "reset-privacy-url-token",
  "postgres:password",
] as const;
let extraOrganizationIds: string[] = [];
let extraBaselineUserIds: string[] = [];

describe.skipIf(!DATABASE_URL_SET)("seed reset integration", () => {
  let ctx: EphemeralDbContext;

  beforeEach(async () => {
    extraOrganizationIds = [];
    extraBaselineUserIds = [];
    ctx = await setupEphemeralDb();
  });

  afterEach(async () => {
    if (ctx) {
      if (extraBaselineUserIds.length > 0) {
        await ctx.prisma.user.deleteMany({
          where: { id: { in: extraBaselineUserIds } },
        });
      }
      for (const organizationId of extraOrganizationIds) {
        await ctx.prisma.loop.deleteMany({ where: { organizationId } });
        await ctx.prisma.project.deleteMany({ where: { organizationId } });
        await ctx.prisma.user.deleteMany({ where: { organizationId } });
        await ctx.prisma.organization.deleteMany({
          where: { id: organizationId },
        });
      }
      await teardownEphemeralDb(ctx);
    }
  });

  it("resets target org data, clears identity scalars, preserves unrelated org data, and reseeds", async () => {
    await runSeed(ctx.prisma, baselineContext, MINIMAL_PLAN);
    const unrelated = await createUnrelatedOrg(ctx);
    const computeTarget = await ctx.prisma.computeTarget.create({
      data: {
        organizationId: BASELINE_ORG_ID,
        userId: BASELINE_USER_ID,
        machineName: `reset-target-${randomUUID()}`,
        platform: "darwin",
      },
    });
    await ctx.prisma.user.update({
      where: { id: BASELINE_USER_ID },
      data: {
        claudeApiKeyEncrypted: "secret-user-key",
        claudeApiKeyLastFour: "1234",
        claudeApiKeySetAt: new Date(),
        preferredComputeTargetId: computeTarget.id,
      },
    });
    await ctx.prisma.organization.update({
      where: { id: BASELINE_ORG_ID },
      data: {
        claudeApiKeyEncrypted: "secret-org-key",
        claudeApiKeyLastFour: "5678",
        claudeApiKeySetAt: new Date(),
      },
    });
    const parentLoop = await ctx.prisma.loop.create({
      data: {
        organizationId: BASELINE_ORG_ID,
        userId: BASELINE_USER_ID,
        command: LoopCommand.PLAN,
        status: LoopStatus.COMPLETED,
        computeTargetId: computeTarget.id,
      },
    });
    await ctx.prisma.loop.create({
      data: {
        organizationId: BASELINE_ORG_ID,
        userId: BASELINE_USER_ID,
        command: LoopCommand.EXECUTE,
        status: LoopStatus.FAILED,
        parentLoopId: parentLoop.id,
        computeTargetId: computeTarget.id,
      },
    });
    const preResetSnapshot = await collectResetVerificationSnapshot(
      ctx.prisma,
      BASELINE_ORG_ID
    );
    const beforeReset = await countResettableOrgRows(
      ctx.prisma,
      BASELINE_ORG_ID,
      preResetSnapshot
    );
    expect(beforeReset.totalRows).toBeGreaterThan(0);

    const resetSummary = await resetOrgData(ctx.prisma, BASELINE_ORG_ID);
    expect(resetSummary.totalRows).toBeGreaterThan(0);
    await expect(
      ctx.prisma.organization.findUniqueOrThrow({
        where: { id: BASELINE_ORG_ID },
      })
    ).resolves.toMatchObject({
      id: BASELINE_ORG_ID,
      claudeApiKeyEncrypted: null,
      claudeApiKeyLastFour: null,
      claudeApiKeySetAt: null,
    });
    await expect(
      ctx.prisma.user.findUniqueOrThrow({ where: { id: BASELINE_USER_ID } })
    ).resolves.toMatchObject({
      id: BASELINE_USER_ID,
      claudeApiKeyEncrypted: null,
      claudeApiKeyLastFour: null,
      claudeApiKeySetAt: null,
      preferredComputeTargetId: null,
    });
    await expect(
      ctx.prisma.project.findUniqueOrThrow({
        where: { id: unrelated.projectId },
      })
    ).resolves.toMatchObject({ id: unrelated.projectId });
    await expect(
      ctx.prisma.loop.findMany({
        where: { id: { in: unrelated.loopIds } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      })
    ).resolves.toHaveLength(2);
    await expect(
      ctx.prisma.loop.count({ where: { organizationId: BASELINE_ORG_ID } })
    ).resolves.toBe(0);

    expect(
      await verifyResetComplete(ctx.prisma, BASELINE_ORG_ID, preResetSnapshot)
    ).toEqual({ ok: true });

    await runSeed(ctx.prisma, baselineContext, MINIMAL_PLAN);
    await expect(
      ctx.prisma.project.count({ where: { organizationId: BASELINE_ORG_ID } })
    ).resolves.toBeGreaterThan(0);
  }, 120_000);

  // Budget 420s = 3 back-to-back `pnpm seed` spawns at COMMAND_TIMEOUT_MS (120s)
  // + 60s margin, so a hang fails via the subprocess timeout (captured output),
  // not a bare Vitest abort. See __tests__/timeouts.ts.
  it("runs the actual reset CLI without SEED_FORCE_OVERWRITE and then blocks no-reset on the non-empty org", async () => {
    await runSeed(ctx.prisma, baselineContext, MINIMAL_PLAN);
    const unrelated = await createUnrelatedOrg(ctx);
    const staleProjectId = randomUUID();
    await ctx.prisma.project.create({
      data: {
        id: staleProjectId,
        organizationId: BASELINE_ORG_ID,
        name: "Stale Reset CLI Project",
        slug: `stale-reset-cli-${staleProjectId}`,
        priority: Priority.LOW,
        status: ProjectStatus.NOT_STARTED,
        createdById: BASELINE_USER_ID,
      },
    });
    const computeTarget = await ctx.prisma.computeTarget.create({
      data: {
        organizationId: BASELINE_ORG_ID,
        userId: BASELINE_USER_ID,
        machineName: `reset-cli-target-${randomUUID()}`,
        platform: "darwin",
      },
    });
    await ctx.prisma.user.update({
      where: { id: BASELINE_USER_ID },
      data: {
        claudeApiKeyEncrypted: "secret-user-key",
        claudeApiKeyLastFour: "1234",
        claudeApiKeySetAt: new Date(),
        preferredComputeTargetId: computeTarget.id,
      },
    });
    await ctx.prisma.organization.update({
      where: { id: BASELINE_ORG_ID },
      data: {
        claudeApiKeyEncrypted: "secret-org-key",
        claudeApiKeyLastFour: "5678",
        claudeApiKeySetAt: new Date(),
      },
    });
    const env = buildCliEnv();
    Reflect.deleteProperty(env, "SEED_FORCE_OVERWRITE");

    const resetResult = spawnSync(
      "pnpm",
      [
        "seed",
        "--",
        "--reset",
        "--force",
        "--profile",
        SeedProfileName.Minimal,
        "--organization-id",
        BASELINE_ORG_ID,
        "--user-id",
        BASELINE_USER_ID,
      ],
      {
        cwd: DATABASE_PACKAGE_DIR,
        env,
        encoding: "utf-8",
        timeout: COMMAND_TIMEOUT_MS,
      }
    );
    expect(
      resetResult.status,
      `stdout:\n${resetResult.stdout}\nstderr:\n${resetResult.stderr}`
    ).toBe(0);
    expect(resetResult.stdout).toContain("[seed] Reset summary:");
    expect(resetResult.stdout).toContain("[seed] Seed complete");
    expect(resetResult.stdout).not.toContain("Type the organization UUID");
    expect(collectPrivateOutputLeaks(resetResult)).toEqual([]);

    await expect(
      ctx.prisma.organization.findUniqueOrThrow({
        where: { id: BASELINE_ORG_ID },
      })
    ).resolves.toMatchObject({
      id: BASELINE_ORG_ID,
      claudeApiKeyEncrypted: null,
      claudeApiKeyLastFour: null,
      claudeApiKeySetAt: null,
    });
    await expect(
      ctx.prisma.user.findUniqueOrThrow({ where: { id: BASELINE_USER_ID } })
    ).resolves.toMatchObject({
      id: BASELINE_USER_ID,
      claudeApiKeyEncrypted: null,
      claudeApiKeyLastFour: null,
      claudeApiKeySetAt: null,
      preferredComputeTargetId: null,
    });
    await expect(
      ctx.prisma.project.findUnique({ where: { id: staleProjectId } })
    ).resolves.toBeNull();
    await expect(
      ctx.prisma.project.count({ where: { organizationId: BASELINE_ORG_ID } })
    ).resolves.toBe(MINIMAL_PLAN.targets.projects);
    await expect(
      ctx.prisma.project.findUniqueOrThrow({
        where: { id: unrelated.projectId },
      })
    ).resolves.toMatchObject({ id: unrelated.projectId });
    await expect(
      ctx.prisma.loop.findMany({
        where: { id: { in: unrelated.loopIds } },
        select: { id: true },
      })
    ).resolves.toHaveLength(2);

    const idempotentNoResetResult = spawnSync(
      "pnpm",
      [
        "seed",
        "--",
        "--profile",
        SeedProfileName.Minimal,
        "--organization-id",
        BASELINE_ORG_ID,
        "--user-id",
        BASELINE_USER_ID,
      ],
      {
        cwd: DATABASE_PACKAGE_DIR,
        env,
        encoding: "utf-8",
        timeout: COMMAND_TIMEOUT_MS,
      }
    );
    expect(
      idempotentNoResetResult.status,
      `stdout:\n${idempotentNoResetResult.stdout}\nstderr:\n${idempotentNoResetResult.stderr}`
    ).toBe(0);
    expect(idempotentNoResetResult.stdout).toContain(
      "Existing deterministic seed-owned rows detected"
    );
    expect(collectPrivateOutputLeaks(idempotentNoResetResult)).toEqual([]);

    const postResetForeignProjectId = randomUUID();
    await ctx.prisma.project.create({
      data: {
        id: postResetForeignProjectId,
        organizationId: BASELINE_ORG_ID,
        name: "Post Reset Foreign Project",
        slug: `post-reset-foreign-${postResetForeignProjectId}`,
        priority: Priority.HIGH,
        status: ProjectStatus.NOT_STARTED,
        createdById: BASELINE_USER_ID,
      },
    });
    const projectCountBeforeNoReset = await ctx.prisma.project.count({
      where: { organizationId: BASELINE_ORG_ID },
    });
    const noResetResult = spawnSync(
      "pnpm",
      [
        "seed",
        "--",
        "--profile",
        SeedProfileName.Minimal,
        "--organization-id",
        BASELINE_ORG_ID,
        "--user-id",
        BASELINE_USER_ID,
      ],
      {
        cwd: DATABASE_PACKAGE_DIR,
        env,
        encoding: "utf-8",
        timeout: COMMAND_TIMEOUT_MS,
      }
    );
    expect(noResetResult.status).not.toBe(0);
    expect(noResetResult.stderr).toContain("Refusing to seed");
    expect(collectPrivateOutputLeaks(noResetResult)).toEqual([]);
    await expect(
      ctx.prisma.project.count({ where: { organizationId: BASELINE_ORG_ID } })
    ).resolves.toBe(projectCountBeforeNoReset);
    await expect(
      ctx.prisma.project.findUnique({
        where: { id: postResetForeignProjectId },
      })
    ).resolves.toMatchObject({ id: postResetForeignProjectId });
  }, 420_000);

  it("removes target-org runtime/credential rows and preserves unrelated-org rows for reset-only models", async () => {
    await runSeed(ctx.prisma, baselineContext, MINIMAL_PLAN);
    const unrelated = await createUnrelatedOrg(ctx);
    const targetFixture = await seedResetOnlyFixture(ctx, {
      organizationId: BASELINE_ORG_ID,
      userId: BASELINE_USER_ID,
      tag: "target",
    });
    const unrelatedFixture = await seedResetOnlyFixture(ctx, {
      organizationId: unrelated.organizationId,
      userId: unrelated.userId,
      tag: "unrelated",
    });

    try {
      await resetOrgData(ctx.prisma, BASELINE_ORG_ID);

      const targetPresence = await checkResetOnlyRowsPresent(
        ctx,
        targetFixture
      );
      expect(
        targetPresence.filter(({ exists }) => exists).map(({ name }) => name)
      ).toEqual([]);

      const unrelatedPresence = await checkResetOnlyRowsPresent(
        ctx,
        unrelatedFixture
      );
      expect(
        unrelatedPresence
          .filter(({ exists }) => !exists)
          .map(({ name }) => name)
      ).toEqual([]);
    } finally {
      // The shared afterEach drops the unrelated org via plain deleteMany. Some
      // reset-only models reference Organization without ON DELETE CASCADE
      // (ComputeTarget) or are scalar-keyed without an FK at all (ApiKey,
      // OAuth*, DesktopOnboarding*). Clean the unrelated-org reset fixture here
      // so the org delete succeeds and these rows do not leak across tests.
      await cleanupResetOnlyFixture(ctx, unrelatedFixture);
    }
  }, 180_000);

  // Budget 540s = 4 back-to-back `pnpm seed` spawns at COMMAND_TIMEOUT_MS (120s)
  // + 60s margin, so a hang fails via the subprocess timeout (captured output),
  // not a bare Vitest abort. See __tests__/timeouts.ts.
  it("fails reset before mutation for non-TTY confirmation and ambiguous targets", async () => {
    await runSeed(ctx.prisma, baselineContext, MINIMAL_PLAN);
    const unrelated = await createUnrelatedOrg(ctx);
    const secondBaselineUserId = await createExtraBaselineUser(ctx);
    const env = buildCliEnv();
    Reflect.deleteProperty(env, "SEED_FORCE_OVERWRITE");
    const projectCountBeforeFailures = await ctx.prisma.project.count({
      where: { organizationId: BASELINE_ORG_ID },
    });

    const noForceResult = spawnSync(
      "pnpm",
      [
        "seed",
        "--",
        "--reset",
        "--profile",
        SeedProfileName.Minimal,
        "--organization-id",
        BASELINE_ORG_ID,
        "--user-id",
        BASELINE_USER_ID,
      ],
      {
        cwd: DATABASE_PACKAGE_DIR,
        env,
        encoding: "utf-8",
        timeout: COMMAND_TIMEOUT_MS,
      }
    );
    expect(noForceResult.status).not.toBe(0);
    expect(noForceResult.stderr).toContain(
      SeedResetFailureReason.ResetConfirmationRequired
    );
    expect(collectPrivateOutputLeaks(noForceResult)).toEqual([]);
    await expect(
      ctx.prisma.project.count({ where: { organizationId: BASELINE_ORG_ID } })
    ).resolves.toBe(projectCountBeforeFailures);

    const ambiguousResult = spawnSync(
      "pnpm",
      [
        "seed",
        "--",
        "--reset",
        "--force",
        "--profile",
        SeedProfileName.Minimal,
      ],
      {
        cwd: DATABASE_PACKAGE_DIR,
        env,
        encoding: "utf-8",
        timeout: COMMAND_TIMEOUT_MS,
      }
    );
    expect(ambiguousResult.status).not.toBe(0);
    expect(ambiguousResult.stderr).toContain(
      SeedResetFailureReason.ResetTargetAmbiguous
    );
    expect(collectPrivateOutputLeaks(ambiguousResult)).toEqual([]);
    await expect(
      ctx.prisma.project.count({ where: { organizationId: BASELINE_ORG_ID } })
    ).resolves.toBe(projectCountBeforeFailures);

    const ambiguousUserResult = spawnSync(
      "pnpm",
      [
        "seed",
        "--",
        "--reset",
        "--force",
        "--profile",
        SeedProfileName.Minimal,
        "--organization-id",
        BASELINE_ORG_ID,
      ],
      {
        cwd: DATABASE_PACKAGE_DIR,
        env,
        encoding: "utf-8",
        timeout: COMMAND_TIMEOUT_MS,
      }
    );
    expect(ambiguousUserResult.status).not.toBe(0);
    expect(ambiguousUserResult.stderr).toContain(
      SeedResetFailureReason.ResetUserAmbiguous
    );
    expect(collectPrivateOutputLeaks(ambiguousUserResult)).toEqual([]);
    await expect(
      ctx.prisma.project.count({ where: { organizationId: BASELINE_ORG_ID } })
    ).resolves.toBe(projectCountBeforeFailures);

    const wrongUserResult = spawnSync(
      "pnpm",
      [
        "seed",
        "--",
        "--reset",
        "--force",
        "--profile",
        SeedProfileName.Minimal,
        "--organization-id",
        BASELINE_ORG_ID,
        "--user-id",
        unrelated.userId,
      ],
      {
        cwd: DATABASE_PACKAGE_DIR,
        env,
        encoding: "utf-8",
        timeout: COMMAND_TIMEOUT_MS,
      }
    );
    expect(wrongUserResult.status).not.toBe(0);
    expect(wrongUserResult.stderr).toContain(
      SeedResetFailureReason.ResetUserNotInOrg
    );
    expect(collectPrivateOutputLeaks(wrongUserResult)).toEqual([]);
    await expect(
      ctx.prisma.project.count({ where: { organizationId: BASELINE_ORG_ID } })
    ).resolves.toBe(projectCountBeforeFailures);
    await ctx.prisma.user.delete({ where: { id: secondBaselineUserId } });
    extraBaselineUserIds = extraBaselineUserIds.filter(
      (id) => id !== secondBaselineUserId
    );
  }, 540_000);

  it("keeps invalid flag and guard failure output private", () => {
    const invalidFlagResult = spawnSync("pnpm", ["seed", "--", "--resett"], {
      cwd: DATABASE_PACKAGE_DIR,
      env: buildCliEnv(),
      encoding: "utf-8",
      timeout: COMMAND_TIMEOUT_MS,
    });
    expect(invalidFlagResult.status).not.toBe(0);
    expect(invalidFlagResult.stderr).toContain("invalid_cli_args");
    expect(collectPrivateOutputLeaks(invalidFlagResult)).toEqual([]);

    const guardEnv = {
      ...buildCliEnv(),
      DATABASE_URL:
        "postgresql://private_user:private_password@cl-ai-prod.example.test:5432/app?token=reset-privacy-url-token",
      PGHOST: "localhost",
      SEED_ALLOW_REMOTE: "1",
    };
    const guardResult = spawnSync(
      "pnpm",
      [
        "seed",
        "--",
        "--reset",
        "--force",
        "--profile",
        SeedProfileName.Minimal,
      ],
      {
        cwd: DATABASE_PACKAGE_DIR,
        env: guardEnv,
        encoding: "utf-8",
        timeout: COMMAND_TIMEOUT_MS,
      }
    );
    expect(guardResult.status).not.toBe(0);
    expect(guardResult.stderr).toContain("production_host_blocked");
    expect(collectPrivateOutputLeaks(guardResult)).toEqual([]);
    expect(`${guardResult.stdout}\n${guardResult.stderr}`).not.toContain(
      "private_password"
    );
  });
});

async function createUnrelatedOrg(ctx: EphemeralDbContext): Promise<{
  organizationId: string;
  userId: string;
  projectId: string;
  loopIds: string[];
}> {
  const organizationId = randomUUID();
  const userId = randomUUID();
  const projectId = randomUUID();
  await ctx.prisma.organization.create({
    data: {
      id: organizationId,
      clerkId: `reset-other-org-${organizationId}`,
      name: "Other Reset Test Org",
      slug: `reset-other-${organizationId}`,
    },
  });
  await ctx.prisma.user.create({
    data: {
      id: userId,
      clerkId: `reset-other-user-${userId}`,
      organizationId,
      email: `other-${userId}@example.test`,
    },
  });
  await ctx.prisma.project.create({
    data: {
      id: projectId,
      organizationId,
      name: "Other Reset Test Project",
      slug: `other-project-${projectId}`,
      priority: Priority.LOW,
      status: ProjectStatus.NOT_STARTED,
      createdById: userId,
    },
  });
  const parentLoop = await ctx.prisma.loop.create({
    data: {
      organizationId,
      userId,
      command: LoopCommand.PLAN,
      status: LoopStatus.COMPLETED,
    },
  });
  const childLoop = await ctx.prisma.loop.create({
    data: {
      organizationId,
      userId,
      command: LoopCommand.EXECUTE,
      status: LoopStatus.FAILED,
      parentLoopId: parentLoop.id,
    },
  });
  extraOrganizationIds.push(organizationId);
  return {
    organizationId,
    userId,
    projectId,
    loopIds: [parentLoop.id, childLoop.id],
  };
}

async function createExtraBaselineUser(
  ctx: EphemeralDbContext
): Promise<string> {
  const userId = randomUUID();
  await ctx.prisma.user.create({
    data: {
      id: userId,
      clerkId: `reset-extra-user-${userId}`,
      organizationId: BASELINE_ORG_ID,
      email: `reset-extra-${userId}@example.test`,
    },
  });
  extraBaselineUserIds.push(userId);
  return userId;
}

function buildCliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: withPrivacyQuery(process.env.DATABASE_URL ?? ""),
  };
}

function withPrivacyQuery(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", "reset-privacy-url-token");
  return url.toString();
}

function collectPrivateOutputLeaks(result: {
  stdout: string;
  stderr: string;
}): string[] {
  const outputText = `${result.stdout}\n${result.stderr}`;
  return [...PRIVATE_OUTPUT_VALUES, process.env.DATABASE_URL ?? ""].filter(
    (value) => value && outputText.includes(value)
  );
}

type ResetOnlyFixtureInput = {
  organizationId: string;
  userId: string;
  tag: string;
};

type ResetOnlyFixture = {
  organizationId: string;
  userPublicKeyId: string;
  apiKeyId: string;
  oAuthAuthorizationCodeId: string;
  oAuthRefreshTokenId: string;
  desktopOnboardingAttemptId: string;
  desktopOnboardingDeviceSessionId: string;
  computeTargetId: string;
  desktopCommandId: string;
  desktopCommandEventKey: { commandId: string; sequence: number };
  loopExecutionCredentialConsumptionId: string;
  agentSessionId: string;
  agentSessionEventId: string;
  agentSessionTokenUsageId: string;
};

async function seedResetOnlyFixture(
  ctx: EphemeralDbContext,
  input: ResetOnlyFixtureInput
): Promise<ResetOnlyFixture> {
  const { organizationId, userId, tag } = input;
  const uniq = `${tag}-${randomUUID()}`;

  const userPublicKey = await ctx.prisma.userPublicKey.create({
    data: {
      userId,
      organizationId,
      publicKeyBase64: `pubkey-${uniq}`,
      fingerprint: `fpr-${uniq}`,
    },
  });
  const apiKey = await ctx.prisma.apiKey.create({
    data: {
      organizationId,
      userId,
      name: `api-${uniq}`,
      keyHash: `hash-${uniq}`,
      keyPrefix: `pfx-${uniq.slice(0, 8)}`,
    },
  });
  const oAuthAuthorizationCode = await ctx.prisma.oAuthAuthorizationCode.create(
    {
      data: {
        code: `code-${uniq}`,
        encryptedApiKey: `enc-${uniq}`,
        keyId: `kid-${uniq}`,
        userId,
        organizationId,
        clientId: `cli-${uniq}`,
        redirectUri: "https://example.test/cb",
        scopes: ["read"],
        codeChallenge: `chal-${uniq}`,
        codeChallengeMethod: "S256",
        expiresAt: new Date(Date.now() + 60_000),
      },
    }
  );
  const oAuthRefreshToken = await ctx.prisma.oAuthRefreshToken.create({
    data: {
      tokenFingerprint: `rt-${uniq}`,
      encryptedApiKey: `enc-${uniq}`,
      keyId: `kid-${uniq}`,
      userId,
      organizationId,
      clientId: `cli-${uniq}`,
      scopes: ["read"],
      familyId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  const desktopOnboardingAttempt =
    await ctx.prisma.desktopOnboardingAttempt.create({
      data: {
        attemptId: `att-${uniq}`,
        userId,
        organizationId,
        webAppOrigin: "https://example.test",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  const desktopOnboardingDeviceSession =
    await ctx.prisma.desktopOnboardingDeviceSession.create({
      data: {
        deviceSessionSecretHash: `dsh-${uniq}`,
        userCode: `uc-${uniq}`,
        webAppOrigin: "https://example.test",
        gatewayId: `gw-${uniq}`,
        gatewayPublicKeyPem: `gpk-${uniq}`,
        machineName: `mach-${uniq}`,
        platform: "darwin",
        desktopVersion: "0.0.0",
        desktopSecurityUpgradeProtocolVersion: 1,
        organizationId,
        userId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  const computeTarget = await ctx.prisma.computeTarget.create({
    data: {
      organizationId,
      userId,
      machineName: `ct-${uniq}`,
      platform: "darwin",
    },
  });
  const desktopCommand = await ctx.prisma.desktopCommand.create({
    data: {
      computeTargetId: computeTarget.id,
      requestFingerprint: `req-${uniq}`,
      operationId: `op-${uniq}`,
      requestPayload: {},
      status: "queued",
    },
  });
  await ctx.prisma.desktopCommandEvent.create({
    data: {
      commandId: desktopCommand.id,
      sequence: 1,
      eventType: "queued",
      eventPayload: {},
    },
  });
  const loop = await ctx.prisma.loop.create({
    data: {
      organizationId,
      userId,
      command: LoopCommand.PLAN,
      status: LoopStatus.COMPLETED,
      computeTargetId: computeTarget.id,
    },
  });
  await ctx.prisma.loopExecutionCredentialConsumption.create({
    data: {
      commandId: desktopCommand.id,
      loopId: loop.id,
      computeTargetId: computeTarget.id,
      gatewayId: `gw-${uniq}`,
      action: "consumed",
    },
  });
  // SESSION artifact + its CTI session_detail (FEA-1699). The artifact id is the
  // session_detail primary key and the FK target for events/token usage.
  const sessionArtifact = await ctx.prisma.artifact.create({
    data: {
      organizationId,
      type: ArtifactType.SESSION,
      name: `Session ${uniq}`,
      status: "active",
      session: {
        create: {
          userId,
          computeTargetId: computeTarget.id,
          externalSessionId: `as-${uniq}`,
          sessionStartedAt: new Date(),
          sessionUpdatedAt: new Date(),
        },
      },
    },
    select: { id: true },
  });
  const agentSession = { id: sessionArtifact.id };
  const agentSessionEvent = await ctx.prisma.agentSessionEvent.create({
    data: {
      agentSessionId: agentSession.id,
      externalEventId: `ase-${uniq}`,
      eventType: "tool_use",
      eventCreatedAt: new Date(),
    },
  });
  const agentSessionTokenUsage = await ctx.prisma.agentSessionTokenUsage.create(
    {
      data: {
        agentSessionId: agentSession.id,
        model: `m-${uniq}`,
      },
    }
  );

  return {
    organizationId,
    userPublicKeyId: userPublicKey.id,
    apiKeyId: apiKey.id,
    oAuthAuthorizationCodeId: oAuthAuthorizationCode.id,
    oAuthRefreshTokenId: oAuthRefreshToken.id,
    desktopOnboardingAttemptId: desktopOnboardingAttempt.attemptId,
    desktopOnboardingDeviceSessionId: desktopOnboardingDeviceSession.id,
    computeTargetId: computeTarget.id,
    desktopCommandId: desktopCommand.id,
    desktopCommandEventKey: { commandId: desktopCommand.id, sequence: 1 },
    loopExecutionCredentialConsumptionId: desktopCommand.id,
    agentSessionId: agentSession.id,
    agentSessionEventId: agentSessionEvent.id,
    agentSessionTokenUsageId: agentSessionTokenUsage.id,
  };
}

async function checkResetOnlyRowsPresent(
  ctx: EphemeralDbContext,
  fixture: ResetOnlyFixture
): Promise<Array<{ name: string; exists: boolean }>> {
  const probes: Array<{ name: string; lookup: Promise<unknown | null> }> = [
    {
      name: "UserPublicKey",
      lookup: ctx.prisma.userPublicKey.findUnique({
        where: { id: fixture.userPublicKeyId },
      }),
    },
    {
      name: "ApiKey",
      lookup: ctx.prisma.apiKey.findUnique({ where: { id: fixture.apiKeyId } }),
    },
    {
      name: "OAuthAuthorizationCode",
      lookup: ctx.prisma.oAuthAuthorizationCode.findUnique({
        where: { id: fixture.oAuthAuthorizationCodeId },
      }),
    },
    {
      name: "OAuthRefreshToken",
      lookup: ctx.prisma.oAuthRefreshToken.findUnique({
        where: { id: fixture.oAuthRefreshTokenId },
      }),
    },
    {
      name: "DesktopOnboardingAttempt",
      lookup: ctx.prisma.desktopOnboardingAttempt.findUnique({
        where: { attemptId: fixture.desktopOnboardingAttemptId },
      }),
    },
    {
      name: "DesktopOnboardingDeviceSession",
      lookup: ctx.prisma.desktopOnboardingDeviceSession.findUnique({
        where: { id: fixture.desktopOnboardingDeviceSessionId },
      }),
    },
    {
      name: "DesktopCommand",
      lookup: ctx.prisma.desktopCommand.findUnique({
        where: { id: fixture.desktopCommandId },
      }),
    },
    {
      name: "DesktopCommandEvent",
      lookup: ctx.prisma.desktopCommandEvent.findUnique({
        where: { commandId_sequence: fixture.desktopCommandEventKey },
      }),
    },
    {
      name: "LoopExecutionCredentialConsumption",
      lookup: ctx.prisma.loopExecutionCredentialConsumption.findUnique({
        where: { commandId: fixture.loopExecutionCredentialConsumptionId },
      }),
    },
    {
      name: "SessionDetail",
      lookup: ctx.prisma.sessionDetail.findUnique({
        where: { artifactId: fixture.agentSessionId },
      }),
    },
    {
      name: "AgentSessionEvent",
      lookup: ctx.prisma.agentSessionEvent.findUnique({
        where: { id: fixture.agentSessionEventId },
      }),
    },
    {
      name: "AgentSessionTokenUsage",
      lookup: ctx.prisma.agentSessionTokenUsage.findUnique({
        where: { id: fixture.agentSessionTokenUsageId },
      }),
    },
    {
      name: "ComputeTarget",
      lookup: ctx.prisma.computeTarget.findUnique({
        where: { id: fixture.computeTargetId },
      }),
    },
  ];

  const results = await Promise.all(probes.map(({ lookup }) => lookup));
  return probes.map(({ name }, index) => ({
    name,
    exists: results[index] !== null,
  }));
}

async function cleanupResetOnlyFixture(
  ctx: EphemeralDbContext,
  fixture: ResetOnlyFixture
): Promise<void> {
  await ctx.prisma.agentSessionTokenUsage.deleteMany({
    where: { id: fixture.agentSessionTokenUsageId },
  });
  await ctx.prisma.agentSessionEvent.deleteMany({
    where: { id: fixture.agentSessionEventId },
  });
  await ctx.prisma.sessionDetail.deleteMany({
    where: { artifactId: fixture.agentSessionId },
  });
  await ctx.prisma.artifact.deleteMany({
    where: { id: fixture.agentSessionId },
  });
  await ctx.prisma.loopExecutionCredentialConsumption.deleteMany({
    where: { commandId: fixture.loopExecutionCredentialConsumptionId },
  });
  await ctx.prisma.desktopCommandEvent.deleteMany({
    where: { commandId: fixture.desktopCommandEventKey.commandId },
  });
  await ctx.prisma.desktopCommand.deleteMany({
    where: { id: fixture.desktopCommandId },
  });
  await ctx.prisma.computeTarget.deleteMany({
    where: { id: fixture.computeTargetId },
  });
  await ctx.prisma.desktopOnboardingDeviceSession.deleteMany({
    where: { id: fixture.desktopOnboardingDeviceSessionId },
  });
  await ctx.prisma.desktopOnboardingAttempt.deleteMany({
    where: { attemptId: fixture.desktopOnboardingAttemptId },
  });
  await ctx.prisma.oAuthRefreshToken.deleteMany({
    where: { id: fixture.oAuthRefreshTokenId },
  });
  await ctx.prisma.oAuthAuthorizationCode.deleteMany({
    where: { id: fixture.oAuthAuthorizationCodeId },
  });
  await ctx.prisma.apiKey.deleteMany({ where: { id: fixture.apiKeyId } });
  await ctx.prisma.userPublicKey.deleteMany({
    where: { id: fixture.userPublicKeyId },
  });
}
