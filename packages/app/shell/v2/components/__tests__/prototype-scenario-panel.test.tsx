import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PrototypeScenarioPanel,
  type ScenarioPanelCondition,
} from "../prototype-scenario-panel";

afterEach(cleanup);

beforeEach(() => {
  window.localStorage.clear();
});

const MODE_STORAGE_KEY = "test-scenario-mode";
const USER_STORAGE_KEY = "test-scenario-user";
const POSITION_STORAGE_KEY = "test-scenario-position";
const PLATFORM_STORAGE_KEY = "test-scenario-platform";
const KNOWN_STORAGE_KEYS = [
  MODE_STORAGE_KEY,
  USER_STORAGE_KEY,
  POSITION_STORAGE_KEY,
  PLATFORM_STORAGE_KEY,
];

function buildConditions(
  onModeChange: (value: string) => void,
  onUserChange: (value: string) => void
): readonly ScenarioPanelCondition[] {
  return [
    {
      ariaLabel: "Scenario mode",
      default: "desktop",
      id: "mode",
      label: "Mode:",
      onChange: onModeChange,
      options: [
        { ariaLabel: "Desktop mode", label: "Desktop", value: "desktop" },
        { ariaLabel: "Web mode", label: "Web", value: "web" },
      ],
      storageKey: MODE_STORAGE_KEY,
    },
    {
      ariaLabel: "Scenario user",
      default: "first-user",
      id: "user",
      label: "User:",
      onChange: onUserChange,
      options: [
        { ariaLabel: "First user", label: "First user", value: "first-user" },
        { ariaLabel: "51st user", label: "51st user", value: "51st-user" },
      ],
      storageKey: USER_STORAGE_KEY,
    },
  ];
}

function buildSessionOnlyCondition(
  onChange: (value: string) => void
): ScenarioPanelCondition {
  return {
    ariaLabel: "Scenario platform",
    default: "detected",
    id: "platform",
    label: "Platform:",
    onChange,
    options: [
      { ariaLabel: "Detected platform", label: "Detected", value: "detected" },
      { ariaLabel: "Windows platform", label: "Windows", value: "windows" },
    ],
  };
}

function storedKeys(): string[] {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key !== null) {
      keys.push(key);
    }
  }
  return keys;
}

