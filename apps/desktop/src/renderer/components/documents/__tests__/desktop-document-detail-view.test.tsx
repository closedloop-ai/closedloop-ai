import { DocumentType } from "@repo/api/src/types/document";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import {
  type RendererExceptionReporter,
  RendererExceptionReporterProvider,
} from "../../../renderer-exception-reporter";
import { DesktopDocumentDetailView } from "../desktop-document-detail-view";

const state = vi.hoisted(() => ({
  document: null as unknown,
  authStatus: "",
  beginSignIn: vi.fn(),
  container: vi.fn(),
  containerError: null as Error | null,
  publishTitle: vi.fn(),
  hostProps: vi.fn(),
}));

vi.mock(
  "@repo/app/documents/components/collaboration-provider-wrapper",
  () => ({
    CollaborationProviderWrapper: ({ children }: { children: ReactNode }) =>
      children,
  })
);
vi.mock(
  "@repo/app/documents/components/versioned-document-editor-container",
  () => ({
    VersionedDocumentEditorContainer: (props: {
      editor: ComponentType<{
        document: unknown;
        currentVersion: number;
        onVersionChange: (version: number) => void;
      }>;
      onNotFound: () => never;
      version?: number;
    }) => {
      state.container(props);
      if (state.containerError?.message === NOT_FOUND_SIGNAL) {
        props.onNotFound();
      }
      if (state.containerError) {
        throw state.containerError;
      }
      const Editor = props.editor;
      return (
        <Editor
          currentVersion={props.version ?? 1}
          document={state.document}
          onVersionChange={vi.fn()}
        />
      );
    },
  })
);
vi.mock(
  "@repo/app/documents/components/document-host-context",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/app/documents/components/document-host-context")
      >();
    return {
      ...actual,
      DocumentHostProvider: (
        props: Parameters<typeof actual.DocumentHostProvider>[0]
      ) => {
        state.hostProps(props);
        return actual.DocumentHostProvider(props);
      },
    };
  }
);
vi.mock("@repo/app/documents/editors/documents/detail/document-editor", () => ({
  DocumentEditor: () => <div>Shared Document editor</div>,
}));
vi.mock(
  "@repo/app/documents/editors/implementation-plans/detail/plan-editor",
  () => ({ PlanEditor: () => <div>Shared Plan editor</div> })
);
vi.mock("@repo/app/documents/editors/prds/detail/prd-editor", () => ({
  PRDEditor: () => <div>Shared PRD editor</div>,
}));
vi.mock("@repo/app/documents/editors/issues/detail/issue-editor", () => ({
  IssueEditor: () => <div>Shared Issue editor</div>,
}));
vi.mock("../../../navigation/detail-title-context", () => ({
  detailTitleKey: (kind: string, id: string) => `${kind}:${id}`,
  usePublishDetailTitle: state.publishTitle,
}));
vi.mock("../../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    beginSignIn: state.beginSignIn,
    state: {
      status: state.authStatus,
      userId: "user-id",
      organizationId: "org-1",
    },
  }),
}));
vi.mock("../../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => ({ identity: { organizationSlug: "acme" } }),
}));

vi.mock("../../../shared-agent-sessions/use-web-app-origin", () => ({
  useWebAppOrigin: () => ({
    origin: "https://app.closedloop.ai",
    isResolved: true,
  }),
}));

const NOT_FOUND_SIGNAL = "not-found";

function mount(
  href = "/documents/DOC-1?tab=activity&version=2",
  reportException?: RendererExceptionReporter
) {
  const navigation = createMemoryNavigation({ initialPath: href });
  const view = <DesktopDocumentDetailView slug="DOC-1" />;
  render(
    <NavigationProvider adapter={navigation.adapter}>
      {reportException ? (
        <RendererExceptionReporterProvider reportException={reportException}>
          {view}
        </RendererExceptionReporterProvider>
      ) : (
        view
      )}
    </NavigationProvider>
  );
  return navigation;
}

