import { DocumentStatus } from "@repo/api/src/types/document";
import {
  type UndoCommandContext,
  UndoEntityType,
  UndoMutationKind,
} from "@repo/api/src/types/undo-command";
import { UNDO_KEYBINDINGS_FLAG_KEY } from "@repo/api/src/types/undo-keybindings-flag";
import { NavigationProvider } from "@repo/navigation/provider";
import { act, cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryNavigation } from "../../../../navigation/memory-adapter";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "../../../shared/feature-flags/static-feature-flag-adapter";
import { UndoKeybindingLayer } from "../../components/undo-keybinding-layer";
import type { UndoStackEntry } from "../../lib/undo-stack";
import { UndoStackProvider, useUndoStackOptional } from "../use-undo-stack";

/**
 * ISS-9092 — the keybinding layer driven through its PRODUCTION path: a real
 * `keydown` on a real document, through the real flag port, the real stack, and
 * the real registry, asserting the API calls that come out the far side.
 *
 * The API client is the one seam that is mocked, because it is the observable:
 * what this layer DOES is turn a chord into the registry's inverse request.
 */

const apiClient = vi.hoisted(() => ({
  post: vi.fn(() => Promise.resolve({})),
  put: vi.fn(() => Promise.resolve({})),
  delete: vi.fn(() => Promise.resolve({})),
}));

vi.mock("../../../shared/api/use-api-client-optional", () => ({
  useApiClientOptional: () => apiClient,
}));

const SESSIONS_SCOPE = "/sessions";
const OTHER_SCOPE = "/documents/prd-1";
const ARTIFACT_ID = "artifact-1";

function statusEntry(scopeKey: string): UndoStackEntry {
  const context: UndoCommandContext = {
    entity: { type: UndoEntityType.Artifact, ids: [ARTIFACT_ID] },
    priorValue: { [ARTIFACT_ID]: DocumentStatus.Draft },
    newValue: { [ARTIFACT_ID]: DocumentStatus.Approved },
  };
  return {
    id: "entry-1",
    kind: UndoMutationKind.ArtifactStatusChange,
    scopeKey,
    label: "Change status",
    context,
  };
}

/** Exposes the mounted stack controller so a test can seed a performed action. */
let pushEntry: ((entry: UndoStackEntry) => void) | null = null;

function StackHandle() {
  const stack = useUndoStackOptional();
  pushEntry = stack ? stack.push : null;
  return null;
}

function mount({
  flagOn,
  path = SESSIONS_SCOPE,
}: {
  flagOn: boolean;
  path?: string;
}) {
  const navigation = createMemoryNavigation({ initialPath: path });
  const adapter = createStaticFeatureFlagAdapter({
    enabledFlags: flagOn ? [UNDO_KEYBINDINGS_FLAG_KEY] : [],
  });
  const tree: ReactNode = (
    <NavigationProvider adapter={navigation.adapter}>
      <FeatureFlagAdapterProvider adapter={adapter}>
        <UndoStackProvider>
          <StackHandle />
          <UndoKeybindingLayer />
          <button id="plain" type="button">
            plain
          </button>
          <input id="field" type="text" />
        </UndoStackProvider>
      </FeatureFlagAdapterProvider>
    </NavigationProvider>
  );
  return render(tree);
}

