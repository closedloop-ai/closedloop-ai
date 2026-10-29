import { createHash } from "node:crypto";
import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { ApiKeySource } from "../../generated/client";
import type { TransactionClient } from "../../generated/internal/prismaNamespace";
import { isLocalhostUrl } from "../db-utils";
import { deterministicUuid, seedLog } from "./helpers";
import type { SeedContext } from "./index";
import {
  API_KEY_PLAINTEXT_ENTROPY_HEX_CHARS,
  API_KEY_PREFIX,
  E2E_SEED_API_KEY_ENV,
  isApiKeyPlaintext,
  mintsSeedApiKey,
  type SeedRunPlan,
} from "./profiles";

/**
 * ISS-9846 (PRD-707 R1) — mint a programmatic API key for the containerized E2E
 * target.
 *
 * The `e2e` profile previously created no key at all, so every harness that
 * wanted to drive the API the way the desktop does had to mock authentication
 * away — which is exactly the coverage hole PRD-707 R exists to close. PRD-707
 * D2 (ISS-9166) consumes this key.
 *
 * TWO INDEPENDENT CONDITIONS GATE THE WRITE, and each closes a different way a
 * live full-access credential could escape a throwaway database:
 *
 *  1. **The caller must supply the secret** in `SEED_E2E_API_KEY`. This module
 *     never invents one and never prints one. An earlier draft generated a key
 *     and logged it once for convenience; in the containerized lane that stdout
 *     is captured by `e2e/container-log-capture.sh` and uploaded as a 14-day CI
 *     artifact, and a runtime-generated value cannot be covered by the capture's
 *     key allowlist — so the convenience was a credential leak with a retention
 *     policy. Absent the variable this is a no-op.
 *  2. **The target must be localhost.** The seed's own shared-stage tripwire
 *     (`evaluateSeedGuards`) is scoped to the `perf` profile, so `--profile e2e`
 *     with `SEED_ALLOW_REMOTE=1` otherwise reaches a deployed database with
 *     nothing in its way. A profile allow-list is a statement of intent; this is
 *     the check that enforces it, and it is deliberately independent of the
 *     CLI's guards so a future change there cannot silently widen this.
 *
 * ONLY the profiles in `SEED_API_KEY_PROFILES` mint one. Every other profile —
 * including the shared-stage `ci-preview` and `perf` runs — leaves the table
 * untouched.
 */

/**
 * Full access, the same three scopes `apiKeysService.generate` grants (which is
 * `FULL_ACCESS_SCOPES`, i.e. everything except `Admin`). Members of the
 * canonical `ApiKeyScope` const, never bare strings.
 */
const SEED_API_KEY_SCOPES = [
  ApiKeyScope.Read,
  ApiKeyScope.Write,
  ApiKeyScope.Delete,
] as const;

const SEED_API_KEY_NAME = "E2E seed key";

/** Why a run minted nothing, for the one log line that says so. */
type SeedApiKeySkipReason = "no-secret" | "non-localhost-target";

export type SeedApiKeyDecision =
  | { mint: true; plaintext: string }
  | { mint: false; reason: SeedApiKeySkipReason };

/**
 * Whether this run may mint, and with what secret.
 *
 * Exported so the decision is testable without a database — it is the whole
 * security surface of this module, and the two refusals below are the only
 * things standing between a full-access key and a shared environment.
 */
export function resolveSeedApiKeyDecision(
  env: NodeJS.ProcessEnv
): SeedApiKeyDecision {
  const supplied = env[E2E_SEED_API_KEY_ENV]?.trim();
  if (!supplied) {
    return { mint: false, reason: "no-secret" };
  }
  if (!isApiKeyPlaintext(supplied)) {
    throw new Error(
      `${E2E_SEED_API_KEY_ENV} must be ${API_KEY_PREFIX} followed by ${API_KEY_PLAINTEXT_ENTROPY_HEX_CHARS} lowercase hex characters — the exact shape the API's own generator emits. A prefix-only or short value (\`${API_KEY_PREFIX}\`) is routed to API-key auth and hashes fine, so it would mint a non-expiring full-access credential whose plaintext is guessable. Generate one with \`openssl rand -hex 32\`.`
    );
  }
  if (!isSeedTargetLocalhost(env.DATABASE_URL)) {
    return { mint: false, reason: "non-localhost-target" };
  }
  return { mint: true, plaintext: supplied };
}

