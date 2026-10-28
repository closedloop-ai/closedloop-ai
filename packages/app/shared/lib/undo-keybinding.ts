/**
 * The canonical undo/redo shortcut resolver (ISS-9092).
 *
 * ONE MODULE, EVERY SURFACE. Undo/redo is the first shortcut in this repo whose
 * binding genuinely DIFFERS by platform, so the `(event.metaKey ||
 * event.ctrlKey)` shape the command palette uses for the SYMMETRIC Cmd/Ctrl+K
 * chord is wrong here: it would fire redo for `Ctrl+Shift+Z` on macOS and for
 * `Cmd+Y` on Windows. Every surface imports these helpers rather than
 * re-declaring the check.
 *
 * MATCH THE HOST PLATFORM, DO NOT INVENT A PAIR (operator direction,
 * 2026-09-03). A user should never have to learn OUR shortcut; the one already
 * in their fingers must work:
 *   - macOS: undo `Cmd+Z`, redo `Cmd+Shift+Z`.
 *   - Windows / Linux: undo `Ctrl+Z`, redo `Ctrl+Y` AND `Ctrl+Shift+Z` — both
 *     are conventional there and real apps accept either. Accepting both is
 *     matching the system, not scope creep.
 *
 * `Cmd+Y` is deliberately NOT bound on macOS. It was requested, then withdrawn
 * the same day: browser chrome takes it (History in Safari and Firefox) and a
 * page cannot reliably win that. Do not re-open it.
 *
 * Pure and SSR-safe: nothing here reads `navigator`, `window`, or `document`.
 * The platform arrives as a value, resolved once by the caller at runtime.
 */

import { normalizedEventKey } from "@repo/design-system/lib/keyboard-event-key";

/**
 * The platform families whose undo/redo conventions actually differ.
 *
 * TWO members, not three, and that is the honest count: Windows and Linux share
 * one binding table exactly, so a third member would be a distinction with no
 * behaviour behind it. Every table below is an exhaustive `Record` over this
 * set, so adding a member fails `tsc` until it declares its own bindings.
 */
export const ShortcutPlatform = {
  Mac: "mac",
  Other: "other",
} as const;
export type ShortcutPlatform =
  (typeof ShortcutPlatform)[keyof typeof ShortcutPlatform];

/** What a matched chord asks the stack to do. */
export const UndoShortcutAction = {
  Undo: "undo",
  Redo: "redo",
} as const;
export type UndoShortcutAction =
  (typeof UndoShortcutAction)[keyof typeof UndoShortcutAction];

/**
 * One chord, as data rather than a predicate.
 *
 * `primary` is the platform's own command modifier — Cmd on macOS, Ctrl
 * elsewhere — so a chord never names `metaKey` or `ctrlKey` directly and cannot
 * be copied onto the wrong platform by accident. Both modifier fields are
 * REQUIRED so a chord that must not be shifted says so, rather than leaving the
 * matcher to guess from an absent key.
 */
export type UndoChord = {
  readonly key: string;
  readonly shift: boolean;
};

type PlatformUndoBindings = {
  readonly undo: readonly UndoChord[];
  readonly redo: readonly UndoChord[];
};

/**
 * The binding table. `satisfies` rather than an annotation so a missing
 * platform is a `tsc` error here, at the declaration, instead of an
 * `undefined` at the match site that would read as "this platform has no undo".
 */
export const UNDO_SHORTCUT_BINDINGS = {
  [ShortcutPlatform.Mac]: {
    undo: [{ key: "z", shift: false }],
    redo: [{ key: "z", shift: true }],
  },
  [ShortcutPlatform.Other]: {
    undo: [{ key: "z", shift: false }],
    // Both, deliberately. Windows/Linux users reach for either.
    redo: [
      { key: "y", shift: false },
      { key: "z", shift: true },
    ],
  },
} as const satisfies Readonly<Record<ShortcutPlatform, PlatformUndoBindings>>;

/**
 * The subset of a `KeyboardEvent` a chord is matched against. Narrowed to the
 * fields that decide the answer so a test drives the real matcher with a plain
 * object rather than a synthesized DOM event.
 */
export type UndoShortcutEvent = {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly repeat?: boolean;
};

