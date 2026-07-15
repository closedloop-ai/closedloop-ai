import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { isValidElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionListItemFixture } from "../session-list-fixtures";
import { SessionRowActionsMenu } from "../session-row-actions-menu";

// Render the Radix DropdownMenu inline so its items are queryable without
// driving the open interaction (which is flaky under jsdom), and wire
// `onSelect` to a click so the copy handlers run. Mirrors the mock precedent in
// documents/components/table/__tests__/table-view-menu.test.tsx.
vi.mock("@repo/design-system/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
  }: {
    children: ReactNode;
    asChild?: boolean;
    disabled?: boolean;
    onSelect?: () => void;
  }) =>
    isValidElement(children) && !onSelect ? (
      children
    ) : (
      <button disabled={disabled} onClick={() => onSelect?.()} type="button">
        {children}
      </button>
    ),
}));

const ORIGINAL_CLIPBOARD_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  globalThis.navigator,
  "clipboard"
);

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  return writeText;
}

afterEach(() => {
  if (ORIGINAL_CLIPBOARD_DESCRIPTOR) {
    Object.defineProperty(
      globalThis.navigator,
      "clipboard",
      ORIGINAL_CLIPBOARD_DESCRIPTOR
    );
    return;
  }
  Reflect.deleteProperty(globalThis.navigator, "clipboard");
});

describe("SessionRowActionsMenu", () => {
  it("exposes a keyboard-accessible, labelled kebab trigger", () => {
    render(
      <SessionRowActionsMenu item={createAgentSessionListItemFixture()} />
    );
    const trigger = screen.getByRole("button", { name: "Session actions" });
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute("type", "button");
  });

  it("copies the branch name when a branch is present", async () => {
    const writeText = mockClipboard();
    render(
      <SessionRowActionsMenu
        item={createAgentSessionListItemFixture({
          branch: "kaiticarp/feature/new-menu",
        })}
      />
    );

    fireEvent.click(screen.getByText("Copy branch name"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("kaiticarp/feature/new-menu")
    );
  });

  it("disables Copy branch name when the session has no branch", () => {
    render(
      <SessionRowActionsMenu
        item={createAgentSessionListItemFixture({ branch: null })}
      />
    );
    expect(
      screen.getByText("Copy branch name").closest("button")
    ).toBeDisabled();
  });

  it("copies the SES slug as the session ID, falling back to the external id", async () => {
    const writeText = mockClipboard();
    const { rerender } = render(
      <SessionRowActionsMenu
        item={createAgentSessionListItemFixture({ slug: "SES-1234" })}
      />
    );

    fireEvent.click(screen.getByText("Copy session ID"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("SES-1234"));

    writeText.mockClear();
    rerender(
      <SessionRowActionsMenu
        item={createAgentSessionListItemFixture({
          externalSessionId: "ext-session-9",
          slug: null,
        })}
      />
    );
    fireEvent.click(screen.getByText("Copy session ID"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("ext-session-9")
    );
  });
});
