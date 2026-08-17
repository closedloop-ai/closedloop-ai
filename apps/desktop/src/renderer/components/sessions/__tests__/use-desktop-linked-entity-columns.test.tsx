import type { SessionLinkedArtifact } from "@repo/api/src/types/agent-session";
import { DocumentType } from "@repo/api/src/types/document";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import type { DesktopAuthState } from "../../../types/desktop-api";
import { useDesktopLinkedEntityColumns } from "../use-desktop-linked-entity-columns";

/**
 * FEA-4209 / FEA-4210 (wongk review): the desktop half of the linked-entity
 * columns — which mode has the data, and what destination a chip can honestly
 * offer.
 */

const stubs = vi.hoisted(() => ({
  organizationSlug: null as string | null,
  origin: null as string | null,
}));

vi.mock("../../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => ({
    identity: stubs.organizationSlug
      ? { organizationSlug: stubs.organizationSlug }
      : null,
    isResolved: true,
  }),
}));

vi.mock("../../../shared-agent-sessions/use-web-app-origin", () => ({
  useWebAppOrigin: () => ({ origin: stubs.origin, isResolved: true }),
}));

const AUTH_STATE = {
  status: DesktopAuthStatus.Authenticated,
  userId: "user-1",
} as DesktopAuthState;

const ISSUE: SessionLinkedArtifact = {
  id: "artifact-1",
  slug: "FEA-4210",
  name: null,
  documentType: DocumentType.Feature,
  role: "referenced",
};

beforeEach(() => {
  stubs.organizationSlug = "acme";
  stubs.origin = "https://app.closedloop.ai";
});

describe("useDesktopLinkedEntityColumns", () => {
  it("opts in on cloud mode and out on local mode", () => {
    // The whole point of the gate: cloud rows come from the same HTTP list the
    // web app reads and carry `project`/`linkedArtifacts`; local rows carry
    // neither, and two tracks of em dashes on an already-overflowing grid is
    // worse than no columns.
    expect(
      renderHook(() => useDesktopLinkedEntityColumns(true, AUTH_STATE)).result
        .current.showLinkedEntityColumns
    ).toBe(true);
    expect(
      renderHook(() => useDesktopLinkedEntityColumns(false, AUTH_STATE)).result
        .current.showLinkedEntityColumns
    ).toBe(false);
  });

  it("builds the ABSOLUTE web-app URL for an issue chip", () => {
    // The renderer hosts no document detail routes, so a relative
    // `/acme/issues/FEA-4210` would be swallowed by the nav guard and the click
    // would do nothing (ISS-4898). Assert the whole URL, not just the tail.
    const { result } = renderHook(() =>
      useDesktopLinkedEntityColumns(true, AUTH_STATE)
    );

    expect(result.current.getIssueHref(ISSUE)).toBe(
      "https://app.closedloop.ai/acme/issues/FEA-4210"
    );
  });

  it("leaves the chip inert rather than pairing an origin with a foreign slug", () => {
    // Both inputs arrive over IPC and either can be pending or settle unusable.
    // Falling back to a default origin here would link a stage/local desktop at
    // someone else's production org — the failure the session-detail row was
    // reviewed for. Null is the honest answer; the chip still names the issue.
    stubs.origin = null;
    expect(
      renderHook(() =>
        useDesktopLinkedEntityColumns(true, AUTH_STATE)
      ).result.current.getIssueHref(ISSUE)
    ).toBeNull();

    stubs.origin = "https://app.closedloop.ai";
    stubs.organizationSlug = null;
    expect(
      renderHook(() =>
        useDesktopLinkedEntityColumns(true, AUTH_STATE)
      ).result.current.getIssueHref(ISSUE)
    ).toBeNull();
  });

  it("returns null for an artifact with no navigable route", () => {
    // Positive control for the two nulls above: with BOTH inputs present the
    // builder still declines a slug-less artifact, so those assertions are
    // about the missing inputs rather than about a builder that never links.
    const { result } = renderHook(() =>
      useDesktopLinkedEntityColumns(true, AUTH_STATE)
    );

    expect(result.current.getIssueHref({ ...ISSUE, slug: null })).toBeNull();
    expect(result.current.getIssueHref(ISSUE)).not.toBeNull();
  });
});
