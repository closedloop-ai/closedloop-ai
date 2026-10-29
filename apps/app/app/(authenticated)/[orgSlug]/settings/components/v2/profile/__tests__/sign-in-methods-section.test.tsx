import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import {
  type SignInMethodConnection,
  SignInMethodStatus,
} from "@repo/app/shared/lib/sign-in-methods";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { installPointerCaptureShims } from "@/__tests__/helpers/pointer-capture-shims";
import { SignInMethodsSection } from "../sign-in-methods-section";
import type { SignInMethodActionState } from "../use-sign-in-method-actions";

installPointerCaptureShims();

const UNRECONCILED_MESSAGE = /Removed, but we couldn't refresh/;
const STALE_ROW_MESSAGE = /this row may be out of date/;

const IDLE: SignInMethodActionState = {
  error: null,
  pending: false,
  unreconciled: false,
};

function connection(
  overrides: Partial<SignInMethodConnection> = {}
): SignInMethodConnection {
  return {
    detail: "octocat",
    isCurrentSignIn: false,
    isKnownProvider: true,
    provider: DesktopSignInProvider.GitHub,
    status: SignInMethodStatus.Connected,
    ...overrides,
  };
}

function renderSection(options: {
  connections: SignInMethodConnection[];
  state?: SignInMethodActionState;
}) {
  const handlers = {
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onRetry: vi.fn(),
  };
  render(
    <SignInMethodsSection
      connections={options.connections}
      getActionState={() => options.state ?? IDLE}
      onConnect={handlers.onConnect}
      onDisconnect={handlers.onDisconnect}
      onRetry={handlers.onRetry}
    />
  );
  return handlers;
}

async function openMenuFor(label: string) {
  await userEvent.click(
    screen.getByRole("button", { name: `${label} sign-in options` })
  );
}

