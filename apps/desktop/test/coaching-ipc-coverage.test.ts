/**
 * @file coaching-ipc-coverage.test.ts
 * @description ISS-10308: behavior pins for the coaching IPC handlers that
 * coaching-ipc-trusted-sender.test.ts does not reach: the Generate/Install
 * result and throw paths, the GetPack/InstallPack/CoachingInstall gates, and
 * the argument validation ahead of each delegate.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { registerCoachingIpcHandlers } from "../src/main/ipc/coaching-ipc.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { CoachingIpcChannel } from "../src/shared/coaching-ipc-channel.js";
import type {
  CoachingHarnessResult,
  CoachingPackInfo,
} from "../src/shared/coaching-pack-contract.js";
import {
  createIpcRegistrar,
  type IpcRegistrarHarness,
  isTrustedSenderDouble,
  TRUSTED_EVENT,
  UNTRUSTED_EVENT,
  UNTRUSTED_SENDER_ERROR,
} from "./helpers/ipc-registrar.js";

const harnessMocks = vi.hoisted(() => ({
  generateCoachingTips: vi.fn(),
  installCoachingArtifact: vi.fn(),
}));

const packMocks = vi.hoisted(() => ({
  installCoachingPack: vi.fn(),
}));

vi.mock(
  "../src/main/agent-monitor/agent-coaching-harness.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    generateCoachingTips: harnessMocks.generateCoachingTips,
    installCoachingArtifact: harnessMocks.installCoachingArtifact,
  })
);

vi.mock(
  "../src/main/agent-monitor/agent-coaching-packs.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    installCoachingPack: packMocks.installCoachingPack,
  })
);

const LOG_TAG = "agent-coaching";
const PACKS_DIR = "/store/coaching-packs";
const COMPUTE_TARGET_ID = "ct-9";
const DISTRIBUTION_ID = "dist-7";

const COACHING_PACKS_DISABLED = { message: "Coaching Packs is disabled." };
const INSTALL_PACK_NEEDS_DIR = {
  message: "install-pack requires a source directory path.",
};
const COACHING_INSTALL_NEEDS_ID = {
  message: "coachingInstall requires a distribution id.",
};
const COACHING_INSTALL_NOT_CONNECTED = {
  message: "Not connected — cannot resolve the distribution.",
};

const SAMPLE_PACK: CoachingPackInfo = {
  name: "token-coach",
  displayName: "Token Coach",
  version: "1.0.0",
  description: null,
  signals: ["keep the prefix stable"],
};

type Flags = {
  tipsEnabled?: boolean;
  packsEnabled?: boolean;
  computeTargetId?: string | null;
};

type Harness = {
  ipc: IpcRegistrarHarness;
  deps: {
    getActiveCoachingPackSeeded: ReturnType<typeof vi.fn>;
    coachingPacksDir: ReturnType<typeof vi.fn>;
    installCoachingDistributionById: ReturnType<typeof vi.fn>;
  };
};

let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  harnessMocks.generateCoachingTips.mockReset();
  harnessMocks.installCoachingArtifact.mockReset();
  packMocks.installCoachingPack.mockReset();
  warnSpy = vi.spyOn(gatewayLog, "warn").mockImplementation(() => undefined);
  errorSpy = vi.spyOn(gatewayLog, "error").mockImplementation(() => undefined);
  infoSpy = vi.spyOn(gatewayLog, "info").mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  infoSpy.mockRestore();
});

function register(flags: Flags = {}): Harness {
  const ipc = createIpcRegistrar();
  const deps = {
    getActiveCoachingPackSeeded: vi.fn(() => SAMPLE_PACK),
    coachingPacksDir: vi.fn(() => PACKS_DIR),
    installCoachingDistributionById: vi.fn(async () => ({ installed: true })),
  };
  registerCoachingIpcHandlers(ipc.registrar, {
    isTrustedSender: isTrustedSenderDouble,
    isAgentCoachingTipsEnabled: () => flags.tipsEnabled ?? true,
    isCoachingPacksEnabled: () => flags.packsEnabled ?? true,
    getActiveCoachingPackSeeded: deps.getActiveCoachingPackSeeded,
    coachingPacksDir: deps.coachingPacksDir,
    getCloudReadComputeTargetId: () =>
      flags.computeTargetId === undefined
        ? COMPUTE_TARGET_ID
        : flags.computeTargetId,
    installCoachingDistributionById: deps.installCoachingDistributionById,
    declineDistributionById: async () => undefined,
    recordDeclinedDistributionId: () => undefined,
    assertDistributionAssigned: async () => undefined,
    acknowledgeOptInHandled: async () => undefined,
  });
  return { ipc, deps };
}

describe("Generate handler result paths", () => {
  test("disabled tips never call the harness", async () => {
    const { ipc } = register({ tipsEnabled: false });

    await ipc.invoke(CoachingIpcChannel.Generate, TRUSTED_EVENT, "prompt");

    assert.equal(harnessMocks.generateCoachingTips.mock.calls.length, 0);
  });

  test("an ok result is returned unchanged and logs no warning", async () => {
    const result: CoachingHarnessResult = { ok: true, output: "[]" };
    harnessMocks.generateCoachingTips.mockResolvedValue(result);
    const { ipc } = register();

    const returned = await ipc.invoke(
      CoachingIpcChannel.Generate,
      TRUSTED_EVENT,
      "the prompt"
    );

    assert.equal(returned, result);
    assert.deepEqual(harnessMocks.generateCoachingTips.mock.calls, [
      ["the prompt"],
    ]);
    assert.equal(warnSpy.mock.calls.length, 0);
  });

  test("a failed result is returned unchanged and logged as a warning", async () => {
    const result: CoachingHarnessResult = {
      ok: false,
      reason: "timeout",
      message: "took too long",
    };
    harnessMocks.generateCoachingTips.mockResolvedValue(result);
    const { ipc } = register();

    const returned = await ipc.invoke(
      CoachingIpcChannel.Generate,
      TRUSTED_EVENT,
      "the prompt"
    );

    assert.equal(returned, result);
    assert.deepEqual(warnSpy.mock.calls, [
      [LOG_TAG, "generate failed (timeout): took too long"],
    ]);
  });

  test("an Error thrown by the harness becomes a spawn_failed result", async () => {
    harnessMocks.generateCoachingTips.mockRejectedValue(new Error("boom"));
    const { ipc } = register();

    const returned = await ipc.invoke(
      CoachingIpcChannel.Generate,
      TRUSTED_EVENT,
      "the prompt"
    );

    assert.deepEqual(returned, {
      ok: false,
      reason: "spawn_failed",
      message: "boom",
    });
    assert.deepEqual(errorSpy.mock.calls, [
      [LOG_TAG, "generate threw unexpectedly — boom"],
    ]);
  });

  test("a non-Error rejection is stringified into the message", async () => {
    harnessMocks.generateCoachingTips.mockRejectedValue("raw failure");
    const { ipc } = register();

    const returned = await ipc.invoke(
      CoachingIpcChannel.Generate,
      TRUSTED_EVENT,
      "the prompt"
    );

    assert.deepEqual(returned, {
      ok: false,
      reason: "spawn_failed",
      message: "raw failure",
    });
  });
});

describe("Install handler", () => {
  test("rejects an untrusted sender without calling the harness", async () => {
    const { ipc } = register();

    await assert.rejects(
      async () =>
        await ipc.invoke(CoachingIpcChannel.Install, UNTRUSTED_EVENT, "draft"),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(harnessMocks.installCoachingArtifact.mock.calls.length, 0);
  });

  test("disabled tips return a spawn_failed result without calling the harness", async () => {
    const { ipc } = register({ tipsEnabled: false });

    const returned = await ipc.invoke(
      CoachingIpcChannel.Install,
      TRUSTED_EVENT,
      "draft",
      "claude",
      "edit-existing"
    );

    assert.deepEqual(returned, {
      ok: false,
      reason: "spawn_failed",
      message: "Agent Coaching Tips is disabled.",
    });
    assert.equal(harnessMocks.installCoachingArtifact.mock.calls.length, 0);
  });

  test("forwards draft, harness and kind unchanged and returns the result", async () => {
    const result: CoachingHarnessResult = { ok: true, output: "installed" };
    harnessMocks.installCoachingArtifact.mockResolvedValue(result);
    const { ipc } = register();

    const returned = await ipc.invoke(
      CoachingIpcChannel.Install,
      TRUSTED_EVENT,
      "draft body",
      "codex",
      "edit-existing"
    );

    assert.equal(returned, result);
    assert.deepEqual(harnessMocks.installCoachingArtifact.mock.calls, [
      ["draft body", "codex", "edit-existing"],
    ]);
  });

  test("an Error thrown by the harness becomes a spawn_failed result", async () => {
    harnessMocks.installCoachingArtifact.mockRejectedValue(new Error("nope"));
    const { ipc } = register();

    const returned = await ipc.invoke(
      CoachingIpcChannel.Install,
      TRUSTED_EVENT,
      "draft"
    );

    assert.deepEqual(returned, {
      ok: false,
      reason: "spawn_failed",
      message: "nope",
    });
    assert.deepEqual(errorSpy.mock.calls, [
      [LOG_TAG, "install threw unexpectedly — nope"],
    ]);
  });

  test("a non-Error rejection is stringified into the message", async () => {
    harnessMocks.installCoachingArtifact.mockRejectedValue(42);
    const { ipc } = register();

    const returned = await ipc.invoke(
      CoachingIpcChannel.Install,
      TRUSTED_EVENT,
      "draft"
    );

    assert.deepEqual(returned, {
      ok: false,
      reason: "spawn_failed",
      message: "42",
    });
  });
});

describe("GetPack handler", () => {
  test("disabled packs return null without seeding", () => {
    const { ipc, deps } = register({ packsEnabled: false });

    assert.equal(ipc.invoke(CoachingIpcChannel.GetPack, TRUSTED_EVENT), null);
    assert.equal(deps.getActiveCoachingPackSeeded.mock.calls.length, 0);
  });

  test("enabled packs return the seeded active pack", () => {
    const { ipc } = register();

    assert.equal(
      ipc.invoke(CoachingIpcChannel.GetPack, TRUSTED_EVENT),
      SAMPLE_PACK
    );
  });

  // Pins current behavior; looks odd because GetPack is the only handler in
  // this module that does not assert sender trust.
  test("answers an untrusted sender with the seeded pack", () => {
    const { ipc } = register();

    assert.equal(
      ipc.invoke(CoachingIpcChannel.GetPack, UNTRUSTED_EVENT),
      SAMPLE_PACK
    );
  });
});

describe("InstallPack handler", () => {
  test("rejects an untrusted sender before any disk work", () => {
    const { ipc, deps } = register();

    assert.throws(
      () =>
        ipc.invoke(CoachingIpcChannel.InstallPack, UNTRUSTED_EVENT, "/pack"),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(packMocks.installCoachingPack.mock.calls.length, 0);
    assert.equal(deps.coachingPacksDir.mock.calls.length, 0);
  });

  test("disabled packs throw before the source path is validated", () => {
    const { ipc } = register({ packsEnabled: false });

    assert.throws(
      () => ipc.invoke(CoachingIpcChannel.InstallPack, TRUSTED_EVENT, ""),
      COACHING_PACKS_DISABLED
    );
    assert.equal(packMocks.installCoachingPack.mock.calls.length, 0);
  });

  test("a non-string source path throws", () => {
    const { ipc } = register();

    assert.throws(
      () => ipc.invoke(CoachingIpcChannel.InstallPack, TRUSTED_EVENT, 42),
      INSTALL_PACK_NEEDS_DIR
    );
    assert.equal(packMocks.installCoachingPack.mock.calls.length, 0);
  });

  test("an empty source path throws", () => {
    const { ipc } = register();

    assert.throws(
      () => ipc.invoke(CoachingIpcChannel.InstallPack, TRUSTED_EVENT, ""),
      INSTALL_PACK_NEEDS_DIR
    );
    assert.equal(packMocks.installCoachingPack.mock.calls.length, 0);
  });

  test("installs the source into the managed packs dir and returns the pack", () => {
    packMocks.installCoachingPack.mockReturnValue(SAMPLE_PACK);
    const { ipc } = register();

    const returned = ipc.invoke(
      CoachingIpcChannel.InstallPack,
      TRUSTED_EVENT,
      "/picked/pack"
    );

    assert.equal(returned, SAMPLE_PACK);
    assert.deepEqual(packMocks.installCoachingPack.mock.calls, [
      ["/picked/pack", PACKS_DIR],
    ]);
  });
});

describe("CoachingInstall handler", () => {
  test("rejects an untrusted sender without resolving the distribution", () => {
    const { ipc, deps } = register();

    assert.throws(
      () =>
        ipc.invoke(
          CoachingIpcChannel.CoachingInstall,
          UNTRUSTED_EVENT,
          DISTRIBUTION_ID
        ),
      UNTRUSTED_SENDER_ERROR
    );
    assert.equal(deps.installCoachingDistributionById.mock.calls.length, 0);
  });

  test("disabled packs throw before the distribution id is validated", () => {
    const { ipc } = register({ packsEnabled: false });

    assert.throws(
      () => ipc.invoke(CoachingIpcChannel.CoachingInstall, TRUSTED_EVENT, ""),
      COACHING_PACKS_DISABLED
    );
  });

  test("a non-string distribution id throws", () => {
    const { ipc } = register();

    assert.throws(
      () => ipc.invoke(CoachingIpcChannel.CoachingInstall, TRUSTED_EVENT, 7),
      COACHING_INSTALL_NEEDS_ID
    );
  });

  test("an empty distribution id throws", () => {
    const { ipc } = register();

    assert.throws(
      () => ipc.invoke(CoachingIpcChannel.CoachingInstall, TRUSTED_EVENT, ""),
      COACHING_INSTALL_NEEDS_ID
    );
  });

  test("a null or empty compute target id throws as not connected", () => {
    for (const computeTargetId of [null, ""]) {
      const { ipc, deps } = register({ computeTargetId });

      assert.throws(
        () =>
          ipc.invoke(
            CoachingIpcChannel.CoachingInstall,
            TRUSTED_EVENT,
            DISTRIBUTION_ID
          ),
        COACHING_INSTALL_NOT_CONNECTED
      );
      assert.equal(deps.installCoachingDistributionById.mock.calls.length, 0);
    }
  });

  test("delegates to installCoachingDistributionById when connected", async () => {
    const { ipc, deps } = register();

    const returned = await ipc.invoke(
      CoachingIpcChannel.CoachingInstall,
      TRUSTED_EVENT,
      DISTRIBUTION_ID
    );

    assert.deepEqual(returned, { installed: true });
    assert.deepEqual(deps.installCoachingDistributionById.mock.calls, [
      [COMPUTE_TARGET_ID, DISTRIBUTION_ID],
    ]);
  });
});
