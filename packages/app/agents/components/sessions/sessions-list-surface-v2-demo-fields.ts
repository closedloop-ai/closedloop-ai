import type {
  CustomFieldEnumOption,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  NumberFormat,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import type { CustomFieldTableValue } from "@repo/app/custom-fields/components/custom-field-table-cell";

/**
 * The demo custom-field corpus for {@link SessionsListSurfaceV2Preview}, one
 * seed per supported `CustomFieldType`, kept OPT-IN at the call site.
 *
 * Two callers share that preview and want opposite things from it: the
 * Storybook `Default` story documents the surface WITH custom-field columns
 * (Stage, Cycle time, and the Add-field affordance beside them), while the
 * `apps/prototypes` Sessions page documents it without them and asserts the
 * Stage column is absent. Field and value travel together so a seeded value can
 * never drift onto the wrong field, which a pair of parallel positional arrays
 * made possible.
 */
export const SESSIONS_DEMO_CUSTOM_FIELD_SEEDS: readonly {
  field: CustomFieldWithOptions;
  value: CustomFieldTableValue;
}[] = [
  {
    field: demoField("stage", "Stage", CustomFieldType.Enum, {
      enumOptions: [
        demoOption("stage", "stage-discovery", "Discovery", 0),
        demoOption("stage", "stage-build", "Build", 1),
        demoOption("stage", "stage-validate", "Validate", 2),
      ],
    }),
    value: "stage-build",
  },
  {
    field: demoField(
      "capabilities",
      "Capabilities",
      CustomFieldType.MultiEnum,
      {
        enumOptions: [
          demoOption("capabilities", "cap-grid", "Grid", 0),
          demoOption("capabilities", "cap-editing", "Editing", 1),
          demoOption("capabilities", "cap-governance", "Governance", 2),
        ],
      }
    ),
    value: ["cap-grid", "cap-governance"],
  },
  {
    field: demoField("due-date", "Due date", CustomFieldType.Date),
    value: "2026-09-04",
  },
  {
    field: demoField("reviewer", "Reviewer", CustomFieldType.People),
    value: ["user-ottilie"],
  },
  {
    field: demoField(
      "parent-issue",
      "Parent issue",
      CustomFieldType.Reference,
      {
        referenceTargetSources: [ReferenceTargetSource.Issue],
      }
    ),
    value: "issue-grid",
  },
  {
    field: demoField(
      "related-artifacts",
      "Related artifacts",
      CustomFieldType.ReferenceMulti,
      { referenceTargetSources: [ReferenceTargetSource.Artifact] }
    ),
    value: ["branch-grid", "session-prototype"],
  },
  {
    field: demoField("cycle-time", "Cycle time", CustomFieldType.Number, {
      numberFormat: NumberFormat.Duration,
    }),
    value: 4_320_000,
  },
  {
    field: demoField("summary", "Summary", CustomFieldType.Text),
    value: "Authentication guard migration",
  },
  {
    field: demoField(
      "revision-count",
      "Revision count",
      CustomFieldType.Number,
      {
        numberFormat: NumberFormat.None,
      }
    ),
    value: 94,
  },
];

function demoField(
  id: string,
  name: string,
  fieldType: CustomFieldWithOptions["fieldType"],
  overrides: Partial<CustomFieldWithOptions> = {}
): CustomFieldWithOptions {
  const timestamp = new Date("2026-08-25T12:00:00.000Z");
  return {
    createdAt: timestamp,
    createdById: "story-user",
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    description: null,
    entityTypes: [CustomFieldEntityType.Session],
    enumOptions: [],
    fieldType,
    id,
    isGlobalToOrg: false,
    isSearchable: true,
    isSortable: true,
    name,
    numberFormat: null,
    organizationId: "story-org",
    precision: null,
    referenceTargetSources: [],
    showInTable: true,
    updatedAt: timestamp,
    ...overrides,
  };
}

function demoOption(
  fieldId: string,
  id: string,
  name: string,
  sortOrder: number
): CustomFieldEnumOption {
  return {
    color: "#64748b",
    customFieldId: fieldId,
    enabled: true,
    id,
    name,
    sortOrder,
  };
}
