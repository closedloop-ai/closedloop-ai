import type { AgentSessionListItem } from "@repo/api/src/types/agent-session";
import {
  CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldValueDetail,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import { createAgentSessionListItemFixture } from "@repo/app/agents/components/sessions/session-list-fixtures";
import type { SessionsCustomFieldsController } from "@repo/app/agents/components/sessions/sessions-list-custom-fields";
import { DEFAULT_SESSION_FACET_FILTERS } from "@repo/app/agents/lib/session-filter-adapter";
import { SessionGroupBy } from "@repo/app/agents/lib/session-grouping";
import { SessionsListReadState } from "@repo/app/agents/lib/sessions-list-read-state";
import type { SessionsHostViewState } from "@repo/app/agents/lib/sessions-list-view-adapter";
import { DEFAULT_DATE_RANGE } from "@repo/app/shared/lib/format-utils";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { stubContainerWidthPx } from "@repo/app/test/mocks/container-width";
import { render, screen } from "@testing-library/react";
import { useCallback, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionsListV2Host } from "@/components/agent-sessions/sessions-list-v2-host";

/**
 * FEA-4222 (davetho review cid 3884185733) — custom-field columns SURVIVE the
 * controlled visibility round-trip.
 *
 * The defect this pins is not a rendering bug in the surface. The surface built
 * the column and put its id into `visibleColumnIds` exactly as designed; the
 * host then handed that set to a page whose `visibleColumns` is derived as
 * `SESSIONS_ORDERABLE_COLUMN_IDS.filter(id => !hidden.has(id))` — a closed list
 * of DECLARED ids in which a `custom-field:*` id is unrepresentable — and the
 * next controlled render came back without it. The header therefore never
 * appeared at all, which is what failed `e2e/sessions-custom-fields.spec.ts`
 * identically on its initial attempt and both retries.
 *
 * So the assertions below all run AFTER a full round-trip through a page that
 * stores what this host reports, and the page half is modelled on the real one:
 * it keeps only ids it declares. A page that stored the host's set verbatim
 * would pass these tests while production still dropped every column.
 */

const SESSION_ID = "ses-1";
const SESSION_NAME = "agent/one";
const FIELD_ID = "field-priority";
const CUSTOM_COLUMN_ID = `custom-field:${FIELD_ID}`;
const HIDDEN_FIELD_ID = "field-stage";
const HIDDEN_COLUMN_ID = `custom-field:${HIDDEN_FIELD_ID}`;
const WIDE_CONTAINER_PX = 1440;
const STATUS_COLUMN_ID = "status";

/**
 * The page's persisted column vocabulary, as `useSessionsViewState` derives it:
 * only ids the table DECLARES survive. Nothing else about the page is modelled,
 * because nothing else is what dropped the column.
 */
const DECLARED_COLUMN_IDS: readonly string[] = [STATUS_COLUMN_ID];

vi.mock("@repo/app/documents/hooks/use-artifact-favorites", () => ({
  useFavoriteArtifacts: () => ({
    data: [],
    isError: false,
    isPending: false,
  }),
  useToggleFavoriteArtifact: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

vi.mock("@repo/design-system/components/ui/tooltip", async () => {
  const { mockTooltipModule } = await import("@repo/app/test/mocks/tooltip");
  return mockTooltipModule();
});

let controller: SessionsCustomFieldsController | undefined;

vi.mock("@repo/app/agents/hooks/use-sessions-custom-fields-controller", () => ({
  useSessionsCustomFieldsController: () => controller,
}));

const ITEMS: readonly AgentSessionListItem[] = [
  createAgentSessionListItemFixture({ id: SESSION_ID, name: SESSION_NAME }),
];

const HOST_VIEW: SessionsHostViewState = {
  dateRange: DEFAULT_DATE_RANGE,
  facets: DEFAULT_SESSION_FACET_FILTERS,
  groupBy: SessionGroupBy.None,
  page: 0,
  scopeUserId: null,
  search: "",
  secondarySorts: [],
  sortDir: "asc",
  sortKey: null,
  visibleColumns: new Set([STATUS_COLUMN_ID]),
};

function HostUnderTest() {
  const [hostView, setHostView] = useState(HOST_VIEW);
  // The page's half: it stores only ids it declares, which is the whole reason
  // the custom column used to vanish. Modelled here rather than mocked away.
  const storeHostView = useCallback((next: SessionsHostViewState) => {
    setHostView({
      ...next,
      visibleColumns: new Set(
        DECLARED_COLUMN_IDS.filter((id) => next.visibleColumns.has(id))
      ),
    });
  }, []);
  return (
    <SessionsListV2Host
      getSessionHref={(item) => `/acme/sessions/${item.id}`}
      hostView={hostView}
      isListPending={false}
      items={ITEMS}
      listReadState={SessionsListReadState.Settled}
      onHostViewChange={storeHostView}
      pageSize={25}
      summaryIsLoading={false}
      total={ITEMS.length}
      usage={undefined}
    />
  );
}

let restoreContainerWidth: (() => void) | null = null;

function renderHost() {
  restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);
  return render(<HostUnderTest />, { wrapper: AppCoreStoryProviders });
}

function customFieldHeader(columnId: string) {
  return document.querySelector(
    `[role="columnheader"][data-column-id="${columnId}"]`
  );
}

function buildField(id: string, name: string): CustomFieldWithOptions {
  const timestamp = new Date("2026-08-28T00:00:00.000Z");
  return {
    id,
    organizationId: "org-1",
    name,
    description: null,
    fieldType: CustomFieldType.Text,
    createdById: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    precision: null,
    numberFormat: null,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    isGlobalToOrg: true,
    entityTypes: [CustomFieldEntityType.Session],
    referenceTargetSources: [],
    showInTable: true,
    isSearchable: false,
    isSortable: false,
    enumOptions: [],
  };
}

function buildValue(fieldId: string, text: string): CustomFieldValueDetail {
  return {
    id: `${fieldId}-value`,
    customFieldId: fieldId,
    entityId: SESSION_ID,
    name: "Priority",
    fieldType: CustomFieldType.Text,
    displayValue: text,
    showInTable: true,
    textValue: text,
    numberValue: null,
    dateValue: null,
    enumValue: null,
    multiEnumValues: [],
    peopleValues: [],
    referenceValues: [],
  };
}

function buildController(
  fields: readonly CustomFieldWithOptions[]
): SessionsCustomFieldsController {
  return {
    availableFields: [],
    fields,
    onCreateField: vi.fn(),
    valuesBySessionId: new Map([
      [SESSION_ID, fields.map((field) => buildValue(field.id, "High"))],
    ]),
  };
}

afterEach(() => {
  controller = undefined;
  restoreContainerWidth?.();
  restoreContainerWidth = null;
});

describe("SessionsListV2Host custom-field column visibility", () => {
  it("renders the page's own declared columns", () => {
    controller = buildController([buildField(FIELD_ID, "Priority")]);

    renderHost();

    // The positive control for every assertion below, and DELIBERATELY only
    // about a declared column: a failure here is a surface that never mounted,
    // not the custom half. It carries no custom-field claim precisely because
    // it must stay green in both the fixed and the broken build.
    expect(customFieldHeader(STATUS_COLUMN_ID)).not.toBeNull();
  });

  it("keeps the custom column and its cell after the page stores the host's view", () => {
    controller = buildController([buildField(FIELD_ID, "Priority")]);

    const { rerender } = renderHost();
    // One more commit past the mount, so what is asserted is the SETTLED render
    // rather than the transient one the surface produces before the host has
    // round-tripped through the page. Under the defect the column exists for
    // that first commit and is gone by this one — which is exactly why the e2e
    // failed on its initial attempt and both retries rather than flaking.
    rerender(<HostUnderTest />);

    expect(customFieldHeader(CUSTOM_COLUMN_ID)).not.toBeNull();
    expect(screen.getByText("High")).toBeVisible();
  });

  it("never reports a custom-field id back to the page", () => {
    const reported: SessionsHostViewState[] = [];
    controller = buildController([buildField(FIELD_ID, "Priority")]);
    restoreContainerWidth = stubContainerWidthPx(WIDE_CONTAINER_PX);

    function CaptureHost() {
      const [hostView, setHostView] = useState(HOST_VIEW);
      const capture = useCallback((next: SessionsHostViewState) => {
        reported.push(next);
        setHostView({
          ...next,
          visibleColumns: new Set(
            DECLARED_COLUMN_IDS.filter((id) => next.visibleColumns.has(id))
          ),
        });
      }, []);
      return (
        <SessionsListV2Host
          getSessionHref={(item) => `/acme/sessions/${item.id}`}
          hostView={hostView}
          isListPending={false}
          items={ITEMS}
          listReadState={SessionsListReadState.Settled}
          onHostViewChange={capture}
          pageSize={25}
          summaryIsLoading={false}
          total={ITEMS.length}
          usage={undefined}
        />
      );
    }

    render(<CaptureHost />, { wrapper: AppCoreStoryProviders });

    // The page's `toggleColumn` does NOT filter against its valid-id list, so a
    // `custom-field:*` id reaching it is persisted into the saved view's
    // `hiddenColumns` in localStorage — permanently, for a column that set can
    // never describe. The host must strip it, not rely on the page ignoring it.
    for (const next of reported) {
      expect([...next.visibleColumns]).not.toContain(CUSTOM_COLUMN_ID);
    }
  });

  it("shows a second field that appears after mount without a reader action", () => {
    controller = buildController([buildField(FIELD_ID, "Priority")]);
    const { rerender } = renderHost();
    expect(customFieldHeader(HIDDEN_COLUMN_ID)).toBeNull();

    controller = buildController([
      buildField(FIELD_ID, "Priority"),
      buildField(HIDDEN_FIELD_ID, "Stage"),
    ]);
    rerender(<HostUnderTest />);

    // A field the reader just created, or one an admin attached, is VISIBLE by
    // default — the host stores the hidden ids, so an id it has never seen
    // means shown rather than hidden.
    expect(customFieldHeader(HIDDEN_COLUMN_ID)).not.toBeNull();
  });
});
