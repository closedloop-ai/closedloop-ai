import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { INLINE_EDIT_SAVE_ERROR_MESSAGE } from "@repo/app/shared/lib/inline-edit-save-error";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
import { userKeys } from "@repo/app/users/hooks/use-users";
import { useQuery } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HTTP_DATA_SOURCE_SCOPE } from "../../../data-source/agent-sessions-data-source";
import { agentSessionKeys } from "../../../hooks/agent-session-keys";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionNameLeadCell } from "../session-name-lead-cell";

/**
 * ISS-8718: the Sessions lead cell over the REAL write path — the ownership
 * gate, the data-source port, and `PATCH /agent-sessions/[id]` with the rename
 * keys ALONE plus the guard. Asserted from the test body on what the transport
 * received, not inside the fixture.
 *
 * A rejected draft stays in the field beside its alert (PRD-722). Source
 * capability and ownership remain the affordance gates.
 *
 * Every negative case asserts the LINK still renders beside the missing
 * control: this cell is the row's only route into the session, so a gate that
 * took the name with it would be a worse bug than the one it was gating.
 *
 * ## Why the viewer is SEEDED and not served
 *
 * The viewer arrives from `GET /me`, so a cell asked about ownership renders
 * the plain link for one beat before the answer lands. An absence asserted in
 * that beat passes whatever the gate does — this suite's first draft had
 * exactly that false green, and deleting the ownership check left it on. Seeding
 * `userKeys.currentUser()` makes the viewer synchronous, so every "no control"
 * assertion below is one the gate is genuinely load-bearing for.
 */

const VIEWER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "55555555-5555-4555-8555-555555555551";
const SESSION_NAME = "agent/refactor-auth-guard";
const EDIT_CONTROL = { name: `Edit session name for ${SESSION_NAME}` };
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { error: toastError, success: vi.fn() },
}));
const SESSION_LIST_KEY = agentSessionKeys.list(HTTP_DATA_SOURCE_SCOPE, {});

const SEEDED_VIEWER = [[userKeys.currentUser(), { id: VIEWER_ID }]] as const;

const OWNED_ROW = createSessionTableRowFixture({
  id: SESSION_ID,
  name: SESSION_NAME,
  user: { id: VIEWER_ID, name: "Marisol Ashgrove" },
});

function renameRoute(received: { path: string; body: unknown }[]) {
  return {
    method: "PATCH" as const,
    path: "/agent-sessions/*",
    respond: (context: FixtureRequestContext) => {
      received.push({ path: context.pathname, body: context.body });
      return {};
    },
  };
}

