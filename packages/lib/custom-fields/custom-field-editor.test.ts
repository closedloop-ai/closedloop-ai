import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { describe, expect, it } from "vitest";
import {
  CUSTOM_FIELD_DURATION_CODEC,
  CUSTOM_FIELD_EDITOR,
  CustomFieldEditor,
  CustomFieldValueParseOutcome,
  CustomFieldValueRejection,
  parseCustomFieldDurationDraft,
  resolveCustomFieldEditor,
  resolveCustomFieldScalarCodec,
} from "./custom-field-editor";

/**
 * The registry pinned against LITERALS rather than against itself. A fixture
 * built from `CUSTOM_FIELD_EDITOR` agrees with any edit to it, including a
 * deleted member — the duplication here IS the test.
 */
const EXPECTED_EDITOR: Record<string, string> = {
  TEXT: "scalar",
  NUMBER: "scalar",
  DATE: "scalar",
  ENUM: "choice",
  MULTI_ENUM: "choice",
  PEOPLE: "people",
  REFERENCE: "reference",
  REFERENCE_MULTI: "reference",
};

describe("CUSTOM_FIELD_EDITOR", () => {
  it("assigns every field type the editor the grid dispatches to", () => {
    expect({ ...CUSTOM_FIELD_EDITOR }).toEqual(EXPECTED_EDITOR);
  });

  it("gives a scalar codec to exactly the types it sends to the scalar editor", () => {
    const withCodec = Object.values(CustomFieldType).filter(
      (fieldType) => resolveCustomFieldScalarCodec(fieldType) !== null
    );

    const scalarTypes = Object.values(CustomFieldType).filter(
      (fieldType) =>
        resolveCustomFieldEditor(fieldType) === CustomFieldEditor.Scalar
    );

    expect([...withCodec].sort()).toEqual([...scalarTypes].sort());
  });
});

describe("resolveCustomFieldEditor", () => {
  it("offers no editor for a field type this build has no row for", () => {
    expect(resolveCustomFieldEditor("GEO_POINT")).toBe(CustomFieldEditor.None);
  });

  it("offers no editor for an inherited object key", () => {
    expect(resolveCustomFieldEditor("constructor")).toBe(
      CustomFieldEditor.None
    );
    expect(resolveCustomFieldEditor("__proto__")).toBe(CustomFieldEditor.None);
  });

  it("resolves no scalar codec for an unknown or inherited key", () => {
    expect(resolveCustomFieldScalarCodec("GEO_POINT")).toBeNull();
    expect(resolveCustomFieldScalarCodec("constructor")).toBeNull();
  });
});

describe("the scalar codecs", () => {
  /**
   * TWO keys on ONE draft: a single-key fixture cannot tell a per-type codec
   * from one global parser. `"12e"` is a value for TEXT and a refusal for
   * NUMBER, so a codec that answered the same for both fails here.
   */
  it("parses one draft differently per field type", () => {
    const text = parse(CustomFieldType.Text, "12e");
    const numeric = parse(CustomFieldType.Number, "12e");

    expect(text).toEqual({
      outcome: CustomFieldValueParseOutcome.Value,
      value: "12e",
    });
    expect(numeric).toEqual({
      outcome: CustomFieldValueParseOutcome.Rejected,
      reason: CustomFieldValueRejection.InvalidNumber,
    });
  });

  it("reads a blank NUMBER draft as a clear, never as a measured zero", () => {
    expect(parse(CustomFieldType.Number, "   ")).toEqual({
      outcome: CustomFieldValueParseOutcome.Cleared,
    });
  });

  it("keeps a finite number", () => {
    expect(parse(CustomFieldType.Number, " -3.5 ")).toEqual({
      outcome: CustomFieldValueParseOutcome.Value,
      value: -3.5,
    });
  });

  it("refuses a non-finite NUMBER draft", () => {
    expect(parse(CustomFieldType.Number, "1e400")).toEqual({
      outcome: CustomFieldValueParseOutcome.Rejected,
      reason: CustomFieldValueRejection.InvalidNumber,
    });
  });

  it("keeps a calendar DATE draft", () => {
    expect(parse(CustomFieldType.Date, "2026-09-24")).toEqual({
      outcome: CustomFieldValueParseOutcome.Value,
      value: "2026-09-24",
    });
  });

  /**
   * ISS-8884: `new Date("0")` is a valid January 2000 the year gate accepts, so
   * the calendar shape is what stops a date nobody typed reaching the column.
   */
  it("refuses a DATE draft that is not a calendar date", () => {
    expect(parse(CustomFieldType.Date, "0")).toEqual({
      outcome: CustomFieldValueParseOutcome.Rejected,
      reason: CustomFieldValueRejection.InvalidDate,
    });
  });

  /**
   * `0000-01-01` and not `99999-01-01`: the five-digit year fails
   * CALENDAR_DATE_PATTERN first, so the year gate is never executed and
   * deleting it leaves this suite green (#7901 review: bug-hunter-a). Year 0
   * is calendar-shaped and below CUSTOM_FIELD_DATE_MIN_YEAR, so only the gate
   * can refuse it.
   */
  it("refuses a calendar DATE draft outside the revivable year range", () => {
    expect(parse(CustomFieldType.Date, "0000-01-01")).toEqual({
      outcome: CustomFieldValueParseOutcome.Rejected,
      reason: CustomFieldValueRejection.InvalidDate,
    });
  });
});

