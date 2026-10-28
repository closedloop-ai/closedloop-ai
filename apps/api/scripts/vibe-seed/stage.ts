import type { PrismaClient } from "@repo/database";

/**
 * One step of the vibe seed (ISS-12017). Stages run in the order
 * `stages/index.ts` lists them, each against the same throwaway database, after
 * the `@repo/database` base seed has created the local-trusted org's core rows.
 *
 * A stage fills its models by calling the product's own producer (the ingest
 * handler, a sync service, a backfill) wherever one exists, so derived columns,
 * rollups, hashes, and encrypted fields come out exactly as production writes
 * them. Raw inserts are only for models no producer writes.
 */
export type VibeSeedStage = {
  /** Stable kebab-case name, used in logs and `vibe check` output. */
  readonly name: string;
  /** Prisma model names this stage is responsible for filling. */
  readonly models: readonly string[];
  readonly run: (context: VibeSeedContext) => Promise<void>;
};

export type VibeSeedContext = {
  readonly prisma: PrismaClient;
  /** The local-trusted organization every seeded row belongs to. */
  readonly organizationId: string;
  /** The local-trusted synthetic user, the org's owner. */
  readonly userId: string;
  /**
   * The golden-corpus Desktop store (`agent-dashboard.sqlite`) the vibe
   * environment also opens in Desktop, so web and Desktop show the same
   * sessions. Null when the run seeds web only.
   */
  readonly desktopStorePath: string | null;
  /**
   * Shift to add to any timestamp read from the frozen golden corpus so its
   * newest session lands at {@link VibeSeedContext.now}; keeps date-windowed
   * screens (last 7 or 30 days) populated.
   */
  readonly corpusShiftMs: number;
  /**
   * Material for a real desktop session the vibe Desktop profile restores on
   * launch (refresh token and the public half of its proof-of-possession key).
   * Null when the run seeds web only.
   */
  readonly desktopAuth: VibeDesktopAuthMaterial | null;
  /** The instant the run treats as "now". */
  readonly now: Date;
  readonly log: (message: string) => void;
};

export type VibeDesktopAuthMaterial = {
  readonly refreshToken: string;
  /** SPKI, base64, of the ed25519 key the Desktop profile signs refreshes with. */
  readonly publicKeySpki: string;
  readonly gatewayId: string;
};
