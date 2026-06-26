export const SeedProfileName = {
  Minimal: "minimal",
  Local: "local",
  E2e: "e2e",
  CiPreview: "ci-preview",
  Perf: "perf",
} as const;
export type SeedProfileName =
  (typeof SeedProfileName)[keyof typeof SeedProfileName];

export const SeedRngMode = {
  Fixed: "fixed",
  Perf: "perf",
} as const;
export type SeedRngMode = (typeof SeedRngMode)[keyof typeof SeedRngMode];

export const SeedAuditMode = {
  CleanOrg: "clean-org",
  IdempotentSeedOrg: "idempotent-seed-org",
  ForceOverwriteNonEmpty: "force-overwrite-non-empty",
} as const;
export type SeedAuditMode = (typeof SeedAuditMode)[keyof typeof SeedAuditMode];

export const SeedTransactionMode = {
  SingleTransaction: "single-transaction",
  Batched: "batched",
} as const;
export type SeedTransactionMode =
  (typeof SeedTransactionMode)[keyof typeof SeedTransactionMode];

export const DEFAULT_SEED_PROFILE = SeedProfileName.Local;
export const DEFAULT_FIXED_RNG_SEED = "closedloop-seed-fixed-v1";
export const DEFAULT_PERF_RNG_SEED = "closedloop-seed-perf-v1";
export const DEFAULT_SEED_CLOCK_ISO = "2026-01-01T12:00:00.000Z";
export const MAX_SAFE_SEED_TARGET = 1_000_000;

export type SeedProfileTargets = {
  projects: number;
  artifacts: number;
  comments: number;
  loops: number;
};

export type SeedProfileTargetRanges = {
  [K in keyof SeedProfileTargets]: { min: number; max: number };
};

export type SeedClock = {
  baseDate: Date;
};

export type SeedTransactionStrategy = {
  mode: SeedTransactionMode;
  timeoutMs: number;
  maxWaitMs: number;
  batchSize: number;
};

export type SeedOrgPreflight = {
  conflicts: readonly string[];
};

export type SeedRunPlan = {
  profile: SeedProfileName;
  targets: SeedProfileTargets;
  targetRanges: SeedProfileTargetRanges;
  multiplier: number;
  rngMode: SeedRngMode;
  rngSeed: string;
  clock: SeedClock;
  auditMode: SeedAuditMode;
  orgPreflight: SeedOrgPreflight;
  transaction: SeedTransactionStrategy;
  allowSharedStage: boolean;
  target: SeedRunTarget;
  reset: SeedRunReset;
};

export type SeedRunTargetSource =
  | "legacy-default"
  | "explicit-flags"
  | "inferred";

export type SeedRunTarget = {
  organizationId?: string;
  userId?: string;
  source: SeedRunTargetSource;
};

export type SeedRunReset = {
  requested: boolean;
  force: boolean;
};

export const SEED_PROFILES: Record<SeedProfileName, SeedProfileTargets> = {
  [SeedProfileName.Minimal]: {
    projects: 1,
    artifacts: 10,
    comments: 20,
    loops: 5,
  },
  [SeedProfileName.Local]: {
    projects: 8,
    artifacts: 60,
    comments: 150,
    loops: 45,
  },
  // Small, fast, deterministic dataset for the containerized E2E target
  // (FEA-2091): enough projects/artifacts/comments/loops for data-dependent
  // specs to render real content, sized to seed quickly on every CI run. Uses
  // the fixed-RNG, single-transaction strategy like the other non-perf profiles.
  [SeedProfileName.E2e]: {
    projects: 3,
    artifacts: 24,
    comments: 48,
    loops: 12,
  },
  [SeedProfileName.CiPreview]: {
    projects: 10,
    artifacts: 100,
    comments: 500,
    loops: 75,
  },
  [SeedProfileName.Perf]: {
    projects: 100,
    artifacts: 8000,
    comments: 75_000,
    loops: 1500,
  },
} as const;

export function isSeedProfileName(value: string): value is SeedProfileName {
  return (Object.values(SeedProfileName) as string[]).includes(value);
}

export function getSeedProfileNames(): readonly SeedProfileName[] {
  return Object.values(SeedProfileName);
}

export function scaleSeedTargets(
  targets: SeedProfileTargets,
  multiplier: number
): SeedProfileTargets {
  return {
    projects: scaleTarget(targets.projects, multiplier),
    artifacts: scaleTarget(targets.artifacts, multiplier),
    comments: scaleTarget(targets.comments, multiplier),
    loops: scaleTarget(targets.loops, multiplier),
  };
}

export function getSeedTargetRanges(
  targets: SeedProfileTargets
): SeedProfileTargetRanges {
  return {
    projects: getRange(targets.projects),
    artifacts: getRange(targets.artifacts),
    comments: getRange(targets.comments),
    loops: getRange(targets.loops),
  };
}

export function getSeedTransactionStrategy(
  profile: SeedProfileName
): SeedTransactionStrategy {
  if (profile === SeedProfileName.Perf) {
    return {
      mode: SeedTransactionMode.Batched,
      timeoutMs: 120_000,
      maxWaitMs: 10_000,
      batchSize: 500,
    };
  }
  return {
    mode: SeedTransactionMode.SingleTransaction,
    timeoutMs: 300_000,
    maxWaitMs: 10_000,
    batchSize: 1000,
  };
}

export function resolveSeedRunPlan({
  profile = DEFAULT_SEED_PROFILE,
  multiplier = 1,
  rngSeed,
  allowSharedStage = false,
  auditMode = SeedAuditMode.CleanOrg,
  orgPreflight = { conflicts: [] },
  target = { source: "legacy-default" },
  reset = { requested: false, force: false },
}: {
  profile?: SeedProfileName;
  multiplier?: number;
  rngSeed?: string;
  allowSharedStage?: boolean;
  auditMode?: SeedAuditMode;
  orgPreflight?: SeedOrgPreflight;
  target?: SeedRunTarget;
  reset?: SeedRunReset;
} = {}): SeedRunPlan {
  const targets = scaleSeedTargets(SEED_PROFILES[profile], multiplier);
  return {
    profile,
    targets,
    targetRanges: getSeedTargetRanges(targets),
    multiplier,
    rngMode:
      profile === SeedProfileName.Perf ? SeedRngMode.Perf : SeedRngMode.Fixed,
    rngSeed:
      rngSeed ??
      (profile === SeedProfileName.Perf
        ? DEFAULT_PERF_RNG_SEED
        : DEFAULT_FIXED_RNG_SEED),
    clock: { baseDate: new Date(DEFAULT_SEED_CLOCK_ISO) },
    auditMode,
    orgPreflight,
    transaction: getSeedTransactionStrategy(profile),
    allowSharedStage,
    target,
    reset,
  };
}

function scaleTarget(base: number, multiplier: number): number {
  return Math.max(1, Math.round(base * multiplier));
}

function getRange(target: number): { min: number; max: number } {
  return {
    min: Math.max(1, Math.floor(target * 0.8)),
    max: Math.ceil(target * 1.2),
  };
}