/**
 * Which platform family a runtime platform string belongs to.
 *
 * Takes the hint as a value — `navigator.userAgentData?.platform`,
 * `navigator.platform`, or `process.platform` — because this module is imported
 * by SSR-capable shared code and must not touch a browser global at import
 * time. An unrecognised or absent hint resolves to {@link
 * ShortcutPlatform.Other}, which is the Ctrl-based table: getting this wrong on
 * a Mac costs a user a shortcut that does nothing, while getting it wrong the
 * other way would have us swallow a keystroke the platform owns.
 */
export function resolveShortcutPlatform(
  platformHint: string | undefined | null
): ShortcutPlatform {
  if (!platformHint) {
    return ShortcutPlatform.Other;
  }
  const normalized = platformHint.toLowerCase();
  const isMac =
    normalized.includes("mac") ||
    normalized.includes("iphone") ||
    normalized.includes("ipad") ||
    normalized === "darwin";
  return isMac ? ShortcutPlatform.Mac : ShortcutPlatform.Other;
}

/** Is the platform's own command modifier — and only it — held? */
function hasPrimaryModifierOnly(
  event: UndoShortcutEvent,
  platform: ShortcutPlatform
): boolean {
  // The non-primary modifier must be ABSENT, not merely unchecked. Accepting
  // `Cmd+Ctrl+Z` would let a chord the OS may have bound elsewhere reach us,
  // and accepting `Ctrl+Z` on macOS would claim a chord macOS does not use for
  // undo at all.
  if (platform === ShortcutPlatform.Mac) {
    return event.metaKey && !event.ctrlKey;
  }
  return event.ctrlKey && !event.metaKey;
}

function matchesChord(event: UndoShortcutEvent, chord: UndoChord): boolean {
  // ISS-7493: `key` is typed `string` and this matcher is reached from a
  // `document` keydown listener, where that type constrains nothing — see
  // `normalizedEventKey`. No usable key matches no chord, which is the correct
  // answer for a shortcut matcher.
  return (
    normalizedEventKey(event) === chord.key && event.shiftKey === chord.shift
  );
}

/**
 * The action this keystroke asks for, or `null` when it asks for nothing.
 *
 * Alt/Option disqualifies every chord: `Alt+Cmd+Z` is not undo on any of these
 * platforms, and quietly treating it as undo would steal a chord an OS or an
 * extension may own.
 */
export function matchUndoShortcut(
  event: UndoShortcutEvent,
  platform: ShortcutPlatform
): UndoShortcutAction | null {
  if (event.altKey || !hasPrimaryModifierOnly(event, platform)) {
    return null;
  }
  const bindings = UNDO_SHORTCUT_BINDINGS[platform];
  if (bindings.undo.some((chord) => matchesChord(event, chord))) {
    return UndoShortcutAction.Undo;
  }
  if (bindings.redo.some((chord) => matchesChord(event, chord))) {
    return UndoShortcutAction.Redo;
  }
  return null;
}

const PRIMARY_MODIFIER_LABEL = {
  [ShortcutPlatform.Mac]: "⌘",
  [ShortcutPlatform.Other]: "Ctrl+",
} as const satisfies Readonly<Record<ShortcutPlatform, string>>;

const SHIFT_LABEL = {
  [ShortcutPlatform.Mac]: "⇧",
  [ShortcutPlatform.Other]: "Shift+",
} as const satisfies Readonly<Record<ShortcutPlatform, string>>;

/**
 * The shortcut as a human reads it, for a discoverability affordance — a menu
 * row, a command-palette hint, shortcut help. Derived from the SAME table the
 * matcher reads, so a printed hint cannot drift from the chord that actually
 * fires.
 *
 * Names the FIRST chord only. Windows redo answers to two, and a hint that
 * lists both teaches nothing extra while making the row twice as wide.
 */
export function describeUndoShortcut(
  platform: ShortcutPlatform,
  action: UndoShortcutAction
): string {
  const bindings = UNDO_SHORTCUT_BINDINGS[platform];
  const [chord] =
    action === UndoShortcutAction.Undo ? bindings.undo : bindings.redo;
  const shift = chord.shift ? SHIFT_LABEL[platform] : "";
  return `${PRIMARY_MODIFIER_LABEL[platform]}${shift}${chord.key.toUpperCase()}`;
}
