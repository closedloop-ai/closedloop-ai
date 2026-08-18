import { AuditScope } from "@repo/crewd/model";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AUDIT_CHARACTER_ROSTER } from "../../../../shared/audit-character-roster.generated";
import {
  AUDIT_CHARACTER_META,
  AUDIT_SCOPE_META,
  AuditCharacter,
  characterMetaFor,
  DEFAULT_AUDIT_CASCADE,
} from "../../../../shared/audit-contract";
import { AuditRunControls } from "../audit-run-controls";

// Radix Select and the cmdk-based character picker rely on a few DOM APIs jsdom
// does not implement. Polyfill them so the popovers open and options are
// clickable in the test environment.
const POLYFILLED_ELEMENT_METHODS = [
  "hasPointerCapture",
  "setPointerCapture",
  "releasePointerCapture",
  "scrollIntoView",
] as const;

// cmdk (via the design-system Command) observes list size with ResizeObserver,
// which jsdom lacks. Stub + restore it so it doesn't leak into other tests in
// the shared jsdom worker (AGENTS.md: restore the original global descriptor).
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

// Capture the originals so the polyfills below do not leak into later renderer
// tests sharing this jsdom Element.prototype.
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

/** The in-flight Run button's accessible name while a run is active. */
const RUNNING_BUTTON_NAME = /Running/;
/** The character picker trigger's accessible name (field + current value). */
const REVIEW_CHARACTER_NAME = /Review character/;

function renderControls(
  overrides: Partial<Parameters<typeof AuditRunControls>[0]> = {}
) {
  const onCharacterChange = vi.fn();
  const onScopeChange = vi.fn();
  const onCascadeChange = vi.fn();
  const onPick = vi.fn();
  const onRun = vi.fn();
  render(
    <AuditRunControls
      cascade={[...DEFAULT_AUDIT_CASCADE]}
      character={AuditCharacter.DocsDarwin}
      onCascadeChange={onCascadeChange}
      onCharacterChange={onCharacterChange}
      onPick={onPick}
      onRun={onRun}
      onScopeChange={onScopeChange}
      repoDir={null}
      repoWarning={null}
      running={false}
      scope={AuditScope.WholeRepo}
      {...overrides}
    />
  );
  return { onCharacterChange, onScopeChange, onCascadeChange, onPick, onRun };
}

describe("AuditRunControls", () => {
  it("shows the selected character and scope labels", () => {
    renderControls();
    expect(
      screen.getByText(AUDIT_CHARACTER_META[AuditCharacter.DocsDarwin].label)
    ).toBeDefined();
    expect(
      screen.getByText(AUDIT_SCOPE_META[AuditScope.WholeRepo].label)
    ).toBeDefined();
    // Both pickers expose an accessible name via their <Label htmlFor>.
    expect(
      screen.getByRole("combobox", { name: REVIEW_CHARACTER_NAME })
    ).toBeDefined();
    expect(screen.getByRole("combobox", { name: "Scope" })).toBeDefined();
  });

  it("forwards the picked character to onCharacterChange", async () => {
    const { onCharacterChange } = renderControls();
    fireEvent.click(
      screen.getByRole("combobox", { name: REVIEW_CHARACTER_NAME })
    );
    const listbox = await screen.findByRole("listbox");
    fireEvent.click(
      within(listbox).getByText(
        AUDIT_CHARACTER_META[AuditCharacter.SecuritySentinel].label
      )
    );
    expect(onCharacterChange).toHaveBeenCalledWith(
      AuditCharacter.SecuritySentinel
    );
  });

  it("forwards the picked scope preset to onScopeChange", async () => {
    const { onScopeChange } = renderControls();
    fireEvent.click(screen.getByRole("combobox", { name: "Scope" }));
    const listbox = await screen.findByRole("listbox");
    fireEvent.click(
      within(listbox).getByText(
        AUDIT_SCOPE_META[AuditScope.ChangedSinceMain].label
      )
    );
    expect(onScopeChange).toHaveBeenCalledWith(AuditScope.ChangedSinceMain);
  });

  it("lists every character in the shipped cast, not just the core subset", async () => {
    renderControls();
    fireEvent.click(
      screen.getByRole("combobox", { name: REVIEW_CHARACTER_NAME })
    );
    const listbox = await screen.findByRole("listbox");
    // Every roster entry must be a selectable option — a regression to a partial
    // list would drop options and fail this. cmdk's option accessible name is the
    // full item text (label + description), so match on the label appearing in an
    // option rather than an exact-name lookup.
    for (const entry of AUDIT_CHARACTER_ROSTER) {
      const option = within(listbox)
        .getAllByRole("option")
        .find((el) => el.textContent?.includes(entry.label));
      expect(option).toBeDefined();
    }
    // And the cast is genuinely more than the legacy 4-member picker.
    expect(AUDIT_CHARACTER_ROSTER.length).toBeGreaterThan(4);
  });

  it("forwards a newly-surfaced (non-core) character on selection", async () => {
    const nightly = AUDIT_CHARACTER_ROSTER.find(
      (entry) => entry.group !== "core"
    );
    expect(nightly).toBeDefined();
    if (!nightly) {
      return;
    }
    const { onCharacterChange } = renderControls();
    fireEvent.click(
      screen.getByRole("combobox", { name: REVIEW_CHARACTER_NAME })
    );
    const listbox = await screen.findByRole("listbox");
    const option = within(listbox)
      .getAllByRole("option")
      .find((el) => el.textContent?.includes(nightly.label));
    expect(option).toBeDefined();
    if (option) {
      fireEvent.click(option);
    }
    // The picker must pass the character's roster id (folder-relative path) so
    // the runner can resolve its `<id>.md` prompt.
    expect(onCharacterChange).toHaveBeenCalledWith(nightly.id);
    expect(characterMetaFor(nightly.id)).not.toBeNull();
  });

  it("disables the pickers and Run while a run is in flight", () => {
    renderControls({ running: true, repoDir: "/repos/demo" });
    expect(
      screen
        .getByRole("combobox", { name: REVIEW_CHARACTER_NAME })
        .hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen.getByRole("combobox", { name: "Scope" }).hasAttribute("disabled")
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: RUNNING_BUTTON_NAME })
        .hasAttribute("disabled")
    ).toBe(true);
  });
});
