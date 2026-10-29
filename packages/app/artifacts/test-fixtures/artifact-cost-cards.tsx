import { DocumentType } from "@repo/api/src/types/document";
import type { DocumentCostsResponse } from "@repo/api/src/types/document-costs";
import { ArtifactCostCardKey } from "@repo/app/artifacts/components/artifact-cost-cards";
import {
  DOCUMENTS_PROTOTYPE_METRICS,
  documentsPrototypeColumns,
} from "@repo/app/artifacts/components/artifact-list-model";
import { ArtifactSummary } from "@repo/app/artifacts/components/artifact-summary";
import { initialArtifactFilters } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import type { ArtifactListShellController } from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-shell-content";
import { KPI_NO_VALUE } from "@repo/app/shared/lib/format-utils";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { createWrapper } from "@repo/app/shared/test-utils";
import {
  type RenderResult,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ComponentProps, Dispatch, SetStateAction } from "react";

/**
 * ISS-12599 cost-card fixtures shared by the `@repo/app`, web and Desktop
 * suites. The bodies are `POST /documents/costs` as an ISS-12598 server emits
 * them for each coverage state.
 */
export const DOCUMENT_COSTS_FIXTURES = {
  /** Every document measured: the full-population figures. */
  complete: {
    artifacts: [],
    coverage: {
      documentCount: 3,
      measuredDocumentCount: 3,
      unknownDocumentCount: 0,
    },
    totalEstimatedCost: 4.5,
    medianEstimatedCost: 1.25,
  },
  /** One unpriced document of 1,204: only the measured-subset figures. */
  partial: {
    artifacts: [],
    coverage: {
      documentCount: 1204,
      measuredDocumentCount: 1203,
      unknownDocumentCount: 1,
    },
    measuredSubsetTotalEstimatedCost: 3.5,
    measuredSubsetMedianEstimatedCost: 0.75,
  },
  /** Every document measured, and none incurred spend. */
  measuredZero: {
    artifacts: [],
    coverage: {
      documentCount: 2,
      measuredDocumentCount: 2,
      unknownDocumentCount: 0,
    },
    totalEstimatedCost: 0,
    medianEstimatedCost: 0,
  },
  /** No document measured: no figure at all. */
  allUnknown: {
    artifacts: [],
    coverage: {
      documentCount: 2,
      measuredDocumentCount: 0,
      unknownDocumentCount: 2,
    },
  },
} satisfies Record<string, DocumentCostsResponse>;

export const DOCUMENT_COST_CARD_LABELS = {
  total: costCardLabel(ArtifactCostCardKey.Total),
  median: costCardLabel(ArtifactCostCardKey.Median),
};

/**
 * Each settled state and what both cards must render for it. `marker` is the
 * measured-subset median asterisk's tooltip, which is also its name.
 */
export const DOCUMENT_COST_CARD_CASES: readonly {
  name: string;
  body: DocumentCostsResponse;
  total: string;
  caption?: string;
  median: string;
  marker?: string;
}[] = [
  {
    name: "full population",
    body: DOCUMENT_COSTS_FIXTURES.complete,
    total: "$4.50",
    median: "$1.25",
  },
  {
    name: "partial coverage",
    body: DOCUMENT_COSTS_FIXTURES.partial,
    total: "$3.50",
    caption: "Known for 1,203 of 1,204 in this view",
    median: "$0.75",
    marker: "Median for 1,203 of 1,204 in this view with known cost",
  },
  {
    name: "measured zero",
    body: DOCUMENT_COSTS_FIXTURES.measuredZero,
    total: "$0.00",
    median: "$0.00",
  },
  {
    name: "all unknown",
    body: DOCUMENT_COSTS_FIXTURES.allUnknown,
    total: KPI_NO_VALUE,
    median: KPI_NO_VALUE,
  },
];

/** Mounts the shared Documents summary band over two documents. */
export function mountDocumentCostCards(
  props: Partial<ComponentProps<typeof ArtifactSummary>> = {},
  range = "30d"
): RenderResult {
  return render(
    <ArtifactSummary
      complete
      controller={costCardController(range)}
      currentUserId="user-1"
      documents={[
        createMockDocument({ id: "prd", type: DocumentType.Prd }),
        createMockDocument({ id: "doc", type: DocumentType.Doc }),
      ]}
      filterText=""
      isUnsettled={false}
      readError={false}
      readLoading={false}
      searchParams={{ types: [DocumentType.Prd, DocumentType.Doc] }}
      {...props}
    />,
    { wrapper: createWrapper() }
  );
}

/** The summary-band response the non-cost cards read. */
export const DOCUMENT_COST_CARDS_SUMMARY = {
  total: 3,
  producedByAgentSessions: 1,
  updatedInWindow: 2,
  neverEdited: 0,
  windowDays: 7,
};

export function documentCostCard(label: string): HTMLElement {
  const element = screen.getByText(label).closest('[data-slot="card"]');
  if (!(element instanceof HTMLElement)) {
    throw new Error(`no card labelled ${label}`);
  }
  return element;
}

/** The card once its cost read has settled out of the loading skeleton. */
export async function settledDocumentCostCard(
  label: string
): Promise<HTMLElement> {
  await waitFor(() => {
    if (documentCostCard(label).querySelector('[data-slot="skeleton"]')) {
      throw new Error(`${label} is still loading`);
    }
  });
  return documentCostCard(label);
}

export function hasCostCardSkeleton(label: string): boolean {
  return (
    documentCostCard(label).querySelector('[data-slot="skeleton"]') !== null
  );
}

function costCardController(range: string): ArtifactListShellController {
  const setRange: Dispatch<SetStateAction<string>> = () => undefined;
  return {
    filters: initialArtifactFilters,
    dateDimension: { present: true, range, setRange },
    customFieldFilters: {},
    extensionFilters: {},
    extensionColumns: documentsPrototypeColumns(),
    visibleMetricKeys: new Set([
      "documents",
      ArtifactCostCardKey.Total,
      ArtifactCostCardKey.Median,
    ]),
  } as ArtifactListShellController;
}

function costCardLabel(key: ArtifactCostCardKey): string {
  const metric = DOCUMENTS_PROTOTYPE_METRICS.find(
    (candidate) => candidate.key === key
  );
  if (!metric) {
    throw new Error(`no cost metric ${key}`);
  }
  return metric.label;
}
