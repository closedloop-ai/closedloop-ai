import {
  CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import { CustomFieldFilterOperator } from "@repo/api/src/types/custom-field-list-query";
import { DocumentType } from "@repo/api/src/types/document";
import { documentsPrototypeColumns } from "@repo/app/artifacts/components/artifact-list-model";
import {
  artifactExtensionFilterScope,
  DOCUMENT_TYPE_EXTENSION_COLUMN_ID,
} from "@repo/app/artifacts/components/artifact-summary-extension-scope";
import { documentCustomFieldColumnId } from "@repo/app/documents/components/documents-prototype-custom-fields";
import { getDocumentTypeLabel } from "@repo/app/documents/lib/document-navigation";
import { describe, expect, it } from "vitest";

const OPTION_A = "00000000-0000-4000-8000-0000000000a1";
const OPTION_B = "00000000-0000-4000-8000-0000000000a2";
const OPTION_C = "00000000-0000-4000-8000-0000000000a3";

function field(
  id: string,
  fieldType: CustomFieldType,
  overrides: Partial<CustomFieldWithOptions> = {}
): CustomFieldWithOptions {
  return {
    id,
    organizationId: "org-1",
    name: id,
    description: null,
    fieldType,
    createdById: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    precision: null,
    numberFormat: null,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    isGlobalToOrg: true,
    entityTypes: [CustomFieldEntityType.Document],
    referenceTargetSources: [],
    showInTable: true,
    isSearchable: true,
    isSortable: true,
    enumOptions: [],
    ...overrides,
  };
}

const ENUM = field(
  "00000000-0000-4000-8000-0000000000e1",
  CustomFieldType.Enum,
  {
    enumOptions: [
      {
        id: OPTION_B,
        customFieldId: "e",
        name: "P0",
        color: "",
        enabled: true,
        sortOrder: 0,
      },
      {
        id: OPTION_A,
        customFieldId: "e",
        name: "P0",
        color: "",
        enabled: true,
        sortOrder: 1,
      },
      {
        id: OPTION_C,
        customFieldId: "e",
        name: "P1",
        color: "",
        enabled: true,
        sortOrder: 2,
      },
    ],
  }
);
const TEXT = field(
  "00000000-0000-4000-8000-0000000000e2",
  CustomFieldType.Text
);
const PEOPLE = field(
  "00000000-0000-4000-8000-0000000000e3",
  CustomFieldType.People
);
const NUMBER = field(
  "00000000-0000-4000-8000-0000000000e4",
  CustomFieldType.Number
);
const FIELDS = [ENUM, TEXT, PEOPLE, NUMBER];
const COLUMNS = [
  ...documentsPrototypeColumns(),
  ...FIELDS.map((definition) => ({
    ...documentsPrototypeColumns()[0],
    id: documentCustomFieldColumnId(definition.id),
  })),
];

function scope(
  id: string,
  filter: { selectedValues?: string[]; min?: number }
) {
  return artifactExtensionFilterScope({ [id]: filter }, COLUMNS, FIELDS);
}

describe("artifactExtensionFilterScope", () => {
  it("maps option-name labels to every option id carrying that name", () => {
    expect(
      scope(documentCustomFieldColumnId(ENUM.id), { selectedValues: ["P0"] })
    ).toEqual({
      expressible: true,
      customFieldFilters: [
        {
          fieldId: ENUM.id,
          operator: CustomFieldFilterOperator.IsAnyOf,
          values: [OPTION_A, OPTION_B],
        },
      ],
    });
  });

  it("maps text labels to the stored text", () => {
    expect(
      scope(documentCustomFieldColumnId(TEXT.id), {
        selectedValues: ["b", "a"],
      }).customFieldFilters
    ).toEqual([
      {
        fieldId: TEXT.id,
        operator: CustomFieldFilterOperator.IsAnyOf,
        values: ["a", "b"],
      },
    ]);
  });

  it("maps the Type facet's labels back to persisted subtypes", () => {
    const label = getDocumentTypeLabel(DocumentType.Prd) ?? "";
    expect(
      scope(DOCUMENT_TYPE_EXTENSION_COLUMN_ID, { selectedValues: [label] })
    ).toEqual({
      expressible: true,
      customFieldFilters: [],
      types: [DocumentType.Prd],
    });
  });

  it("leaves people labels, ranges and fields the server will not filter unscoped", () => {
    expect(
      scope(documentCustomFieldColumnId(PEOPLE.id), { selectedValues: ["Ada"] })
        .expressible
    ).toBe(false);
    expect(
      scope(documentCustomFieldColumnId(NUMBER.id), { min: 3 }).expressible
    ).toBe(false);
    expect(
      artifactExtensionFilterScope(
        { [documentCustomFieldColumnId(ENUM.id)]: { selectedValues: ["P0"] } },
        COLUMNS,
        [{ ...ENUM, filterOperators: [CustomFieldFilterOperator.IsEmpty] }]
      ).expressible
    ).toBe(false);
  });

  it("ignores a filter on a column the list does not render, as the list does", () => {
    expect(scope("custom-retired", { selectedValues: ["x"] })).toEqual({
      expressible: true,
      customFieldFilters: [],
    });
  });
});