describe("parseCustomFieldDurationDraft", () => {
  it("keeps a parseable span in milliseconds", () => {
    expect(parseCustomFieldDurationDraft("1h 12m")).toEqual({
      outcome: CustomFieldValueParseOutcome.Value,
      value: 4_320_000,
    });
  });

  it("reads a blank draft as a clear", () => {
    expect(parseCustomFieldDurationDraft("  ")).toEqual({
      outcome: CustomFieldValueParseOutcome.Cleared,
    });
  });

  /**
   * ONE draft, both codecs. A duration is a NUMBER field, so `90` is a value to
   * each of them and they disagree only about the UNIT — 90 seconds here, a
   * bare 90 there. Asserting both readings of the same draft is what pins the
   * split: pairing a duration-only REFUSAL with a number-only value proved
   * nothing, because `Number("1h 12")` is `NaN` and the NUMBER codec refuses it
   * too, so delegating bare numbers to `parseNumberDraft` left the suite green
   * (ISS-8213; #7902 review: tamsinb).
   */
  it("reads a bare draft as seconds where the NUMBER codec reads it as a count", () => {
    expect(parseCustomFieldDurationDraft("90")).toEqual({
      outcome: CustomFieldValueParseOutcome.Value,
      value: 90_000,
    });
    expect(parse(CustomFieldType.Number, "90")).toEqual({
      outcome: CustomFieldValueParseOutcome.Value,
      value: 90,
    });
  });

  it("refuses a span whose trailing token carries no unit", () => {
    expect(parseCustomFieldDurationDraft("1h 12")).toEqual({
      outcome: CustomFieldValueParseOutcome.Rejected,
      reason: CustomFieldValueRejection.InvalidDuration,
    });
  });
});

describe("the DURATION codec's toDraft", () => {
  it("opens on the span the read path rendered", () => {
    expect(
      CUSTOM_FIELD_DURATION_CODEC.toDraft(
        durationValue({ displayValue: "1h 12m", numberValue: 4_350_500 })
      )
    ).toBe("1h 12m");
  });

  it("formats the stored milliseconds when the server sent no display value", () => {
    expect(
      CUSTOM_FIELD_DURATION_CODEC.toDraft(
        durationValue({ displayValue: null, numberValue: 90_000 })
      )
    ).toBe("1m 30s");
  });

  /** A stored `0` is "0s"; only an unset value opens empty. */
  it("keeps a measured zero distinct from an unset value", () => {
    expect(
      CUSTOM_FIELD_DURATION_CODEC.toDraft(
        durationValue({ displayValue: null, numberValue: 0 })
      )
    ).toBe("0s");
    expect(
      CUSTOM_FIELD_DURATION_CODEC.toDraft(
        durationValue({ displayValue: null, numberValue: null })
      )
    ).toBe("");
  });
});

describe("the scalar codecs' toDraft", () => {
  it("opens a TEXT value on its stored text and an unset one empty", () => {
    expect(toDraft(CustomFieldType.Text, { textValue: "hi" })).toBe("hi");
    expect(toDraft(CustomFieldType.Text, { textValue: null })).toBe("");
  });

  /** A stored `0` is a measurement; only an unset NUMBER opens empty. */
  it("keeps a stored NUMBER zero distinct from an unset one", () => {
    expect(toDraft(CustomFieldType.Number, { numberValue: 0 })).toBe("0");
    expect(toDraft(CustomFieldType.Number, { numberValue: null })).toBe("");
  });

  it("opens a DATE on the calendar shape its input commits in", () => {
    expect(
      toDraft(CustomFieldType.Date, {
        dateValue: new Date("2026-09-24T00:00:00.000Z"),
      })
    ).toBe("2026-09-24");
  });

  /**
   * ISS-8884: a stored DATE the year gate rejects keeps its RAW wire text, so
   * the parse arm refuses it and the value stays on screen. A non-string wire
   * kind has no real stored text — `String(new Date(NaN))` is the literal words
   * "Invalid Date" — so those open empty instead of inventing one.
   */
  it("keeps an unrevivable DATE's raw text but never a toString artifact", () => {
    expect(
      toDraft(
        CustomFieldType.Date,
        wireDateValue("+010000-01-01T00:00:00.000Z")
      )
    ).toBe("+010000-01-01T00:00:00.000Z");
    expect(toDraft(CustomFieldType.Date, wireDateValue(0))).toBe("");
    expect(
      toDraft(CustomFieldType.Date, {
        dateValue: new Date("2026-99-99T00:00:00.000Z"),
      })
    ).toBe("");
  });
});

function toDraft(
  fieldType: CustomFieldType,
  stored: Partial<CustomFieldValueDetail>
): string {
  const codec = resolveCustomFieldScalarCodec(fieldType);
  if (!codec) {
    throw new Error(`no scalar codec for ${fieldType}`);
  }
  return codec.toDraft(storedValue(stored));
}

function durationValue(stored: Partial<CustomFieldValueDetail>) {
  return storedValue(stored);
}

/** Only the value columns under test are populated; the rest are unread here. */
function storedValue(
  stored: Partial<CustomFieldValueDetail>
): CustomFieldValueDetail {
  return stored as CustomFieldValueDetail;
}

/** A value as it arrives on the wire, before the reviver has typed it. */
function wireDateValue(dateValue: unknown): Partial<CustomFieldValueDetail> {
  return { dateValue } as Partial<CustomFieldValueDetail>;
}

function parse(fieldType: CustomFieldType, draft: string) {
  const codec = resolveCustomFieldScalarCodec(fieldType);
  if (!codec) {
    throw new Error(`no scalar codec for ${fieldType}`);
  }
  return codec.parse(draft);
}
