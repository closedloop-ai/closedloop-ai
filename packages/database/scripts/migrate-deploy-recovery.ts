import {
  isTransientConnectionError,
  subprocessErrorOutput,
  withRetry,
} from "./migrate-retry";
import { isPreviewSchema } from "./preview-schema";

export const PrismaMigrateDeployErrorCode = {
  UserDefinedInvariant: "P0001",
  NonEmptySchema: "P3005",
  FailedMigration: "P3009",
  MigrationFailedToApply: "P3018",
} as const;

export type PrismaMigrateDeployErrorCode =
  (typeof PrismaMigrateDeployErrorCode)[keyof typeof PrismaMigrateDeployErrorCode];

export const PostgresMigrationSqlstate = {
  RelationAlreadyExists: "42P07",
  ColumnAlreadyExists: "42701",
  // 42710 (duplicate_object) covers an already-existing constraint, type/enum,
  // trigger, or sequence — the DDL this schema's migrations most commonly emit.
  ObjectAlreadyExists: "42710",
} as const;

export type PostgresMigrationSqlstate =
  (typeof PostgresMigrationSqlstate)[keyof typeof PostgresMigrationSqlstate];

export const MigrateDeployRecoveryDiagnostic = {
  PartialCommittedDdlArtifact: "partial_committed_ddl_artifact",
} as const;

export type MigrateDeployRecoveryDiagnostic =
  (typeof MigrateDeployRecoveryDiagnostic)[keyof typeof MigrateDeployRecoveryDiagnostic];

export const MigrateDeployRecoveryDecision = {
  FailFastUserDefinedInvariant: "fail_fast_user_defined_invariant",
  PreviewReset: "preview_reset",
  ResolveRolledBack: "resolve_rolled_back",
  Rethrow: "rethrow",
} as const;

export type MigrateDeployRecoveryDecision =
  (typeof MigrateDeployRecoveryDecision)[keyof typeof MigrateDeployRecoveryDecision];

const P0001_PATTERN = /\bP0001\b/;
const P3005_PATTERN = /\bP3005\b/;
const P3009_PATTERN = /\bP3009\b/;
const P3018_PATTERN = /\bP3018\b/;
const MIGRATION_NAME_PATTERN = /Migration name: (\S+)|The `(\S+?)` migration/;
const DATABASE_ERROR_MESSAGE_PATTERN =
  /Database error:\s*(?:ERROR:\s*)?([^\n]+)/;
const DB_ERROR_MESSAGE_FIELD_PATTERN = /message:\s*"([^"]+)"/;
// Anchor SQLSTATE detection to Prisma's structured "Database error code:" field
// rather than scanning the whole output, so an incidental token such as a port
// (e.g. ":42701") cannot be misread as a duplicate-column SQLSTATE.
const POSTGRES_ERROR_CODE_FIELD_PATTERN = /Database error code:\s*([0-9A-Z]+)/;
const TARGET_POSTGRES_SQLSTATES = new Set<string>(
  Object.values(PostgresMigrationSqlstate)
);
const DATABASE_URL_ASSIGNMENT_PATTERN = /\bDATABASE_URL\s*=\s*\S+/g;
const IAM_TOKEN_FRAGMENT_PATTERN =
  /\bX-Amz-(?:Credential|Security-Token|Signature)=\S+/g;
const POSTGRES_CREDENTIAL_URL_PATTERN =
  /\bpostgres(?:ql)?:\/\/[^:\s/@]+:[^\s/@]+@[^\s]+/gi;
