import { parseArgs } from "node:util";
import { isLocalhostUrl, matchesProductionHostPattern } from "../db-utils";
import {
  getSeedProfileNames,
  isSeedProfileName,
  MAX_SAFE_SEED_TARGET,
  SEED_PROFILES,
  SeedProfileName,
  type SeedProfileName as SeedProfileNameValue,
  type SeedRunReset,
  scaleSeedTargets,
} from "./profiles";

export const SeedGuardFailureReason = {
  HelpRequested: "help_requested",
  // Backwards-compatible reason emitted on generic parseArgs failures so
  // operator scripts and CI greps that key off `invalid_cli_args` keep working
  // after this CLI gained reset and target validation. New target validation
  // failures use the dedicated `invalid_target_uuid` reason instead.
  InvalidCliArgs: "invalid_cli_args",
  InvalidProfile: "invalid_profile",
  InvalidMultiplier: "invalid_multiplier",
  InvalidTargetUuid: "invalid_target_uuid",
  MissingDatabaseUrl: "missing_database_url",
  InvalidDatabaseUrl: "invalid_database_url",
  ProductionHostBlocked: "production_host_blocked",
  RemoteHostRequiresOptIn: "remote_host_requires_opt_in",
  RemoteResetRequiresExplicitOptIn: "remote_reset_requires_explicit_opt_in",
  StageHostUnconfigured: "stage_host_unconfigured",
  TargetHostUnknown: "target_host_unknown",
  TargetHostMismatch: "target_host_mismatch",
  SharedStageBlocked: "shared_stage_blocked",
} as const;
export type SeedGuardFailureReason =
  (typeof SeedGuardFailureReason)[keyof typeof SeedGuardFailureReason];

export type SeedCliOptions = {
  profile: SeedProfileNameValue;
  multiplier: number;
  rngSeed?: string;
  allowSharedStage: boolean;
  target: SeedCliTargetOptions;
  reset: SeedRunReset;
  bootstrapUser: boolean;
};

export type SeedCliTargetOptions = {
  organizationId?: string;
  userId?: string;
};

export type SeedCliParseResult =
  | { ok: true; options: SeedCliOptions; warnings: string[] }
  | {
      ok: false;
      reason: SeedGuardFailureReason;
      message: string;
      helpText?: string;
      validProfiles?: readonly SeedProfileNameValue[];
    };

export type SeedGuardResult =
  | {
      ok: true;
      url: URL;
      targetHost: string;
      targetHostSource: TargetHostSource;
    }
  | { ok: false; reason: SeedGuardFailureReason; message: string };

export type TargetHostSource = "PGHOST" | "DATABASE_URL";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseSeedCliArgs(argv: readonly string[]): SeedCliParseResult {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...normalizedArgv],
      allowPositionals: false,
      options: {
        profile: { type: "string" },
        "scale-multiplier": { type: "string" },
        "rng-seed": { type: "string" },
        "allow-shared-stage": { type: "boolean", default: false },
        reset: { type: "boolean", default: false },
        force: { type: "boolean", default: false },
        "bootstrap-user": { type: "boolean", default: false },
        "organization-id": { type: "string" },
        "user-id": { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      strict: true,
    });
  } catch {
    return {
      ok: false,
      reason: SeedGuardFailureReason.InvalidCliArgs,
      message: "Invalid seed CLI argument.",
      helpText: getSeedCliHelpText(),
      validProfiles: getSeedProfileNames(),
    };
  }

  if (parsed.values.help === true) {
    return {
      ok: false,
      reason: SeedGuardFailureReason.HelpRequested,
      message: "Seed CLI help requested.",
      helpText: getSeedCliHelpText(),
      validProfiles: getSeedProfileNames(),
    };
  }

  const rawProfile =
    typeof parsed.values.profile === "string" ? parsed.values.profile : "local";
  if (!isSeedProfileName(rawProfile)) {
    return {
      ok: false,
      reason: SeedGuardFailureReason.InvalidProfile,
      message: `Invalid seed profile. Valid profiles: ${getSeedProfileNames().join(", ")}.`,
      validProfiles: getSeedProfileNames(),
    };
  }

  const multiplierResult = parseScaleMultiplier(
    typeof parsed.values["scale-multiplier"] === "string"
      ? parsed.values["scale-multiplier"]
      : undefined,
    rawProfile
  );
  if (!multiplierResult.ok) {
    return multiplierResult;
  }

  const targetResult = parseTargetOptions({
    organizationId:
      typeof parsed.values["organization-id"] === "string"
        ? parsed.values["organization-id"]
        : undefined,
    userId:
      typeof parsed.values["user-id"] === "string"
        ? parsed.values["user-id"]
        : undefined,
  });
  if (!targetResult.ok) {
    return targetResult;
  }

  return {
    ok: true,
    options: {
      profile: rawProfile,
      multiplier: multiplierResult.multiplier,
      rngSeed:
        typeof parsed.values["rng-seed"] === "string"
          ? parsed.values["rng-seed"]
          : undefined,
      allowSharedStage: parsed.values["allow-shared-stage"] === true,
      target: targetResult.target,
      reset: {
        requested: parsed.values.reset === true,
        force: parsed.values.force === true,
      },
      bootstrapUser: parsed.values["bootstrap-user"] === true,
    },
    warnings: multiplierResult.warnings,
  };
}

