import { SESSIONS_TAGS_COLUMN_ID } from "@repo/app/agents/lib/sessions-table-columns";
import { SESSIONS_COLUMN_LABELS } from "@repo/app/agents/lib/sessions-total-estimated-cost-columns";
import { DEFAULT_TABLE_PAGE_SIZE } from "@repo/design-system/components/ui/table-page-size-select";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { SessionsPrototypePreview } from "../sessions-prototype-preview";
import {
  createSessionsPrototypeApiRoutes,
  SESSIONS_PROTOTYPE_ROWS,
} from "../sessions-prototype-preview-fixtures";

afterEach(cleanup);

const OPTIONS_MENU_TRIGGER = { name: "Options" } as const;

describe("SessionsPrototypePreview", () => {
  it("fills the first page with varied, intentional session records", () => {
    expect(SESSIONS_PROTOTYPE_ROWS).toHaveLength(DEFAULT_TABLE_PAGE_SIZE);
    expect(new Set(SESSIONS_PROTOTYPE_ROWS.map((row) => row.status)).size).toBe(
      3
    );
    expect(SESSIONS_PROTOTYPE_ROWS.some((row) => row.branch === null)).toBe(
      true
    );
    expect(SESSIONS_PROTOTYPE_ROWS.some((row) => row.repo === null)).toBe(true);
    expect(SESSIONS_PROTOTYPE_ROWS.some((row) => row.user === null)).toBe(true);
    expect(SESSIONS_PROTOTYPE_ROWS.some((row) => row.name.length > 50)).toBe(
      true
    );
  });

  it("offers the Tags column its production hosts offer (whitlockk review, #9123)", async () => {
    const user = userEvent.setup();
    render(<SessionsPrototypePreview />);

    await user.click(screen.getByRole("button", OPTIONS_MENU_TRIGGER));

    expect(
      await screen.findByRole("menuitem", { name: tagsColumnLabel() })
    ).toBeInTheDocument();
  }, 20_000);

  it("navigates from the canonical list to its canonical detail and back", async () => {
    const user = userEvent.setup();
    const [firstRow] = SESSIONS_PROTOTYPE_ROWS;
    render(<SessionsPrototypePreview />);

    await user.click(screen.getByRole("link", { name: firstRow.name }));

    const breadcrumb = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(within(breadcrumb).getByText(firstRow.name)).toHaveAttribute(
      "aria-current",
      "page"
    );

    await user.click(
      within(breadcrumb).getByRole("link", { name: "Sessions" })
    );

    expect(within(breadcrumb).getByText("Sessions")).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(
      screen.getByRole("link", { name: firstRow.name })
    ).toBeInTheDocument();
  });

  it("keeps detail comments local across create, reply, edit, and delete", async () => {
    const routes = createSessionsPrototypeApiRoutes();
    const createRoute = requirePrototypeRoute(routes, "POST");
    const updateRoute = requirePrototypeRoute(routes, "PATCH");
    const deleteRoute = requirePrototypeRoute(routes, "DELETE");
    const listRoute = requirePrototypeRoute(routes, "GET");
    const draft = {
      anchor: {
        endOffset: 4,
        row: 1,
        selectedText: "test",
        sourceText: "test fixture",
        startOffset: 0,
        traceId: "prototype-trace",
        turnId: "prototype-turn",
      },
      body: "Review this trace.",
    };

    await createRoute.respond(
      prototypeRequest(
        "POST",
        "/agent-sessions/session-list-adapter/trace-comments",
        draft
      )
    );
    const replied = await createRoute.respond(
      prototypeRequest(
        "POST",
        "/agent-sessions/session-list-adapter/trace-comments/prototype-comment-1/replies",
        { body: "Confirmed." }
      )
    );
    expect(replied).toEqual(
      expect.objectContaining({
        replies: [expect.objectContaining({ body: "Confirmed." })],
      })
    );

    const edited = await updateRoute.respond(
      prototypeRequest(
        "PATCH",
        "/agent-sessions/session-list-adapter/trace-comments/prototype-comment-1",
        { body: "Updated review." }
      )
    );
    expect(edited).toEqual(
      expect.objectContaining({ body: "Updated review." })
    );

    await deleteRoute.respond(
      prototypeRequest(
        "DELETE",
        "/agent-sessions/session-list-adapter/trace-comments/prototype-comment-1"
      )
    );
    expect(
      await listRoute.respond(
        prototypeRequest(
          "GET",
          "/agent-sessions/session-list-adapter/trace-comments"
        )
      )
    ).toEqual([]);
  });

  it("lists only comments for the requested preview session", async () => {
    const routes = createSessionsPrototypeApiRoutes();
    const createRoute = requirePrototypeRoute(routes, "POST");
    const listRoute = requirePrototypeRoute(routes, "GET");
    const draft = {
      anchor: {
        endOffset: 4,
        row: 1,
        selectedText: "test",
        sourceText: "test fixture",
        startOffset: 0,
        traceId: "prototype-trace",
        turnId: "prototype-turn",
      },
      body: "Review this trace.",
    };

    await createRoute.respond(
      prototypeRequest(
        "POST",
        "/agent-sessions/session-list-adapter/trace-comments",
        draft
      )
    );
    await createRoute.respond(
      prototypeRequest(
        "POST",
        "/agent-sessions/desktop-implementation/trace-comments",
        { ...draft, body: "Review the desktop trace." }
      )
    );

    const firstComments = await listRoute.respond(
      prototypeRequest(
        "GET",
        "/agent-sessions/session-list-adapter/trace-comments"
      )
    );
    const secondComments = await listRoute.respond(
      prototypeRequest(
        "GET",
        "/agent-sessions/desktop-implementation/trace-comments"
      )
    );
    expect(firstComments).toEqual([
      expect.objectContaining({
        artifactId: "session-list-adapter",
        body: draft.body,
      }),
    ]);
    expect(secondComments).toEqual([
      expect.objectContaining({
        artifactId: "desktop-implementation",
        body: "Review the desktop trace.",
      }),
    ]);
  });
});

const SESSION_COMMENT_ROUTE_PATH = "/agent-sessions/*";

function requirePrototypeRoute(
  routes: ReturnType<typeof createSessionsPrototypeApiRoutes>,
  method: string
) {
  // The session comment routes; the prototype also serves the `/tags` vocabulary.
  const route = routes.find(
    (candidate) =>
      candidate.method === method &&
      candidate.path === SESSION_COMMENT_ROUTE_PATH
  );
  if (!route) {
    throw new Error(`Missing prototype ${method} route.`);
  }
  return route;
}

function prototypeRequest(method: string, pathname: string, body?: unknown) {
  return {
    body,
    method,
    pathname,
    search: "",
    searchParams: new URLSearchParams(),
  };
}

function tagsColumnLabel(): string {
  const label = SESSIONS_COLUMN_LABELS[SESSIONS_TAGS_COLUMN_ID];
  if (!label) {
    throw new Error("The Tags column has no menu label.");
  }
  return label;
}
