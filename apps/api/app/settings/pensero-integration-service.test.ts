import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  withDb: vi.fn(),
  send: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
}));

vi.mock("@repo/aws/credentials", () => ({
  getAwsCredentials: vi.fn(() => undefined),
}));

vi.mock("@aws-sdk/client-kms", () => {
  class EncryptCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class DecryptCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class KMSClient {
    send = mocks.send;
  }
  return { KMSClient, EncryptCommand, DecryptCommand };
});

import { penseroIntegrationService } from "./pensero-integration-service";

const ORG_A = "org-a";
const ORG_B = "org-b";
const TOKEN_A = "tk_apublic:sk_asecret1111";
const TOKEN_A_LAST_FOUR = "1111";
const TOKEN_B_LAST_FOUR = "2222";

type Row = {
  organizationId: string;
  apiTokenEncrypted: string;
  apiTokenLastFour: string;
  baseUrl: string | null;
  teamIdentifiers: string[];
  setAt: Date;
};

/**
 * An org-keyed fake of the `penseroIntegration` delegate.
 *
 * This is deliberately a real store rather than a `vi.fn()` returning a fixed
 * row: a stub that answers the same way regardless of the `where` clause proves
 * nothing about org scoping, and the cross-org test below would pass just as
 * happily against a service that never filtered at all. Every method here
 * THROWS when the caller omits `where.organizationId`, so dropping the scope
 * from the service is a loud failure and not a silent widening.
 */
function createFakeDelegate(seed: Row[]) {
  const rows = new Map<string, Row>(rowsById(seed));

  return {
    rows,
    delegate: {
      upsert({
        where,
        create,
        update,
      }: {
        where: { organizationId?: string };
        create: Row;
        update: Partial<Row>;
      }) {
        const organizationId = requireOrgScope(where);
        const existing = rows.get(organizationId);
        const next = existing
          ? { ...existing, ...update }
          : { ...create, organizationId };
        rows.set(organizationId, next);
        return Promise.resolve(next);
      },
      findUnique({ where }: { where: { organizationId?: string } }) {
        const organizationId = requireOrgScope(where);
        return Promise.resolve(rows.get(organizationId) ?? null);
      },
      deleteMany({ where }: { where: { organizationId?: string } }) {
        const organizationId = requireOrgScope(where);
        const existed = rows.delete(organizationId);
        return Promise.resolve({ count: existed ? 1 : 0 });
      },
    },
  };
}

function rowsById(seed: Row[]): [string, Row][] {
  return seed.map((row) => [row.organizationId, row]);
}

function requireOrgScope(where: { organizationId?: string }): string {
  if (!where?.organizationId) {
    throw new Error(
      "pensero_integrations was queried without an organizationId scope"
    );
  }
  return where.organizationId;
}