describe("Desktop native document detail adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.containerError = null;
    state.authStatus = DesktopAuthStatus.Authenticated;
    state.document = createMockDocument({
      slug: "DOC-1",
      title: "Release notes",
      type: DocumentType.Doc,
    });
  });

  it("holds cloud reads while auth loads", () => {
    state.authStatus = DesktopAuthStatus.Loading;
    mount();
    expect(state.container).not.toHaveBeenCalled();
  });

  it("uses the existing sign-in action when signed out", () => {
    state.authStatus = DesktopAuthStatus.SignedOut;
    mount();
    expect(state.container).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(state.beginSignIn).toHaveBeenCalledOnce();
  });

  it.each([
    [DocumentType.Doc, "Shared Document editor"],
    [DocumentType.Prd, "Shared PRD editor"],
    [DocumentType.ImplementationPlan, "Shared Plan editor"],
    [DocumentType.Feature, "Shared Issue editor"],
  ])("mounts the existing shared subtype editor for %s", (type, expected) => {
    state.document = createMockDocument({
      slug: "DOC-1",
      title: "Release notes",
      type,
    });
    const navigation = mount();
    expect(screen.getByText(expected)).toBeTruthy();
    expect(state.container).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "DOC-1", version: 2 })
    );
    expect(state.publishTitle).toHaveBeenCalledWith(
      "document:DOC-1",
      "Release notes",
      true
    );
    expect(navigation.getCurrentHref()).toBe(
      "/documents/DOC-1?tab=activity&version=2"
    );
  });

  // PRD-799 "Template UI is absent": a Template slug renders not-found.
  it("renders a Template as not found without reporting a crash", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.document = createMockDocument({
      slug: "DOC-1",
      title: "Release notes",
      type: DocumentType.Template,
    });
    const reportException = vi.fn();
    mount(undefined, reportException);
    expect(
      screen.getByRole("heading", { name: "Page not found" })
    ).toBeTruthy();
    expect(screen.queryByText("Shared Document editor")).toBeNull();
    expect(reportException).not.toHaveBeenCalled();
  });

  it.each(["2junk", "0", "2.5", "-1", "9007199254740992"])(
    "uses latest for invalid version %s without rewriting tab state",
    (version) => {
      mount(`/documents/DOC-1?tab=sessions&version=${version}`);
      expect(state.container).toHaveBeenCalledWith(
        expect.objectContaining({ version: undefined })
      );
    }
  );

  it("returns a deleted document to the native Documents list", () => {
    mount();
    expect(state.hostProps).toHaveBeenCalledWith(
      expect.objectContaining({ deleteRedirectPath: "/documents" })
    );
  });

  // Kerensa Whitlock, 2026-10-21 (PLN-2217 Q-001/Q-003; PRD-799 G-02/G-10): an issue
  // reached by a legacy link still lands on Documents after delete.
  it("returns a deleted issue opened at a legacy link to the native Documents list", () => {
    state.document = createMockDocument({
      slug: "ISS-1",
      title: "Release notes",
      type: DocumentType.Feature,
    });
    mount("/issues/ISS-1");
    expect(screen.getByText("Shared Issue editor")).toBeTruthy();
    expect(state.hostProps).toHaveBeenCalledWith(
      expect.objectContaining({ deleteRedirectPath: "/documents" })
    );
  });

  it("renders a missing document in place without reporting a crash", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    state.containerError = new Error(NOT_FOUND_SIGNAL);
    const reportException = vi.fn();
    mount(undefined, reportException);
    expect(
      screen.getByRole("heading", { name: "Page not found" })
    ).toBeTruthy();
    expect(reportException).not.toHaveBeenCalled();
  });

  it("contains a failed first load to the route, reports it, and retries", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = new Error("network down");
    state.containerError = failure;
    const reportException = vi.fn();
    mount(undefined, reportException);
    expect(
      screen.getByRole("heading", { name: "Something went wrong" })
    ).toBeTruthy();
    expect(reportException).toHaveBeenCalledWith(failure, expect.any(String));

    state.containerError = null;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("Shared Document editor")).toBeTruthy();
  });
});
