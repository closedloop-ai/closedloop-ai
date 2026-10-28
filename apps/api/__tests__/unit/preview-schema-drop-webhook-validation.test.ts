/**
 * ISS-7567: `dropSchemaForBranch` validates its own branch argument.
 *
 * The GitHub webhook reaches that function WITHOUT passing any route
 * validator, so a route-local bound left the webhook able to derive a
 * `preview_*` schema name from an unshaped ref. These cases therefore drive
 * the REAL service through `maybeDropPreviewSchemaOnClose` — only the database
 * and Slack layers are mocked — rather than through the HTTP route.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockWithDb,
  mockWithDbTx,
  mockWithMigratorClient,
  mockWaitUntil,
  mockNotifySlack,
} = vi.hoisted(() => ({
  mockWithDb: vi.fn(),
  mockWithDbTx: vi.fn(),
  mockWithMigratorClient: vi.fn(),
  mockWaitUntil: vi.fn(),
  mockNotifySlack: vi.fn(),
}));

vi.mock("@/app/preview-schemas/service/migrator-connection", () => ({
  withMigratorClient: mockWithMigratorClient,
}));

vi.mock("@repo/database", () => ({
  withDb: Object.assign(mockWithDb, { tx: mockWithDbTx }),
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
}));

vi.mock("@repo/github", () => ({
  listAllBranchNames: vi.fn(),
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: mockWaitUntil,
}));

vi.mock("@/lib/slack-notifier", () => ({
  notifySlack: mockNotifySlack,
  buildCorrelationId: () => "ts=2024-01-01T00:00:00.000Z",
}));

import { PreviewSchemaSourceRepo } from "@/app/preview-schemas/constants";
import { maybeDropPreviewSchemaOnClose } from "@/app/webhooks/github/preview-schema-drop";

const SOURCE_REPO = PreviewSchemaSourceRepo.fullName;
const WELL_SHAPED_BRANCH = "fix/iss-7567-probe";
const UNSHAPED_BRANCH = "@@@";

/** Settles the background promise the webhook handed to `waitUntil`. */
function settleWaitUntil(): Promise<unknown> {
  return mockWaitUntil.mock.calls[0]?.[0] ?? Promise.resolve();
}

describe("dropSchemaForBranch branch validation, via the webhook entry point", () => {
  beforeEach(() => {
    mockNotifySlack.mockResolvedValue(undefined);
    // The existence check answers "no such schema", so a branch that PASSES
    // validation still stops before the migrator connection issues a DROP.
    mockWithDb.mockImplementation((fn: (db: unknown) => unknown) =>
      fn({ $queryRaw: vi.fn().mockResolvedValue([]) })
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("queries the database for a well-shaped ref", async () => {
    maybeDropPreviewSchemaOnClose({
      action: "closed",
      branch: WELL_SHAPED_BRANCH,
      repoFullName: SOURCE_REPO,
    });

    await settleWaitUntil();

    expect(mockWithDb).toHaveBeenCalled();
    expect(mockNotifySlack).not.toHaveBeenCalled();
  });

  it("reaches no database statement for a ref outside the branch character class", async () => {
    maybeDropPreviewSchemaOnClose({
      action: "closed",
      branch: UNSHAPED_BRANCH,
      repoFullName: SOURCE_REPO,
    });

    await settleWaitUntil();

    expect(mockWithDb).not.toHaveBeenCalled();
    expect(mockWithMigratorClient).not.toHaveBeenCalled();
    // The rejection is reported, not swallowed — otherwise "no statement ran"
    // would also be satisfied by the webhook silently doing nothing at all.
    expect(mockNotifySlack).toHaveBeenCalledWith(
      expect.objectContaining({ route: "cleanup-preview-schemas:pr-close" })
    );
  });
});
