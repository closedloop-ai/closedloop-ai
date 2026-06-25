import { describe, expect, it, vi } from "vitest";
import {
  MigrateDeployRecoveryDiagnostic,
  PostgresMigrationSqlstate,
  PrismaMigrateDeployErrorCode,
  recoverMigrateDeployFailure,
} from "../scripts/migrate-deploy-recovery";
import { makeDeployError as createDeployError } from "./test-helpers/deploy-error";

const DATABASE_URL = "postgresql://app:password@localhost:5432/db";
const PREVIEW_SCHEMA = "preview_fea_1215";
const NON_PREVIEW_SCHEMA = "public";
const BRANCH = "fea-1215";
const MIGRATION_NAME = "20260515021500_branch_artifact_destructive_cutover";
const INVARIANT_MESSAGE =
  "PLN-587 Migration B cannot continue: PULL_REQUEST artifact without PullRequestDetail";
const MISSING_NAME_INVARIANT_MESSAGE =
  "PLN-587 Migration B cannot continue: missing cutover invariant";
const SENSITIVE_DATABASE_URL_ASSIGNMENT =
  "DATABASE_URL=postgresql://app:supersecret@db.example.com:5432/prod";
const SENSITIVE_IAM_TOKEN =
  "X-Amz-Credential=AKIAEXAMPLE%2F20260528%2Fus-east-1%2Frds-db%2Faws4_request&X-Amz-Signature=0123456789abcdef";
const SENSITIVE_PASSWORD_URL =
  "postgresql://app:supersecret-password@db.example.com:5432/prod";
const SENSITIVE_SINGLE_PG_PASSWORD_ASSIGNMENT = "PGPASSWORD=single-secret";
const SENSITIVE_SINGLE_PGHOST_ASSIGNMENT = "PGHOST=db.internal.example.com";
const SENSITIVE_ENV_CONNECTION_TEXT =
  "PGHOST=db.example.com PGUSER=app PGDATABASE=prod PGPORT=5432";
const SENSITIVE_INVARIANT_REDACTION_MARKER = "[redacted sensitive value]";
const DIFFERENT_MIGRATION_NAME = "20260529091500_unrelated_cutover";
const LONG_RAW_RETRY_OUTPUT = "raw retry output should not be copied ".repeat(
  100
);

const REALISTIC_P0001_OUTPUT = `
Error: ${PrismaMigrateDeployErrorCode.MigrationFailedToApply}

A migration failed to apply. New migrations cannot be applied before the error is recovered from.

Migration name: ${MIGRATION_NAME}

Database error code: ${PrismaMigrateDeployErrorCode.UserDefinedInvariant}

Database error:
ERROR: ${INVARIANT_MESSAGE}
`;

const P0001_OUTPUT_WITHOUT_OPTIONAL_FIELDS = `
Error: ${PrismaMigrateDeployErrorCode.MigrationFailedToApply}
Database error code: ${PrismaMigrateDeployErrorCode.UserDefinedInvariant}
Database error:
ERROR: ${MISSING_NAME_INVARIANT_MESSAGE}
`;

function createP0001OutputWithInvariant(invariantMessage: string): string {
  return `
Error: ${PrismaMigrateDeployErrorCode.MigrationFailedToApply}
Migration name: ${MIGRATION_NAME}
Database error code: ${PrismaMigrateDeployErrorCode.UserDefinedInvariant}
Database error:
ERROR: ${invariantMessage}
`;
}

const PREVIEW_P3005_OUTPUT = `
Error: ${PrismaMigrateDeployErrorCode.NonEmptySchema}
The database schema is not empty.
`;

const NON_PREVIEW_P3018_OUTPUT = `
Error: ${PrismaMigrateDeployErrorCode.MigrationFailedToApply}
Migration name: ${MIGRATION_NAME}
Database error code: 23505
`;