export function getSeedCliHelpText(): string {
  return [
    "Usage: pnpm seed -- [options]",
    "",
    "Options:",
    `  --profile <${getSeedProfileNames().join("|")}>`,
    "  --scale-multiplier <number>",
    "  --rng-seed <seed>",
    "  --allow-shared-stage",
    "  --reset",
    "  --force",
    "  --bootstrap-user",
    "  --organization-id <uuid>",
    "  --user-id <uuid>",
    "  -h, --help",
  ].join("\n");
}

export function parseScaleMultiplier(
  raw: string | undefined,
  profile: SeedProfileNameValue
):
  | { ok: true; multiplier: number; warnings: string[] }
  | { ok: false; reason: SeedGuardFailureReason; message: string } {
  if (raw === undefined) {
    return { ok: true, multiplier: 1, warnings: [] };
  }
  if (raw.trim() === "") {
    return invalidMultiplier("Scale multiplier must not be empty.");
  }

  const multiplier = Number(raw);
  if (!Number.isFinite(multiplier) || multiplier < 1) {
    return invalidMultiplier(
      "Scale multiplier must be a finite number greater than or equal to 1."
    );
  }

  const scaledTargets = scaleSeedTargets(SEED_PROFILES[profile], multiplier);
  const unsafe = Object.values(scaledTargets).some(
    (target) => target > MAX_SAFE_SEED_TARGET || !Number.isSafeInteger(target)
  );
  if (unsafe) {
    return invalidMultiplier(
      `Scale multiplier produces an unsafe target above ${MAX_SAFE_SEED_TARGET}.`
    );
  }

  const warnings =
    multiplier > 10
      ? [
          `Scale multiplier ${multiplier} is above 10; seed runtime and row counts may be large.`,
        ]
      : [];
  return { ok: true, multiplier, warnings };
}

export function evaluateSeedGuards({
  profile,
  allowSharedStage,
  databaseUrl,
  pgHost,
  stagePgHost,
  seedAllowRemote,
  resetRequested = false,
  seedResetAllowRemote,
}: {
  profile: SeedProfileNameValue;
  allowSharedStage: boolean;
  databaseUrl: string | undefined;
  pgHost: string | undefined;
  stagePgHost: string | undefined;
  seedAllowRemote: string | undefined;
  resetRequested?: boolean;
  seedResetAllowRemote?: string | undefined;
}): SeedGuardResult {
  if (!databaseUrl) {
    return {
      ok: false,
      reason: SeedGuardFailureReason.MissingDatabaseUrl,
      message: "DATABASE_URL environment variable is required.",
    };
  }

  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return {
      ok: false,
      reason: SeedGuardFailureReason.InvalidDatabaseUrl,
      message: "DATABASE_URL is invalid.",
    };
  }

  const canonicalDatabaseHost = canonicalizeSeedHost(url.hostname);
  if (
    canonicalDatabaseHost &&
    matchesProductionHostPattern(canonicalDatabaseHost)
  ) {
    return {
      ok: false,
      reason: SeedGuardFailureReason.ProductionHostBlocked,
      message: "Refusing to seed production-shaped host from DATABASE_URL.",
    };
  }

  const targetHostResult = resolveSeedTargetHost({ databaseUrl, pgHost });
  if (!targetHostResult.ok) {
    return targetHostResult;
  }

  if (
    targetHostResult.source === "PGHOST" &&
    canonicalDatabaseHost &&
    !hostsEqual(targetHostResult.targetHost, canonicalDatabaseHost)
  ) {
    return {
      ok: false,
      reason: SeedGuardFailureReason.TargetHostMismatch,
      message:
        "Refusing to seed because PGHOST does not match DATABASE_URL host.",
    };
  }

  const canonicalTargetHost = canonicalizeSeedHost(targetHostResult.targetHost);
  const productionPattern = matchesProductionHostPattern(canonicalTargetHost);
  if (productionPattern) {
    return {
      ok: false,
      reason: SeedGuardFailureReason.ProductionHostBlocked,
      message: `Refusing to seed production-shaped host from ${targetHostResult.source}.`,
    };
  }

  const urlForLocalhostCheck = new URL(url.toString());
  urlForLocalhostCheck.hostname = canonicalTargetHost;
  const isLocalhost = isLocalhostUrl(urlForLocalhostCheck);
  if (!isLocalhost && seedAllowRemote !== "1") {
    return {
      ok: false,
      reason: SeedGuardFailureReason.RemoteHostRequiresOptIn,
      message:
        "Refusing to seed a non-localhost database without SEED_ALLOW_REMOTE=1.",
    };
  }

  // Destructive --reset on a non-localhost target needs its own explicit opt-in
  // beyond SEED_ALLOW_REMOTE; the docs promise non-interactive reset still fails
  // on remote/shared-stage targets, and --reset --force skips the only human
  // confirmation. Operators that genuinely want to wipe a remote dev/preview env
  // must additionally set SEED_RESET_ALLOW_REMOTE=1.
  if (resetRequested && !isLocalhost && seedResetAllowRemote !== "1") {
    return {
      ok: false,
      reason: SeedGuardFailureReason.RemoteResetRequiresExplicitOptIn,
      message:
        "Refusing to --reset a non-localhost database without SEED_RESET_ALLOW_REMOTE=1.",
    };
  }

  if (profile === SeedProfileName.Perf) {
    const configuredStageHost = canonicalizeSeedHost(stagePgHost ?? "");
    if (!configuredStageHost) {
      return {
        ok: false,
        reason: SeedGuardFailureReason.StageHostUnconfigured,
        message: "STAGE_PGHOST must be configured for perf profile runs.",
      };
    }
    if (canonicalTargetHost === configuredStageHost && !allowSharedStage) {
      return {
        ok: false,
        reason: SeedGuardFailureReason.SharedStageBlocked,
        message:
          "Refusing perf seed against configured shared-stage host without --allow-shared-stage.",
      };
    }
  }

  return {
    ok: true,
    url,
    targetHost: canonicalTargetHost,
    targetHostSource: targetHostResult.source,
  };
}

