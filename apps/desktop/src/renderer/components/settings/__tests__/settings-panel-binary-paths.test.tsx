import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BinaryResolveSource } from "../../../../shared/cli-binary-tools";
import { DesktopAppPanel } from "../../../settings-v2/panels/desktop-app-panel";
import { desktopAppPanelMountReads } from "./desktop-app-panel-mount-reads";

const INVALID_PATH_ERROR = "Binary path for claude does not exist: /bad/path";
const NOT_FOUND_GUIDANCE_RE = /couldn't find/i;

type DetectEntry = {
  name: string;
  override: string | null;
  source: BinaryResolveSource;
  resolvedPath: string | null;
};

function detectEntry(
  name: string,
  source: DetectEntry["source"],
  resolvedPath: string | null,
  override: string | null = null
): DetectEntry {
  return { name, override, source, resolvedPath };
}

function installDesktopApi(
  patchBinaryPaths: ReturnType<typeof vi.fn>,
  detectResult: Record<string, DetectEntry> = {
    claude: detectEntry("claude", "path", "/usr/bin/claude"),
  }
): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      ...desktopAppPanelMountReads(),
      detectCliTools: vi.fn(async () => detectResult),
      patchBinaryPaths,
    },
  });
}

/**
 * The CLI Tools card subtree.
 *
 * ISS-10246: this suite mounts `DesktopAppPanel`, which renders Security beside
 * CLI Tools, and the global sandbox card there has a "Save" button of its own.
 * Scoping keeps every assertion below a statement about the binary-path row.
 */
function cliToolsCard(): ReturnType<typeof within> {
  const card = screen.getByText("CLI Tools").closest('[data-slot="card"]');
  if (card === null) {
    throw new Error("CLI Tools card not found");
  }
  return within(card as HTMLElement);
}

function cliToolsSaveButton(): HTMLElement {
  return cliToolsCard().getByRole("button", { name: "Save" });
}

async function openClaudeEditor(badValue: string) {
  // The claude row is the first listed tool; enter its edit mode.
  const editButtons = await screen.findAllByRole("button", { name: "Edit" });
  fireEvent.click(editButtons[0]);
  const input = await screen.findByLabelText("claude");
  fireEvent.change(input, { target: { value: badValue } });
  return input;
}

describe("Settings CLI Tools binary path loading", () => {
  it("stops loading when the initial detectCliTools IPC rejects on mount", async () => {
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        ...desktopAppPanelMountReads(),
        detectCliTools: vi.fn(() =>
          Promise.reject(new Error("IPC unavailable"))
        ),
      },
    });
    render(<DesktopAppPanel />);

    // The loading placeholder must clear even though the IPC rejected, so the
    // tool rows (each with an Edit button) render instead of hanging forever.
    await waitFor(() => {
      expect(screen.queryByText("Detecting tools...")).toBeNull();
    });
    expect(
      (await screen.findAllByRole("button", { name: "Edit" })).length
    ).toBeGreaterThan(0);
  });

  it("stops loading when a Detect Tools retry rejects", async () => {
    let call = 0;
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {
        ...desktopAppPanelMountReads(),
        detectCliTools: vi.fn(() => {
          call += 1;
          // First call (mount) resolves; the retry click rejects.
          return call === 1
            ? Promise.resolve({})
            : Promise.reject(new Error("IPC unavailable"));
        }),
      },
    });
    render(<DesktopAppPanel />);

    const detectButton = await screen.findByRole("button", {
      name: "Detect Tools",
    });
    fireEvent.click(detectButton);

    // The rejected retry must clear the loading state instead of stranding the
    // tab on the "Detecting tools..." placeholder with the button disabled.
    await waitFor(() => {
      expect(screen.queryByText("Detecting tools...")).toBeNull();
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Detect Tools",
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  it("shows a binary detected at a known location (FEA-3742), not 'Not found'", async () => {
    installDesktopApi(
      vi.fn(async () => undefined),
      {
        claude: detectEntry(
          "claude",
          "known_location",
          "/Users/me/.claude/local/claude"
        ),
      }
    );
    render(<DesktopAppPanel />);

    expect(
      await screen.findByText("/Users/me/.claude/local/claude")
    ).toBeDefined();
    // A known-location hit is a success — no "Not found" for that tool.
    await waitFor(() => {
      expect(screen.queryByText("Detecting tools...")).toBeNull();
    });
  });

  it("renders a manual override path (override wins over auto-detection) — FEA-3257", async () => {
    // A tool with a valid manual override resolves with source "override" and a
    // resolvedPath equal to that override. The row must display the override
    // path, proving the operator's explicit choice takes precedence over
    // whatever bare PATH/known-location detection would have found.
    installDesktopApi(
      vi.fn(async () => undefined),
      {
        claude: detectEntry(
          "claude",
          "override",
          "/opt/custom/claude",
          "/opt/custom/claude"
        ),
      }
    );
    render(<DesktopAppPanel />);

    expect(await screen.findByText("/opt/custom/claude")).toBeDefined();
    // An override hit is a success — never "Not found" for that tool.
    await waitFor(() => {
      expect(screen.queryByText("Detecting tools...")).toBeNull();
    });
  });

  it("shows an actionable Not found message when a tool cannot be resolved", async () => {
    installDesktopApi(
      vi.fn(async () => undefined),
      {
        claude: detectEntry("claude", "fallback", null),
      }
    );
    render(<DesktopAppPanel />);

    expect((await screen.findAllByText("Not found")).length).toBeGreaterThan(0);
    // Guidance names what's missing and points at the next steps.
    expect(screen.getAllByText(NOT_FOUND_GUIDANCE_RE).length).toBeGreaterThan(
      0
    );
  });
});

