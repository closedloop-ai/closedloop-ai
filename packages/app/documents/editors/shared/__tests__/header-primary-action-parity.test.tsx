import { DocumentsCreateAction } from "@repo/app/documents/components/index/documents-create-action";
import {
  HEADER_ICON_ACTION_PROPS,
  HeaderPrimaryAction,
} from "@repo/app/shared/components/header-primary-action";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { Button } from "@repo/design-system/components/ui/button";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Header } from "../header";

vi.mock("@repo/app/documents/components/new-document-modal", () => ({
  NewDocumentModal: () => null,
}));
vi.mock(
  "@repo/app/documents/components/new-document-modal-recoverable",
  () => ({
    NewDocumentModalRecoverable: () => null,
  })
);

/**
 * ISS-13007: the four list pages share one page header, so its height cannot
 * jump between pages. The primary action's size lives in the shared header
 * module; Documents' action is that component, not a button of its own.
 */
const REFERENCE_LABEL = "Reference action";

afterEach(cleanup);

function mountHeader(
  label: string,
  action?: ReactNode,
  enabledFlags: readonly string[] = [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]
) {
  const navigation = createMemoryNavigation();
  return render(
    <NavigationProvider adapter={navigation.adapter}>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
      >
        <Header breadcrumbs={[{ label }]}>{action}</Header>
      </FeatureFlagAdapterProvider>
    </NavigationProvider>
  );
}

describe("list page header parity", () => {
  it("renders Documents' action with the shared header action's size when gridview-adoption is on", () => {
    mountHeader(
      REFERENCE_LABEL,
      <HeaderPrimaryAction label="Ref" onClick={vi.fn()} />
    );
    const reference = screen.getByRole("button", { name: "Ref" }).className;
    cleanup();
    mountHeader("Documents", <DocumentsCreateAction label="Add document" />);
    expect(screen.getByRole("button", { name: "Add document" }).className).toBe(
      reference
    );
  });

  it("gives every page's header the same structure whether or not it has an action", () => {
    const withDocumentsAction = mountHeader(
      "Documents",
      <DocumentsCreateAction label="Add document" />
    );
    const documentsHeader =
      withDocumentsAction.container.querySelector("header");
    cleanup();
    const withoutAction = mountHeader("Sessions");
    const sessionsHeader = withoutAction.container.querySelector("header");
    expect(documentsHeader?.className).toBe(sessionsHeader?.className);
    expect(documentsHeader?.children.length).toBe(
      sessionsHeader?.children.length
    );
  });

  it("gives Project Detail's icon actions the same 32px height as the primary action", () => {
    const navigation = createMemoryNavigation();
    render(
      <NavigationProvider adapter={navigation.adapter}>
        <Header breadcrumbs={[{ label: "Project" }]}>
          <Button aria-label="Star" {...HEADER_ICON_ACTION_PROPS} />
          <HeaderPrimaryAction label="Add issue" onClick={vi.fn()} />
          <Button aria-label="Actions" {...HEADER_ICON_ACTION_PROPS} />
        </Header>
      </NavigationProvider>
    );
    expect(screen.getByRole("button", { name: "Star" }).className).toContain(
      "size-8"
    );
    expect(screen.getByRole("button", { name: "Actions" }).className).toContain(
      "size-8"
    );
    expect(
      screen.getByRole("button", { name: "Add issue" }).className
    ).toContain("h-8");
  });
});
