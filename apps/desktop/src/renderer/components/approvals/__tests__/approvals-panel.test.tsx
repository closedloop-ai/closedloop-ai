import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalsPanel } from "../ApprovalsPanel";
import {
  installApprovalsApi,
  PENDING_APPROVAL,
  restoreDesktopApi,
} from "./install-approvals-api";

// FEA-3988: the two zero-data reads (pending approvals / always-allow rules)
// route through the shared `EmptyState` (title + description + a tokenized
// icon) instead of bare card-wrapped "No pending approvals" /
// "No always-allow rules" strings, matching the canonical empty-state scale
// used across the shared list/panel surfaces.

afterEach(restoreDesktopApi);

describe("ApprovalsPanel empty states (FEA-3988)", () => {
  it("renders the shared EmptyState with icons + copy for both zero-data sections", async () => {
    installApprovalsApi({});
    const { container } = render(<ApprovalsPanel />);

    await waitFor(() => {
      expect(screen.getByText("No pending approvals")).toBeTruthy();
    });
    expect(screen.getByText("No always-allow rules")).toBeTruthy();
    // The canonical EmptyState carries a description + a glyph the old bare
    // <CardContent>text</CardContent> never had.
    expect(
      screen.getByText("Requests that need your approval will appear here.")
    ).toBeTruthy();
    expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * ISS-5301: the populated states either side of those empty states. The panel
 * gates local execution, so what it renders per pending request — and whether a
 * decision actually reaches the main process — is the behavior that matters.
 */

const EXPIRES_LINE = /^Expires /;

describe("ApprovalsPanel — pending requests", () => {
  it("shows a loading state before the first read lands", () => {
    installApprovalsApi({});
    render(<ApprovalsPanel />);

    expect(screen.getByText("Loading approvals...")).toBeTruthy();
  });

  it("renders the reason, request path, and risk tier of each request", async () => {
    installApprovalsApi({ approvals: [PENDING_APPROVAL] });
    render(<ApprovalsPanel />);

    expect(
      await screen.findByText("Run `pnpm build` in ~/code/app")
    ).toBeTruthy();
    expect(screen.getByText("/api/gateway/exec")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
  });

  it("labels a request that carries no risk tier as unknown", async () => {
    installApprovalsApi({
      approvals: [{ id: "approval-2", reason: "Unclassified request" }],
    });
    render(<ApprovalsPanel />);

    expect(await screen.findByText("Unclassified request")).toBeTruthy();
    // Never blank: an unlabelled tier still has to read as un-assessed.
    expect(screen.getByText("unknown")).toBeTruthy();
  });

  it("sends an approve decision for the right request", async () => {
    const api = installApprovalsApi({ approvals: [PENDING_APPROVAL] });
    render(<ApprovalsPanel />);
    await screen.findByText("Run `pnpm build` in ~/code/app");

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(api.approveApproval).toHaveBeenCalledWith("approval-1");
    });
  });

  it("sends a deny decision for the right request", async () => {
    const api = installApprovalsApi({ approvals: [PENDING_APPROVAL] });
    render(<ApprovalsPanel />);
    await screen.findByText("Run `pnpm build` in ~/code/app");

    fireEvent.click(screen.getByRole("button", { name: "Deny" }));

    await waitFor(() => {
      expect(api.denyApproval).toHaveBeenCalledWith("approval-1");
    });
  });

  it("sends an always-allow grant for the right request", async () => {
    const api = installApprovalsApi({ approvals: [PENDING_APPROVAL] });
    render(<ApprovalsPanel />);
    await screen.findByText("Run `pnpm build` in ~/code/app");

    fireEvent.click(screen.getByRole("button", { name: "Always Allow" }));

    await waitFor(() => {
      expect(api.alwaysAllowApproval).toHaveBeenCalledWith("approval-1");
    });
  });

  it("clears the queue and re-reads it", async () => {
    const api = installApprovalsApi({ approvals: [PENDING_APPROVAL] });
    render(<ApprovalsPanel />);
    await screen.findByText("Run `pnpm build` in ~/code/app");
    const readsBefore = api.getPendingApprovals.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Clear Queue" }));

    await waitFor(() => {
      expect(api.clearPendingApprovals).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(api.getPendingApprovals.mock.calls.length).toBeGreaterThan(
        readsBefore
      );
    });
  });

  it("re-reads on Refresh", async () => {
    const api = installApprovalsApi({ approvals: [PENDING_APPROVAL] });
    render(<ApprovalsPanel />);
    await screen.findByText("Run `pnpm build` in ~/code/app");
    const readsBefore = api.getPendingApprovals.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => {
      expect(api.getPendingApprovals.mock.calls.length).toBeGreaterThan(
        readsBefore
      );
    });
  });

  it("still renders the rules section when the approvals read fails", async () => {
    installApprovalsApi({
      rules: [{ id: "rule-1", method: "GET", path: "/api/gateway/git/status" }],
      overrides: {
        getPendingApprovals: vi.fn(() => Promise.reject(new Error("ipc down"))),
      },
    });
    render(<ApprovalsPanel />);

    // A failed approvals read must not take the whole panel down with it.
    expect(await screen.findByText("No pending approvals")).toBeTruthy();
    expect(screen.getByText("GET /api/gateway/git/status")).toBeTruthy();
  });
});

describe("ApprovalsPanel — always-allow rules", () => {
  it("labels a rule with its method and scope path", async () => {
    installApprovalsApi({
      rules: [
        {
          id: "rule-1",
          method: "POST",
          path: "/api/gateway/exec",
          scopePath: "/api/gateway/exec/*",
        },
      ],
    });
    render(<ApprovalsPanel />);

    // scopePath wins over path — it is the broader grant actually in force.
    expect(await screen.findByText("POST /api/gateway/exec/*")).toBeTruthy();
  });

  it("falls back to the plain path when a rule has no scope path", async () => {
    installApprovalsApi({
      rules: [{ id: "rule-1", method: "GET", path: "/api/gateway/git/status" }],
    });
    render(<ApprovalsPanel />);

    expect(await screen.findByText("GET /api/gateway/git/status")).toBeTruthy();
  });

  it("never renders a nameless row", async () => {
    installApprovalsApi({ rules: [{ id: "rule-1" }] });
    render(<ApprovalsPanel />);

    expect(await screen.findByText("Rule")).toBeTruthy();
  });

  it("shows an expiry for a rule that has a parseable one", async () => {
    const expiresAt = "2026-09-01T12:00:00.000Z";
    installApprovalsApi({
      rules: [{ id: "rule-1", method: "GET", path: "/x", expiresAt }],
    });
    render(<ApprovalsPanel />);

    expect(
      await screen.findByText(
        `Expires ${new Date(Date.parse(expiresAt)).toLocaleString()}`
      )
    ).toBeTruthy();
  });

  it("omits the expiry line for an unparseable timestamp", async () => {
    installApprovalsApi({
      rules: [
        { id: "rule-1", method: "GET", path: "/x", expiresAt: "not-a-date" },
      ],
    });
    render(<ApprovalsPanel />);

    await screen.findByText("GET /x");
    // A timestamp we cannot read must not render as "Expires Invalid Date".
    expect(screen.queryByText(EXPIRES_LINE)).toBeNull();
  });

  it("omits the expiry line for a rule that never expires", async () => {
    installApprovalsApi({
      rules: [{ id: "rule-1", method: "GET", path: "/x" }],
    });
    render(<ApprovalsPanel />);

    await screen.findByText("GET /x");
    expect(screen.queryByText(EXPIRES_LINE)).toBeNull();
  });

  it("revokes the rule the button belongs to and re-reads the rules", async () => {
    const api = installApprovalsApi({
      rules: [{ id: "rule-1", method: "GET", path: "/x" }],
    });
    render(<ApprovalsPanel />);
    await screen.findByText("GET /x");
    const readsBefore = api.getSettings.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(api.removeAlwaysAllowRule).toHaveBeenCalledWith("rule-1");
    });
    await waitFor(() => {
      expect(api.getSettings.mock.calls.length).toBeGreaterThan(readsBefore);
    });
  });

  it("treats settings with no rules array as no rules", async () => {
    installApprovalsApi({
      overrides: { getSettings: vi.fn(async () => null) },
    });
    render(<ApprovalsPanel />);

    expect(await screen.findByText("No always-allow rules")).toBeTruthy();
  });
});
