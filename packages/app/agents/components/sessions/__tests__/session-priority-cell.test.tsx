import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
import { PRIORITY_LABELS } from "@repo/design-system/lib/priority-order";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { createSessionTableRowFixture } from "../session-list-fixtures";
import { SessionPriorityCell } from "../session-priority-cell";

/**
 * ISS-10332: the Sessions `Priority` cell over the real write path — the
 * champion editor, the data-source port, `PATCH /agent-sessions/[id]` with the
 * priority keys ALONE plus the guard and the surface. Asserted from the test
 * body on what the transport received, not inside the fixture.
 */

const ROW = createSessionTableRowFixture({
  id: "55555555-5555-4555-8555-555555555551",
  priority: Priority.Low,
});

describe("SessionPriorityCell", () => {
  it("renders the empty glyph and no control for a producer that omitted the field", () => {
    render(<SessionPriorityCell row={createSessionTableRowFixture()} />);

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("renders the mark read-only where no data source can write", () => {
    render(<SessionPriorityCell row={ROW} />);

    expect(screen.getByText(PRIORITY_LABELS.LOW)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("writes the chosen priority alone, guarded by the shown value and attributed to the cell", async () => {
    const received: { path: string; body: unknown }[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "PATCH",
            path: "/agent-sessions/*",
            respond: (context: FixtureRequestContext) => {
              received.push({ path: context.pathname, body: context.body });
              return {};
            },
          },
        ]}
      >
        <SessionPriorityCell row={ROW} />
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button"));
    await user.click(
      await screen.findByRole("menuitem", { name: PRIORITY_LABELS.HIGH })
    );

    await waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].path).toBe(`/agent-sessions/${ROW.id}`);
    expect(received[0].body).toEqual({
      priority: Priority.High,
      expectedPriority: Priority.Low,
      surface: ArtifactStatusEditSurface.InlineCell,
    });
  });
});
