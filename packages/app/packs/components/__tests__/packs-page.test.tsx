/**
 * @file packs-page.test.tsx
 * @description Behavioral tests for the shared Packs page spine (FEA-4087
 * Slice 1): the capability-driven admin/member treatment pick and the
 * whole-page states (loading skeleton, error + retry, empty-org) the spine
 * owns. The realized treatments are stubbed here — this proves the spine, not
 * the sibling views (FEA-4088/4089).
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import {
  API_NO_RESPONSE_STATUS,
  API_TIMEOUT_ERROR_CODE,
  API_TIMEOUT_ERROR_MESSAGE,
} from "../../../shared/api/api-timeout";
import { createPacksContext, PacksMode } from "../../lib/packs-context";
import { PacksPage } from "../packs-page";

const adminView = <div data-testid="admin-view" />;
const memberView = <div data-testid="member-view" />;

describe("PacksPage spine", () => {
  it("renders the admin treatment when the context can manage distribution", () => {
    render(
      <PacksPage
        adminView={adminView}
        context={createPacksContext(PacksMode.WebAdmin)}
        memberView={memberView}
      />
    );

    expect(screen.getByTestId("admin-view")).toBeInTheDocument();
    expect(screen.queryByTestId("member-view")).toBeNull();
  });

  it("renders the member treatment for a member context", () => {
    render(
      <PacksPage
        adminView={adminView}
        context={createPacksContext(PacksMode.WebMember)}
        memberView={memberView}
      />
    );

    expect(screen.getByTestId("member-view")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-view")).toBeNull();
  });

  it("renders the member treatment for desktop solo (no manage capability)", () => {
    render(
      <PacksPage
        adminView={adminView}
        context={createPacksContext(PacksMode.DesktopSolo)}
        memberView={memberView}
      />
    );

    expect(screen.getByTestId("member-view")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-view")).toBeNull();
  });

  it("shows the page skeleton (and no treatment) while loading", () => {
    render(
      <PacksPage
        adminView={adminView}
        context={createPacksContext(PacksMode.WebAdmin)}
        isLoading
        memberView={memberView}
      />
    );

    expect(screen.getByTestId("packs-page-skeleton")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-view")).toBeNull();
  });

  it("shows a page-level error with a retry that fires onRetry", async () => {
    const onRetry = vi.fn();
    render(
      <PacksPage
        adminView={adminView}
        context={createPacksContext(PacksMode.WebAdmin)}
        isError
        memberView={memberView}
        onRetry={onRetry}
      />
    );

    expect(screen.getByText("Couldn't load packs")).toBeInTheDocument();
    expect(screen.queryByTestId("admin-view")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders the timeout treatment when the surface threads a client-deadline error", () => {
    // ISS-5013: without the `error` prop the spine can only ever render the
    // generic failed-read copy, which blames the user's connection for a
    // deadline we set.
    render(
      <PacksPage
        adminView={adminView}
        context={createPacksContext(PacksMode.WebAdmin)}
        error={
          new ApiError(API_TIMEOUT_ERROR_MESSAGE, API_NO_RESPONSE_STATUS, {
            code: API_TIMEOUT_ERROR_CODE,
          })
        }
        isError
        memberView={memberView}
      />
    );

    expect(screen.getByText("Packs took too long to load")).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load packs")).toBeNull();
  });

  it("omits the retry control when no onRetry is provided", () => {
    render(
      <PacksPage
        adminView={adminView}
        context={createPacksContext(PacksMode.WebAdmin)}
        isError
        memberView={memberView}
      />
    );

    expect(screen.getByText("Couldn't load packs")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("shows the empty-org state (and no treatment) when empty", () => {
    render(
      <PacksPage
        adminView={adminView}
        context={createPacksContext(PacksMode.WebMember)}
        isEmpty
        memberView={memberView}
      />
    );

    expect(screen.getByText("No packs yet")).toBeInTheDocument();
    expect(screen.queryByTestId("member-view")).toBeNull();
  });
});