function makeRow(
  organizationId: string,
  lastFour: string,
  teamIdentifiers: string[] = []
): Row {
  return {
    organizationId,
    apiTokenEncrypted: `ciphertext-${organizationId}`,
    apiTokenLastFour: lastFour,
    baseUrl: null,
    teamIdentifiers,
    setAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function install(seed: Row[]) {
  const fake = createFakeDelegate(seed);
  mocks.withDb.mockImplementation((callback: (db: unknown) => unknown) =>
    callback({ penseroIntegration: fake.delegate })
  );
  return fake;
}

beforeAll(() => {
  process.env.KMS_KEY_ARN = "arn:aws:kms:us-east-1:123:key/test-key";
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockImplementation((command: { input: unknown }) => {
    const name = (command as { constructor: { name: string } }).constructor
      .name;
    if (name === "EncryptCommand") {
      const { Plaintext } = command.input as { Plaintext: Buffer };
      return Promise.resolve({
        CiphertextBlob: Buffer.from(`enc:${Plaintext.toString("utf-8")}`),
      });
    }
    throw new Error(`unexpected KMS command: ${name}`);
  });
});

describe("penseroIntegrationService org scoping", () => {
  /**
   * The positive sibling. Without it the cross-org test below is vacuous — a
   * service that returned "not configured" for EVERY org would satisfy the
   * negative on its own.
   */
  it("reads back the credential belonging to the requesting org", async () => {
    install([makeRow(ORG_A, TOKEN_A_LAST_FOUR)]);

    const info = await penseroIntegrationService.getOrgCredentialInfo(ORG_A);

    expect(info.isSet).toBe(true);
    expect(info.lastFour).toBe(TOKEN_A_LAST_FOUR);
  });

  it("does not return org A's credential to org B", async () => {
    install([makeRow(ORG_A, TOKEN_A_LAST_FOUR)]);

    const info = await penseroIntegrationService.getOrgCredentialInfo(ORG_B);

    expect(info.isSet).toBe(false);
    expect(info.lastFour).toBeNull();
  });

  it("keeps two orgs' credentials distinct when both are configured", async () => {
    install([
      makeRow(ORG_A, TOKEN_A_LAST_FOUR),
      makeRow(ORG_B, TOKEN_B_LAST_FOUR),
    ]);

    const infoA = await penseroIntegrationService.getOrgCredentialInfo(ORG_A);
    const infoB = await penseroIntegrationService.getOrgCredentialInfo(ORG_B);

    expect(infoA.lastFour).toBe(TOKEN_A_LAST_FOUR);
    expect(infoB.lastFour).toBe(TOKEN_B_LAST_FOUR);
  });

  it("writes only the requesting org's row, leaving a sibling org untouched", async () => {
    const fake = install([makeRow(ORG_B, TOKEN_B_LAST_FOUR)]);

    await penseroIntegrationService.setOrgCredential(ORG_A, {
      token: TOKEN_A,
    });

    expect(fake.rows.get(ORG_B)?.apiTokenLastFour).toBe(TOKEN_B_LAST_FOUR);
    expect(fake.rows.get(ORG_A)?.apiTokenLastFour).toBe(TOKEN_A_LAST_FOUR);
  });

  it("removes only the requesting org's credential", async () => {
    const fake = install([
      makeRow(ORG_A, TOKEN_A_LAST_FOUR),
      makeRow(ORG_B, TOKEN_B_LAST_FOUR),
    ]);

    await penseroIntegrationService.removeOrgCredential(ORG_A);

    expect(fake.rows.has(ORG_A)).toBe(false);
    expect(fake.rows.has(ORG_B)).toBe(true);
  });
});

describe("penseroIntegrationService secret handling", () => {
  /**
   * Booleans, not `not.toContain(TOKEN_A)`: a containment matcher renders its
   * subject into stdout and the HTML report when it fails, which would print a
   * credential on exactly the run where something went wrong.
   */
  it("never includes the plaintext token in what it returns to a caller", async () => {
    install([]);

    const written = await penseroIntegrationService.setOrgCredential(ORG_A, {
      token: TOKEN_A,
    });
    const read = await penseroIntegrationService.getOrgCredentialInfo(ORG_A);

    expect(JSON.stringify(written).includes(TOKEN_A)).toBe(false);
    expect(JSON.stringify(read).includes(TOKEN_A)).toBe(false);
  });

  it("stores a KMS ciphertext rather than the plaintext token", async () => {
    const fake = install([]);

    await penseroIntegrationService.setOrgCredential(ORG_A, { token: TOKEN_A });

    const stored = fake.rows.get(ORG_A)?.apiTokenEncrypted ?? "";
    expect(stored.length > 0).toBe(true);
    expect(stored.includes(TOKEN_A)).toBe(false);
  });

  it("binds the ciphertext to the pensero encryption context", async () => {
    install([]);

    await penseroIntegrationService.setOrgCredential(ORG_A, { token: TOKEN_A });

    const command = mocks.send.mock.calls[0]?.[0] as {
      input: { EncryptionContext: { purpose: string } };
    };
    expect(command.input.EncryptionContext.purpose).toBe("pensero-api-token");
  });

  it("exposes only the last four characters as a fingerprint", async () => {
    install([]);

    const written = await penseroIntegrationService.setOrgCredential(ORG_A, {
      token: TOKEN_A,
    });

    expect(written.lastFour).toBe(TOKEN_A_LAST_FOUR);
    expect(written.lastFour?.length).toBe(4);
  });
});

describe("penseroIntegrationService base URL handling", () => {
  it("persists an https override", async () => {
    const fake = install([]);

    const written = await penseroIntegrationService.setOrgCredential(ORG_A, {
      token: TOKEN_A,
      baseUrl: "https://pensero.example.com/api",
    });

    expect(written.baseUrl).toBe("https://pensero.example.com/api");
    expect(fake.rows.get(ORG_A)?.baseUrl).toBe(
      "https://pensero.example.com/api"
    );
  });

  /**
   * Replacing a credential without a base URL must CLEAR the previous override
   * rather than silently keep pointing at a host the admin removed.
   */
  it("clears a previous override when a replacement omits the base URL", async () => {
    const fake = install([]);

    await penseroIntegrationService.setOrgCredential(ORG_A, {
      token: TOKEN_A,
      baseUrl: "https://old.example.com/api",
    });
    const replaced = await penseroIntegrationService.setOrgCredential(ORG_A, {
      token: TOKEN_A,
    });

    expect(replaced.baseUrl).toBeNull();
    expect(fake.rows.get(ORG_A)?.baseUrl).toBeNull();
  });

  it("reports an absent override as null rather than the deployment default", async () => {
    install([makeRow(ORG_A, TOKEN_A_LAST_FOUR)]);

    const info = await penseroIntegrationService.getOrgCredentialInfo(ORG_A);

    expect(info.baseUrl).toBeNull();
  });
});

describe("penseroIntegrationService team narrowing", () => {
  const STORED_TEAMS = ["Engineering", "Platform"];

  /**
   * The defect (codex + whitlockk, #6492): the team list is behind a
   * closed-by-default flag, so the card OMITS it while the control is hidden.
   * Under whole-configuration semantics that omission was written through as
   * `[]`, and an admin rotating a token silently widened their org's scheduled
   * poll to every Pensero team — with no screen anywhere showing what changed.
   */
  it("preserves the stored narrowing when the write omits the field", async () => {
    const fake = install([
      makeRow(ORG_A, TOKEN_A_LAST_FOUR, [...STORED_TEAMS]),
    ]);

    const replaced = await penseroIntegrationService.setOrgCredential(ORG_A, {
      token: TOKEN_A,
    });

    expect(fake.rows.get(ORG_A)?.teamIdentifiers).toEqual(STORED_TEAMS);
    expect(replaced.teamIdentifiers).toEqual(STORED_TEAMS);
  });

  it("clears the narrowing on an EXPLICIT empty list", async () => {
    // The distinction has to stay expressible, or preserving it above would
    // just be a different way of taking the choice away.
    const fake = install([
      makeRow(ORG_A, TOKEN_A_LAST_FOUR, [...STORED_TEAMS]),
    ]);

    const replaced = await penseroIntegrationService.setOrgCredential(ORG_A, {
      token: TOKEN_A,
      teamIdentifiers: [],
    });

    expect(fake.rows.get(ORG_A)?.teamIdentifiers).toEqual([]);
    expect(replaced.teamIdentifiers).toEqual([]);
  });

  it("replaces the narrowing when a new list is sent", async () => {
    const fake = install([
      makeRow(ORG_A, TOKEN_A_LAST_FOUR, [...STORED_TEAMS]),
    ]);

    await penseroIntegrationService.setOrgCredential(ORG_A, {
      token: TOKEN_A,
      teamIdentifiers: ["Delivery"],
    });

    expect(fake.rows.get(ORG_A)?.teamIdentifiers).toEqual(["Delivery"]);
  });

  it("defaults a FIRST write with no list to not-narrowed", async () => {
    // On create there is no stored list to preserve, so the omission is the
    // documented default rather than a preservation.
    const fake = install([]);

    const created = await penseroIntegrationService.setOrgCredential(ORG_A, {
      token: TOKEN_A,
    });

    expect(fake.rows.get(ORG_A)?.teamIdentifiers).toEqual([]);
    expect(created.teamIdentifiers).toEqual([]);
  });
});

describe("penseroIntegrationService removal", () => {
  it("is idempotent when no credential is configured", async () => {
    const fake = install([]);

    await expect(
      penseroIntegrationService.removeOrgCredential(ORG_A)
    ).resolves.toBeUndefined();
    expect(fake.rows.has(ORG_A)).toBe(false);
  });
});
