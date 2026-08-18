import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLocalStorage } from "../../../__tests__/local-storage-fixture";
import {
  readImportSplashCollapsed,
  useImportSplashCollapsed,
  writeImportSplashCollapsed,
} from "../use-import-splash-collapsed";

const STORAGE_KEY = "closedloop.desktop.import-splash.collapsed";

// The renderer jsdom environment ships no usable `Storage`; the shared fixture
// installs an in-memory one (same fixture the app-shell sidebar suite uses).
let restoreLocalStorage: () => void = () => undefined;

// A minimal harness so the hook can be driven through a real mount/unmount
// cycle — remounting is exactly what "survives navigation" has to mean.
function Probe() {
  const { collapsed, collapse, expand } = useImportSplashCollapsed();
  return (
    <button
      onClick={collapsed ? expand : collapse}
      type="button"
    >{`collapsed:${collapsed}`}</button>
  );
}

function toggle(): void {
  act(() => {
    screen.getByRole("button").click();
  });
}

beforeEach(() => {
  restoreLocalStorage = installLocalStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreLocalStorage();
});

describe("useImportSplashCollapsed (ISS-5258)", () => {
  it("defaults to expanded for a brand-new user with nothing stored", () => {
    render(<Probe />);
    expect(screen.getByRole("button").textContent).toBe("collapsed:false");
  });

  it("persists a collapse and restores it on a fresh mount", () => {
    const { unmount } = render(<Probe />);
    toggle();
    expect(screen.getByRole("button").textContent).toBe("collapsed:true");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("true");

    // Remount: the same thing that happens when the user navigates away and
    // back, or relaunches.
    unmount();
    render(<Probe />);
    expect(screen.getByRole("button").textContent).toBe("collapsed:true");
  });

  it("persists the inverse too — re-expanding does not leave a stale collapse", () => {
    window.localStorage.setItem(STORAGE_KEY, "true");
    const { unmount } = render(<Probe />);
    expect(screen.getByRole("button").textContent).toBe("collapsed:true");
    toggle();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("false");

    unmount();
    render(<Probe />);
    expect(screen.getByRole("button").textContent).toBe("collapsed:false");
  });

  it("treats a corrupt stored value as expanded", () => {
    window.localStorage.setItem(STORAGE_KEY, "collapsed");
    render(<Probe />);
    expect(screen.getByRole("button").textContent).toBe("collapsed:false");
  });

  it("degrades to expanded when storage throws", () => {
    vi.spyOn(window.localStorage, "getItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });

    expect(readImportSplashCollapsed()).toBe(false);
    expect(() => writeImportSplashCollapsed(true)).not.toThrow();

    render(<Probe />);
    expect(screen.getByRole("button").textContent).toBe("collapsed:false");
    // The write fails, but the in-memory choice still wins for this session.
    toggle();
    expect(screen.getByRole("button").textContent).toBe("collapsed:true");
  });
});
