// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Stub the Liveblocks `InboxNotification.Custom` so the test can render the
// domain component without a full Liveblocks provider tree. The stub surfaces
// the `title` node and the `href` link target as inspectable DOM, which is
// exactly the contract FEA-3969 changes: the visible title must be readable and
// the raw session UUID may appear only as the link href.
vi.mock("@liveblocks/react-ui", () => ({
  InboxNotification: {
    Custom: ({
      title,
      href,
      children,
    }: {
      title: ReactNode;
      href: string;
      children: ReactNode;
    }) => (
      <a data-testid="notification" href={href}>
        <span data-testid="title">{title}</span>
        {children}
      </a>
    ),
  },
}));

const SESSION_UUID = "f9bdb32c-bebc-4d2a-a416-4f07a7a6b85e";
const SESSION_URL = `https://app.example.com/sessions/${SESSION_UUID}`;

type ActivityData = { sessionTitle?: unknown; sessionUrl?: string };

function makeNotification(data: ActivityData) {
  return {
    id: "in_1",
    kind: "$awaitingInput" as const,
    activities: [{ id: "ac_1", data }],
  };
}

async function renderNotification(data: ActivityData) {
  const { AwaitingInputNotification } = await import(
    "../client/awaiting-input-notification"
  );
  // The runtime shape (a partial Liveblocks notification) is looser than the
  // component's prop type; the component only reads activities[0].data. Cast
  // through the prop type of the component itself so no `any` is introduced.
  type Props = Parameters<typeof AwaitingInputNotification>[0];
  const notification = makeNotification(
    data
  ) as unknown as Props["inboxNotification"];
  render(<AwaitingInputNotification inboxNotification={notification} />);
}

describe("AwaitingInputNotification", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("renders a real session title as the visible label", async () => {
    await renderNotification({
      sessionTitle: "Fix the login flow",
      sessionUrl: SESSION_URL,
    });
    expect(screen.getByTestId("title")).toHaveTextContent(
      "Fix the login flow needs your input"
    );
  });

  it("keeps the session UUID out of the visible label, using it only as the link target (FEA-3969)", async () => {
    await renderNotification({
      sessionTitle: SESSION_UUID,
      sessionUrl: SESSION_URL,
    });

    const title = screen.getByTestId("title");
    expect(title).toHaveTextContent("Untitled session needs your input");
    expect(title.textContent).not.toContain(SESSION_UUID);

    // The UUID survives as the link href only.
    expect(screen.getByTestId("notification")).toHaveAttribute(
      "href",
      SESSION_URL
    );
  });

  it("renders the readable fallback when no title is present", async () => {
    await renderNotification({ sessionUrl: SESSION_URL });
    const title = screen.getByTestId("title");
    expect(title).toHaveTextContent("Untitled session needs your input");
    expect(title.textContent).not.toContain(SESSION_UUID);
  });

  it("keeps the legacy synthetic `Session <uuid>` name out of the visible label (FEA-3969)", async () => {
    // The sync producer names unnamed sessions `Session <externalSessionId>`,
    // and persisted notifications carry that whole value as `sessionTitle`.
    await renderNotification({
      sessionTitle: `Session ${SESSION_UUID}`,
      sessionUrl: SESSION_URL,
    });

    const title = screen.getByTestId("title");
    expect(title).toHaveTextContent("Untitled session needs your input");
    expect(title.textContent).not.toContain(SESSION_UUID);

    // The UUID survives as the link href only.
    expect(screen.getByTestId("notification")).toHaveAttribute(
      "href",
      SESSION_URL
    );
  });
});
