/**
 * ISS-8880 §4 — the 100-enum-option cap applies to BOTH write paths.
 *
 * `MAX_ENUM_OPTIONS_PER_FIELD` was enforced only by the incremental route
 * (`POST /custom-fields/:id/enum-options`, via `checkOptionLimit`). `createField`
 * nested-created every element and never consulted it, so one request could
 * exceed the documented cap ~50x, and a large enough array hit Prisma's default
 * transaction timeout as a P2028 → 500.
 *
 * The bound now lives in two places on purpose, and both are covered here:
 * the request schema (which is what returns 400) and `createField` itself
 * (which is an exported service method, so its own contract is reachable
 * without the route).
 */
import { CustomFieldType } from "@repo/api/src/types/custom-field";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  count: vi.fn(),
  tx: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  Prisma: { TransactionIsolationLevel: { Serializable: "Serializable" } },
  withDb: Object.assign(vi.fn(), { tx: mocks.tx }),
}));

vi.mock("@/lib/db-utils", () => ({ getPrismaErrorCode: () => undefined }));

import { customFieldsService } from "../service";
import { MAX_ENUM_OPTIONS_PER_FIELD } from "../utils";
import { createCustomFieldValidator } from "../validators";

const OPTION_LIMIT_MESSAGE = /maximum of 100 enum options/;

const ORG_ID = "org-1";
const USER_ID = "user-1";

function options(count: number) {
  return Array.from({ length: count }, (_, i) => ({ name: `option-${i}` }));
}

function body(optionCount: number) {
  return {
    name: "field",
    fieldType: CustomFieldType.Enum,
    enumOptions: options(optionCount),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.count.mockResolvedValue(0);
  mocks.create.mockResolvedValue({ id: "field-1", enumOptions: [] });
  mocks.tx.mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({
      customField: { count: mocks.count, create: mocks.create },
    })
  );
});

describe("§4 request schema bound", () => {
  it(`refuses ${MAX_ENUM_OPTIONS_PER_FIELD + 1} options`, () => {
    const parsed = createCustomFieldValidator.safeParse(
      body(MAX_ENUM_OPTIONS_PER_FIELD + 1)
    );

    expect(parsed.success).toBe(false);
  });

  it(`accepts exactly ${MAX_ENUM_OPTIONS_PER_FIELD} — the over-rejection guard`, () => {
    const parsed = createCustomFieldValidator.safeParse(
      body(MAX_ENUM_OPTIONS_PER_FIELD)
    );

    expect(parsed.success).toBe(true);
  });

  it("still accepts a field with no enumOptions at all", () => {
    const parsed = createCustomFieldValidator.safeParse({
      name: "field",
      fieldType: CustomFieldType.Text,
    });

    expect(parsed.success).toBe(true);
  });
});

describe("§4 createField service bound", () => {
  it(`rejects ${MAX_ENUM_OPTIONS_PER_FIELD + 1} options and writes no row`, async () => {
    // Called DIRECTLY, bypassing the route schema — this is what makes the
    // service-side guard a live contract rather than a branch nothing enters.
    await expect(
      customFieldsService.createField(ORG_ID, USER_ID, {
        name: "field",
        fieldType: CustomFieldType.Enum,
        enumOptions: options(MAX_ENUM_OPTIONS_PER_FIELD + 1),
      })
    ).rejects.toThrow(OPTION_LIMIT_MESSAGE);

    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses before opening a transaction", async () => {
    await expect(
      customFieldsService.createField(ORG_ID, USER_ID, {
        name: "field",
        fieldType: CustomFieldType.Enum,
        enumOptions: options(MAX_ENUM_OPTIONS_PER_FIELD + 1),
      })
    ).rejects.toThrow();

    // The count is known from the argument alone, so there is no TOCTOU to
    // close and no reason to pay a BEGIN/ROLLBACK to refuse.
    expect(mocks.tx).not.toHaveBeenCalled();
  });

  it(`still creates with exactly ${MAX_ENUM_OPTIONS_PER_FIELD} options`, async () => {
    await customFieldsService.createField(ORG_ID, USER_ID, {
      name: "field",
      fieldType: CustomFieldType.Enum,
      enumOptions: options(MAX_ENUM_OPTIONS_PER_FIELD),
    });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const arg = mocks.create.mock.calls[0][0] as {
      data: { enumOptions?: { create: unknown[] } };
    };
    expect(arg.data.enumOptions?.create).toHaveLength(
      MAX_ENUM_OPTIONS_PER_FIELD
    );
  });
});
