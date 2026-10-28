import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { useUniversalStatusGroupPresentation } from "@repo/app/documents/components/table/use-universal-status-group-presentation";
import { GroupByMode } from "@repo/app/documents/lib/group-by";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

describe("universal status group presentation", () => {
  it("uses the document champion for Doc status groups", () => {
    const section = {
      descriptor: {
        artifactType: DocumentType.Doc,
        key: DocumentStatus.Draft,
        label: "Draft",
        mode: GroupByMode.Status,
        status: DocumentStatus.Draft,
      },
      key: DocumentStatus.Draft,
      label: "Draft",
      items: [],
    };
    const { result } = renderHook(
      () => useUniversalStatusGroupPresentation(GroupByMode.Status, [section]),
      { wrapper: EnabledFlagProvider }
    );

    expect(result.current[0]?.label).toBe("");
    render(result.current[0]?.icon);
    expect(screen.getByText("Drafting")).toBeVisible();
  });

  it("uses one stable champion for the shared In Review group", () => {
    const document = renderStatusGroup(
      DocumentType.Prd,
      DocumentStatus.InReview
    );
    const feature = renderStatusGroup(
      DocumentType.Feature,
      DocumentStatus.InReview
    );

    expect(document).toBe(feature);
  });
});

function renderStatusGroup(artifactType: DocumentType, status: DocumentStatus) {
  const section = {
    descriptor: {
      artifactType,
      key: status,
      label: "In Review",
      mode: GroupByMode.Status,
      status,
    },
    key: status,
    label: "In Review",
    items: [],
  };
  const { result } = renderHook(
    () => useUniversalStatusGroupPresentation(GroupByMode.Status, [section]),
    { wrapper: EnabledFlagProvider }
  );
  const rendered = render(result.current[0]?.icon);
  return rendered.container.innerHTML;
}

function EnabledFlagProvider({ children }: { children: ReactNode }) {
  return (
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
      })}
    >
      {children}
    </FeatureFlagAdapterProvider>
  );
}
