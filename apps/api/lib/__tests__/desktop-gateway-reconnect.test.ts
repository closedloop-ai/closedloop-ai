import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitPendingCommandsForReconnect,
  partitionPendingCommandsForReconnect,
  type ReconnectPendingCommand,
  warnSkippedPendingCommands,
} from "../desktop-gateway-reconnect";

vi.mock("@repo/observability/log", () => ({ log: { warn: vi.fn() } }));

const SKIP_WARNING =
  "Pending command has non-gateway path — possible legacy command in store";

const makeCommand = (
  overrides: Partial<ReconnectPendingCommand> = {}
): ReconnectPendingCommand => ({
  commandId: "cmd-1",
  computeTargetId: "target-1",
  path: "/api/gateway/health-check",
  ...overrides,
});

describe("partitionPendingCommandsForReconnect", () => {
  it("emits only commands whose path passes isDesktopApiPath", () => {
    const gatewayCommand = makeCommand({
      commandId: "cmd-gateway",
      path: "/api/gateway/symphony/loop",
    });
    const legacyCommand = makeCommand({
      commandId: "cmd-legacy",
      path: "/api/engineer/symphony/loop",
    });
    const unrelatedCommand = makeCommand({
      commandId: "cmd-unrelated",
      path: "/some/other/path",
    });

    const { emit, skipped } = partitionPendingCommandsForReconnect([
      gatewayCommand,
      legacyCommand,
      unrelatedCommand,
    ]);

    expect(emit).toEqual([gatewayCommand]);
    expect(skipped).toEqual([legacyCommand, unrelatedCommand]);
  });

  it("returns empty groups for an empty input", () => {
    expect(partitionPendingCommandsForReconnect([])).toEqual({
      emit: [],
      skipped: [],
    });
  });

  it("skips a persisted command whose request path is not a string", () => {
    const corruptCommand = makeCommand({
      commandId: "cmd-corrupt",
      path: null as never,
    });

    expect(partitionPendingCommandsForReconnect([corruptCommand])).toEqual({
      emit: [],
      skipped: [corruptCommand],
    });
  });

  it("preserves input order within each group", () => {
    const a = makeCommand({ commandId: "a", path: "/api/gateway/a" });
    const b = makeCommand({ commandId: "b", path: "/api/engineer/b" });
    const c = makeCommand({ commandId: "c", path: "/api/gateway/c" });
    const d = makeCommand({ commandId: "d", path: "/api/engineer/d" });

    const { emit, skipped } = partitionPendingCommandsForReconnect([
      a,
      b,
      c,
      d,
    ]);

    expect(emit.map((cmd) => cmd.commandId)).toEqual(["a", "c"]);
    expect(skipped.map((cmd) => cmd.commandId)).toEqual(["b", "d"]);
  });
});

describe("warnSkippedPendingCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports every skipped command with the id, target, and path", () => {
    warnSkippedPendingCommands([
      makeCommand({ commandId: "cmd-legacy", path: "/api/engineer/loop" }),
      makeCommand({ commandId: "cmd-corrupt", path: null as never }),
    ]);

    expect(vi.mocked(log.warn).mock.calls).toEqual([
      [
        SKIP_WARNING,
        {
          commandId: "cmd-legacy",
          computeTargetId: "target-1",
          path: "/api/engineer/loop",
        },
      ],
      [
        SKIP_WARNING,
        {
          commandId: "cmd-corrupt",
          computeTargetId: "target-1",
          path: null,
        },
      ],
    ]);
  });

  it("stays silent when nothing was skipped", () => {
    warnSkippedPendingCommands([]);

    expect(log.warn).not.toHaveBeenCalled();
  });
});

describe("emitPendingCommandsForReconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The direct lane routes its warning through the same emitter the relay lane
  // now calls, so the two cannot report a skipped row differently again.
  it("warns for the skipped command and emits only the gateway one", () => {
    const gateway = makeCommand({
      commandId: "cmd-gateway",
      path: "/api/gateway/loop",
    });
    const legacy = makeCommand({
      commandId: "cmd-legacy",
      path: "/api/engineer/loop",
    });
    const emitted: ReconnectPendingCommand[] = [];

    emitPendingCommandsForReconnect([gateway, legacy], (command) => {
      emitted.push(command);
    });

    expect(emitted).toEqual([gateway]);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(SKIP_WARNING, {
      commandId: "cmd-legacy",
      computeTargetId: "target-1",
      path: "/api/engineer/loop",
    });
  });
});
