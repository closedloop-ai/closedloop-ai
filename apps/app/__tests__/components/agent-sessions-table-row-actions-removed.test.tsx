/**
 * ISS-5315: the per-row overflow (⋯) menu is gone from the PRIMARY web
 * `/sessions` table adapter (`apps/app/components/agent-sessions/sessions-table.tsx`).
 *
 * Why this pins the ADAPTER and not the shared table: this route mounts its OWN
 * wrapper, so adapter behavior has to be asserted on the adapter — the sibling
 * `agent-sessions-table-duration-zero-span.test.tsx` exists for the same reason,
 * one flag earlier.
 *
 * ISS-6239 then deleted `SessionRowActionsMenu` and the `renderRowActions` seam
 * the shared table grew its actions column for, so nothing in the repo can
 * render that trigger any more. "Session actions" was the menu's accessible
 * name, and asserting the ROLE+NAME rather than the glyph means this still fails
 * if the menu comes back wearing a different icon.
 */
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SessionsTable } from "@/components/agent-sessions/sessions-table";

vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const ROW_NAME = "Locate DESKTOP_SESSION_JWT_SECRET";

const item = createAgentSessionListItemFixture({
  id: "web-row-actions-removed",
  name: ROW_NAME,
  branch: "feat/auth-guard",
});

describe("Web Sessions table adapter — row overflow menu removed (ISS-5315)", () => {
  it("renders no per-row actions trigger", () => {
    render(
      <SessionsTable
        getSessionHref={(row) => `/acme/sessions/${row.id}`}
        items={[item]}
        mode="expanded"
      />,
      { wrapper: AppCoreStoryProviders }
    );

    // The row itself rendered — otherwise "no trigger" would be vacuously true
    // for an empty table.
    expect(screen.getByRole("link", { name: ROW_NAME })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Session actions" })
    ).toBeNull();
  });
});