const NON_PREVIEW_P3009_OUTPUT = `
Error: ${PrismaMigrateDeployErrorCode.FailedMigration}
The \`${MIGRATION_NAME}\` migration started at 2026-05-28 failed
`;

const UNKNOWN_OUTPUT = "Error: migration engine failed before reporting a code";

function createRollbackRetryOutput(input: {
  sqlstate: PostgresMigrationSqlstate;
  migrationName?: string;
  databaseError?: string;
}): string {
  return `
Error: ${PrismaMigrateDeployErrorCode.MigrationFailedToApply}
${input.migrationName ? `Migration name: ${input.migrationName}` : ""}
Database error code: ${input.sqlstate}
Database error:
ERROR: ${input.databaseError ?? `relation already exists (${input.sqlstate})`}
`;
}

function createDeps() {
  const callOrder: string[] = [];
  return {
    callOrder,
    runMigrateDeploy: vi.fn(() => {
      callOrder.push("runMigrateDeploy");
      return Promise.resolve();
    }),
    resolveFailedMigration: vi.fn(() => {
      callOrder.push("resolveFailedMigration");
      return Promise.resolve();
    }),
    resetSchema: vi.fn(() => {
      callOrder.push("resetSchema");
      return Promise.resolve();
    }),
    upsertSchemaRegistry: vi.fn(() => {
      callOrder.push("upsertSchemaRegistry");
      return Promise.resolve();
    }),
    registryRetrySleep: vi.fn(() => {
      callOrder.push("registryRetrySleep");
      return Promise.resolve();
    }),
  };
}

function createDeferredVoid(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function captureThrownError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error("Expected an Error instance");
  }

  throw new Error("Expected promise to reject");
}

