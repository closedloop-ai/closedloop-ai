// ISS-11284 branch coverage for binary-paths-tab.tsx: the startEdit prefill
// fallback chain (override ?? resolvedPath ?? ""), the inline Save-error
// render guard, and the editor's Enter/Escape keydown branches.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BinaryResolveSource } from "../../../../shared/cli-binary-tools";
import { BinaryPathsTab } from "../binary-paths-tab";

const SAVE_ERROR_RE = /Failed to save binary path/i;

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

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

function installDesktopApi(overrides: {
  detectResult: Record<string, DetectEntry>;
  patchBinaryPaths?: ReturnType<typeof vi.fn>;
}): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getSettings: vi.fn(async () => ({})),
      detectCliTools: vi.fn(async () => overrides.detectResult),
      patchBinaryPaths:
        overrides.patchBinaryPaths ?? vi.fn(async () => undefined),
    },
  });
}

async function editButtonFor(tool: string): Promise<HTMLElement> {
  const rows = await screen.findAllByRole("button", { name: "Edit" });
  const label = await screen.findByText(tool);
  const row = label.closest("div.flex.items-start");
  return rows.find((candidate) => row?.contains(candidate)) ?? rows[0];
}

describe("BinaryPathsTab — startEdit prefill fallback chain", () => {
  it("prefills the editor with the manual override when one is set", async () => {
    installDesktopApi({
      detectResult: {
        claude: detectEntry("claude", "override", "/opt/claude", "/opt/claude"),
      },
    });
    render(<BinaryPathsTab />);

    fireEvent.click(await editButtonFor("claude"));

    expect(await screen.findByLabelText("claude")).toHaveProperty(
      "value",
      "/opt/claude"
    );
  });

  it("prefills the editor with the resolved path when there is no override", async () => {
    installDesktopApi({
      detectResult: {
        claude: detectEntry("claude", "path", "/usr/bin/claude"),
      },
    });
    render(<BinaryPathsTab />);

    fireEvent.click(await editButtonFor("claude"));

    expect(await screen.findByLabelText("claude")).toHaveProperty(
      "value",
      "/usr/bin/claude"
    );
  });

  it("prefills the editor empty when the tool has neither an override nor a resolved path", async () => {
    installDesktopApi({
      detectResult: {
        claude: detectEntry("claude", "fallback", null),
      },
    });
    render(<BinaryPathsTab />);

    fireEvent.click(await editButtonFor("claude"));

    expect(await screen.findByLabelText("claude")).toHaveProperty("value", "");
  });
});

describe("BinaryPathsTab — inline Save-error rendering", () => {
  it("renders no inline error paragraph before Save has been attempted", async () => {
    installDesktopApi({
      detectResult: {
        claude: detectEntry("claude", "path", "/usr/bin/claude"),
      },
    });
    render(<BinaryPathsTab />);

    fireEvent.click(await editButtonFor("claude"));
    await screen.findByLabelText("claude");

    expect(screen.queryByText(SAVE_ERROR_RE)).toBeNull();
  });

  it("renders the inline error paragraph when Save rejects", async () => {
    installDesktopApi({
      detectResult: {
        claude: detectEntry("claude", "path", "/usr/bin/claude"),
      },
      patchBinaryPaths: vi.fn(() => Promise.reject(new Error("nope"))),
    });
    render(<BinaryPathsTab />);

    fireEvent.click(await editButtonFor("claude"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("nope")).not.toBeNull();
  });
});

describe("BinaryPathsTab — editor keydown branches", () => {
  it("saves on Enter", async () => {
    const patchBinaryPaths = vi.fn(async () => undefined);
    installDesktopApi({
      detectResult: {
        claude: detectEntry("claude", "path", "/usr/bin/claude"),
      },
      patchBinaryPaths,
    });
    render(<BinaryPathsTab />);

    fireEvent.click(await editButtonFor("claude"));
    const input = await screen.findByLabelText("claude");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(patchBinaryPaths).toHaveBeenCalledWith({
        claude: "/usr/bin/claude",
      });
    });
  });

  it("cancels edit mode on Escape", async () => {
    installDesktopApi({
      detectResult: {
        claude: detectEntry("claude", "path", "/usr/bin/claude"),
      },
    });
    render(<BinaryPathsTab />);

    fireEvent.click(await editButtonFor("claude"));
    const input = await screen.findByLabelText("claude");
    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByLabelText("claude")).toBeNull();
    });
  });

  it("does nothing on a key that is neither Enter nor Escape", async () => {
    const patchBinaryPaths = vi.fn(async () => undefined);
    installDesktopApi({
      detectResult: {
        claude: detectEntry("claude", "path", "/usr/bin/claude"),
      },
      patchBinaryPaths,
    });
    render(<BinaryPathsTab />);

    fireEvent.click(await editButtonFor("claude"));
    const input = await screen.findByLabelText("claude");
    fireEvent.keyDown(input, { key: "a" });

    // Neither save nor cancel fires: the editor stays open and Save is untouched.
    expect(screen.getByLabelText("claude")).not.toBeNull();
    expect(patchBinaryPaths).not.toHaveBeenCalled();
  });
});