describe("Settings CLI Tools binary path editing", () => {
  it("surfaces an inline error and keeps the row in edit mode when Save fails", async () => {
    const patchBinaryPaths = vi.fn(() =>
      Promise.reject(new Error(INVALID_PATH_ERROR))
    );
    installDesktopApi(patchBinaryPaths);
    render(<DesktopAppPanel />);

    await openClaudeEditor("/bad/path");
    fireEvent.click(cliToolsSaveButton());

    expect(await screen.findByText(INVALID_PATH_ERROR)).toBeDefined();
    // Row stays in edit mode so the user can correct the value.
    expect(screen.getByLabelText("claude")).toBeDefined();
    expect(cliToolsSaveButton()).toBeDefined();
  });

  it("clears the inline error and exits edit mode on a successful save", async () => {
    let attempt = 0;
    const patchBinaryPaths = vi.fn(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error(INVALID_PATH_ERROR))
        : Promise.resolve();
    });
    installDesktopApi(patchBinaryPaths);
    render(<DesktopAppPanel />);

    await openClaudeEditor("/bad/path");
    fireEvent.click(cliToolsSaveButton());
    expect(await screen.findByText(INVALID_PATH_ERROR)).toBeDefined();

    fireEvent.change(screen.getByLabelText("claude"), {
      target: { value: "/usr/bin/claude" },
    });
    fireEvent.click(cliToolsSaveButton());

    await waitFor(() => {
      expect(screen.queryByText(INVALID_PATH_ERROR)).toBeNull();
      expect(cliToolsCard().queryByRole("button", { name: "Save" })).toBeNull();
    });
  });

  it("clears the override (auto-detect again) when Save is pressed with an empty value", async () => {
    // Regression for FEA-3742: the not-found copy tells users they can "clear it
    // to auto-detect again", so an empty Save must actually clear the override
    // (patch null) rather than silently no-op.
    const patchBinaryPaths = vi.fn(async () => undefined);
    installDesktopApi(patchBinaryPaths, {
      claude: detectEntry("claude", "override_invalid", null, "/bad/override"),
    });
    render(<DesktopAppPanel />);

    // Open the claude editor (prefilled with the invalid override) and clear it.
    await openClaudeEditor("");

    fireEvent.click(cliToolsSaveButton());

    await waitFor(() => {
      expect(patchBinaryPaths).toHaveBeenCalledWith({ claude: null });
      // Row exits edit mode after clearing.
      expect(cliToolsCard().queryByRole("button", { name: "Save" })).toBeNull();
    });
  });
});
