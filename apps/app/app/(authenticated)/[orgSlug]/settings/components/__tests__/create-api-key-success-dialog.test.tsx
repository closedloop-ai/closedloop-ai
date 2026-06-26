import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@repo/app/shared/lib/clipboard-utils", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: {
    error: mocks.toastError,
  },
}));

import { CreateApiKeySuccessDialog } from "../create-api-key-success-dialog";

const DEFAULT_PROPS = {
  plaintext: "sk_live_secret",
  onClose: vi.fn(),
};

describe("CreateApiKeySuccessDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("copies the key via the clipboard utility and shows copied state", async () => {
    mocks.copyToClipboard.mockResolvedValue(true);
    const user = userEvent.setup();
    render(<CreateApiKeySuccessDialog {...DEFAULT_PROPS} />);

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
    render(<CreateApiKeySuccessDialog {...DEFAULT_PROPS} />);

    await user.click(screen.getByRole("button", { name: "Copy API key" }));

    expect(mocks.copyToClipboard).toHaveBeenCalledWith("sk_live_secret");
    expect(mocks.toastError).toHaveBeenCalledWith(
      "Failed to copy to clipboard"
    );
    expect(
      screen.getByRole("button", { name: "Copy API key" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Copied" })
    ).not.toBeInTheDocument();
  });
});
