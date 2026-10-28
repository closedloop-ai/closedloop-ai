import { createHash } from "node:crypto";
import { ApiKeyScope } from "@repo/api/src/types/api-key";
import { describe, expect, it, vi } from "vitest";
import { resolveSeedApiKeyDecision, seedApiKeys } from "../../api-keys";
import type { SeedContext } from "../../index";
import {
  API_KEY_PREFIX,
  E2E_SEED_API_KEY_ENV,
  mintsSeedApiKey,
  resolveSeedRunPlan,
  SeedProfileName,
  type SeedRunPlan,
} from "../../profiles";

/**
 * ISS-9846 (PRD-707 R1) — the `e2e` profile mints an `sk_live_` key, and every
 * other profile, every non-localhost target, and every run without a supplied
 * secret must mint nothing. Both refusals are security gates, so each is
 * asserted on its own rather than through a single "did it write" boolean.
 */

const CONTEXT: SeedContext = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
};

// 64 lowercase hex characters, the exact shape `apps/api`'s generator emits.
const SUPPLIED_KEY = `${API_KEY_PREFIX}${"deadbeef".repeat(8)}`;

/**
 * The row id `seedApiKeys` derives for CONTEXT, as a golden value.
 *
 * Pinned as a literal rather than recomputed here: re-deriving it with the same
 * formula the module uses would agree with any mistake in that formula, and the
 * point of the id is that it is STABLE — a change to the derivation must red
 * this, because it orphans every row a previous seed wrote.
 */
const SEED_ROW_ID = "697181ec-4850-508a-95db-ad0d193d2e01";
const LOCAL_DATABASE_URL = "postgresql://postgres@localhost:5432/app";
const REMOTE_DATABASE_URL = "postgresql://postgres@db.stage.example.com/app";
const MINTING_ENV = {
  [E2E_SEED_API_KEY_ENV]: SUPPLIED_KEY,
  DATABASE_URL: LOCAL_DATABASE_URL,
} satisfies NodeJS.ProcessEnv;

function suppliedKeyHash(): string {
  return createHash("sha256").update(SUPPLIED_KEY, "utf8").digest("hex");
}

function planFor(profile: SeedProfileName): SeedRunPlan {
  return { ...resolveSeedRunPlan(), profile };
}

function mockPrisma() {
  const create = vi.fn().mockResolvedValue({});
  const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
  return {
    client: { apiKey: { create, deleteMany } },
    create,
    deleteMany,
  };
}

type MockedPrisma = ReturnType<typeof mockPrisma>;

function runSeed(
  prisma: MockedPrisma,
  profile: SeedProfileName,
  env: NodeJS.ProcessEnv
) {
  return seedApiKeys(
    prisma.client as unknown as Parameters<typeof seedApiKeys>[0],
    CONTEXT,
    planFor(profile),
    env
  );
}