export function canonicalizeSeedHost(hostname: string): string {
  let normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    normalized = normalized.slice(1, -1);
  }
  while (normalized.endsWith(".")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

export function resolveSeedTargetHost({
  databaseUrl,
  pgHost,
}: {
  databaseUrl: string;
  pgHost: string | undefined;
}):
  | { ok: true; targetHost: string; source: TargetHostSource }
  | { ok: false; reason: SeedGuardFailureReason; message: string } {
  const trimmedPgHost = pgHost?.trim();
  if (trimmedPgHost) {
    return { ok: true, targetHost: trimmedPgHost, source: "PGHOST" };
  }
  try {
    const url = new URL(databaseUrl);
    if (!url.hostname) {
      return {
        ok: false,
        reason: SeedGuardFailureReason.TargetHostUnknown,
        message: "Could not resolve target database host.",
      };
    }
    return { ok: true, targetHost: url.hostname, source: "DATABASE_URL" };
  } catch {
    return {
      ok: false,
      reason: SeedGuardFailureReason.InvalidDatabaseUrl,
      message: "DATABASE_URL is invalid.",
    };
  }
}

function hostsEqual(left: string, right: string): boolean {
  return canonicalizeSeedHost(left) === canonicalizeSeedHost(right);
}

function invalidMultiplier(message: string): {
  ok: false;
  reason: SeedGuardFailureReason;
  message: string;
} {
  return {
    ok: false,
    reason: SeedGuardFailureReason.InvalidMultiplier,
    message,
  };
}

function parseTargetOptions({
  organizationId,
  userId,
}: {
  organizationId: string | undefined;
  userId: string | undefined;
}):
  | { ok: true; target: SeedCliTargetOptions }
  | { ok: false; reason: SeedGuardFailureReason; message: string } {
  const target: SeedCliTargetOptions = {};
  if (organizationId !== undefined) {
    const trimmed = organizationId.trim();
    if (!UUID_PATTERN.test(trimmed)) {
      return {
        ok: false,
        reason: SeedGuardFailureReason.InvalidTargetUuid,
        message: "--organization-id must be a UUID.",
      };
    }
    target.organizationId = trimmed.toLowerCase();
  }
  if (userId !== undefined) {
    const trimmed = userId.trim();
    if (!UUID_PATTERN.test(trimmed)) {
      return {
        ok: false,
        reason: SeedGuardFailureReason.InvalidTargetUuid,
        message: "--user-id must be a UUID.",
      };
    }
    target.userId = trimmed.toLowerCase();
  }
  return { ok: true, target };
}
