import { act, renderHook } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import { describe, expect, test, vi } from "vitest";
import { type SlashCommand, useSlashCommands } from "../use-slash-commands";

const COMMANDS: SlashCommand[] = [
  { command: "/deploy", description: "Deploy the app" },
  { command: "/debug", description: "Debug mode" },
  { command: "/diagnose", description: "Diagnose issues" },
];

/** Builds a minimal fake React keyboard event for handleKeyDown. */
function makeKeyEvent(key: string): KeyboardEvent {
  return { key, preventDefault: vi.fn() } as unknown as KeyboardEvent;
}

describe("useSlashCommands", () => {
  describe("detectSlash", () => {
    test("opens the menu with the typed query and filters matching commands", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/de", 3);
      });

      expect(result.current.slashState).toEqual({
        isOpen: true,
        query: "de",
        selectedIndex: 0,
      });
      // "de" matches deploy and debug but not diagnose — proves the filter
      // actually narrows the list rather than passing every command through.
      expect(result.current.filteredCommands).toEqual([
        COMMANDS[0],
        COMMANDS[1],
      ]);
    });

    test("filters case-insensitively", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/DEB", 4);
      });

      expect(result.current.filteredCommands).toEqual([COMMANDS[1]]);
    });

    test("closes the menu when the text before the cursor has no leading slash", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/de", 3);
      });
      expect(result.current.slashState?.isOpen).toBe(true);

      act(() => {
        result.current.detectSlash("hello world", 11);
      });

      expect(result.current.slashState).toBeNull();
      expect(result.current.filteredCommands).toEqual([]);
    });

    test("closes the menu once the slash command is followed by whitespace", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/deploy now", 11);
      });

      expect(result.current.slashState).toBeNull();
    });

    test("re-filtering resets selectedIndex back to 0", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/d", 2);
      });
      act(() => {
        result.current.handleKeyDown(makeKeyEvent("ArrowDown"));
      });
      expect(result.current.slashState?.selectedIndex).toBe(1);

      act(() => {
        result.current.detectSlash("/de", 3);
      });

      expect(result.current.slashState?.selectedIndex).toBe(0);
    });
  });

  describe("handleKeyDown", () => {
    test("returns false and leaves the event unhandled when the menu is closed", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      const event = makeKeyEvent("ArrowDown");
      let handled: boolean | undefined;
      act(() => {
        handled = result.current.handleKeyDown(event);
      });

      expect(handled).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    test("returns false when the menu is open but no command matches the query", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/zzz", 4);
      });
      expect(result.current.slashState?.isOpen).toBe(true);
      expect(result.current.filteredCommands).toEqual([]);

      let handled: boolean | undefined;
      act(() => {
        handled = result.current.handleKeyDown(makeKeyEvent("ArrowDown"));
      });

      expect(handled).toBe(false);
    });

    test("ArrowDown advances selectedIndex and clamps at the last filtered index", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/d", 2);
      });
      expect(result.current.filteredCommands).toHaveLength(3);

      act(() => {
        result.current.handleKeyDown(makeKeyEvent("ArrowDown"));
      });
      expect(result.current.slashState?.selectedIndex).toBe(1);

      // Two more ArrowDowns would overshoot past the last index (2) — the
      // clamp must stop it there rather than letting it run off the array.
      act(() => {
        result.current.handleKeyDown(makeKeyEvent("ArrowDown"));
      });
      act(() => {
        result.current.handleKeyDown(makeKeyEvent("ArrowDown"));
      });

      expect(result.current.slashState?.selectedIndex).toBe(2);
    });

    test("ArrowDown calls preventDefault and reports the key as handled", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/d", 2);
      });

      const event = makeKeyEvent("ArrowDown");
      let handled: boolean | undefined;
      act(() => {
        handled = result.current.handleKeyDown(event);
      });

      expect(handled).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
    });

    test("ArrowUp moves the selection back and clamps at 0", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/d", 2);
      });
      act(() => {
        result.current.handleKeyDown(makeKeyEvent("ArrowDown"));
      });
      expect(result.current.slashState?.selectedIndex).toBe(1);

      act(() => {
        result.current.handleKeyDown(makeKeyEvent("ArrowUp"));
      });
      expect(result.current.slashState?.selectedIndex).toBe(0);

      // Already at 0 — pressing ArrowUp again must not go negative.
      act(() => {
        result.current.handleKeyDown(makeKeyEvent("ArrowUp"));
      });
      expect(result.current.slashState?.selectedIndex).toBe(0);
    });

    test("Enter selects the currently highlighted command, not the first one", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/d", 2);
      });
      act(() => {
        result.current.handleKeyDown(makeKeyEvent("ArrowDown"));
      });
      act(() => {
        result.current.handleKeyDown(makeKeyEvent("ArrowDown"));
      });
      expect(result.current.slashState?.selectedIndex).toBe(2);

      act(() => {
        result.current.handleKeyDown(makeKeyEvent("Enter"));
      });

      expect(onSelect).toHaveBeenCalledExactlyOnceWith(COMMANDS[2].command);
      expect(onSelect).not.toHaveBeenCalledWith(COMMANDS[0].command);
      expect(result.current.slashState).toBeNull();
    });

    test("Tab selects the currently highlighted command like Enter", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/d", 2);
      });
      act(() => {
        result.current.handleKeyDown(makeKeyEvent("ArrowDown"));
      });

      act(() => {
        result.current.handleKeyDown(makeKeyEvent("Tab"));
      });

      expect(onSelect).toHaveBeenCalledExactlyOnceWith(COMMANDS[1].command);
      expect(result.current.slashState).toBeNull();
    });

    test("Escape closes the menu without selecting a command", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/d", 2);
      });

      const event = makeKeyEvent("Escape");
      let handled: boolean | undefined;
      act(() => {
        handled = result.current.handleKeyDown(event);
      });

      expect(handled).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(result.current.slashState).toBeNull();
      expect(onSelect).not.toHaveBeenCalled();
    });

    test("an unrecognized key leaves the menu open and reports unhandled", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/d", 2);
      });

      let handled: boolean | undefined;
      act(() => {
        handled = result.current.handleKeyDown(makeKeyEvent("a"));
      });

      expect(handled).toBe(false);
      expect(result.current.slashState?.isOpen).toBe(true);
    });

    test("Enter is a no-op when the highlighted index no longer maps to a command", () => {
      // Reproduces a real race: the caller's command list shrinks (e.g. a
      // feature flag disables one) while the menu is open and the user has
      // already arrowed down past the new, shorter list. selectedIndex is
      // hook state and is not reset by a commands-prop change, so it can
      // point past the end of the freshly filtered array.
      const onSelect = vi.fn();
      const { result, rerender } = renderHook(
        ({ commands }) => useSlashCommands(commands, onSelect),
        { initialProps: { commands: COMMANDS } }
      );

      act(() => {
        result.current.detectSlash("/d", 2);
      });
      act(() => {
        result.current.handleKeyDown(makeKeyEvent("ArrowDown"));
      });
      act(() => {
        result.current.handleKeyDown(makeKeyEvent("ArrowDown"));
      });
      expect(result.current.slashState?.selectedIndex).toBe(2);

      rerender({ commands: [COMMANDS[0]] });
      expect(result.current.filteredCommands).toEqual([COMMANDS[0]]);

      act(() => {
        result.current.handleKeyDown(makeKeyEvent("Enter"));
      });

      expect(onSelect).not.toHaveBeenCalled();
      // Enter is still reported as "handled" (preventDefault fires) even
      // though no selection happened — the menu is not closed either.
      expect(result.current.slashState?.isOpen).toBe(true);
    });
  });

  describe("selectCommand", () => {
    test("closes the menu and invokes onSelect with the given command", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/d", 2);
      });

      act(() => {
        result.current.selectCommand("/deploy");
      });

      expect(onSelect).toHaveBeenCalledExactlyOnceWith("/deploy");
      expect(result.current.slashState).toBeNull();
    });
  });

  describe("close", () => {
    test("clears the open slash menu without invoking onSelect", () => {
      const onSelect = vi.fn();
      const { result } = renderHook(() => useSlashCommands(COMMANDS, onSelect));

      act(() => {
        result.current.detectSlash("/d", 2);
      });
      expect(result.current.slashState?.isOpen).toBe(true);

      act(() => {
        result.current.close();
      });

      expect(result.current.slashState).toBeNull();
      expect(result.current.filteredCommands).toEqual([]);
      expect(onSelect).not.toHaveBeenCalled();
    });
  });
});