describe("seedApiKeys (ISS-9846)", () => {
  it("mints a full-access sk_live_ key for the e2e profile", async () => {
    const prisma = mockPrisma();
    await runSeed(prisma, SeedProfileName.E2e, MINTING_ENV);

    expect(prisma.create).toHaveBeenCalledTimes(1);
    const createArg = prisma.create.mock.calls[0]?.[0];
    expect(createArg).toBeDefined();
    const { data } = createArg as { data: Record<string, unknown> };
    expect(data.keyPrefix).toBe(API_KEY_PREFIX);
    expect(data.organizationId).toBe(CONTEXT.organizationId);
    expect(data.userId).toBe(CONTEXT.userId);
    expect(data.scopes).toEqual([
      ApiKeyScope.Read,
      ApiKeyScope.Write,
      ApiKeyScope.Delete,
    ]);
    // Pinned against an INDEPENDENT digest of the same plaintext, not against
    // whatever the module happened to compute: the API verifies a key by
    // sha256-hex of its UTF-8 bytes, so a different hash mints a key nothing can
    // authenticate with and every assertion derived from the module's own output
    // would agree with the mistake.
    expect(data.keyHash).toBe(suppliedKeyHash());
    // The seed writes its own primary key so the delete above can recognise the
    // row it owns; `uuid(7)` would give it a fresh, unrecognisable one.
    expect(data.id).toBe(SEED_ROW_ID);
  });

  it("clears the previous row by BOTH identities before re-minting", async () => {
    const prisma = mockPrisma();
    await runSeed(prisma, SeedProfileName.E2e, MINTING_ENV);

    // `keyHash` is globally unique while the seed's own row is its derived id,
    // so matching one identity alone leaves a same-secret row from another
    // bootstrap org standing — and the P2002 that follows rolls back the whole
    // single-transaction seed.
    //
    // Neither arm mentions `name`, and that is the contract: `E2E seed key` is a
    // name a human's own USER_CREATED key can carry, so a name predicate deletes
    // the user's key on the next re-seed.
    expect(prisma.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.deleteMany.mock.calls[0]?.[0]).toEqual({
      where: {
        OR: [{ id: SEED_ROW_ID }, { keyHash: suppliedKeyHash() }],
      },
    });
  });

  it.each([
    SeedProfileName.Minimal,
    SeedProfileName.Local,
    SeedProfileName.CiPreview,
    SeedProfileName.Perf,
  ])("writes no key for the %s profile", async (profile) => {
    const prisma = mockPrisma();
    await runSeed(prisma, profile, MINTING_ENV);
    expect(mintsSeedApiKey(profile)).toBe(false);
    expect(prisma.create).not.toHaveBeenCalled();
    expect(prisma.deleteMany).not.toHaveBeenCalled();
  });

  it("writes no key against a non-localhost target, even on the e2e profile", async () => {
    const prisma = mockPrisma();
    await runSeed(prisma, SeedProfileName.E2e, {
      [E2E_SEED_API_KEY_ENV]: SUPPLIED_KEY,
      DATABASE_URL: REMOTE_DATABASE_URL,
    });
    // The CLI's shared-stage tripwire is scoped to the `perf` profile, so this
    // is the only thing stopping `--profile e2e` with `SEED_ALLOW_REMOTE=1` from
    // putting a live full-access key on a deployed database.
    expect(prisma.create).not.toHaveBeenCalled();
    expect(prisma.deleteMany).not.toHaveBeenCalled();
  });

  it("writes no key when the environment supplies no secret", async () => {
    const prisma = mockPrisma();
    await runSeed(prisma, SeedProfileName.E2e, {
      DATABASE_URL: LOCAL_DATABASE_URL,
    });
    expect(prisma.create).not.toHaveBeenCalled();
    expect(prisma.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    ["carries no sk_live_ prefix", "not-a-live-key"],
    // The one that matters: prefix-valid, hashes fine, routed to API-key auth by
    // `withAnyAuth`, and guessable by anyone — it would mint a non-expiring
    // read/write/delete credential.
    ["is the bare prefix", API_KEY_PREFIX],
    ["is short of the generator's entropy", `${API_KEY_PREFIX}deadbeef`],
    [
      "carries one hex character too few",
      `${API_KEY_PREFIX}${"deadbeef".repeat(7)}deadbee`,
    ],
    [
      "carries one hex character too many",
      `${API_KEY_PREFIX}${"deadbeef".repeat(8)}0`,
    ],
    ["is not lowercase hex", `${API_KEY_PREFIX}${"DEADBEEF".repeat(8)}`],
    ["is prefix plus non-hex filler", `${API_KEY_PREFIX}${"z".repeat(64)}`],
  ])("refuses a supplied key that %s", (_label, supplied) => {
    expect(() =>
      resolveSeedApiKeyDecision({
        [E2E_SEED_API_KEY_ENV]: supplied,
        DATABASE_URL: LOCAL_DATABASE_URL,
      })
    ).toThrow(E2E_SEED_API_KEY_ENV);
  });

  it("accepts the shape the API's own generator emits", () => {
    const decision = resolveSeedApiKeyDecision(MINTING_ENV);
    expect(decision).toEqual({ mint: true, plaintext: SUPPLIED_KEY });
  });

  it.each([
    ["absent", undefined],
    ["unparseable", "not-a-url"],
  ])("fails closed on an %s DATABASE_URL", (_label, databaseUrl) => {
    // "Cannot tell what the target is" must never mint.
    const decision = resolveSeedApiKeyDecision({
      [E2E_SEED_API_KEY_ENV]: SUPPLIED_KEY,
      ...(databaseUrl === undefined ? {} : { DATABASE_URL: databaseUrl }),
    });
    expect(decision.mint).toBe(false);
  });
});
