import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsDismissMode } from "../../components/settings-dismissal";
import { useSettingsFocusRestoration } from "../use-settings-focus-restoration";

/**
 * ISS-8978 — the restore handler's decision, exercised directly.
 *
 * Driven through the returned handler rather than through a rendered dialog on a
 * timer: Radix fires this on a macrotask after unmount, so a test that waits for
 * the steal to "not happen" passes whether or not the guard exists. Calling the
 * handler with a real cancelable event makes both halves of the branch — whether
 * Radix's own handling is cancelled, and where focus lands — observable and
 * deterministic.
 */

function closeAutoFocusEvent(): Event {
  return new Event("dialog.closeAutoFocus", { cancelable: true });
}

let invoker: HTMLButtonElement | null = null;

function mountInvoker(): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = "Open settings";
  document.body.append(button);
  button.focus();
  invoker = button;
  return button;
}

afterEach(() => {
  invoker?.remove();
  invoker = null;
});

describe("useSettingsFocusRestoration (ISS-8978)", () => {
  it("cancels Radix's handling and restores the invoker in overlay mode", () => {
    const trigger = mountInvoker();
    const { result } = renderHook(() =>
      useSettingsFocusRestoration(SettingsDismissMode.Overlay)
    );

    // Focus has moved into the dialog by the time the handler runs.
    document.body.focus();
    const event = closeAutoFocusEvent();
    result.current(event);

    // Radix's own close-auto-focus would focus a `DialogTrigger` that does not
    // exist here, so it has to be cancelled for the restore to survive.
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(trigger);
  });

  it("leaves Radix's handling and the destination's focus alone in cold mode", () => {
    mountInvoker();
    const { result } = renderHook(() =>
      useSettingsFocusRestoration(SettingsDismissMode.Cold)
    );

    // A cold dismiss navigates, so by now this is the DESTINATION's focus.
    const destination = document.createElement("button");
    document.body.append(destination);
    destination.focus();

    const event = closeAutoFocusEvent();
    result.current(event);

    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(destination);
    destination.remove();
  });
});
