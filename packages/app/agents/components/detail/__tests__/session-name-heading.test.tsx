import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import type { BasicUser } from "@repo/api/src/types/user";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
import { userKeys } from "@repo/app/users/hooks/use-users";
import { useQuery } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { HTTP_DATA_SOURCE_SCOPE } from "../../../data-source/agent-sessions-data-source";
import { agentSessionKeys } from "../../../hooks/agent-session-keys";
import { SessionNameHeading } from "../session-name-heading";

/**
 * ISS-8718: Session detail's heading must answer the SAME gate as the list's
 * lead cell — a session renameable in one place and not the other is the
 * cross-surface inconsistency `packages/app/AGENTS.md` forbids. The viewer is
 * seeded for the reason the lead-cell suite seeds it: an absence asserted while
 * `GET /me` is still in flight passes whatever the gate does.
 */

const VIEWER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "55555555-5555-4555-8555-555555555551";
const SESSION_NAME = "agent/refactor-auth-guard";
const EDIT_CONTROL = { name: `Edit session name for ${SESSION_NAME}` };
const SESSION_DETAIL_KEY = agentSessionKeys.detail(
  HTTP_DATA_SOURCE_SCOPE,
  SESSION_ID
);
const SEEDED_VIEWER = [[userKeys.currentUser(), { id: VIEWER_ID }]] as const;

/** `BasicUser` carries no display name of its own — the row mapper derives one. */
function basicUser(id: string): BasicUser {
  return {
    avatarUrl: null,
    email: `${id}@example.test`,
    firstName: null,
    id,
    lastName: null,
  };
}

function sessionDetail(
  overrides: Partial<AgentSessionDetail> = {}
): AgentSessionDetail {
  return {
    externalSessionId: "ext-1",
    id: SESSION_ID,
    name: SESSION_NAME,
    user: basicUser(VIEWER_ID),
    ...overrides,
  } as AgentSessionDetail;
}

function renameRoute(received: { body: unknown }[]) {
  return {
    method: "PATCH" as const,
    path: "/agent-sessions/*",
    respond: (context: FixtureRequestContext) => {
      received.push({ body: context.body });
      return {};
    },
  };
}