describe("PrototypeScenarioPanel", () => {
  it("renders one toggle group per condition, with every control accessibly named", () => {
    render(
      <PrototypeScenarioPanel
        ariaLabel="Test controls"
        conditions={buildConditions(vi.fn(), vi.fn())}
        positionStorageKey={POSITION_STORAGE_KEY}
      />
    );

    expect(
      screen.getByRole("radiogroup", { name: "Scenario mode" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: "Scenario user" })
    ).toBeInTheDocument();
    for (const name of [
      "Desktop mode",
      "Web mode",
      "First user",
      "51st user",
    ]) {
      expect(screen.getByRole("radio", { name })).toBeInTheDocument();
    }
  });

  it("initializes from localStorage and reports the resolved value on mount", () => {
    window.localStorage.setItem(MODE_STORAGE_KEY, "web");
    const onModeChange = vi.fn();
    render(
      <PrototypeScenarioPanel
        ariaLabel="Test controls"
        conditions={buildConditions(onModeChange, vi.fn())}
        positionStorageKey={POSITION_STORAGE_KEY}
      />
    );

    expect(screen.getByRole("radio", { name: "Web mode" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(onModeChange).toHaveBeenCalledWith("web");
  });

  it("falls back to the declared default for an unknown persisted value", () => {
    window.localStorage.setItem(MODE_STORAGE_KEY, "not-a-real-mode");
    const onModeChange = vi.fn();
    render(
      <PrototypeScenarioPanel
        ariaLabel="Test controls"
        conditions={buildConditions(onModeChange, vi.fn())}
        positionStorageKey={POSITION_STORAGE_KEY}
      />
    );

    expect(screen.getByRole("radio", { name: "Desktop mode" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(onModeChange).toHaveBeenCalledWith("desktop");
  });

  it("persists a selection and reports it through the condition's onChange", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    render(
      <PrototypeScenarioPanel
        ariaLabel="Test controls"
        conditions={buildConditions(onModeChange, vi.fn())}
        positionStorageKey={POSITION_STORAGE_KEY}
      />
    );
    onModeChange.mockClear();

    await user.click(screen.getByRole("radio", { name: "Web mode" }));

    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBe("web");
    expect(onModeChange).toHaveBeenCalledWith("web");
  });

  it("resets every condition to its default and persists that default", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    const onUserChange = vi.fn();
    render(
      <PrototypeScenarioPanel
        ariaLabel="Test controls"
        conditions={buildConditions(onModeChange, onUserChange)}
        positionStorageKey={POSITION_STORAGE_KEY}
      />
    );
    await user.click(screen.getByRole("radio", { name: "Web mode" }));
    await user.click(screen.getByRole("radio", { name: "51st user" }));
    onModeChange.mockClear();
    onUserChange.mockClear();

    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(screen.getByRole("radio", { name: "Desktop mode" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(screen.getByRole("radio", { name: "First user" })).toHaveAttribute(
      "aria-checked",
      "true"
    );
    expect(window.localStorage.getItem(MODE_STORAGE_KEY)).toBe("desktop");
    expect(window.localStorage.getItem(USER_STORAGE_KEY)).toBe("first-user");
    expect(onModeChange).toHaveBeenCalledWith("desktop");
    expect(onUserChange).toHaveBeenCalledWith("first-user");
  });

  it("renders a caller-supplied action and invokes its callback", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(
      <PrototypeScenarioPanel
        actions={[{ label: "Simulate something", onClick }]}
        ariaLabel="Test controls"
        conditions={buildConditions(vi.fn(), vi.fn())}
        positionStorageKey={POSITION_STORAGE_KEY}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "Simulate something" })
    );

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("rejects two actions sharing one label instead of colliding their keys", () => {
    const onClick = vi.fn();
    expect(() =>
      render(
        <PrototypeScenarioPanel
          actions={[
            { label: "Simulate something", onClick },
            { label: "Simulate something", onClick },
          ]}
          ariaLabel="Test controls"
          conditions={buildConditions(vi.fn(), vi.fn())}
          positionStorageKey={POSITION_STORAGE_KEY}
        />
      )
    ).toThrow('duplicate action label "Simulate something"');
  });

  // Positive control for the throw above: the same two actions, distinct labels.
  it("renders two actions that differ only by label", () => {
    const onClick = vi.fn();
    render(
      <PrototypeScenarioPanel
        actions={[
          { label: "Simulate something", onClick },
          { label: "Simulate something else", onClick },
        ]}
        ariaLabel="Test controls"
        conditions={buildConditions(vi.fn(), vi.fn())}
        positionStorageKey={POSITION_STORAGE_KEY}
      />
    );

    expect(
      screen.getByRole("button", { name: "Simulate something" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Simulate something else" })
    ).toBeInTheDocument();
  });

  it("keeps a condition with no storageKey out of localStorage entirely", async () => {
    const user = userEvent.setup();
    const onPlatformChange = vi.fn();
    window.localStorage.setItem(PLATFORM_STORAGE_KEY, "windows");
    render(
      <PrototypeScenarioPanel
        ariaLabel="Test controls"
        conditions={[
          ...buildConditions(vi.fn(), vi.fn()),
          buildSessionOnlyCondition(onPlatformChange),
        ]}
        positionStorageKey={POSITION_STORAGE_KEY}
      />
    );

    // A key-shaped entry already in storage must not seed a keyless condition.
    expect(
      screen.getByRole("radio", { name: "Detected platform" })
    ).toHaveAttribute("aria-checked", "true");

    await user.click(screen.getByRole("radio", { name: "Windows platform" }));
    expect(onPlatformChange).toHaveBeenCalledWith("windows");
    onPlatformChange.mockClear();

    // Reset writes every condition's default, so a storage-writing panel would
    // leave "detected" here; the seeded value surviving is the proof it wrote
    // nothing. The caller is still notified either way.
    await user.click(screen.getByRole("button", { name: "Reset" }));
    expect(onPlatformChange).toHaveBeenCalledWith("detected");
    expect(window.localStorage.getItem(PLATFORM_STORAGE_KEY)).toBe("windows");
    // Nor under any other spelling a missing key could collapse to — the id,
    // the label, or the string "undefined".
    expect(
      storedKeys().filter((key) => !KNOWN_STORAGE_KEYS.includes(key))
    ).toEqual([]);
  });

  it("moves the panel with the arrow keys from the drag handle, and persists the position", async () => {
    const user = userEvent.setup();
    render(
      <PrototypeScenarioPanel
        ariaLabel="Test controls"
        conditions={buildConditions(vi.fn(), vi.fn())}
        positionStorageKey={POSITION_STORAGE_KEY}
      />
    );

    const handle = screen.getByRole("button", { name: "Move Mode" });
    handle.focus();
    await user.keyboard("{ArrowDown}");

    // jsdom measures the panel at 0,0, so one ArrowDown from the unset position
    // lands at exactly one keyboard step down, clamped to the viewport padding.
    // An unmoved panel would persist 0, which the old matcher accepted.
    const stored = window.localStorage.getItem(POSITION_STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string)).toEqual({ x: 8, y: 16 });
  });
});
