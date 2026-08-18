/**
 * Regression for ISS-5976: a focus-triggered refetch must not discard the Linear
 * team the user deliberately picked.
 *
 * `LinearExportDialog` auto-selects a default team from `useLinearIntegrationStatus`
 * in an effect keyed on the whole `status` query object. Now that the shared query
 * client refetches on window focus, that query hands back a NEW object carrying
 * the same teams whenever the user tabs away and back — so an unconditional
 * re-select would silently snap the dropdown from the team they chose back to the
 * default, with the export button still armed. The selection is only auto-filled
 * when there is nothing valid to preserve.
 */

import type { LinearTeam } from "@repo/api/src/types/linear";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {
      // jsdom no-op
    }
    unobserve() {
      // jsdom no-op
    }
    disconnect() {
      // jsdom no-op
    }
  } as unknown as typeof ResizeObserver;

  // Radix UI Select requires pointer-capture and scroll APIs jsdom lacks.
  if (typeof Element !== "undefined") {
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.setPointerCapture ??= () => {
      // jsdom no-op
    };
    Element.prototype.releasePointerCapture ??= () => {
      // jsdom no-op
    };
    Element.prototype.scrollIntoView ??= () => {
      // jsdom no-op
    };
  }
});

const mocks = vi.hoisted(() => ({
  exportMutateAsync: vi.fn(),
  refetch: vi.fn(),
  status: undefined as unknown,
}));

vi.mock("@repo/app/linear/hooks/use-linear", () => ({
  useExportToLinear: () => ({
    isPending: false,
    mutateAsync: mocks.exportMutateAsync,
  }),
  useLinearIntegrationStatus: () => ({
    data: mocks.status,
    isLoading: false,
    refetch: mocks.refetch,
  }),
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "closedloop-ai",
}));

import { LinearExportDialog } from "../../app/(authenticated)/[orgSlug]/implementation-plans/[slug]/components/linear-export-dialog";

/** Options render as `${name} (${key})`, so this is the exact option text. */
const CHOSEN_OPTION_LABEL = "Chosen Team (CHO)";

const TEAMS: LinearTeam[] = [
  { id: "team-default", key: "DEF", name: "Default Team" },
  { id: "team-chosen", key: "CHO", name: "Chosen Team" },
];

/**
 * A fresh status OBJECT carrying identical data — exactly what a focus refetch
 * produces. The object identity is the whole point, so this must not be hoisted
 * into a shared constant.
 */
function statusFixture() {
  return {
    connected: true,
    defaultTeamId: "team-default",
    teams: TEAMS.map((team) => ({ ...team })),
  };
}

function renderDialog() {
  return render(
    <LinearExportDialog
      documentId="doc-1"
      onOpenChange={() => {
        // Open is pinned; this case is about a refetch while the dialog stays open.
      }}
      open={true}
    />
  );
}

describe("LinearExportDialog team selection across a refetch (ISS-5976)", () => {
  beforeEach(() => {
    mocks.status = statusFixture();
    mocks.refetch.mockReset();
    mocks.exportMutateAsync.mockReset();
  });

  it("keeps the user's chosen team when the status query object is replaced", async () => {
    const user = userEvent.setup({
      // The open Radix Dialog sets `pointer-events: none` on ancestors, which
      // userEvent's default actionability check reads as "not clickable".
      pointerEventsCheck: 0,
    });
    const { rerender } = renderDialog();

    // The default lands first.
    await waitFor(() =>
      expect(screen.getByRole("combobox")).toHaveTextContent("Default Team")
    );

    // The user deliberately picks a different team.
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByText(CHOSEN_OPTION_LABEL));
    await waitFor(() =>
      expect(screen.getByRole("combobox")).toHaveTextContent("Chosen Team")
    );

    // A focus refetch returns the same teams in a new object.
    mocks.status = statusFixture();
    rerender(
      <LinearExportDialog
        documentId="doc-1"
        onOpenChange={() => {
          // See above.
        }}
        open={true}
      />
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("Chosen Team");
  });

  it("re-fills the selection when the chosen team disappears from the refreshed list", async () => {
    // The guard preserves a still-VALID choice, not any choice: a team the user
    // no longer has access to must not be left selected and exported against.
    const user = userEvent.setup({
      // The open Radix Dialog sets `pointer-events: none` on ancestors, which
      // userEvent's default actionability check reads as "not clickable".
      pointerEventsCheck: 0,
    });
    const { rerender } = renderDialog();

    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByText(CHOSEN_OPTION_LABEL));
    await waitFor(() =>
      expect(screen.getByRole("combobox")).toHaveTextContent("Chosen Team")
    );

    mocks.status = {
      connected: true,
      defaultTeamId: "team-default",
      teams: [{ ...TEAMS[0] }],
    };
    rerender(
      <LinearExportDialog
        documentId="doc-1"
        onOpenChange={() => {
          // See above.
        }}
        open={true}
      />
    );

    await waitFor(() =>
      expect(screen.getByRole("combobox")).toHaveTextContent("Default Team")
    );
  });
});
