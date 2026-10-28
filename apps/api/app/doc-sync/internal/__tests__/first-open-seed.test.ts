import { log } from "@repo/observability/log";
import { FirstOpenSeedState } from "@repo/realtime-contract/doc-sync-internal";
import { generateDocumentRoomId } from "@repo/realtime-contract/document-room";
import { InternalCallFailure } from "@repo/realtime-server/internal-call";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  probeFirstOpenSeed: vi.fn(),
  seedIfNeverStored: vi.fn(),
  getLatest: vi.fn(),
}));

vi.mock("../internal-client", () => ({
  docSyncInternalClient: () => ({
    probeFirstOpenSeed: mocks.probeFirstOpenSeed,
    seedIfNeverStored: mocks.seedIfNeverStored,
  }),
}));
vi.mock("../../../documents/document-version-service", () => ({
  documentVersionService: { getLatest: mocks.getLatest },
}));

const {
  DOC_SYNC_FIRST_OPEN_SEED_FAILED_EVENT,
  DOC_SYNC_FIRST_OPEN_SEED_TIMEOUT_MS,
  FirstOpenSeedOutcome,
  seedLatestVersionOnFirstOpen,
} = await import("../first-open-seed");

const FAILED_CALL = { ok: false, failure: InternalCallFailure.Unreachable };

const ORG_ID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const DOCUMENT = { organizationId: ORG_ID, slug: "PRD-42", documentId: "d1" };
const ROOM_ID = generateDocumentRoomId(ORG_ID, "PRD-42");

function probed(state: string) {
  return { ok: true, value: { state } };
}