/** Dispatch a real Cmd+Z / Cmd+Shift+Z from `target`, returning defaultPrevented. */
function pressUndoChord(
  target: Element,
  { shift = false, repeat = false }: { shift?: boolean; repeat?: boolean } = {}
): boolean {
  const event = new KeyboardEvent("keydown", {
    key: shift ? "Z" : "z",
    metaKey: true,
    shiftKey: shift,
    repeat,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  pushEntry = null;
  // The layer resolves the platform from `navigator.platform` inside its
  // effect; pin it so the chord under test is the Mac one on every runner.
  vi.spyOn(globalThis.navigator, "platform", "get").mockReturnValue("MacIntel");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the closed default", () => {
  /*
   * Flag off means NO listener at all, so the keystroke reaches the browser
   * untouched. `defaultPrevented === false` is the assertion that matters: a
   * layer that matched the chord and then declined to act would still have
   * swallowed the user's native undo.
   */
  it("attaches no listener, leaving the chord to the browser", async () => {
    mount({ flagOn: false });
    act(() => {
      pushEntry?.(statusEntry(SESSIONS_SCOPE));
    });

    const prevented = pressUndoChord(
      document.querySelector("#plain") as Element
    );
    await settle();

    expect(prevented).toBe(false);
    expect(apiClient.put).not.toHaveBeenCalled();
  });
});

describe("focus inside something that owns its own undo", () => {
  /*
   * AC2, and the regression the ticket says will actually ship. The layer must
   * neither act NOR preventDefault, so the text field's native undo still runs.
   */
  it("does not act and does not preventDefault in a text input", async () => {
    mount({ flagOn: true });
    act(() => {
      pushEntry?.(statusEntry(SESSIONS_SCOPE));
    });

    const prevented = pressUndoChord(
      document.querySelector("#field") as Element
    );
    await settle();

    expect(prevented).toBe(false);
    expect(apiClient.put).not.toHaveBeenCalled();
  });
});

describe("the undo chord on a surface that owns the top entry", () => {
  it("dispatches the registry's inverse as a real API request", async () => {
    mount({ flagOn: true });
    act(() => {
      pushEntry?.(statusEntry(SESSIONS_SCOPE));
    });

    const prevented = pressUndoChord(
      document.querySelector("#plain") as Element
    );
    await settle();

    expect(prevented).toBe(true);
    // The INVERSE, so the prior status — not the new one the forward set.
    expect(apiClient.put).toHaveBeenCalledWith(`/documents/${ARTIFACT_ID}`, {
      status: DocumentStatus.Draft,
    });
  });

  /*
   * After a committed undo the entry is on the future list, so the redo chord
   * replays the FORWARD call. Without this, "commitUndo ran" is only inferred.
   */
  it("replays the forward call when redo follows undo", async () => {
    mount({ flagOn: true });
    act(() => {
      pushEntry?.(statusEntry(SESSIONS_SCOPE));
    });

    pressUndoChord(document.querySelector("#plain") as Element);
    await settle();
    apiClient.put.mockClear();

    pressUndoChord(document.querySelector("#plain") as Element, {
      shift: true,
    });
    await settle();

    expect(apiClient.put).toHaveBeenCalledWith(`/documents/${ARTIFACT_ID}`, {
      status: DocumentStatus.Approved,
    });
  });
});

describe("the undo chord on a surface that does NOT own the top entry", () => {
  /*
   * "The reader must never undo something they cannot see." The chord is still
   * claimed (the layer owns it while enabled), but nothing is sent.
   */
  it("sends no request when the top entry belongs to another screen", async () => {
    mount({ flagOn: true, path: OTHER_SCOPE });
    act(() => {
      pushEntry?.(statusEntry(SESSIONS_SCOPE));
    });

    pressUndoChord(document.querySelector("#plain") as Element);
    await settle();

    expect(apiClient.put).not.toHaveBeenCalled();
  });
});

describe("when the inverse request fails", () => {
  /*
   * Nothing may be committed, or the stack reports a mutation reverted that the
   * server still holds. Proved by pressing the chord a SECOND time: the entry is
   * still on the past list, so the inverse is attempted again.
   */
  it("leaves the entry on the stack so the chord can be pressed again", async () => {
    apiClient.put.mockRejectedValue(new Error("500"));
    mount({ flagOn: true });
    act(() => {
      pushEntry?.(statusEntry(SESSIONS_SCOPE));
    });

    pressUndoChord(document.querySelector("#plain") as Element);
    await settle();
    expect(apiClient.put).toHaveBeenCalledTimes(1);

    pressUndoChord(document.querySelector("#plain") as Element);
    await settle();

    expect(apiClient.put).toHaveBeenCalledTimes(2);
    expect(apiClient.put).toHaveBeenLastCalledWith(
      `/documents/${ARTIFACT_ID}`,
      { status: DocumentStatus.Draft }
    );
  });
});

describe("a chord pressed again before the first inverse settles", () => {
  /**
   * Hold the API open so the first inverse is genuinely still in flight when
   * the second chord arrives — the exact window the serialization closes.
   */
  function deferApi() {
    let release: () => void = () => undefined;
    apiClient.put.mockImplementation(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          release = () => resolve({});
        })
    );
    return () => release();
  }

  /*
   * The stack does not move until the request returns, so a second press
   * re-resolves the SAME uncommitted top entry. The `commitUndo` identity guard
   * stops the duplicate stack move but cannot recall the duplicate REQUESTS —
   * a bulk inverse is several grouped calls and every one of them is re-issued.
   */
  it("issues the inverse once, not twice", async () => {
    const release = deferApi();
    mount({ flagOn: true });
    act(() => {
      pushEntry?.(statusEntry(SESSIONS_SCOPE));
    });

    pressUndoChord(document.querySelector("#plain") as Element);
    const second = pressUndoChord(document.querySelector("#plain") as Element);
    await settle();

    expect(apiClient.put).toHaveBeenCalledTimes(1);
    // Positive control on the SAME press the absence is claimed for: the layer
    // still CLAIMED the chord. A dropped press that fell through to the browser
    // would also show one call, while handing native undo a keystroke the app
    // had already taken.
    expect(second).toBe(true);

    act(() => {
      release();
    });
    await settle();
  });

  /*
   * A HELD chord auto-repeats at the OS key-repeat rate, so this is the same
   * defect arriving tens of times a second without the user pressing anything
   * again.
   */
  it("ignores the auto-repeat of a held chord", async () => {
    mount({ flagOn: true });
    act(() => {
      pushEntry?.(statusEntry(SESSIONS_SCOPE));
    });

    const prevented = pressUndoChord(
      document.querySelector("#plain") as Element,
      { repeat: true }
    );
    await settle();

    expect(apiClient.put).not.toHaveBeenCalled();
    // Same positive control: the chord matched and was claimed, so the absence
    // above is the repeat being refused rather than a chord that never fired.
    expect(prevented).toBe(true);
  });

  /*
   * The reservation must be released on the FAILURE path too. Clearing it only
   * on success would wedge the layer permanently at the first failed request:
   * the entry stays on the stack for retry and nothing is ever allowed to retry
   * it.
   */
  it("releases the reservation after a failed inverse so retry still works", async () => {
    apiClient.put.mockRejectedValue(new Error("500"));
    mount({ flagOn: true });
    act(() => {
      pushEntry?.(statusEntry(SESSIONS_SCOPE));
    });

    pressUndoChord(document.querySelector("#plain") as Element);
    await settle();
    pressUndoChord(document.querySelector("#plain") as Element);
    await settle();

    expect(apiClient.put).toHaveBeenCalledTimes(2);
  });
});

describe("an empty stack", () => {
  it("sends nothing when there is no performed action", async () => {
    mount({ flagOn: true });

    pressUndoChord(document.querySelector("#plain") as Element);
    await settle();

    expect(apiClient.put).not.toHaveBeenCalled();
  });
});