/**
 * FAIL CLOSED on anything that is not a parseable localhost URL — an
 * unparseable or absent `DATABASE_URL` is a target this module cannot vouch
 * for, and "cannot tell" must not mint.
 */
function isSeedTargetLocalhost(databaseUrl: string | undefined): boolean {
  if (!databaseUrl) {
    return false;
  }
  try {
    return isLocalhostUrl(new URL(databaseUrl));
  } catch {
    return false;
  }
}

/**
 * SHA-256 hex of the plaintext — the identical function `apps/api`'s
 * `hashToken` applies, restated because `packages/database` cannot import from
 * `apps/api`. A mismatch here mints a key nothing can authenticate with, so the
 * unit suite pins the digest against a known vector rather than against this
 * function's own output.
 */
function hashSeedApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/**
 * A stable, seed-owned identity for the row, derived from the bootstrap
 * org + user this seed is writing.
 *
 * The delete below needs to recognise the row THIS SEED minted, and no column
 * on `ApiKey` says "the seed made me": `source` is `USER_CREATED` (the same
 * value a human's key carries) and matching on `name` cannot tell a prior seed
 * row from a user key that happens to be called `E2E seed key`, so re-seeding
 * would delete the user's. Writing the primary key ourselves gives the row a
 * marker nothing else can collide with, and lets the delete replace exactly
 * that row.
 *
 * `deterministicUuid` is the seed's own derivation, already used for every other
 * stable id it writes — same namespace, same guarantee that a re-seed of the
 * same (org, user) resolves to the same row.
 */
function seedApiKeyRowId(organizationId: string, userId: string): string {
  return deterministicUuid(`api-key:${organizationId}:${userId}`);
}

/**
 * Create the profile's API key, replacing any key this seed minted before.
 *
 * The delete covers TWO identities, because `ApiKey.keyHash` is globally
 * `@unique` while the seed's own row is identified by `seedApiKeyRowId`.
 * Re-seeding the SAME secret into a different bootstrap org would otherwise
 * leave the prior row standing, hit P2002 on the hash, and — since the whole
 * seed runs inside one interactive transaction — roll the entire seed back.
 */
export async function seedApiKeys(
  prisma: TransactionClient,
  context: SeedContext,
  plan: SeedRunPlan,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (!mintsSeedApiKey(plan.profile)) {
    return;
  }
  const decision = resolveSeedApiKeyDecision(env);
  if (!decision.mint) {
    seedLog(seedApiKeySkipMessage(plan.profile, decision.reason));
    return;
  }

  const { organizationId, userId } = context;
  const keyHash = hashSeedApiKey(decision.plaintext);
  const id = seedApiKeyRowId(organizationId, userId);
  await prisma.apiKey.deleteMany({
    where: { OR: [{ id }, { keyHash }] },
  });
  await prisma.apiKey.create({
    data: {
      id,
      organizationId,
      userId,
      name: SEED_API_KEY_NAME,
      scopes: [...SEED_API_KEY_SCOPES],
      keyHash,
      keyPrefix: API_KEY_PREFIX,
      expiresAt: null,
      source: ApiKeySource.USER_CREATED,
      gatewayId: null,
      boundPublicKey: null,
    },
    // The row is discarded, so narrow `RETURNING *` to the primary key.
    select: { id: true },
  });
  seedLog(
    `Seeded the ${plan.profile} API key from ${E2E_SEED_API_KEY_ENV} (plaintext not logged).`
  );
}

/** Says which gate refused, so an operator is never left guessing. */
export function seedApiKeySkipMessage(
  profile: string,
  reason: SeedApiKeySkipReason
): string {
  if (reason === "no-secret") {
    return `No ${profile} API key seeded: set ${E2E_SEED_API_KEY_ENV} to an ${API_KEY_PREFIX} secret. This seed never generates or logs one.`;
  }
  return `No ${profile} API key seeded: the target DATABASE_URL is not localhost. A full-access key is minted only against a throwaway local database.`;
}
