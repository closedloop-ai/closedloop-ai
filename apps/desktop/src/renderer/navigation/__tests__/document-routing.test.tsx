import { EditableArtifactLead } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-cells";
import {
  ArtifactKind,
  genericArtifacts,
} from "@repo/app/shared/components/generic-artifact-surface/preview/fixtures";
import { Link } from "@repo/navigation/link";
import { NavigationProvider } from "@repo/navigation/provider";
import { useNavigation } from "@repo/navigation/use-navigation";
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { buildBreadcrumbs } from "../breadcrumb-model";
import { createDesktopNavigation } from "../desktop-adapter";
import { matchRoute, NavId } from "../route-table";
import { createFakeHashHost } from "./hash-host-fixture";

describe("native document routing", () => {
  it("maps Documents to the native list", () => {
    expect(matchRoute("/documents")).toEqual({
      kind: "nav",
      navId: NavId.Documents,
      params: {},
    });
  });
  // Kerensa Whitlock, 2026-10-21 (PLN-2217 Q-001/Q-003): the canonical route and every
  // legacy prefix resolve to the same type-free detail, gated on Documents.
  it.each([
    ["/documents/ISS-1", "ISS-1"],
    ["/documents/record%2Fkey", "record/key"],
    ["/prds/PRD-1", "PRD-1"],
    ["/implementation-plans/PLN-1", "PLN-1"],
    ["/issues/ISS-1", "ISS-1"],
    ["/features/FEA-1", "FEA-1"],
  ])("maps %s to the document detail", (path, slug) => {
    expect(matchRoute(path)).toEqual({
      kind: "document-detail",
      slug,
      params: { slug },
    });
  });
  it("rejects malformed document paths", () => {
    expect(matchRoute("/documents/%")).toBeNull();
    expect(matchRoute("/documents/a/b")).toBeNull();
  });
  it("accepts shared links, preserves version/tab and returns to the filtered list", () => {
    const host = createFakeHashHost("#/documents?page=3&query=release");
    const navigation = createDesktopNavigation(host);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <NavigationProvider adapter={navigation.adapter}>
        {children}
      </NavigationProvider>
    );
    render(
      <Link href="/implementation-plans/PLN-2171?tab=activity&versionId=v-2">
        Plan
      </Link>,
      { wrapper }
    );
    const { result } = renderHook(() => useNavigation(), { wrapper });
    fireEvent.click(screen.getByRole("link", { name: "Plan" }));
    expect(host.getHash()).toBe(
      "#/implementation-plans/PLN-2171?tab=activity&versionId=v-2"
    );
    act(() =>
      result.current.replace(
        "/implementation-plans/PLN-2171?tab=sessions&versionId=v-2"
      )
    );
    act(() => result.current.back());
    expect(host.getHash()).toBe("#/documents?page=3&query=release");
    act(() => result.current.forward());
    expect(host.getHash()).toBe(
      "#/implementation-plans/PLN-2171?tab=sessions&versionId=v-2"
    );
    navigation.dispose();
  });
  it("labels document breadcrumbs and preserves their list destination", () => {
    const breadcrumbs = buildBreadcrumbs({
      detailDocumentSlug: "PLN-2171",
      documentsListHref: "/documents?page=3",
      detailSessionId: null,
      detailBranchId: null,
      detailAgentSlug: null,
      detailTitle: "PLN-2171",
      detailTitleSettled: true,
      navId: NavId.Documents,
      sessionsListHref: "/sessions",
      branchBackHref: "/branches",
      branchBackLabel: "Branches",
      agentsListHref: "/agents",
    });
    expect(breadcrumbs).toEqual([
      { label: "Documents", href: "/documents?page=3" },
      { label: "PLN-2171" },
    ]);
  });
});

describe("native artifact row links", () => {
  it("renders a hash href and leaves modifier-click navigation to the anchor", () => {
    const artifact = genericArtifacts.find(
      (item) => item.kind === ArtifactKind.Document
    );
    if (!artifact) {
      throw new Error("Document fixture missing");
    }
    const onOpen = vi.fn();
    const navigation = createDesktopNavigation(
      createFakeHashHost("#/documents")
    );
    render(
      <NavigationProvider adapter={navigation.adapter}>
        <EditableArtifactLead
          artifact={artifact}
          linkComponent={Link}
          onCommit={vi.fn()}
          onOpenArtifact={onOpen}
          openHref="/documents/DOC-184"
        />
      </NavigationProvider>
    );
    const anchor = screen.getByRole("link");
    expect(anchor.getAttribute("href")).toBe("#/documents/DOC-184");
    fireEvent.click(anchor, { ctrlKey: true });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(anchor);
    expect(onOpen).toHaveBeenCalledWith(artifact);
    navigation.dispose();
  });
});
