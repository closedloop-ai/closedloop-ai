import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentsView } from "../documents-view";

const mocks = vi.hoisted(() => ({
  state: { status: "authenticated", organizationId: "org-1" as string | null },
  beginSignIn: vi.fn(),
  listing: vi.fn(),
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: mocks.state,
    beginSignIn: mocks.beginSignIn,
  }),
}));
vi.mock("@repo/app/documents/components/index/documents-index-surface", () => ({
  DocumentsIndexSurface: (props: {
    renderHeader: (action: ReactNode) => ReactNode;
  }) => {
    mocks.listing();
    return (
      <>
        {props.renderHeader(<button type="button">Add document</button>)}
        <div>Shared Documents listing</div>
      </>
    );
  },
}));
beforeEach(() => {
  mocks.state.status = "authenticated";
  mocks.state.organizationId = "org-1";
  vi.clearAllMocks();
});
describe("native Documents listing", () => {
  it("mounts the canonical shared list and its create action for a signed-in organization", () => {
    render(<DocumentsView />);
    expect(screen.getByText("Shared Documents listing")).toBeDefined();
    expect(screen.getByRole("button", { name: "Add document" })).toBeDefined();
  });
  it("waits for authentication without mounting cloud reads", () => {
    mocks.state.status = "loading";
    render(<DocumentsView />);
    expect(mocks.listing).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
  });
  it.each(["signed_out", "refresh_failed"])(
    "offers sign-in for %s without mounting the list",
    (status) => {
      mocks.state.status = status;
      render(<DocumentsView />);
      expect(mocks.listing).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      expect(mocks.beginSignIn).toHaveBeenCalledOnce();
    }
  );
  it("does not mount an organization list when no organization is selected", () => {
    mocks.state.organizationId = null;
    render(<DocumentsView />);
    expect(mocks.listing).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDefined();
  });
  it("AC-006 AC-011 keeps Desktop on its non-project list without hierarchy placement", () => {
    render(<DocumentsView />);
    expect(screen.getByText("Shared Documents listing")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Reorder row" })).toBeNull();
  });
});
