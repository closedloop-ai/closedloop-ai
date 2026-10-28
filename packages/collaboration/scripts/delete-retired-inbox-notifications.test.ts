import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type * as CleanupModule from "./retired-inbox-notification-cleanup";
import type { InboxNotificationCleanupReport } from "./retired-inbox-notification-cleanup";

const mocks = vi.hoisted(() => ({
  cleanup: vi.fn(),
  liveblocksSecrets: [] as string[],
  readFileSync: vi.fn(),
}));

vi.mock("node:fs", () => ({ readFileSync: mocks.readFileSync }));

vi.mock("@liveblocks/node", () => ({
  Liveblocks: class {
    constructor({ secret }: { secret: string }) {
      mocks.liveblocksSecrets.push(secret);
    }
  },
}));

vi.mock("./retired-inbox-notification-cleanup", async (importOriginal) => ({
  ...(await importOriginal<typeof CleanupModule>()),
  cleanupRetiredInboxNotifications: mocks.cleanup,
}));

let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let originalSecret: string | undefined;
let stderr: ReturnType<typeof vi.spyOn>;
let stdout: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.liveblocksSecrets.length = 0;
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  originalSecret = process.env.LIVEBLOCKS_SECRET;
  process.env.LIVEBLOCKS_SECRET = SECRET;
  mocks.readFileSync.mockReturnValue(JSON.stringify(RECIPIENTS));
  mocks.cleanup.mockResolvedValue(CLEAN_REPORT);
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  if (originalSecret === undefined) {
    Reflect.deleteProperty(process.env, "LIVEBLOCKS_SECRET");
  } else {
    process.env.LIVEBLOCKS_SECRET = originalSecret;
  }
  stderr.mockRestore();
  stdout.mockRestore();
});

describe("delete-retired-inbox-notifications CLI (ISS-12435)", () => {
  it("exits 2 without a Liveblocks secret and touches nothing", async () => {
    Reflect.deleteProperty(process.env, "LIVEBLOCKS_SECRET");

    expect(await runCli("--recipients", SNAPSHOT_PATH)).toBe(2);
    expect(stderr).toHaveBeenCalledWith("LIVEBLOCKS_SECRET is required.\n");
    expect(mocks.readFileSync).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it.each([
    ["is missing", []],
    // indexOf is -1 here, so the path lookup reads argv[0]; the flag check
    // must still refuse.
    ["is missing but another argument is present", ["--apply"]],
    ["has no path after it", ["--recipients"]],
  ])("exits 2 when --recipients %s", async (_label, args) => {
    expect(await runCli(...args)).toBe(2);
    expect(stderr).toHaveBeenCalledWith(
      "--recipients <snapshot.json> is required.\n"
    );
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it("dry-runs the snapshot by default and exits 0 on a clean report", async () => {
    expect(await runCli("--recipients", SNAPSHOT_PATH)).toBe(0);

    expect(mocks.readFileSync).toHaveBeenCalledWith(SNAPSHOT_PATH, "utf8");
    expect(mocks.liveblocksSecrets).toEqual([SECRET]);
    expect(mocks.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ recipients: RECIPIENTS, apply: false })
    );
    expect(stdout).toHaveBeenCalledWith(
      `${JSON.stringify(CLEAN_REPORT, null, 2)}\n`
    );
  });

  it("applies with --apply and exits 1 when a recipient failed", async () => {
    mocks.cleanup.mockResolvedValue({
      ...CLEAN_REPORT,
      apply: true,
      failures: [
        { ...RECIPIENTS[0], inboxNotificationId: null, error: "list refused" },
      ],
    });

    expect(await runCli("--apply", "--recipients", SNAPSHOT_PATH)).toBe(1);
    expect(mocks.cleanup).toHaveBeenCalledWith(
      expect.objectContaining({ apply: true })
    );
  });

  it("refuses a snapshot row without an organization before any cleanup", async () => {
    mocks.readFileSync.mockReturnValue(
      JSON.stringify([{ userId: "user-ada" }])
    );

    const rejection = runCli("--recipients", SNAPSHOT_PATH);
    await expect(rejection).rejects.toThrow(ZodError);
    await expect(rejection).rejects.toMatchObject({
      issues: [expect.objectContaining({ path: [0, "organizationId"] })],
    });
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });
});

async function runCli(...args: string[]): Promise<typeof process.exitCode> {
  process.argv = ["node", "delete-retired-inbox-notifications.ts", ...args];
  await import("./delete-retired-inbox-notifications");
  return process.exitCode;
}

const SECRET = "sk_test-cleanup";
const SNAPSHOT_PATH = "/tmp/recipients.json";
const RECIPIENTS = [{ userId: "user-ada", organizationId: "org-1" }];

const CLEAN_REPORT: InboxNotificationCleanupReport = {
  apply: false,
  recipients: 1,
  scanned: 2,
  matched: 1,
  deleted: 0,
  failures: [],
};
