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
  },
  [SeedProfileName.Local]: {
    projects: 8,
    artifacts: 60,
    comments: 150,
  },
  // Small, fast, deterministic dataset for the containerized E2E target
  // (FEA-2091): enough projects/artifacts/comments for data-dependent
  // specs to render real content, sized to seed quickly on every CI run. Uses
  // the fixed-RNG, single-transaction strategy like the other non-perf profiles.
  [SeedProfileName.E2e]: {
    projects: 3,
    artifacts: 24,
    comments: 48,
  },
  [SeedProfileName.CiPreview]: {
    projects: 10,
    artifacts: 100,
    comments: 500,
  },
  [SeedProfileName.Perf]: {
    projects: 100,
    artifacts: 8000,
    comments: 75_000,
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
  };
}

export function getSeedTargetRanges(
  targets: SeedProfileTargets
): SeedProfileTargetRanges {
  return {
    projects: getRange(targets.projects),
    artifacts: getRange(targets.artifacts),
    comments: getRange(targets.comments),
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

/**
 * ISS-9846 (PRD-707 R1): the profiles whose seed MAY mint a programmatic API key.
 *
 * Only the containerized E2E target. `ci-preview` and `perf` can be pointed at a
 * shared stage database, and a full-access bearer token is not something a
 * throughput or preview seed should leave behind; `local` and `minimal` have a
 * signed-in browser session and need no programmatic key.
 *
 * A Set of the const members, not a widened `string[]` — a profile added to
 * `SeedProfileName` cannot silently be assumed excluded, because naming it here
 * is the only way it joins.
 *
 * MAY, not WILL, and this list is NOT the security boundary. The `e2e` profile
 * clears the CLI's remote-target checks with `SEED_ALLOW_REMOTE=1` like any
 * other, and the shared-stage tripwire in `evaluateSeedGuards` is scoped to
 * `perf` alone — so an allow-list of profiles would put nothing at all between
 * `--profile e2e` and a deployed database. `seedApiKeys` enforces the boundary
 * itself: a caller-supplied secret AND a localhost target, each checked there.
 */
export const SEED_API_KEY_PROFILES: ReadonlySet<SeedProfileName> =
  new Set<SeedProfileName>([SeedProfileName.E2e]);

/** Whether this profile's seed mints an API key. */
export function mintsSeedApiKey(profile: SeedProfileName): boolean {
  return SEED_API_KEY_PROFILES.has(profile);
}

/**
 * Where the E2E seed reads its API-key plaintext from.
 *
 * REQUIRED for the key to be minted at all. The seed neither generates nor logs
 * a secret: the containerized lane captures the seed container's stdout into an
 * uploaded CI artifact, so a printed key would be a credential with a retention
 * policy.
 */
export const E2E_SEED_API_KEY_ENV = "SEED_E2E_API_KEY";

/**
 * The live API-key prefix. `withAnyAuth` routes a bearer token to API-key
 * authentication by exactly this prefix, so a seeded key that does not carry it
 * authenticates nothing.
 */
export const API_KEY_PREFIX = "sk_live_";

/**
 * The shape `apps/api`'s key generator emits: the prefix followed by
 * `randomBytes(32).toString("hex")`. Restated here because `packages/database`
 * cannot import from `apps/api` — the same restatement this module already
 * makes for `API_KEY_PREFIX` and that `api-keys.ts` makes for `hashToken`.
 *
 * A supplied secret must satisfy this WHOLE pattern, not merely start with the
 * prefix. `SEED_E2E_API_KEY=sk_live_` is prefix-valid, hashes fine, and would
 * mint a non-expiring read/write/delete credential whose plaintext anyone can
 * guess — so prefix-only validation is not validation.
 *
 * The restatement is pinned against the REAL generator by the contract-replay
 * integration suite, which feeds `apiKeysService.generate`'s own plaintext
 * through `resolveSeedApiKeyDecision`: if the generator's shape ever moves, that
 * case reds rather than this constant silently drifting.
 */
export const API_KEY_PLAINTEXT_ENTROPY_HEX_CHARS = 64;
const API_KEY_PLAINTEXT_PATTERN = new RegExp(
  `^${API_KEY_PREFIX}[0-9a-f]{${API_KEY_PLAINTEXT_ENTROPY_HEX_CHARS}}$`
);

/** Whether `value` is shaped like a key the API's own generator would emit. */
export function isApiKeyPlaintext(value: string): boolean {
  return API_KEY_PLAINTEXT_PATTERN.test(value);
}
