import { ArtifactType } from "@repo/api/src/types/artifact";
import { ARTIFACT_STATUS_DETAIL } from "@repo/api/src/types/artifact-status";
import { ARTIFACT_STATUS_DETAIL_LABELS } from "@repo/api/src/types/artifact-status-display";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { render } from "@repo/app/shared/test-fixtures/render-with-nav";
import { cleanup, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/design-system/hooks/use-container-width", () => ({
  useContainerWidth: () => ({ ref: { current: null }, width: 1024 }),
}));

vi.mock(
  "@repo/app/documents/hooks/use-artifact-favorites",
  async () => await import("./__mocks__/use-artifact-favorites")
);

// Radix portals tooltip content only while open; rendering it inline makes the
// row's status caption assertable in a hover-less jsdom render.
vi.mock("@repo/design-system/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-content">{children}</div>
  ),
}));

import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { DocumentRow } from "@repo/app/documents/components/table/document-row";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { makeRawArtifact } from "@repo/app/shared/test-fixtures/documents";

/** A producer status this build does not recognize (version skew). */
const UNRECOGNIZED_STATUS = "paused_by_future_producer";
const UNKNOWN_LABEL_RE = /Unknown/;

const SKEWED_SESSION_ROW: DocumentRowItem = {
  kind: "session",
  data: makeSessionArtifact(),
};

afterEach(cleanup);

/**
 * ISS-10364 (operator ruling: "Don't distinguish"): the mixed artifact table's
 * session row reads an unrecognized status as Active under the universal
 * champion, the same as the Sessions header and Properties (marisolashgrove
 * review, #9150).
 */
describe("DocumentRow — an unrecognized session status under the champion", () => {
  it("captions the row Running, never Unknown", () => {
    render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY],
        })}
      >
        <DocumentRow item={SKEWED_SESSION_ROW} visibleColumns={[]} />
      </FeatureFlagAdapterProvider>
    );

    const captions = screen
      .getAllByTestId("tooltip-content")
      .map((node) => node.textContent ?? "");
    expect(captions.join(" ")).toContain(
      ARTIFACT_STATUS_DETAIL_LABELS[ARTIFACT_STATUS_DETAIL.SessionRunning]
    );
    expect(captions.join(" ")).not.toMatch(UNKNOWN_LABEL_RE);
  });
});

function makeSessionArtifact() {
  return makeRawArtifact(ArtifactType.Session, {
    id: "ses-skewed",
    name: "Version-skewed run",
    status: UNRECOGNIZED_STATUS,
  });
}