describe("SessionNameHeading", () => {
  it("renders the heading with no control for a non-owner", () => {
    render(
      <AppCoreStoryProviders queryData={SEEDED_VIEWER}>
        <SessionNameHeading
          session={sessionDetail({
            user: basicUser("22222222-2222-4222-8222-222222222222"),
          })}
          title={SESSION_NAME}
        />
      </AppCoreStoryProviders>
    );

    expect(
      screen.getByRole("heading", { level: 1, name: SESSION_NAME })
    ).toHaveTextContent(SESSION_NAME);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("button", EDIT_CONTROL)).toBeNull();
  });

  it("offers the assignee the control when someone else recorded the session (ISS-12251 T-4.5)", () => {
    render(
      <AppCoreStoryProviders queryData={SEEDED_VIEWER}>
        <SessionNameHeading
          session={sessionDetail({
            assignee: basicUser(VIEWER_ID),
            user: basicUser("22222222-2222-4222-8222-222222222222"),
          })}
          title={SESSION_NAME}
        />
      </AppCoreStoryProviders>
    );

    expect(screen.getByRole("button", EDIT_CONTROL)).toBeInTheDocument();
  });

  it("offers the recording user no control once someone else is the assignee (ISS-12251 T-4.5)", () => {
    render(
      <AppCoreStoryProviders queryData={SEEDED_VIEWER}>
        <SessionNameHeading
          session={sessionDetail({
            assignee: basicUser("22222222-2222-4222-8222-222222222222"),
          })}
          title={SESSION_NAME}
        />
      </AppCoreStoryProviders>
    );

    expect(
      screen.getByRole("heading", { level: 1, name: SESSION_NAME })
    ).toHaveTextContent(SESSION_NAME);
    expect(screen.queryByRole("button", EDIT_CONTROL)).toBeNull();
  });

  it("offers no control for a session that has only an external id to show", () => {
    // The heading falls back to the external session id, which is an IDENTIFIER
    // standing in for a name. Seeding an editor with it would pre-fill a rename
    // with something the owner never chose.
    render(
      <AppCoreStoryProviders queryData={SEEDED_VIEWER}>
        <SessionNameHeading
          session={sessionDetail({ name: null })}
          title="ext-1"
        />
      </AppCoreStoryProviders>
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "ext-1" })
    ).toHaveTextContent("ext-1");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("lets the owner rename from the heading, guarded by the shown name", async () => {
    const received: { body: unknown }[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={[renameRoute(received)]}
        queryData={SEEDED_VIEWER}
      >
        <SessionNameHeading session={sessionDetail()} title={SESSION_NAME} />
      </AppCoreStoryProviders>
    );

    // The half the `<h1>` ruling is about, and it is named from REAL TEXT —
    // `textContent`, not an accname quirk over an empty heading. One `<h1>`,
    // for the owner exactly as for everyone else.
    const h1 = screen.getByRole("heading", { level: 1, name: SESSION_NAME });
    expect(h1).toHaveTextContent(SESSION_NAME);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    const user = userEvent.setup();
    // The owner's title is editable inline, which is the other half of the
    // ruling: the resting heading carries the pencil, and activating it swaps
    // the text for the field.
    await user.click(screen.getByRole("button", EDIT_CONTROL));
    const field = screen.getByRole("textbox", EDIT_CONTROL);
    await user.clear(field);
    await user.type(field, "auth guard rewrite{Enter}");

    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].body).toEqual({
      name: "auth guard rewrite",
      expectedName: SESSION_NAME,
      surface: ArtifactStatusEditSurface.Detail,
    });
  });

  it("keeps typing after Enter and guards the next rename with the accepted name", async () => {
    const received: { body: unknown }[] = [];
    let acceptFirst: (() => void) | undefined;
    const acceptanceGate = new Promise<void>((resolve) => {
      acceptFirst = resolve;
    });
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "PATCH",
            path: "/agent-sessions/*",
            respond: async (context: FixtureRequestContext) => {
              received.push({ body: context.body });
              if (received.length === 1) {
                await acceptanceGate;
              }
              return {};
            },
          },
        ]}
        queryData={SEEDED_VIEWER}
      >
        <SessionNameHeading session={sessionDetail()} title={SESSION_NAME} />
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", EDIT_CONTROL));
    const field = screen.getByRole("textbox", EDIT_CONTROL);
    await user.clear(field);
    await user.type(field, "first rename{Enter}");
    await waitFor(() => expect(received).toHaveLength(1));
    await user.clear(field);
    await user.type(field, "continued typing");

    await act(async () => {
      acceptFirst?.();
      await acceptanceGate;
    });
    expect(field).toHaveValue("continued typing");

    await user.type(field, "{Enter}");
    await waitFor(() => expect(received).toHaveLength(2));
    expect(received).toEqual([
      {
        body: {
          expectedName: SESSION_NAME,
          name: "first rename",
          surface: ArtifactStatusEditSurface.Detail,
        },
      },
      {
        body: {
          expectedName: "first rename",
          name: "continued typing",
          surface: ArtifactStatusEditSurface.Detail,
        },
      },
    ]);
  });

  it("keeps the refused draft when the real detail cache echoes and rolls back the attempt", async () => {
    let releaseRefusal: (() => void) | undefined;
    const refusalGate = new Promise<void>((resolve) => {
      releaseRefusal = resolve;
    });
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "PATCH",
            path: "/agent-sessions/*",
            respond: async () => {
              await refusalGate;
              throw new Error("refused");
            },
          },
        ]}
        queryData={[...SEEDED_VIEWER, [SESSION_DETAIL_KEY, sessionDetail()]]}
      >
        <CachedSessionNameHeading />
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", EDIT_CONTROL));
    const field = screen.getByRole("textbox", EDIT_CONTROL);
    await user.clear(field);
    await user.type(field, "never lands{Enter}");

    await waitFor(() =>
      expect(screen.getByTestId("cached-session-name")).toHaveTextContent(
        "never lands"
      )
    );
    await act(async () => {
      releaseRefusal?.();
      await refusalGate;
    });
    await waitFor(() =>
      expect(screen.getByTestId("cached-session-name")).toHaveTextContent(
        SESSION_NAME
      )
    );
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveValue("never lands");
    expect(field).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  /** A name has no clear-to-unset reading, so the shared name cell cancels it. */
  it("refuses a cleared name instead of writing one, and keeps the previous name", async () => {
    const received: { body: unknown }[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={[renameRoute(received)]}
        queryData={SEEDED_VIEWER}
      >
        <SessionNameHeading session={sessionDetail()} title={SESSION_NAME} />
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", EDIT_CONTROL));
    const field = screen.getByRole("textbox", EDIT_CONTROL);
    await user.clear(field);
    await user.type(field, "{Enter}");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: SESSION_NAME })
      ).toBeInTheDocument()
    );
    expect(received).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /** Whitespace only is the same cancellation after the cell trims the draft. */
  it("refuses a whitespace-only name", async () => {
    const received: { body: unknown }[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={[renameRoute(received)]}
        queryData={SEEDED_VIEWER}
      >
        <SessionNameHeading session={sessionDetail()} title={SESSION_NAME} />
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", EDIT_CONTROL));
    const field = screen.getByRole("textbox", EDIT_CONTROL);
    await user.clear(field);
    await user.type(field, "   {Enter}");

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: SESSION_NAME })
      ).toBeInTheDocument()
    );
    expect(received).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /**
   * A padded name is no rename, so it spends no request — the same answer the
   * list cell gives, so one gesture cannot write on one surface and not the
   * other.
   */
  it("writes nothing for a name that differs only by surrounding whitespace", async () => {
    const received: { body: unknown }[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={[renameRoute(received)]}
        queryData={SEEDED_VIEWER}
      >
        <SessionNameHeading session={sessionDetail()} title={SESSION_NAME} />
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", EDIT_CONTROL));
    const field = screen.getByRole("textbox", EDIT_CONTROL);
    await user.clear(field);
    await user.type(field, `  ${SESSION_NAME}  {Enter}`);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { level: 1, name: SESSION_NAME })
      ).toBeInTheDocument()
    );
    expect(received).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

function CachedSessionNameHeading() {
  const cached = useQuery({
    queryFn: () => Promise.resolve(sessionDetail()),
    queryKey: SESSION_DETAIL_KEY,
  });
  const session = cached.data;
  if (!session) {
    return null;
  }
  return (
    <>
      <span data-testid="cached-session-name">{session.name}</span>
      <SessionNameHeading
        session={session}
        title={session.name ?? session.externalSessionId}
      />
    </>
  );
}
