import { describe, expect, it } from "vitest";
import {
  partitionPendingCommandsForReconnect,
  type ReconnectPendingCommand,
} from "../desktop-gateway-reconnect";

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
