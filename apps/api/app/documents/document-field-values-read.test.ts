import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { log } from "@repo/observability/log";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { customFieldValuesService } from "@/app/custom-fields/values-service";
import { readDocumentFieldValues } from "./document-field-values-read";

vi.mock("@/app/custom-fields/values-service", () => ({
  customFieldValuesService: { getValuesForEntity: vi.fn() },
}));
vi.mock("@repo/observability/log", () => ({ log: { warn: vi.fn() } }));

const readValues = vi.mocked(customFieldValuesService.getValuesForEntity);
const organizationId = "org-fields";

beforeEach(() => vi.clearAllMocks());

describe("document field values cohort", () => {
  it("reuses the canonical scoped projection without per-row reads", async () => {
    const value = {
      id: "value-a",
      customFieldId: "field-a",
      entityId: "a",
      name: "Field",
      fieldType: CustomFieldType.Text,
      displayValue: "hello",
      showInTable: true,
      textValue: "hello",
      numberValue: null,
      dateValue: null,
      enumValue: null,
      multiEnumValues: [],
      peopleValues: [],
      referenceValues: [],
    };
    readValues.mockResolvedValue([value]);
    expect(
      await readDocumentFieldValues(organizationId, ["a", "b", "a"])
    ).toEqual(new Map([["a", [value]]]));
    expect(readValues).toHaveBeenCalledExactlyOnceWith(
      CustomFieldEntityType.Document,
      ["a", "b"],
      organizationId
    );
  });

  it("distinguishes an empty cohort from a failed read", async () => {
    expect(await readDocumentFieldValues(organizationId, [])).toEqual(
      new Map()
    );
    expect(readValues).not.toHaveBeenCalled();
    readValues.mockRejectedValue(new Error("unavailable"));
    expect(await readDocumentFieldValues(organizationId, ["a"])).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(
      "telemetry.enrichment_failed",
      expect.objectContaining({
        enrichmentKind: "document_field_values",
        organizationId,
      })
    );
  });

  it("bounds batches and discards partial enrichment on failure", async () => {
    readValues
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("later chunk failed"));
    const ids = Array.from({ length: 1001 }, (_, index) => `artifact-${index}`);
    expect(await readDocumentFieldValues(organizationId, ids)).toBeNull();
    expect(readValues.mock.calls.map((call) => call[1].length)).toEqual([
      1000, 1,
    ]);
  });
});
