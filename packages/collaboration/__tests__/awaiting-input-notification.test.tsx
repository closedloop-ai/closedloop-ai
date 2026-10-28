// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Shared `@liveblocks/react-ui` stand-in; see the module for what it models.
vi.mock(
  "@liveblocks/react-ui",
  () => import("./support/liveblocks-react-ui-stub")
);

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

  it("pins current behavior: an activity with no session URL renders an empty href", async () => {
    // Pins what main does, not a contract. An empty href links back to the
    // current page, so this row is clickable and goes nowhere. ISS-12566
    // tracks the missing-URL handling; change this case when that lands.
    await renderNotification({ sessionTitle: "Fix the login flow" });

    expect(screen.getByTestId("notification")).toHaveAttribute("href", "");
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
