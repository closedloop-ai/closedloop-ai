import { describe, expect, it } from "vitest";
import {
  describeUndoShortcut,
  matchUndoShortcut,
  resolveShortcutPlatform,
  ShortcutPlatform,
  UndoShortcutAction,
  type UndoShortcutEvent,
} from "../undo-keybinding";

/**
 * ISS-9092: the canonical undo/redo chord resolver.
 *
 * The contract under test is that the binding DIFFERS by platform. The
 * `(metaKey || ctrlKey)` shape used for the symmetric Cmd/Ctrl+K palette chord
 * would pass a naive "does Cmd+Z undo" test while still firing redo for
 * `Ctrl+Shift+Z` on macOS and `Cmd+Y` on Windows, so every case below that
 * matters is a NEGATIVE on the opposite platform's chord.
 */

function event(overrides: Partial<UndoShortcutEvent>): UndoShortcutEvent {
  return {
    key: "z",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("resolveShortcutPlatform", () => {
  it.each([
    ["MacIntel", ShortcutPlatform.Mac],
    ["macOS", ShortcutPlatform.Mac],
    ["darwin", ShortcutPlatform.Mac],
    ["iPhone", ShortcutPlatform.Mac],
    ["iPad", ShortcutPlatform.Mac],
    ["Win32", ShortcutPlatform.Other],
    ["Linux x86_64", ShortcutPlatform.Other],
  ])("resolves %s to %s", (hint, expected) => {
    expect(resolveShortcutPlatform(hint)).toBe(expected);
  });

  /*
   * An absent or unrecognised hint must resolve to the Ctrl-based table, not the
   * Cmd one. Getting this wrong on a Mac costs a shortcut that does nothing;
   * getting it wrong the other way would have us swallow a keystroke the
   * platform owns.
   */
  it.each([undefined, null, "", "SomethingNobodyShipped"])(
    "falls back to the Ctrl table for %s",
    (hint) => {
      expect(resolveShortcutPlatform(hint)).toBe(ShortcutPlatform.Other);
    }
  );
});

describe("matchUndoShortcut on macOS", () => {
  const platform = ShortcutPlatform.Mac;

  it("Cmd+Z is undo", () => {
    expect(matchUndoShortcut(event({ metaKey: true }), platform)).toBe(
      UndoShortcutAction.Undo
    );
  });

  it("Cmd+Shift+Z is redo", () => {
    expect(
      matchUndoShortcut(event({ metaKey: true, shiftKey: true }), platform)
    ).toBe(UndoShortcutAction.Redo);
  });

  /*
   * The ruling the ticket says must not be re-opened: Cmd+Y was requested, then
   * withdrawn the same day because browser chrome takes it. A resolver that
   * bound it anyway would still pass every other case in this file.
   */
  it("Cmd+Y is NOT bound — browser chrome owns it", () => {
    expect(
      matchUndoShortcut(event({ key: "y", metaKey: true }), platform)
    ).toBeNull();
  });

  /* The Windows chord must not fire here, or the two tables have collapsed. */
  it.each([
    ["Ctrl+Z", { ctrlKey: true }],
    ["Ctrl+Shift+Z", { ctrlKey: true, shiftKey: true }],
    ["Ctrl+Y", { key: "y", ctrlKey: true }],
  ])("%s does nothing on macOS", (_label, overrides) => {
    expect(matchUndoShortcut(event(overrides), platform)).toBeNull();
  });

  it("Cmd+Ctrl+Z is refused — a chord the OS may own elsewhere", () => {
    expect(
      matchUndoShortcut(event({ metaKey: true, ctrlKey: true }), platform)
    ).toBeNull();
  });

  it("Alt disqualifies the chord", () => {
    expect(
      matchUndoShortcut(event({ metaKey: true, altKey: true }), platform)
    ).toBeNull();
  });

  it("a bare Z asks for nothing", () => {
    expect(matchUndoShortcut(event({}), platform)).toBeNull();
  });
});

describe("matchUndoShortcut on Windows/Linux", () => {
  const platform = ShortcutPlatform.Other;

  it("Ctrl+Z is undo", () => {
    expect(matchUndoShortcut(event({ ctrlKey: true }), platform)).toBe(
      UndoShortcutAction.Undo
    );
  });

  /*
   * BOTH redo chords, deliberately. Real apps on these platforms accept either,
   * and a table that bound only one would pass a single-chord test while
   * leaving half of Windows users' fingers unanswered.
   */
  it.each([
    ["Ctrl+Y", { key: "y", ctrlKey: true }],
    ["Ctrl+Shift+Z", { ctrlKey: true, shiftKey: true }],
  ])("%s is redo", (_label, overrides) => {
    expect(matchUndoShortcut(event(overrides), platform)).toBe(
      UndoShortcutAction.Redo
    );
  });

  it.each([
    ["Cmd+Z", { metaKey: true }],
    ["Cmd+Shift+Z", { metaKey: true, shiftKey: true }],
  ])("%s does nothing off macOS", (_label, overrides) => {
    expect(matchUndoShortcut(event(overrides), platform)).toBeNull();
  });
});

describe("matchUndoShortcut is case-insensitive on the key", () => {
  /*
   * A shifted chord reports an UPPERCASE `key` in every browser, so a matcher
   * comparing raw `event.key` to "z" would never fire redo at all.
   */
  it("matches the uppercase key a shifted chord reports", () => {
    expect(
      matchUndoShortcut(
        event({ key: "Z", metaKey: true, shiftKey: true }),
        ShortcutPlatform.Mac
      )
    ).toBe(UndoShortcutAction.Redo);
  });
});

describe("matchUndoShortcut with an unusable key on the event (ISS-7493)", () => {
  /*
   * `UndoShortcutEvent.key` is typed `string`, and a real keystroke honours
   * that — but this matcher is reached from a `document` keydown listener,
   * where a synthetic event (password managers, some extensions) can carry no
   * `key` at all, or a non-string one. Production RUM caught the unguarded form
   * of exactly this shape throwing `Cannot read properties of undefined
   * (reading 'toLowerCase')` from the sibling command-palette listener.
   *
   * Nullish is only the half optional chaining would have covered; the
   * non-string rows are the other half (whitlockk review, PR #7424). Both reach the
   * same `.toLowerCase()` and both throw without the guard.
   *
   * The cast is the point rather than a convenience: the type FORBIDS these
   * inputs and the runtime delivers them anyway, which is the trust-boundary
   * carve-out AGENTS.md names. Without it the test cannot express the case.
   */
  const withKey = (
    key: unknown,
    overrides: Partial<UndoShortcutEvent>
  ): UndoShortcutEvent =>
    ({ ...event(overrides), key }) as unknown as UndoShortcutEvent;

  const unusableKeys: ReadonlyArray<readonly [string, unknown]> = [
    ["absent", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", {}],
  ];

  it.each(unusableKeys)(
    "asks for nothing instead of throwing on the undo chord, with %s key",
    (_label, key) => {
      const keyless = withKey(key, { metaKey: true });
      expect(() =>
        matchUndoShortcut(keyless, ShortcutPlatform.Mac)
      ).not.toThrow();
      expect(matchUndoShortcut(keyless, ShortcutPlatform.Mac)).toBeNull();
    }
  );

  it.each(unusableKeys)(
    "asks for nothing on the redo chord too, with %s key",
    (_label, key) => {
      const keyless = withKey(key, { ctrlKey: true, shiftKey: true });
      expect(() =>
        matchUndoShortcut(keyless, ShortcutPlatform.Other)
      ).not.toThrow();
      expect(matchUndoShortcut(keyless, ShortcutPlatform.Other)).toBeNull();
    }
  );
});

describe("describeUndoShortcut", () => {
  /*
   * The hint a discoverability affordance prints. Derived from the same table
   * the matcher reads, so ISS-9093 cannot render a chord that does not fire.
   */
  it.each([
    [ShortcutPlatform.Mac, UndoShortcutAction.Undo, "⌘Z"],
    [ShortcutPlatform.Mac, UndoShortcutAction.Redo, "⌘⇧Z"],
    [ShortcutPlatform.Other, UndoShortcutAction.Undo, "Ctrl+Z"],
    [ShortcutPlatform.Other, UndoShortcutAction.Redo, "Ctrl+Y"],
  ])("renders %s %s as %s", (platform, action, expected) => {
    expect(describeUndoShortcut(platform, action)).toBe(expected);
  });
});
