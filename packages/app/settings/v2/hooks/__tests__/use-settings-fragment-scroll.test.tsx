import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsPanelDataState } from "../../lib/settings-panel-data-state";
import {
  FRAGMENT_TARGET_WAIT_MS,
  useSettingsFragmentScroll,
} from "../use-settings-fragment-scroll";

const TARGET_ID = "anthropic-api-key";
const ROUTE_FRAGMENT = "/org/settings?panel=api-keys";

/**
 * A focusable target with its own `scrollIntoView` spy. jsdom does not
 * implement `scrollIntoView`, so the stub lives on the instance and leaves the
 * shared prototype untouched.
 */
function createTarget(id: string = TARGET_ID): {
  target: HTMLElement;
  scrollIntoView: ReturnType<typeof vi.fn>;
} {
  const target = document.createElement("div");
  target.id = id;
  target.tabIndex = -1;
  const scrollIntoView = vi.fn();
  target.scrollIntoView = scrollIntoView;
  return { scrollIntoView, target };
}

describe("useSettingsFragmentScroll", () => {
  const originalHref = globalThis.location.href;

  afterEach(() => {
    globalThis.history.replaceState(null, "", originalHref);
    document.getElementById(TARGET_ID)?.remove();
    document.getElementById(ROUTE_FRAGMENT)?.remove();
    for (const node of document.querySelectorAll(LOADING_SELECTOR)) {
      node.remove();
    }
  });

  it("scrolls to and focuses a fragment target that is already rendered", () => {
    globalThis.history.replaceState(null, "", `/settings#${TARGET_ID}`);
    const { target, scrollIntoView } = createTarget();
    document.body.append(target);

    renderHook(() => useSettingsFragmentScroll());

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(document.activeElement).toBe(target);
  });

  it("finds a fragment target that renders after mount", async () => {
    globalThis.history.replaceState(null, "", `/settings#${TARGET_ID}`);
    renderHook(() => useSettingsFragmentScroll());

    const { target, scrollIntoView } = createTarget();
    document.body.append(target);

    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" })
    );
    expect(document.activeElement).toBe(target);
  });

  it("ignores a route fragment even when an element carries that id", () => {
    // The desktop renderer keeps its route in the hash. An element whose id
    // matches it proves the hook skipped the fragment rather than missed it.
    globalThis.history.replaceState(null, "", `/settings#${ROUTE_FRAGMENT}`);
    const { target, scrollIntoView } = createTarget(ROUTE_FRAGMENT);
    document.body.append(target);

    renderHook(() => useSettingsFragmentScroll());

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(target);
  });

  it("waits for the last loading screen to leave before revealing the target", async () => {
    globalThis.history.replaceState(null, "", `/settings#${TARGET_ID}`);
    const loading = document.createElement("div");
    loading.dataset.settingsPanelDataState = SettingsPanelDataState.Loading;
    const { target, scrollIntoView } = createTarget();
    document.body.append(loading, target);

    renderHook(() => useSettingsFragmentScroll());
    expect(scrollIntoView).not.toHaveBeenCalled();

    loading.remove();

    await waitFor(() =>
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" })
    );
    expect(document.activeElement).toBe(target);
  });

  describe("at the wait deadline", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("reveals a rendered target anyway", () => {
      globalThis.history.replaceState(null, "", `/settings#${TARGET_ID}`);
      const loading = document.createElement("div");
      loading.dataset.settingsPanelDataState = SettingsPanelDataState.Loading;
      const { target, scrollIntoView } = createTarget();
      document.body.append(loading, target);

      renderHook(() => useSettingsFragmentScroll());
      vi.advanceTimersByTime(FRAGMENT_TARGET_WAIT_MS - 1);
      expect(scrollIntoView).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);

      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
      expect(document.activeElement).toBe(target);
    });
  });

  it("does nothing when the URL has no fragment", () => {
    const { target, scrollIntoView } = createTarget();
    document.body.append(target);

    renderHook(() => useSettingsFragmentScroll());

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(target);
  });
});

const LOADING_SELECTOR = `[data-settings-panel-data-state="${SettingsPanelDataState.Loading}"]`;