describe("SessionNameLeadCell", () => {
  it("keeps the narrow status glyph outside the session link's name", () => {
    render(
      <AppCoreStoryProviders queryData={SEEDED_VIEWER}>
        <SessionNameLeadCell
          getSessionHref={(row) => `/sessions/${row.id}`}
          row={OWNED_ROW}
          showStatusIcon
        />
      </AppCoreStoryProviders>
    );

    const link = screen.getByRole("link");
    expect(link).toHaveAccessibleName(SESSION_NAME);
    const glyph = link.parentElement?.querySelector("svg");
    expect(glyph).toBeTruthy();
    expect(link.contains(glyph ?? null)).toBe(false);
  });

  it("offers no edit control where no data source can write", () => {
    // No providers at all: no source, no query client. The bare table render.
    render(<SessionNameLeadCell row={OWNED_ROW} />);

    expect(screen.getByText(SESSION_NAME)).toBeInTheDocument();
    expect(screen.queryByRole("button", EDIT_CONTROL)).toBeNull();
  });

  it("offers no edit control to a viewer who does not own the session", () => {
    render(
      <AppCoreStoryProviders queryData={SEEDED_VIEWER}>
        <SessionNameLeadCell
          row={createSessionTableRowFixture({
            id: SESSION_ID,
            name: SESSION_NAME,
            user: {
              id: "22222222-2222-4222-8222-222222222222",
              name: "Someone Else",
            },
          })}
        />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(SESSION_NAME)).toBeInTheDocument();
    expect(screen.queryByRole("button", EDIT_CONTROL)).toBeNull();
  });

  it("offers the owner an edit control", () => {
    render(
      <AppCoreStoryProviders queryData={SEEDED_VIEWER}>
        <SessionNameLeadCell row={OWNED_ROW} />
      </AppCoreStoryProviders>
    );

    expect(screen.getByRole("button", EDIT_CONTROL)).toBeInTheDocument();
  });

  it("writes the new name alone, guarded by the name the owner was shown", async () => {
    const received: { path: string; body: unknown }[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={[renameRoute(received)]}
        queryData={SEEDED_VIEWER}
      >
        <SessionNameLeadCell row={OWNED_ROW} />
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", EDIT_CONTROL));
    const field = screen.getByRole("textbox", EDIT_CONTROL);
    await user.clear(field);
    await user.type(field, "auth guard rewrite{Enter}");

    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].path).toBe(`/agent-sessions/${SESSION_ID}`);
    // The rename keys ALONE: the route refuses a body pairing them with a
    // priority or a grouping field, so a stray key here is a 400 in production.
    expect(received[0].body).toEqual({
      name: "auth guard rewrite",
      expectedName: SESSION_NAME,
      surface: ArtifactStatusEditSurface.InlineCell,
    });
  });

  it("keeps the owner's typing in one field instead of re-selecting it per keystroke", async () => {
    // The callback ref is stable for this reason: an inline arrow is detached
    // and re-attached every render, and the remount's select() would make each
    // new character replace the whole draft — so this would read "e".
    render(
      <AppCoreStoryProviders
        apiRoutes={[renameRoute([])]}
        queryData={SEEDED_VIEWER}
      >
        <SessionNameLeadCell row={OWNED_ROW} />
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", EDIT_CONTROL));
    const field = screen.getByRole("textbox", EDIT_CONTROL);
    await user.clear(field);
    await user.type(field, "five");

    expect(field).toHaveValue("five");
  });

  it("writes nothing when Escape discards the edit, and keeps the old name", async () => {
    const received: { path: string; body: unknown }[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={[renameRoute(received)]}
        queryData={SEEDED_VIEWER}
      >
        <SessionNameLeadCell row={OWNED_ROW} />
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", EDIT_CONTROL));
    const field = screen.getByRole("textbox", EDIT_CONTROL);
    await user.clear(field);
    await user.type(field, "discarded{Escape}");

    // The field is gone, the name is back, and nothing was written.
    await waitFor(() =>
      expect(screen.queryByRole("textbox", EDIT_CONTROL)).toBeNull()
    );
    expect(screen.getByText(SESSION_NAME)).toBeInTheDocument();
    expect(received).toHaveLength(0);
  });

  it("does not seed the next edit with typing Escape discarded", async () => {
    // The outcome above holds because Escape UNMOUNTS the field and React fires
    // no blur for a removed node — so it stays green even with the draft revert
    // deleted, and on its own it pins nothing about that revert. This is the
    // case the revert is load-bearing for: re-opening must offer the committed
    // name, never the name the owner just threw away.
    render(
      <AppCoreStoryProviders
        apiRoutes={[renameRoute([])]}
        queryData={SEEDED_VIEWER}
      >
        <SessionNameLeadCell row={OWNED_ROW} />
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", EDIT_CONTROL));
    const field = screen.getByRole("textbox", EDIT_CONTROL);
    await user.clear(field);
    await user.type(field, "discarded{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("textbox", EDIT_CONTROL)).toBeNull()
    );

    await user.click(screen.getByRole("button", EDIT_CONTROL));
    expect(screen.getByRole("textbox", EDIT_CONTROL)).toHaveValue(SESSION_NAME);
  });

  it("writes nothing when the owner clears the field, and keeps the old name", async () => {
    const received: { path: string; body: unknown }[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={[renameRoute(received)]}
        queryData={SEEDED_VIEWER}
      >
        <SessionNameLeadCell row={OWNED_ROW} />
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", EDIT_CONTROL));
    const field = screen.getByRole("textbox", EDIT_CONTROL);
    await user.clear(field);
    await user.type(field, "   {Enter}");

    // The route refuses a blank name, so a request here buys a 400 and a flash
    // of a name the row never held.
    expect(received).toHaveLength(0);
    expect(screen.getByText(SESSION_NAME)).toBeInTheDocument();
  });

  it("keeps the refused draft when the real query cache echoes and rolls back the attempt", async () => {
    const attempts = { count: 0 };
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
              attempts.count += 1;
              await refusalGate;
              throw new Error("refused");
            },
          },
        ]}
        queryData={[
          ...SEEDED_VIEWER,
          [SESSION_LIST_KEY, { items: [OWNED_ROW], total: 1 }],
        ]}
      >
        <CachedSessionNameLeadCell />
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", EDIT_CONTROL));
    const field = screen.getByRole("textbox", EDIT_CONTROL);
    await user.clear(field);
    await user.type(field, "never lands{Enter}");

    await waitFor(() => expect(attempts.count).toBe(1));
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
    expect(field).toHaveAccessibleDescription(INLINE_EDIT_SAVE_ERROR_MESSAGE);
    expect(screen.getByRole("alert")).toHaveTextContent(
      INLINE_EDIT_SAVE_ERROR_MESSAGE
    );
  });

  it("restores the shared toast when Escape closes a pending rename editor", async () => {
    toastError.mockClear();
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
        queryData={[
          ...SEEDED_VIEWER,
          [SESSION_LIST_KEY, { items: [OWNED_ROW], total: 1 }],
        ]}
      >
        <CachedSessionNameLeadCell />
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

    fireEvent.keyDown(field, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("textbox", EDIT_CONTROL)).toBeNull()
    );
    await act(async () => {
      releaseRefusal?.();
      await refusalGate;
    });

    await waitFor(() => expect(toastError).toHaveBeenCalledOnce());
  });
});

