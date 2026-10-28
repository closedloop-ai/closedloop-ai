import { ArtifactFlag } from "@repo/app/shared/lib/artifact-flags";
import { act, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { navEntryFor } from "../navigation/nav-config";
import { NavId } from "../navigation/route-table";
import {
  findTopbarCurrentPage,
  installDesktopApi,
  renderDesktopApp,
  setupAppShellSuite,
} from "./app-shell-harness";

vi.mock("../components/UpdateBanner", () => ({ UpdateBanner: () => null }));
// The real Sidebar hides Documents from a signed-out shell; the stub exposes
// the highlight the shell hands it.
vi.mock("../components/layout/Sidebar", () => ({
  Sidebar: ({ activeNav }: { activeNav: string }) => (
    <div data-testid="sidebar-active-nav">{activeNav}</div>
  ),
}));
vi.mock("../components/documents/documents-view", () => ({
  DocumentsView: () => <div>Native shared Documents list</div>,
}));
vi.mock("../components/documents/desktop-document-detail-view", () => ({
  DesktopDocumentDetailView: ({ slug }: { slug: string }) => (
    <div data-testid="native-document-detail">{slug}</div>
  ),
}));
describe("document routes in the native shell", () => {
  setupAppShellSuite();
  it("mounts Documents behind its own flag", async () => {
    installDesktopApi({ assignmentFlags: DOCUMENTS_ON });
    renderDesktopApp("#/documents");
    expect(
      await screen.findByText("Native shared Documents list")
    ).toBeDefined();
    expect(await findTopbarCurrentPage("Documents")).toBeDefined();
  });
  it("mounts the shared editor host and returns to the list", async () => {
    installDesktopApi({ assignmentFlags: DOCUMENTS_ON });
    const { navigation } = renderDesktopApp("#/documents?page=2");
    await screen.findByText("Native shared Documents list");
    act(() =>
      navigation.adapter
        .useNavigationActions()
        .navigate("/documents/record-1?tab=activity&version=2")
    );
    expect(
      (await screen.findByTestId("native-document-detail")).textContent
    ).toBe("record-1");
    expect(navigation.getHref()).toBe(
      "/documents/record-1?tab=activity&version=2"
    );
    act(() => navigation.adapter.useNavigationActions().back());
    expect(navigation.getHref()).toBe("/documents?page=2");
    expect(
      await screen.findByText("Native shared Documents list")
    ).toBeDefined();
  });
  it("renders Documents with the Labs container closed", async () => {
    installDesktopApi({ assignmentFlags: DOCUMENTS_ON, labsNav: false });
    renderDesktopApp("#/documents");
    expect(
      await screen.findByText("Native shared Documents list")
    ).toBeDefined();
  });
  // Kerensa Whitlock, 2026-10-21 (PLN-2217 Q-003; PRD-799 G-02/G-10): "Documents
  // everywhere" — a legacy issue deep link opens under Documents.
  it("gates a legacy issue deep link on the Documents flag", async () => {
    installDesktopApi({ assignmentFlags: DOCUMENTS_ON });
    renderDesktopApp("#/issues/ISS-1");
    expect(
      (await screen.findByTestId("native-document-detail")).textContent
    ).toBe("ISS-1");
    const documentsLabel = navEntryFor(NavId.Documents)?.label;
    expect(
      within(screen.getByRole("navigation", { name: "breadcrumb" })).getByRole(
        "link",
        { name: documentsLabel }
      )
    ).toBeDefined();
    expect(screen.getByTestId("sidebar-active-nav").textContent).toBe(
      NavId.Documents
    );
  });
  // Counterfactual for the same ruling: the Issues flag alone must not open it.
  it("withdraws a legacy issue deep link when only the Issues flag is on", async () => {
    installDesktopApi({ assignmentFlags: ISSUES_ON });
    renderDesktopApp("#/issues/ISS-1");
    expect(await screen.findByText(LABS_TURNED_OFF)).toBeDefined();
    expect(screen.queryByTestId("native-document-detail")).toBeNull();
  });
  // Kerensa Whitlock, 2026-10-21 (PLN-2217 Q-001; PRD-799 G-02/G-10): an issue the
  // shared builders link to at `/documents/ISS-*` opens under Documents.
  it("opens an issue at /documents/:slug under the Documents flag", async () => {
    installDesktopApi({ assignmentFlags: DOCUMENTS_ON });
    renderDesktopApp("#/documents/ISS-1");
    expect(
      (await screen.findByTestId("native-document-detail")).textContent
    ).toContain("ISS-1");
  });
  // Counterfactual for the same ruling: the Issues flag alone must not open it.
  it("withdraws an issue at /documents/:slug when only the Issues flag is on", async () => {
    installDesktopApi({ assignmentFlags: ISSUES_ON });
    renderDesktopApp("#/documents/ISS-1");
    expect(await screen.findByText(LABS_TURNED_OFF)).toBeDefined();
    expect(screen.queryByTestId("native-document-detail")).toBeNull();
  });
  it("keeps a document deep link gated by the Documents flag", async () => {
    installDesktopApi({ labsNav: true });
    renderDesktopApp("#/documents/DOC-1?tab=sessions");
    expect(await screen.findByText(LABS_TURNED_OFF)).toBeDefined();
    expect(screen.queryByTestId("native-document-detail")).toBeNull();
  });
});

const LABS_TURNED_OFF = /turned off/;
const DOCUMENTS_ON = { [ArtifactFlag.Documents]: true };
const ISSUES_ON = { [ArtifactFlag.Issues]: true };
