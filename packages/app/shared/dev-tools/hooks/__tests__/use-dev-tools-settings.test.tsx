import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DevToolsSetting } from "../../lib/dev-tools-settings";
import { useDevToolsSettings } from "../use-dev-tools-settings";

const STORAGE_KEY = "test:dev-tools-settings";
const FIRST_CONTROL = "first-control";
const SECOND_CONTROL = "second-control";

afterEach(() => {
  cleanup();
  localStorage.removeItem(STORAGE_KEY);
});

function readStored(): unknown {
  const raw = localStorage.getItem(STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

describe("useDevToolsSettings", () => {
  it("persists an override per control in this browser", () => {
    const { result } = renderHook(() => useDevToolsSettings(STORAGE_KEY));

    act(() =>
      result.current.setSetting(FIRST_CONTROL, DevToolsSetting.Off, true)
    );
    act(() =>
      result.current.setSetting(SECOND_CONTROL, DevToolsSetting.On, false)
    );

    expect(readStored()).toEqual({
      [FIRST_CONTROL]: false,
      [SECOND_CONTROL]: true,
    });
    expect(result.current.settings).toEqual({
      [FIRST_CONTROL]: false,
      [SECOND_CONTROL]: true,
    });
  });

  it("clears one control by choosing its default, then all of them on reset", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [FIRST_CONTROL]: true, [SECOND_CONTROL]: false })
    );
    const { result } = renderHook(() => useDevToolsSettings(STORAGE_KEY));

    act(() =>
      result.current.setSetting(FIRST_CONTROL, DevToolsSetting.Off, false)
    );
    expect(readStored()).toEqual({ [SECOND_CONTROL]: false });

    act(() => result.current.resetAll());
    expect(readStored()).toEqual({});
    expect(result.current.settings).toEqual({});
  });

  it("reads malformed stored settings, such as a stored default, as no overrides", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [FIRST_CONTROL]: "default", [SECOND_CONTROL]: "on" })
    );

    const { result } = renderHook(() => useDevToolsSettings(STORAGE_KEY));

    expect(result.current.settings).toEqual({});
  });
});