beforeEach(() => {
  mocks.probeFirstOpenSeed
    .mockReset()
    .mockResolvedValue(probed(FirstOpenSeedState.NeedsSeed));
  mocks.seedIfNeverStored
    .mockReset()
    .mockResolvedValue({ ok: true, value: { applied: true, updateBytes: 9 } });
  mocks.getLatest
    .mockReset()
    .mockResolvedValue({ version: 5, content: "# Latest" });
  vi.spyOn(log, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("seedLatestVersionOnFirstOpen", () => {
  it.each([
    FirstOpenSeedState.Stored,
    FirstOpenSeedState.InMemoryNotSeedable,
    "added-later",
  ])(
    "reads no version, sends no apply and confirms when the probe answers %s",
    async (state) => {
      mocks.probeFirstOpenSeed.mockResolvedValue(probed(state));

      await expect(seedLatestVersionOnFirstOpen(DOCUMENT)).resolves.toBe(
        FirstOpenSeedOutcome.Confirmed
      );

      expect(mocks.probeFirstOpenSeed).toHaveBeenCalledWith(ROOM_ID, {
        timeoutMs: DOC_SYNC_FIRST_OPEN_SEED_TIMEOUT_MS,
      });
      expect(mocks.getLatest).not.toHaveBeenCalled();
      expect(mocks.seedIfNeverStored).not.toHaveBeenCalled();
    }
  );

  it("after a failed probe, sends no apply and is unconfirmed when the latest version has content", async () => {
    mocks.probeFirstOpenSeed.mockResolvedValue(FAILED_CALL);

    await expect(seedLatestVersionOnFirstOpen(DOCUMENT)).resolves.toBe(
      FirstOpenSeedOutcome.Unconfirmed
    );

    expect(mocks.getLatest).toHaveBeenCalledWith("d1");
    expect(mocks.seedIfNeverStored).not.toHaveBeenCalled();
  });

  it("after a failed probe, confirms a document whose latest version has no content", async () => {
    mocks.probeFirstOpenSeed.mockResolvedValue(FAILED_CALL);
    mocks.getLatest.mockResolvedValue(null);

    await expect(seedLatestVersionOnFirstOpen(DOCUMENT)).resolves.toBe(
      FirstOpenSeedOutcome.Confirmed
    );
  });

  it("is unconfirmed when the apply fails", async () => {
    mocks.seedIfNeverStored.mockResolvedValue(FAILED_CALL);

    await expect(seedLatestVersionOnFirstOpen(DOCUMENT)).resolves.toBe(
      FirstOpenSeedOutcome.Unconfirmed
    );
  });

  it("confirms an apply that found the document no longer seedable", async () => {
    mocks.seedIfNeverStored.mockResolvedValue({
      ok: true,
      value: { applied: false, updateBytes: 0 },
    });

    await expect(seedLatestVersionOnFirstOpen(DOCUMENT)).resolves.toBe(
      FirstOpenSeedOutcome.Confirmed
    );
  });

  it("on needs-seed, reads the latest version, sends its markdown and number, and confirms", async () => {
    await expect(seedLatestVersionOnFirstOpen(DOCUMENT)).resolves.toBe(
      FirstOpenSeedOutcome.Confirmed
    );

    expect(mocks.getLatest).toHaveBeenCalledWith("d1");
    expect(mocks.seedIfNeverStored).toHaveBeenCalledWith(
      ROOM_ID,
      { markdown: "# Latest", version: 5 },
      { timeoutMs: expect.any(Number) }
    );
  });

  it.each([
    ["no version", null],
    ["null content", { version: 5, content: null }],
    ["blank content", { version: 5, content: "  \n\t " }],
  ])("sends no apply and confirms for %s", async (_label, latest) => {
    mocks.getLatest.mockResolvedValue(latest);

    await expect(seedLatestVersionOnFirstOpen(DOCUMENT)).resolves.toBe(
      FirstOpenSeedOutcome.Confirmed
    );

    expect(mocks.seedIfNeverStored).not.toHaveBeenCalled();
  });

  it("swallows a version read that throws, logs ids only, and is unconfirmed", async () => {
    mocks.getLatest.mockRejectedValue(new TypeError("db down"));

    await expect(seedLatestVersionOnFirstOpen(DOCUMENT)).resolves.toBe(
      FirstOpenSeedOutcome.Unconfirmed
    );

    expect(mocks.seedIfNeverStored).not.toHaveBeenCalled();
    expect(vi.mocked(log.error).mock.calls).toEqual([
      [
        expect.any(String),
        {
          event: DOC_SYNC_FIRST_OPEN_SEED_FAILED_EVENT,
          organizationId: ORG_ID,
          documentId: "d1",
          code: "TypeError",
        },
      ],
    ]);
  });

  it("shares one deadline: a slow probe shrinks the apply's timeout", async () => {
    let clock = 0;
    const now = () => clock;
    mocks.probeFirstOpenSeed.mockImplementation(() => {
      clock += 1000;
      return Promise.resolve(probed(FirstOpenSeedState.NeedsSeed));
    });
    mocks.getLatest.mockImplementation(() => {
      clock += 500;
      return Promise.resolve({ version: 5, content: "# Latest" });
    });

    await seedLatestVersionOnFirstOpen(DOCUMENT, now);

    expect(mocks.seedIfNeverStored).toHaveBeenCalledWith(
      ROOM_ID,
      expect.anything(),
      { timeoutMs: DOC_SYNC_FIRST_OPEN_SEED_TIMEOUT_MS - 1500 }
    );
  });

  it.each([
    ["answered needs-seed", probed(FirstOpenSeedState.NeedsSeed)],
    ["failed", FAILED_CALL],
  ])(
    "skips the version read and the apply, unconfirmed, once a probe that %s used the whole deadline",
    async (_label, answer) => {
      let clock = 0;
      mocks.probeFirstOpenSeed.mockImplementation(() => {
        clock += DOC_SYNC_FIRST_OPEN_SEED_TIMEOUT_MS;
        return Promise.resolve(answer);
      });

      await expect(
        seedLatestVersionOnFirstOpen(DOCUMENT, () => clock)
      ).resolves.toBe(FirstOpenSeedOutcome.Unconfirmed);

      expect(mocks.getLatest).not.toHaveBeenCalled();
      expect(mocks.seedIfNeverStored).not.toHaveBeenCalled();
    }
  );

  it("skips the apply, unconfirmed, once the version read used the rest of the deadline", async () => {
    let clock = 0;
    mocks.getLatest.mockImplementation(() => {
      clock += DOC_SYNC_FIRST_OPEN_SEED_TIMEOUT_MS;
      return Promise.resolve({ version: 5, content: "# Latest" });
    });

    await expect(
      seedLatestVersionOnFirstOpen(DOCUMENT, () => clock)
    ).resolves.toBe(FirstOpenSeedOutcome.Unconfirmed);

    expect(mocks.getLatest).toHaveBeenCalled();
    expect(mocks.seedIfNeverStored).not.toHaveBeenCalled();
  });

  it("drops a version read still pending at the deadline, unconfirmed", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    mocks.getLatest.mockReturnValue(new Promise(() => undefined));

    const pending = seedLatestVersionOnFirstOpen(DOCUMENT);
    await vi.advanceTimersByTimeAsync(DOC_SYNC_FIRST_OPEN_SEED_TIMEOUT_MS);

    await expect(pending).resolves.toBe(FirstOpenSeedOutcome.Unconfirmed);
    expect(mocks.seedIfNeverStored).not.toHaveBeenCalled();
  });
});