describe("recoverMigrateDeployFailure", () => {
  it("fails fast on preview-schema P0001 without reset, retry, registry, or rollback side effects", async () => {
    const deps = createDeps();
    const error = await captureThrownError(
      recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({ stderr: REALISTIC_P0001_OUTPUT }),
        },
        deps
      )
    );

    expect(error.message).toContain(
      PrismaMigrateDeployErrorCode.UserDefinedInvariant
    );
    expect(error.message).toContain(MIGRATION_NAME);
    expect(error.message).toContain(INVARIANT_MESSAGE);
    expect(error.message).not.toContain(SENSITIVE_INVARIANT_REDACTION_MARKER);
    expect(error.message).toContain("migrate deploy was not retried");
    expect(deps.resetSchema).not.toHaveBeenCalled();
    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
    expect(deps.runMigrateDeploy).not.toHaveBeenCalled();
    expect(deps.resolveFailedMigration).not.toHaveBeenCalled();
  });

  it("fails fast on non-preview P0001 without rollback resolution or recovery deploy retry", async () => {
    const deps = createDeps();
    const error = await captureThrownError(
      recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: NON_PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({ stdout: REALISTIC_P0001_OUTPUT }),
        },
        deps
      )
    );

    expect(error.message).toContain(
      PrismaMigrateDeployErrorCode.UserDefinedInvariant
    );
    expect(error.message).toContain(MIGRATION_NAME);
    expect(error.message).toContain(INVARIANT_MESSAGE);
    expect(error.message).not.toContain(SENSITIVE_INVARIANT_REDACTION_MARKER);
    expect(deps.resolveFailedMigration).not.toHaveBeenCalled();
    expect(deps.runMigrateDeploy).not.toHaveBeenCalled();
    expect(deps.resetSchema).not.toHaveBeenCalled();
    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
  });

  it("keeps P0001 formatter bounded when raw output contains credential material", async () => {
    const deps = createDeps();
    const error = await captureThrownError(
      recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({
            message: SENSITIVE_DATABASE_URL_ASSIGNMENT,
            stdout: `${SENSITIVE_IAM_TOKEN}\n${REALISTIC_P0001_OUTPUT}`,
            stderr: `${SENSITIVE_PASSWORD_URL}\n${SENSITIVE_ENV_CONNECTION_TEXT}`,
          }),
        },
        deps
      )
    );

    expect(error.message).toContain(
      PrismaMigrateDeployErrorCode.UserDefinedInvariant
    );
    expect(error.message).toContain(MIGRATION_NAME);
    expect(error.message).toContain(INVARIANT_MESSAGE);
    expect(error.message).not.toContain(SENSITIVE_DATABASE_URL_ASSIGNMENT);
    expect(error.message).not.toContain(SENSITIVE_IAM_TOKEN);
    expect(error.message).not.toContain(SENSITIVE_PASSWORD_URL);
    expect(error.message).not.toContain(SENSITIVE_ENV_CONNECTION_TEXT);
  });

  it.each([
    ["DATABASE_URL assignment", SENSITIVE_DATABASE_URL_ASSIGNMENT],
    ["IAM token fragment", SENSITIVE_IAM_TOKEN],
    ["password-bearing Postgres URL", SENSITIVE_PASSWORD_URL],
    ["single PGPASSWORD assignment", SENSITIVE_SINGLE_PG_PASSWORD_ASSIGNMENT],
    ["single PGHOST assignment", SENSITIVE_SINGLE_PGHOST_ASSIGNMENT],
    ["Postgres env connection text", SENSITIVE_ENV_CONNECTION_TEXT],
  ])("redacts %s when it is parsed as the P0001 invariant", async (_description, sensitiveInvariantText) => {
    const deps = createDeps();
    const safeInvariantPrefix =
      "PLN-587 Migration B cannot continue before checking tenant state:";
    const invariantMessage = `${safeInvariantPrefix} ${sensitiveInvariantText}`;
    const error = await captureThrownError(
      recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({
            stderr: createP0001OutputWithInvariant(invariantMessage),
          }),
        },
        deps
      )
    );

    expect(error.message).toContain(
      PrismaMigrateDeployErrorCode.UserDefinedInvariant
    );
    expect(error.message).toContain(MIGRATION_NAME);
    expect(error.message).toContain(safeInvariantPrefix);
    expect(error.message).toContain(SENSITIVE_INVARIANT_REDACTION_MARKER);
    expect(error.message).not.toContain(sensitiveInvariantText);
    expect(deps.resetSchema).not.toHaveBeenCalled();
    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
    expect(deps.runMigrateDeploy).not.toHaveBeenCalled();
    expect(deps.resolveFailedMigration).not.toHaveBeenCalled();
  });

  it("redacts credential material parsed from a P0001 message field", async () => {
    const deps = createDeps();
    const safeInvariantPrefix =
      "PLN-587 Migration B cannot continue before checking tenant state:";
    const error = await captureThrownError(
      recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({
            stderr: `
Error: ${PrismaMigrateDeployErrorCode.UserDefinedInvariant}
message: "${safeInvariantPrefix} ${SENSITIVE_PASSWORD_URL}"
`,
          }),
        },
        deps
      )
    );

    expect(error.message).toContain(
      PrismaMigrateDeployErrorCode.UserDefinedInvariant
    );
    expect(error.message).toContain(safeInvariantPrefix);
    expect(error.message).toContain(SENSITIVE_INVARIANT_REDACTION_MARKER);
    expect(error.message).not.toContain(SENSITIVE_PASSWORD_URL);
  });

  it("fails fast on P0001 even when optional migration name is missing", async () => {
    const deps = createDeps();
    const error = await captureThrownError(
      recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: NON_PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({
            stderr: P0001_OUTPUT_WITHOUT_OPTIONAL_FIELDS,
          }),
        },
        deps
      )
    );

    expect(error.message).toContain(
      PrismaMigrateDeployErrorCode.UserDefinedInvariant
    );
    expect(error.message).toContain("unknown migration");
    expect(error.message).toContain(MISSING_NAME_INVARIANT_MESSAGE);
    expect(error.message).not.toContain(SENSITIVE_INVARIANT_REDACTION_MARKER);
    expect(deps.resolveFailedMigration).not.toHaveBeenCalled();
    expect(deps.runMigrateDeploy).not.toHaveBeenCalled();
  });

  it("preserves preview non-P0001 recovery by resetting, rerunning deploy, and re-registering", async () => {
    const deps = createDeps();

    const result = await recoverMigrateDeployFailure(
      {
        databaseUrl: DATABASE_URL,
        schema: PREVIEW_SCHEMA,
        branch: BRANCH,
        error: createDeployError({ stderr: PREVIEW_P3005_OUTPUT }),
      },
      deps
    );

    expect(result).toBe(true);
    expect(deps.callOrder).toEqual([
      "resetSchema",
      "runMigrateDeploy",
      "upsertSchemaRegistry",
    ]);
    expect(deps.resetSchema).toHaveBeenCalledWith(DATABASE_URL, PREVIEW_SCHEMA);
    expect(deps.runMigrateDeploy).toHaveBeenCalledWith(DATABASE_URL);
    expect(deps.upsertSchemaRegistry).toHaveBeenCalledWith(
      DATABASE_URL,
      PREVIEW_SCHEMA,
      BRANCH
    );
    expect(deps.resolveFailedMigration).not.toHaveBeenCalled();
  });

  it("awaits preview deploy retry before re-registering the schema", async () => {
    const deps = createDeps();
    const deployRetry = createDeferredVoid();
    const deployRetryStarted = createDeferredVoid();
    deps.runMigrateDeploy.mockImplementationOnce(() => {
      deps.callOrder.push("runMigrateDeploy");
      deployRetryStarted.resolve();
      return deployRetry.promise;
    });

    const recoveryPromise = recoverMigrateDeployFailure(
      {
        databaseUrl: DATABASE_URL,
        schema: PREVIEW_SCHEMA,
        branch: BRANCH,
        error: createDeployError({ stderr: PREVIEW_P3005_OUTPUT }),
      },
      deps
    );

    await deployRetryStarted.promise;

    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
    expect(deps.callOrder).toEqual(["resetSchema", "runMigrateDeploy"]);

    deployRetry.resolve();

    await expect(recoveryPromise).resolves.toBe(true);
    expect(deps.callOrder).toEqual([
      "resetSchema",
      "runMigrateDeploy",
      "upsertSchemaRegistry",
    ]);
  });

  it("preserves preview registry transient retry after a non-P0001 reset", async () => {
    const deps = createDeps();
    const transientError = Object.assign(new Error("connection failed"), {
      code: "08006",
    });
    deps.upsertSchemaRegistry
      .mockImplementationOnce(() => {
        deps.callOrder.push("upsertSchemaRegistry");
        return Promise.reject(transientError);
      })
      .mockImplementationOnce(() => {
        deps.callOrder.push("upsertSchemaRegistry");
        return Promise.resolve();
      });

    const result = await recoverMigrateDeployFailure(
      {
        databaseUrl: DATABASE_URL,
        schema: PREVIEW_SCHEMA,
        branch: BRANCH,
        error: createDeployError({ stderr: PREVIEW_P3005_OUTPUT }),
      },
      deps
    );

    expect(result).toBe(true);
    expect(deps.upsertSchemaRegistry).toHaveBeenCalledTimes(2);
    expect(deps.registryRetrySleep).toHaveBeenCalledTimes(1);
    expect(deps.callOrder).toEqual([
      "resetSchema",
      "runMigrateDeploy",
      "upsertSchemaRegistry",
      "registryRetrySleep",
      "upsertSchemaRegistry",
    ]);
  });

  it("preserves non-preview P3018 rollback recovery with a parsed migration name", async () => {
    const deps = createDeps();

    const result = await recoverMigrateDeployFailure(
      {
        databaseUrl: DATABASE_URL,
        schema: NON_PREVIEW_SCHEMA,
        branch: BRANCH,
        error: createDeployError({ stderr: NON_PREVIEW_P3018_OUTPUT }),
      },
      deps
    );

    expect(result).toBe(false);
    expect(deps.callOrder).toEqual([
      "resolveFailedMigration",
      "runMigrateDeploy",
    ]);
    expect(deps.resolveFailedMigration).toHaveBeenCalledWith(
      DATABASE_URL,
      MIGRATION_NAME
    );
    expect(deps.runMigrateDeploy).toHaveBeenCalledWith(DATABASE_URL);
    expect(deps.resetSchema).not.toHaveBeenCalled();
    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
  });

  it("awaits rolled-back resolution before retrying migrate deploy", async () => {
    const deps = createDeps();
    const rollbackResolution = createDeferredVoid();
    const rollbackResolutionStarted = createDeferredVoid();
    deps.resolveFailedMigration.mockImplementationOnce(() => {
      deps.callOrder.push("resolveFailedMigration");
      rollbackResolutionStarted.resolve();
      return rollbackResolution.promise;
    });

    const recoveryPromise = recoverMigrateDeployFailure(
      {
        databaseUrl: DATABASE_URL,
        schema: NON_PREVIEW_SCHEMA,
        branch: BRANCH,
        error: createDeployError({ stderr: NON_PREVIEW_P3018_OUTPUT }),
      },
      deps
    );

    await rollbackResolutionStarted.promise;

    expect(deps.runMigrateDeploy).not.toHaveBeenCalled();
    expect(deps.callOrder).toEqual(["resolveFailedMigration"]);

    rollbackResolution.resolve();

    await expect(recoveryPromise).resolves.toBe(false);
    expect(deps.callOrder).toEqual([
      "resolveFailedMigration",
      "runMigrateDeploy",
    ]);
  });

  it("preserves non-preview P3009 rollback recovery with the legacy migration-name shape", async () => {
    const deps = createDeps();

    const result = await recoverMigrateDeployFailure(
      {
        databaseUrl: DATABASE_URL,
        schema: NON_PREVIEW_SCHEMA,
        branch: BRANCH,
        error: createDeployError({ stderr: NON_PREVIEW_P3009_OUTPUT }),
      },
      deps
    );

    expect(result).toBe(false);
    expect(deps.resolveFailedMigration).toHaveBeenCalledWith(
      DATABASE_URL,
      MIGRATION_NAME
    );
    expect(deps.runMigrateDeploy).toHaveBeenCalledTimes(1);
  });

  it("diagnoses relation-already-exists retry failure after rolled-back resolution without further side effects", async () => {
    const deps = createDeps();
    const retryError = createDeployError({
      stderr: createRollbackRetryOutput({
        sqlstate: PostgresMigrationSqlstate.RelationAlreadyExists,
        migrationName: MIGRATION_NAME,
      }),
    });
    deps.runMigrateDeploy.mockImplementationOnce(() => {
      deps.callOrder.push("runMigrateDeploy");
      return Promise.reject(retryError);
    });

    const error = await captureThrownError(
      recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: NON_PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({ stderr: NON_PREVIEW_P3018_OUTPUT }),
        },
        deps
      )
    );

    expect(error.cause).toBeUndefined();
    expect(error.message).toContain(MIGRATION_NAME);
    expect(error.message).toContain(
      PostgresMigrationSqlstate.RelationAlreadyExists
    );
    expect(error.message).toContain(
      MigrateDeployRecoveryDiagnostic.PartialCommittedDdlArtifact
    );
    expect(error.message).toContain(
      `prisma migrate resolve --applied ${MIGRATION_NAME}`
    );
    expect(error.message).toContain("corrective forward-only migration");
    expect(error.message).toContain("No further automatic recovery");
    expect(deps.callOrder).toEqual([
      "resolveFailedMigration",
      "runMigrateDeploy",
    ]);
    expect(deps.resolveFailedMigration).toHaveBeenCalledWith(
      DATABASE_URL,
      MIGRATION_NAME
    );
    expect(deps.runMigrateDeploy).toHaveBeenCalledTimes(1);
    expect(deps.resetSchema).not.toHaveBeenCalled();
    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
  });

  it("diagnoses column-already-exists retry failure after rolled-back resolution", async () => {
    const deps = createDeps();
    const retryError = createDeployError({
      stderr: createRollbackRetryOutput({
        sqlstate: PostgresMigrationSqlstate.ColumnAlreadyExists,
        migrationName: MIGRATION_NAME,
      }),
    });
    deps.runMigrateDeploy.mockImplementationOnce(() => {
      deps.callOrder.push("runMigrateDeploy");
      return Promise.reject(retryError);
    });

    const error = await captureThrownError(
      recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: NON_PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({ stderr: NON_PREVIEW_P3018_OUTPUT }),
        },
        deps
      )
    );

    expect(error.cause).toBeUndefined();
    expect(error.message).toContain(MIGRATION_NAME);
    expect(error.message).toContain(
      PostgresMigrationSqlstate.ColumnAlreadyExists
    );
    expect(error.message).toContain(
      MigrateDeployRecoveryDiagnostic.PartialCommittedDdlArtifact
    );
    expect(deps.callOrder).toEqual([
      "resolveFailedMigration",
      "runMigrateDeploy",
    ]);
    expect(deps.resetSchema).not.toHaveBeenCalled();
    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
  });

  it("diagnoses object-already-exists (42710) retry failure for a committed constraint/enum", async () => {
    const deps = createDeps();
    const retryError = createDeployError({
      stderr: createRollbackRetryOutput({
        sqlstate: PostgresMigrationSqlstate.ObjectAlreadyExists,
        migrationName: MIGRATION_NAME,
        databaseError: 'type "branch_artifact_kind" already exists',
      }),
    });
    deps.runMigrateDeploy.mockImplementationOnce(() => {
      deps.callOrder.push("runMigrateDeploy");
      return Promise.reject(retryError);
    });

    const error = await captureThrownError(
      recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: NON_PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({ stderr: NON_PREVIEW_P3018_OUTPUT }),
        },
        deps
      )
    );

    expect(error.cause).toBeUndefined();
    expect(error.message).toContain(MIGRATION_NAME);
    expect(error.message).toContain(
      PostgresMigrationSqlstate.ObjectAlreadyExists
    );
    expect(error.message).toContain(
      MigrateDeployRecoveryDiagnostic.PartialCommittedDdlArtifact
    );
    expect(deps.callOrder).toEqual([
      "resolveFailedMigration",
      "runMigrateDeploy",
    ]);
    expect(deps.resetSchema).not.toHaveBeenCalled();
    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
  });

  it("keeps the partial committed-DDL diagnostic bounded when retry output contains credential material", async () => {
    const deps = createDeps();
    const sensitiveDatabaseError = [
      `relation already exists ${PostgresMigrationSqlstate.RelationAlreadyExists}`,
      SENSITIVE_DATABASE_URL_ASSIGNMENT,
      SENSITIVE_IAM_TOKEN,
      SENSITIVE_PASSWORD_URL,
      LONG_RAW_RETRY_OUTPUT,
    ].join(" ");
    const retryError = createDeployError({
      message: LONG_RAW_RETRY_OUTPUT,
      stdout: `${SENSITIVE_PASSWORD_URL}\n${LONG_RAW_RETRY_OUTPUT}`,
      stderr: createRollbackRetryOutput({
        sqlstate: PostgresMigrationSqlstate.RelationAlreadyExists,
        migrationName: MIGRATION_NAME,
        databaseError: sensitiveDatabaseError,
      }),
    });
    deps.runMigrateDeploy.mockImplementationOnce(() => {
      deps.callOrder.push("runMigrateDeploy");
      return Promise.reject(retryError);
    });

    const error = await captureThrownError(
      recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: NON_PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({ stderr: NON_PREVIEW_P3018_OUTPUT }),
        },
        deps
      )
    );

    expect(error.message).toContain(MIGRATION_NAME);
    expect(error.message).toContain(
      PostgresMigrationSqlstate.RelationAlreadyExists
    );
    expect(error.message).toContain(
      MigrateDeployRecoveryDiagnostic.PartialCommittedDdlArtifact
    );
    expect(error.message).toContain(SENSITIVE_INVARIANT_REDACTION_MARKER);
    expect(error.message).not.toContain(SENSITIVE_DATABASE_URL_ASSIGNMENT);
    expect(error.message).not.toContain(SENSITIVE_IAM_TOKEN);
    expect(error.message).not.toContain(SENSITIVE_PASSWORD_URL);
    expect(error.message).not.toContain(LONG_RAW_RETRY_OUTPUT);
  });

  it("rethrows the retry error unchanged when rolled-back retry output is non-target", async () => {
    const deps = createDeps();
    const retryError = createDeployError({
      stderr: "Database error code: 23505",
    });
    deps.runMigrateDeploy.mockImplementationOnce(() => {
      deps.callOrder.push("runMigrateDeploy");
      return Promise.reject(retryError);
    });

    let thrown: unknown;
    try {
      await recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: NON_PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({ stderr: NON_PREVIEW_P3018_OUTPUT }),
        },
        deps
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(retryError);
    expect(deps.callOrder).toEqual([
      "resolveFailedMigration",
      "runMigrateDeploy",
    ]);
    expect(deps.resetSchema).not.toHaveBeenCalled();
    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
  });

  it("rethrows the retry error unchanged when target SQLSTATE names a different migration", async () => {
    const deps = createDeps();
    const retryError = createDeployError({
      stderr: createRollbackRetryOutput({
        sqlstate: PostgresMigrationSqlstate.RelationAlreadyExists,
        migrationName: DIFFERENT_MIGRATION_NAME,
      }),
    });
    deps.runMigrateDeploy.mockImplementationOnce(() => {
      deps.callOrder.push("runMigrateDeploy");
      return Promise.reject(retryError);
    });

    let thrown: unknown;
    try {
      await recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: NON_PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({ stderr: NON_PREVIEW_P3018_OUTPUT }),
        },
        deps
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(retryError);
    expect(deps.callOrder).toEqual([
      "resolveFailedMigration",
      "runMigrateDeploy",
    ]);
    expect(deps.resetSchema).not.toHaveBeenCalled();
    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
  });

  it("rethrows the retry error unchanged when target SQLSTATE has no parseable migration name", async () => {
    const deps = createDeps();
    const retryError = createDeployError({
      stderr: createRollbackRetryOutput({
        sqlstate: PostgresMigrationSqlstate.RelationAlreadyExists,
      }),
    });
    deps.runMigrateDeploy.mockImplementationOnce(() => {
      deps.callOrder.push("runMigrateDeploy");
      return Promise.reject(retryError);
    });

    let thrown: unknown;
    try {
      await recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: NON_PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({ stderr: NON_PREVIEW_P3018_OUTPUT }),
        },
        deps
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(retryError);
    expect(deps.callOrder).toEqual([
      "resolveFailedMigration",
      "runMigrateDeploy",
    ]);
    expect(deps.resetSchema).not.toHaveBeenCalled();
    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
  });

  it("redacts a single PG connection assignment in the partial committed-DDL diagnostic", async () => {
    const deps = createDeps();
    const retryError = createDeployError({
      stderr: createRollbackRetryOutput({
        sqlstate: PostgresMigrationSqlstate.RelationAlreadyExists,
        migrationName: MIGRATION_NAME,
        databaseError: `relation already exists ${SENSITIVE_SINGLE_PGHOST_ASSIGNMENT}`,
      }),
    });
    deps.runMigrateDeploy.mockImplementationOnce(() => {
      deps.callOrder.push("runMigrateDeploy");
      return Promise.reject(retryError);
    });

    const error = await captureThrownError(
      recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: NON_PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({ stderr: NON_PREVIEW_P3018_OUTPUT }),
        },
        deps
      )
    );

    expect(error.message).toContain(
      MigrateDeployRecoveryDiagnostic.PartialCommittedDdlArtifact
    );
    expect(error.message).toContain(SENSITIVE_INVARIANT_REDACTION_MARKER);
    expect(error.message).not.toContain(SENSITIVE_SINGLE_PGHOST_ASSIGNMENT);
  });

  it("does not diagnose when a target SQLSTATE token appears only outside the Database error code field", async () => {
    const deps = createDeps();
    // 42701 appears incidentally as a port number, but the structured
    // "Database error code:" field is a non-target code. The migration name
    // matches, so only the SQLSTATE-anchoring gate can reject this.
    const retryError = createDeployError({
      stderr: `
Error: ${PrismaMigrateDeployErrorCode.MigrationFailedToApply}
Migration name: ${MIGRATION_NAME}
Database error code: 08006
Database error:
ERROR: connection to server at "db.example.com" port 42701 failed
`,
    });
    deps.runMigrateDeploy.mockImplementationOnce(() => {
      deps.callOrder.push("runMigrateDeploy");
      return Promise.reject(retryError);
    });

    let thrown: unknown;
    try {
      await recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: NON_PREVIEW_SCHEMA,
          branch: BRANCH,
          error: createDeployError({ stderr: NON_PREVIEW_P3018_OUTPUT }),
        },
        deps
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(retryError);
    expect(deps.callOrder).toEqual([
      "resolveFailedMigration",
      "runMigrateDeploy",
    ]);
    expect(deps.resetSchema).not.toHaveBeenCalled();
    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
  });

  it("rethrows the original error when output is unknown", async () => {
    const deps = createDeps();
    const originalError = createDeployError({ stderr: UNKNOWN_OUTPUT });

    let thrown: unknown;
    try {
      await recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: NON_PREVIEW_SCHEMA,
          branch: BRANCH,
          error: originalError,
        },
        deps
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(originalError);
    expect(deps.resetSchema).not.toHaveBeenCalled();
    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
    expect(deps.runMigrateDeploy).not.toHaveBeenCalled();
    expect(deps.resolveFailedMigration).not.toHaveBeenCalled();
  });

  it("rethrows a P1001 connectivity error unchanged without any recovery side effects", async () => {
    // Production path for an exhausted transient blip: migrate.ts's withRetry
    // exhausts the P1001 retries and rethrows the original error, which lands
    // here. P1001 is connectivity, not a migration-state code (P3005/P3009/
    // P3018/P0001), so recovery must take the Rethrow branch — no reset, no
    // rollback resolution, no recovery deploy retry, no re-registration — and
    // the build fails loud on the original error.
    const deps = createDeps();
    const originalError = createDeployError({
      stderr:
        "Error: P1001: Can't reach database server at `db.example.com:5432`",
    });

    let thrown: unknown;
    try {
      await recoverMigrateDeployFailure(
        {
          databaseUrl: DATABASE_URL,
          schema: NON_PREVIEW_SCHEMA,
          branch: BRANCH,
          error: originalError,
        },
        deps
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe(originalError);
    expect(deps.resetSchema).not.toHaveBeenCalled();
    expect(deps.upsertSchemaRegistry).not.toHaveBeenCalled();
    expect(deps.runMigrateDeploy).not.toHaveBeenCalled();
    expect(deps.resolveFailedMigration).not.toHaveBeenCalled();
  });
});