function CachedSessionNameLeadCell() {
  const cached = useQuery({
    queryFn: () =>
      Promise.resolve({
        items: [OWNED_ROW],
        total: 1,
      }),
    queryKey: SESSION_LIST_KEY,
  });
  const row = cached.data?.items[0];
  if (!row) {
    return null;
  }
  return (
    <>
      <span data-testid="cached-session-name">{row.name}</span>
      <SessionNameLeadCell row={row} />
    </>
  );
}

describe("SessionNameLeadCell owner is the assignee (ISS-12251 T-4.5)", () => {
  const OTHER = { id: "22222222-2222-4222-8222-222222222222", name: "Other" };

  it("offers the assignee an edit control when someone else recorded the session", () => {
    render(
      <AppCoreStoryProviders queryData={SEEDED_VIEWER}>
        <SessionNameLeadCell
          row={createSessionTableRowFixture({
            id: SESSION_ID,
            name: SESSION_NAME,
            owner: { id: VIEWER_ID, name: "Marisol Ashgrove" },
            user: OTHER,
          })}
        />
      </AppCoreStoryProviders>
    );

    expect(screen.getByRole("button", EDIT_CONTROL)).toBeInTheDocument();
  });

  it("offers the recording user no edit control once someone else is the assignee", () => {
    render(
      <AppCoreStoryProviders queryData={SEEDED_VIEWER}>
        <SessionNameLeadCell
          row={createSessionTableRowFixture({
            id: SESSION_ID,
            name: SESSION_NAME,
            owner: OTHER,
            user: { id: VIEWER_ID, name: "Marisol Ashgrove" },
          })}
        />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(SESSION_NAME)).toBeInTheDocument();
    expect(screen.queryByRole("button", EDIT_CONTROL)).toBeNull();
  });
});

describe("SessionNameLeadCell grid wiring", () => {
  it("declares the rename control as the cell's grid entry target", () => {
    // The cell holds the session LINK and this button. `grid-cell-keyboard.ts`
    // enters a cell at its declared `data-grid-primary-editor`, else at the
    // first operable node — the link — so without the marker Enter on a focused
    // lead cell navigates instead of opening the editor.
    render(
      <AppCoreStoryProviders
        apiRoutes={[renameRoute([])]}
        queryData={SEEDED_VIEWER}
      >
        <SessionNameLeadCell row={OWNED_ROW} />
      </AppCoreStoryProviders>
    );

    const control = screen.getByRole("button", EDIT_CONTROL);
    expect(control).toHaveAttribute("data-grid-primary-editor");
    // And it must be the ONLY one in the cell: two markers reintroduce exactly
    // the DOM-order ambiguity the attribute exists to remove.
    // `parentElement` is the reveal wrapper itself, so this stays pinned to the
    // cell rather than to whichever element name the wrapper happens to use.
    expect(
      control.parentElement?.querySelectorAll("[data-grid-primary-editor]")
    ).toHaveLength(1);
  });
});
