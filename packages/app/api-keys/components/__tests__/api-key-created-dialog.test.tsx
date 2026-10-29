import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../../shared/lib/clipboard-utils", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: mocks.toastError,
  },
}));

import { ApiKeyCreatedDialog } from "../api-key-created-dialog";

const DEFAULT_PROPS = {
  onDismiss: vi.fn(),
  plaintext: "sk_live_secret",
};

describe("ApiKeyCreatedDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("copies the key via the clipboard utility and shows copied state", async () => {
    mocks.copyToClipboard.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<ApiKeyCreatedDialog {...DEFAULT_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Copy API key" }));

    expect(mocks.copyToClipboard).toHaveBeenCalledWith("sk_live_secret");
    expect(
      await screen.findByRole("button", { name: "Copied" })
    ).toBeInTheDocument();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("shows an error toast and no copied state when the copy fails", async () => {
    mocks.copyToClipboard.mockResolvedValue(false);
    const user = userEvent.setup();
    render(<ApiKeyCreatedDialog {...DEFAULT_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Copy API key" }));

    expect(mocks.copyToClipboard).toHaveBeenCalledWith("sk_live_secret");
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Couldn't copy to your clipboard. Select the key and copy it."
    );
    expect(
      screen.getByRole("button", { name: "Copy API key" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Copied" })
    ).not.toBeInTheDocument();
  });

  it("offers no close control until the key has been acknowledged", async () => {
    // The dismissal is gated on the acknowledgement, so a drawn, focusable X
    // that silently no-ops would be a control lying about what it does.
    const user = userEvent.setup();
    render(<ApiKeyCreatedDialog {...DEFAULT_PROPS} />);

    expect(
      screen.queryByRole("button", { name: "Close" })
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByLabelText("I have stored this key somewhere safe")
    );

    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});
