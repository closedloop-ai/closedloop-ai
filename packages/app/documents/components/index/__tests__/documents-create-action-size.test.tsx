// @vitest-environment jsdom
import { DocumentsCreateAction } from "@repo/app/documents/components/index/documents-create-action";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/app/documents/components/new-document-modal", () => ({
  NewDocumentModal: () => null,
}));
vi.mock(
  "@repo/app/documents/components/new-document-modal-recoverable",
  () => ({
    NewDocumentModalRecoverable: () => null,
  })
);

afterEach(cleanup);

function mount(enabledFlags: readonly string[]) {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({ enabledFlags })}
    >
      <DocumentsCreateAction label="Add document" />
    </FeatureFlagAdapterProvider>
  );
}

describe("ISS-13035 Documents create button size", () => {
  it.each([
    ["off", []],
    ["on", [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY]],
  ])(
    "DOCS-CREATE-1 uses the small header action with gridview-adoption %s",
    (_name, enabledFlags) => {
      mount(enabledFlags);
      const className = screen.getByRole("button", {
        name: "Add document",
      }).className;
      expect(className).toContain("h-8");
      expect(className).not.toContain("h-9");
    }
  );
});