describe("SignInMethodsSection rows", () => {
  it("shows a connected account's identifier as its detail", () => {
    renderSection({ connections: [connection()] });

    expect(screen.getByText("· octocat")).toBeInTheDocument();
  });

  it("says Connected when a connected account has no usable identifier", () => {
    renderSection({ connections: [connection({ detail: null })] });

    expect(screen.getByText("· Connected")).toBeInTheDocument();
  });

  it("says Available for a provider that is not connected", () => {
    renderSection({
      connections: [
        connection({ detail: null, status: SignInMethodStatus.Disconnected }),
      ],
    });

    expect(screen.getByText("· Available")).toBeInTheDocument();
  });

  it("does not present an unverified account as connected", () => {
    renderSection({
      connections: [connection({ status: SignInMethodStatus.Unverified })],
    });

    // The identifier stays on the row: with two half-connected accounts,
    // "Not finished" alone does not say which one this row is about.
    expect(screen.getByText("· octocat — not finished")).toBeInTheDocument();
    expect(screen.queryByText("· Connected")).not.toBeInTheDocument();
  });

  it("badges the current sign-in method, and only it", () => {
    renderSection({
      connections: [
        connection({ isCurrentSignIn: true }),
        connection({
          detail: "ada@example.com",
          provider: DesktopSignInProvider.Google,
        }),
      ],
    });

    expect(screen.getAllByText("Current sign-in")).toHaveLength(1);
  });

  it("renders a provider outside the known set under its own name", () => {
    renderSection({
      connections: [
        connection({
          detail: "person",
          isKnownProvider: false,
          provider: "gitlab",
        }),
      ],
    });

    expect(screen.getByText("gitlab")).toBeInTheDocument();
  });

  it("announces an action failure on the row rather than swallowing it", () => {
    renderSection({
      connections: [connection()],
      state: { ...IDLE, error: "You cannot remove your last sign-in method." },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "You cannot remove your last sign-in method."
    );
  });

  it("reports an unreconciled removal instead of an outright failure", () => {
    // `destroy()` succeeded and only `reload()` failed. Saying "that failed"
    // here would be wrong in the opposite direction from saying "disconnected".
    renderSection({
      connections: [connection()],
      state: { ...IDLE, unreconciled: true },
    });

    expect(screen.getByRole("alert")).toHaveTextContent(UNRECONCILED_MESSAGE);
  });

  it("keeps the Clerk reason when the refresh ALSO failed, rather than replacing it", () => {
    // Retry can fail its re-create and then its refresh. Answering that with
    // the removal sentence alone tells the user the opposite of the action they
    // took and discards the only text naming what actually broke.
    renderSection({
      connections: [connection()],
      state: { ...IDLE, error: "network down", unreconciled: true },
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("network down");
    expect(alert).toHaveTextContent(STALE_ROW_MESSAGE);
    expect(alert).not.toHaveTextContent(UNRECONCILED_MESSAGE);
  });
});

describe("SignInMethodsSection actions", () => {
  it("offers Connect for a disconnected provider and fires it", async () => {
    const handlers = renderSection({
      connections: [
        connection({ detail: null, status: SignInMethodStatus.Disconnected }),
      ],
    });

    await openMenuFor("GitHub");
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Connect GitHub" })
    );

    expect(handlers.onConnect).toHaveBeenCalledWith(
      DesktopSignInProvider.GitHub
    );
  });

  it("offers a finish-connecting action for an unverified account, not Connect", async () => {
    const handlers = renderSection({
      connections: [connection({ status: SignInMethodStatus.Unverified })],
    });

    await openMenuFor("GitHub");
    expect(
      screen.queryByRole("menuitem", { name: "Connect GitHub" })
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Finish connecting GitHub" })
    );

    expect(handlers.onRetry).toHaveBeenCalledWith(DesktopSignInProvider.GitHub);
  });

  it("offers no Disconnect for a provider that is not connected", async () => {
    renderSection({
      connections: [
        connection({ detail: null, status: SignInMethodStatus.Disconnected }),
      ],
    });

    await openMenuFor("GitHub");

    expect(
      screen.queryByRole("menuitem", { name: "Disconnect GitHub" })
    ).not.toBeInTheDocument();
  });

  it("disconnects on select, with no confirm step, as the prototype does", async () => {
    const handlers = renderSection({ connections: [connection()] });

    await openMenuFor("GitHub");
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Disconnect GitHub" })
    );

    expect(handlers.onDisconnect).toHaveBeenCalledWith(
      DesktopSignInProvider.GitHub
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("offers Disconnect for an unknown provider too, so the row is not a dead control", async () => {
    const handlers = renderSection({
      connections: [
        connection({
          detail: "person",
          isKnownProvider: false,
          provider: "gitlab",
        }),
      ],
    });

    await openMenuFor("gitlab");
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Disconnect gitlab" })
    );

    expect(handlers.onDisconnect).toHaveBeenCalledWith("gitlab");
  });

  it("renders a provider named after an Object prototype member as plain text", async () => {
    // `"constructor" in SIGN_IN_PROVIDER_LABEL` is TRUE, so an `in` guard here
    // would hand `labelFor` the Object constructor to render. `"gitlab"`
    // cannot catch that regression — it is absent under either form of the
    // guard.
    const handlers = renderSection({
      connections: [
        connection({
          detail: "someone",
          isKnownProvider: false,
          provider: "constructor",
        }),
      ],
    });

    expect(screen.getByText("constructor")).toBeInTheDocument();
    await openMenuFor("constructor");
    await userEvent.click(
      screen.getByRole("menuitem", { name: "Disconnect constructor" })
    );

    expect(handlers.onDisconnect).toHaveBeenCalledWith("constructor");
  });

  it("disables a row's menu while that row's action is in flight", () => {
    renderSection({
      connections: [connection()],
      state: { ...IDLE, pending: true },
    });

    expect(
      screen.getByRole("button", { name: "GitHub sign-in options" })
    ).toBeDisabled();
  });
});