const CREDENTIAL_ENV_ASSIGNMENT_PATTERN =
  /\b[A-Z][A-Z0-9_]*(?:PASSWORD|PASSFILE|SECRET|TOKEN|CREDENTIAL|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*\S+/g;
// Redact each PG connection assignment individually so a lone PGHOST/PGUSER/etc.
// (or newline-separated fields) is sanitized, not only runs of two or more on one line.
const POSTGRES_ENV_CONNECTION_ASSIGNMENT_PATTERN =
  /\b(?:PGHOST|PGUSER|PGDATABASE|PGPORT|PGPASSWORD)\s*=\s*\S+/g;
const SENSITIVE_INVARIANT_VALUE_MARKER = "[redacted sensitive value]";
const MAX_OPERATOR_ERROR_FRAGMENT_LENGTH = 500;

type RecoverMigrateDeployFailureInput = {
  databaseUrl: string;
  schema: string | null;
  branch: string | undefined;
  error: unknown;
};

type RecoverMigrateDeployFailureDeps = {
  runMigrateDeploy: (databaseUrl: string) => Promise<void>;
  resolveFailedMigration: (
    databaseUrl: string,
    migrationName: string
  ) => Promise<void>;
  resetSchema: (databaseUrl: string, schema: string | null) => Promise<void>;
  upsertSchemaRegistry: (
    databaseUrl: string,
    schema: string | null,
    branch: string | undefined
  ) => Promise<void>;
  registryRetrySleep?: (ms: number) => Promise<void>;
};

type MigrateDeployFailureClassificationBase = {
  isP3005: boolean;
  isP3009: boolean;
  isP3018: boolean;
  invariantMessage: string | null;
};

type MigrateDeployFailureClassification =
  | (MigrateDeployFailureClassificationBase & {
      decision:
        | typeof MigrateDeployRecoveryDecision.FailFastUserDefinedInvariant
        | typeof MigrateDeployRecoveryDecision.PreviewReset
        | typeof MigrateDeployRecoveryDecision.Rethrow;
      migrationName: string | null;
    })
  | (MigrateDeployFailureClassificationBase & {
      decision: typeof MigrateDeployRecoveryDecision.ResolveRolledBack;
      migrationName: string;
    });

function parseFailedMigrationName(message: string): string | null {
  const match = MIGRATION_NAME_PATTERN.exec(message);
  return match?.[1] ?? match?.[2] ?? null;
}

// Protects formatted summaries operators copy into Slack/tickets.
// Raw Prisma output is already emitted by migrate.ts before recovery sees it.
function sanitizeOperatorMessageFragment(message: string): string {
  return message
    .replace(DATABASE_URL_ASSIGNMENT_PATTERN, SENSITIVE_INVARIANT_VALUE_MARKER)
    .replace(IAM_TOKEN_FRAGMENT_PATTERN, SENSITIVE_INVARIANT_VALUE_MARKER)
    .replace(POSTGRES_CREDENTIAL_URL_PATTERN, SENSITIVE_INVARIANT_VALUE_MARKER)
    .replace(
      POSTGRES_ENV_CONNECTION_ASSIGNMENT_PATTERN,
      SENSITIVE_INVARIANT_VALUE_MARKER
    )
    .replace(
      CREDENTIAL_ENV_ASSIGNMENT_PATTERN,
      SENSITIVE_INVARIANT_VALUE_MARKER
    );
}

function parseInvariantMessage(message: string): string | null {
  const databaseErrorMatch = DATABASE_ERROR_MESSAGE_PATTERN.exec(message);
  if (databaseErrorMatch?.[1]) {
    return sanitizeOperatorMessageFragment(databaseErrorMatch[1].trim());
  }

  const dbErrorFieldMatch = DB_ERROR_MESSAGE_FIELD_PATTERN.exec(message);
  const dbErrorFieldMessage = dbErrorFieldMatch?.[1]?.trim();
  return dbErrorFieldMessage
    ? sanitizeOperatorMessageFragment(dbErrorFieldMessage)
    : null;
}

function isTargetPostgresSqlstate(
  code: string
): code is PostgresMigrationSqlstate {
  return TARGET_POSTGRES_SQLSTATES.has(code);
}

function parseTargetPostgresSqlstate(
  output: string
): PostgresMigrationSqlstate | null {
  const code = POSTGRES_ERROR_CODE_FIELD_PATTERN.exec(output)?.[1];
  return code && isTargetPostgresSqlstate(code) ? code : null;
}

function truncateOperatorErrorFragment(fragment: string): string {
  if (fragment.length <= MAX_OPERATOR_ERROR_FRAGMENT_LENGTH) {
    return fragment;
  }

  return `${fragment.slice(0, MAX_OPERATOR_ERROR_FRAGMENT_LENGTH)}...`;
}

function parseRetryDatabaseErrorFragment(output: string): string | null {
  const fragment = parseInvariantMessage(output);
  return fragment ? truncateOperatorErrorFragment(fragment) : null;
}

function prismaErrorLabel(
  isP3009: boolean,
  isP3018: boolean
): "P3009" | "P3018" | "P3005" {
  if (isP3009) {
    return PrismaMigrateDeployErrorCode.FailedMigration;
  }
  if (isP3018) {
    return PrismaMigrateDeployErrorCode.MigrationFailedToApply;
  }
  return PrismaMigrateDeployErrorCode.NonEmptySchema;
}

function classifyMigrateDeployFailure(input: {
  output: string;
  schema: string | null;
}): MigrateDeployFailureClassification {
  const { output, schema } = input;
  const isP0001 = P0001_PATTERN.test(output);
  const isP3005 = P3005_PATTERN.test(output);
  const isP3009 = P3009_PATTERN.test(output);
  const isP3018 = P3018_PATTERN.test(output);
  const migrationName = parseFailedMigrationName(output);
  const invariantMessage = parseInvariantMessage(output);

  if (isP0001) {
    return {
      decision: MigrateDeployRecoveryDecision.FailFastUserDefinedInvariant,
      isP3005,
      isP3009,
      isP3018,
      migrationName,
      invariantMessage,
    };
  }

  if ((isP3005 || isP3009 || isP3018) && isPreviewSchema(schema)) {
    return {
      decision: MigrateDeployRecoveryDecision.PreviewReset,
      isP3005,
      isP3009,
      isP3018,
      migrationName,
      invariantMessage,
    };
  }

  if ((isP3009 || isP3018) && migrationName && !isPreviewSchema(schema)) {
    return {
      decision: MigrateDeployRecoveryDecision.ResolveRolledBack,
      isP3005,
      isP3009,
      isP3018,
      migrationName,
      invariantMessage,
    };
  }

  return {
    decision: MigrateDeployRecoveryDecision.Rethrow,
    isP3005,
    isP3009,
    isP3018,
    migrationName,
    invariantMessage,
  };
}

function formatP0001ErrorMessage(input: {
  migrationName: string | null;
  invariantMessage: string | null;
}): string {
  const migration = input.migrationName ?? "unknown migration";
  const invariant =
    input.invariantMessage ??
    "No invariant message was parsed from Prisma output.";

  return [
    `Prisma migrate deploy failed with ${PrismaMigrateDeployErrorCode.UserDefinedInvariant} (user-defined migration invariant).`,
    `Migration: ${migration}`,
    `Invariant: ${invariant}`,
    "No recovery was attempted: the migration was not resolved as rolled back, preview schemas were not reset, and migrate deploy was not retried.",
    "Preserve the original deploy output, fix the data or migration invariant, then rerun migrations.",
  ].join("\n");
}

function formatPartialCommittedDdlArtifactErrorMessage(input: {
  migrationName: string;
  sqlstate: PostgresMigrationSqlstate;
  databaseErrorFragment: string | null;
}): string {
  return [
    "Prisma migrate deploy failed after resolving a failed migration as rolled back.",
    `Migration: ${input.migrationName}`,
    `SQLSTATE: ${input.sqlstate}`,
    `Diagnosis: ${MigrateDeployRecoveryDiagnostic.PartialCommittedDdlArtifact}`,
    "The retry reported database objects that may already exist from the migration even though Prisma marked it rolled back.",
    "No further automatic recovery was attempted: the runner did not reset schemas, retry deploy again, or mark the migration applied.",
    `Next steps: preserve the original deploy output, verify the database objects match the migration, then either run prisma migrate resolve --applied ${input.migrationName} or create a corrective forward-only migration.`,
    ...(input.databaseErrorFragment
      ? [`Retry database error: ${input.databaseErrorFragment}`]
      : []),
  ].join("\n");
}

function classifyRollbackRetryFailure(input: {
  retryError: unknown;
  migrationName: string;
}): {
  sqlstate: PostgresMigrationSqlstate;
  databaseErrorFragment: string | null;
} | null {
  const output = subprocessErrorOutput(input.retryError);
  const sqlstate = parseTargetPostgresSqlstate(output);
  if (!sqlstate) {
    return null;
  }

  // Only diagnose a partial-committed artifact when the retry output names the
  // SAME migration we just resolved as rolled back. A missing or different name
  // does not prove the already-existing object came from that migration, so the
  // raw retry error is rethrown unchanged instead.
  const retryMigrationName = parseFailedMigrationName(output);
  if (retryMigrationName !== input.migrationName) {
    return null;
  }

  return {
    sqlstate,
    databaseErrorFragment: parseRetryDatabaseErrorFragment(output),
  };
}

export async function recoverMigrateDeployFailure(
  input: RecoverMigrateDeployFailureInput,
  deps: RecoverMigrateDeployFailureDeps
): Promise<boolean> {
  const output = subprocessErrorOutput(input.error);
  const classification = classifyMigrateDeployFailure({
    output,
    schema: input.schema,
  });

  if (
    classification.decision ===
    MigrateDeployRecoveryDecision.FailFastUserDefinedInvariant
  ) {
    throw new Error(
      formatP0001ErrorMessage({
        migrationName: classification.migrationName,
        invariantMessage: classification.invariantMessage,
      }),
      { cause: input.error }
    );
  }

  if (classification.decision === MigrateDeployRecoveryDecision.PreviewReset) {
    console.log(
      `↪ Preview schema ${input.schema} hit ${prismaErrorLabel(
        classification.isP3009,
        classification.isP3018
      )}, resetting...`
    );
    await deps.resetSchema(input.databaseUrl, input.schema);
    await deps.runMigrateDeploy(input.databaseUrl);
    // Recovery-path registration: re-register schema after reset so FEA-1082 reaper can track it. Same transient-retry protection as the primary path.
    await withRetry(
      () =>
        deps.upsertSchemaRegistry(
          input.databaseUrl,
          input.schema,
          input.branch
        ),
      isTransientConnectionError,
      {
        attempts: 3,
        ...(deps.registryRetrySleep ? { sleep: deps.registryRetrySleep } : {}),
      }
    );
    return true;
  }

  if (
    classification.decision === MigrateDeployRecoveryDecision.ResolveRolledBack
  ) {
    const migrationName = classification.migrationName;

    console.log(
      `↪ Failed migration detected: ${migrationName}, resolving as rolled-back...`
    );
    await deps.resolveFailedMigration(input.databaseUrl, migrationName);
    console.log("↪ Retrying migrate deploy...");
    try {
      await deps.runMigrateDeploy(input.databaseUrl);
    } catch (retryError) {
      const retryClassification = classifyRollbackRetryFailure({
        retryError,
        migrationName,
      });

      if (retryClassification) {
        // Do not attach retryError as `cause`: its raw stdout/stderr can carry
        // credential-bearing Prisma output that the formatter deliberately
        // sanitizes out. The sanitized fragment is already in the message, and
        // migrate.ts has already emitted the raw output to the deploy log.
        throw new Error(
          formatPartialCommittedDdlArtifactErrorMessage({
            migrationName,
            sqlstate: retryClassification.sqlstate,
            databaseErrorFragment: retryClassification.databaseErrorFragment,
          })
        );
      }

      throw retryError;
    }
    return false;
  }

  throw input.error;
}
