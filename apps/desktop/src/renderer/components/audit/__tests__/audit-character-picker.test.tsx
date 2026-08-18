import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AUDIT_CHARACTER_ROSTER } from "../../../../shared/audit-character-roster.generated";
import { AuditCharacter } from "../../../../shared/audit-contract";
import { AuditCharacterPicker } from "../audit-character-picker";

// cmdk (via the design-system Command) needs a few DOM APIs jsdom lacks; stub +
// restore them so they don't leak into other tests in the shared jsdom worker.
const POLYFILLED_ELEMENT_METHODS = [
  "hasPointerCapture",
  "setPointerCapture",
  "releasePointerCapture",
  "scrollIntoView",
] as const;

class ResizeObserverStub {
  observe() {
    // no-op
  }
  unobserve() {
    // no-op
  }
  disconnect() {
    // no-op
  }
}

const originalElementMethods = new Map<
  string,
  PropertyDescriptor | undefined
>();
let originalResizeObserver: PropertyDescriptor | undefined;

beforeAll(() => {
  for (const method of POLYFILLED_ELEMENT_METHODS) {
    originalElementMethods.set(
      method,
      Object.getOwnPropertyDescriptor(Element.prototype, method)
    );
  }
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {
    // no-op in jsdom
  };
  Element.prototype.releasePointerCapture = () => {
    // no-op in jsdom
  };
  Element.prototype.scrollIntoView = () => {
    // no-op in jsdom
  };
  originalResizeObserver = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver"
  );
  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: ResizeObserverStub,
    writable: true,
  });
});

afterAll(() => {
  for (const method of POLYFILLED_ELEMENT_METHODS) {
    const original = originalElementMethods.get(method);
    if (original) {
      Object.defineProperty(Element.prototype, method, original);
    } else {
      Reflect.deleteProperty(Element.prototype, method);
    }
  }
  if (originalResizeObserver) {
    Object.defineProperty(globalThis, "ResizeObserver", originalResizeObserver);
  } else {
    Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});

/** A non-core roster entry, used to exercise the searchable-by-focus path. */
const NON_CORE = AUDIT_CHARACTER_ROSTER.find((entry) => entry.group !== "core");
/** The picker trigger's accessible name (field + current value). */
const REVIEW_CHARACTER_NAME = /Review character/;

describe("AuditCharacterPicker", () => {
  it("names the trigger with the field and the selected label", () => {
    render(
      <AuditCharacterPicker
        onChange={vi.fn()}
        value={AuditCharacter.DocsDarwin}
      />
    );
    // A <button> is not labeled by a sibling <label htmlFor>, so the trigger
    // must carry its own accessible name including the field.
    expect(
      screen.getByRole("combobox", { name: REVIEW_CHARACTER_NAME })
    ).toBeDefined();
  });

  it("surfaces an unavailable state instead of a blank trigger", () => {
    render(<AuditCharacterPicker onChange={vi.fn()} value="not-a-real-id" />);
    // A version-skewed / removed id must not render an empty field.
    expect(screen.getByText("Character unavailable")).toBeDefined();
  });

  it("filters the list by typed focus keywords, not just the name", async () => {
    expect(NON_CORE).toBeDefined();
    if (!NON_CORE) {
      return;
    }
    const onChange = vi.fn();
    render(
      <AuditCharacterPicker
        onChange={onChange}
        value={AuditCharacter.DocsDarwin}
      />
    );
    fireEvent.click(
      screen.getByRole("combobox", { name: REVIEW_CHARACTER_NAME })
    );
    const search = await screen.findByPlaceholderText(
      "Search by name or focus…"
    );
    // Type the character's label so cmdk narrows to it, then pick it.
    fireEvent.change(search, { target: { value: NON_CORE.label } });
    const listbox = await screen.findByRole("listbox");
    const option = within(listbox)
      .getAllByRole("option")
      .find((el) => el.textContent?.includes(NON_CORE.label));
    expect(option).toBeDefined();
    if (option) {
      fireEvent.click(option);
    }
    expect(onChange).toHaveBeenCalledWith(NON_CORE.id);
  });

  it("does not open the list while disabled", () => {
    render(
      <AuditCharacterPicker
        disabled
        onChange={vi.fn()}
        value={AuditCharacter.DocsDarwin}
      />
    );
    const trigger = screen.getByRole("combobox", {
      name: REVIEW_CHARACTER_NAME,
    });
    expect(trigger.hasAttribute("disabled")).toBe(true);
    fireEvent.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
