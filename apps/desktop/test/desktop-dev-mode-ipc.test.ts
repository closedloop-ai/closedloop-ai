import { describe, expect, it, vi } from "vitest";
import { registerDesktopDevModeIpcHandlers } from "../src/main/ipc/desktop-dev-mode-ipc.js";
import { DesktopDevModeIpcChannel } from "../src/shared/desktop-dev-mode-channel.js";

/**
 * ISS-12048: only the trusted renderer window may hand main Dev Tools overrides
 * or read main's checked keys. An untrusted sender is refused before the
 * payload is passed anywhere.
 */
type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const TRUSTED_EVENT = { sender: "trusted" };
const UNTRUSTED_EVENT = { sender: "evil" };
const OVERRIDES = { agentsNav: true };
const CHECKED_KEYS = ["agentsNav", "docsHelp"];

function register() {
  const handlers = new Map<string, IpcHandler>();
  const setOverrides = vi.fn();
  const readCheckedKeys = vi.fn(() => CHECKED_KEYS);
  registerDesktopDevModeIpcHandlers(
    {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    },
    {
      isTrustedSender: (sender) => sender === TRUSTED_EVENT.sender,
      setOverrides,
      readCheckedKeys,
    }
  );
  return { handlers, setOverrides, readCheckedKeys };
}

describe("Desktop Dev Mode IPC", () => {
  it("passes a trusted sender's overrides to main's validating store", () => {
    const { handlers, setOverrides } = register();

    const result = handlers.get(
      DesktopDevModeIpcChannel.SetFeatureFlagOverrides
    )?.(TRUSTED_EVENT, OVERRIDES);

    expect(result).toBe(true);
    expect(setOverrides).toHaveBeenCalledWith(OVERRIDES);
  });

  it("refuses an untrusted sender's overrides without reading them", () => {
    const { handlers, setOverrides } = register();

    const result = handlers.get(
      DesktopDevModeIpcChannel.SetFeatureFlagOverrides
    )?.(UNTRUSTED_EVENT, OVERRIDES);

    expect(result).toBe(false);
    expect(setOverrides).not.toHaveBeenCalled();
  });

  it("answers checked keys to the trusted sender only", () => {
    const { handlers, readCheckedKeys } = register();
    const get = handlers.get(DesktopDevModeIpcChannel.GetCheckedFeatureFlags);

    expect(get?.(UNTRUSTED_EVENT)).toEqual([]);
    expect(readCheckedKeys).not.toHaveBeenCalled();
    expect(get?.(TRUSTED_EVENT)).toEqual(CHECKED_KEYS);
  });
});
