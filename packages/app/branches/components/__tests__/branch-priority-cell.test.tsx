import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import type { FixtureRequestContext } from "@repo/app/shared/storybook/fixture-fetch";
import { PRIORITY_LABELS } from "@repo/design-system/lib/priority-order";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { branchRow } from "../../lib/__tests__/branch-row-fixture";
import { BranchPriorityCell } from "../branch-priority-cell";

/**
 * ISS-10332: the Branches `Priority` cell over the real write path — the
 * champion editor, the data-source port, `PATCH /branches/[id]` keyed on the
 * CLOUD artifact id with the guard and the surface. Asserted from the test
 * body on what the transport received.
 */

const ARTIFACT_ID = "66666666-6666-4666-8666-666666666661";
const ROW = branchRow({
  id: "local-id",
  artifactId: ARTIFACT_ID,
  priority: Priority.Low,
});

describe("BranchPriorityCell", () => {
  it("renders the surface's Unavailable word and no control for an omitted field", () => {
    render(<BranchPriorityCell item={branchRow()} readOnly={false} />);

    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders the mark read-only when the host says so, even with a writable source", () => {
    render(
      <AppCoreStoryProviders>
        <BranchPriorityCell item={ROW} readOnly />
      </AppCoreStoryProviders>
    );

    expect(screen.getByText(PRIORITY_LABELS.LOW)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("writes through the cloud artifact id, guarded by the shown value and attributed to the cell", async () => {
    const received: { path: string; body: unknown }[] = [];
    render(
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "PATCH",
            path: "/branches/*",
            respond: (context: FixtureRequestContext) => {
              received.push({ path: context.pathname, body: context.body });
              return { id: ARTIFACT_ID, priority: Priority.Urgent };
            },
          },
        ]}
      >
        <BranchPriorityCell item={ROW} readOnly={false} />
      </AppCoreStoryProviders>
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button"));
    await user.click(
      await screen.findByRole("menuitem", { name: PRIORITY_LABELS.URGENT })
    );

    await waitFor(() => expect(received).toHaveLength(1));
    // The artifact id, never the row's local id.
    expect(received[0].path).toBe(`/branches/${ARTIFACT_ID}`);
    expect(received[0].body).toEqual({
      priority: Priority.Urgent,
      expectedPriority: Priority.Low,
      surface: ArtifactStatusEditSurface.InlineCell,
    });
  });
});
