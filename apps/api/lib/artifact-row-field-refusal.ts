import {
  type ArtifactRowFieldMutationError,
  unsupportedRowFieldRefusal,
} from "@repo/api/src/types/artifact-row-field-edit";
import { z } from "zod";
import { formatZodErrors } from "@/lib/route-utils";
import { isRecord } from "@/lib/type-guards";

const NO_KEYS_BODY = z.strictObject({});

/**
 * ISS-9485: the refusal for a PATCH body that names a row field its type does
 * not let a user write, or null. Read off the RAW body, because the Sessions
 * validator strips unknown keys, which is exactly the silent drop the ruling
 * forbids for a known row field.
 *
 * A key that is not a row field at all is left to the validator: the Sessions
 * body keeps stripping it for version skew, the Branches body keeps refusing it
 * as `.strict()`. A read-side key that names a writable field by another name
 * (`project`) is refused too, with the body key to send in `useFields`. A
 * body that is not an object (`null`, an array) is also left to the validator,
 * which already refuses it.
 *
 * The message is Zod's unrecognized-key text for the refused keys: the same
 * words the strict Branches body sent for them before this refusal existed,
 * so no route sends agent-written copy (AGENTS.md, Human Provenance).
 */
export function unsupportedRowFieldError(
  rawBody: unknown,
  rowFieldEdit: Readonly<Record<string, string>>,
  writableFields: readonly string[]
): ArtifactRowFieldMutationError | null {
  if (!isRecord(rawBody)) {
    return null;
  }
  const unsupported = Object.entries(rowFieldEdit).filter(
    ([key]) => Object.hasOwn(rawBody, key) && !writableFields.includes(key)
  );
  if (unsupported.length === 0) {
    return null;
  }
  const unsupportedFields = unsupported.map(([key]) => key);
  const useFields: Record<string, string> = {};
  for (const [key, edit] of unsupported) {
    if (writableFields.includes(edit)) {
      useFields[key] = edit;
    }
  }
  return unsupportedRowFieldRefusal(
    unrecognizedKeysMessage(unsupportedFields),
    {
      unsupportedFields,
      writableFields: [...writableFields],
      ...(Object.keys(useFields).length > 0 ? { useFields } : {}),
    }
  );
}

function unrecognizedKeysMessage(keys: readonly string[]): string {
  const result = NO_KEYS_BODY.safeParse(
    Object.fromEntries(keys.map((key) => [key, null]))
  );
  return result.success ? "" : formatZodErrors(result.error.issues);
}
