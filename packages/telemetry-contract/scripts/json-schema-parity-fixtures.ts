/**
 * Shared shape and text builders for the generated-JSON-Schema parity cases.
 *
 * Split out of `check-json-schemas.ts` (ISS-6313) so the per-schema case tables
 * and the Ajv runner that executes them stop sharing one file: the app table
 * alone grew past what a single module should carry, and the runner is the part
 * nobody edits when a new attribute lands.
 */

/** One generated schema plus the payloads it must accept and reject. */
export type SchemaCheck = {
  path: string;
  id: string;
  validPayloads: Array<{
    name: string;
    payload: Record<string, unknown>;
  }>;
  invalidPayloads: Array<{
    name: string;
    payload: Record<string, unknown>;
  }>;
  /**
   * Attributes whose generated `enum` must be SET-EQUAL to the source constant
   * that defines it.
   *
   * A payload table can only ever pin the members somebody remembered to list,
   * so a value added to the source and dropped by the generator stays green
   * until a hand-written case catches up with it. Comparing the two sets is
   * derived, so it cannot go stale: the next member is covered by the member
   * that adds it.
   */
  enumParity?: Array<{
    attribute: string;
    members: readonly string[];
  }>;
};

const NON_BMP_CHARACTER = String.fromCodePoint(0x1_f9_ea);

/**
 * Bounded text built from a non-BMP character, so a length case measures the
 * same units the schema does rather than passing on a UTF-16 accident.
 */
export const maxUnicodeText = (maxLength: number) =>
  NON_BMP_CHARACTER.repeat(maxLength);

export const overflowUnicodeText = (maxLength: number) =>
  NON_BMP_CHARACTER.repeat(maxLength + 1);

// ISS-7217/ISS-7224: the span's `error.type`, `artifact.type`, and
// `artifact.status` are pattern-bounded, not free text, so their length cases
// must be built from characters the pattern actually accepts — otherwise a
// case named "above maximum" would be passing on the pattern instead.
export const identifierText = (length: number) => "E".repeat(length);

export const upperTokenText = (length: number) => "A".repeat(length);

/**
 * Hold one generated schema's declared enums to the source constants they were
 * generated from. Throws on the first divergence, in either direction: a member
 * the generator dropped, and one it invented.
 */
export function assertEnumParity(
  path: string,
  properties: Record<string, Record<string, unknown>>,
  entries: SchemaCheck["enumParity"]
): void {
  for (const entry of entries ?? []) {
    const generated = properties[entry.attribute]?.enum;
    if (!Array.isArray(generated)) {
      throw new Error(
        `${path} declares no enum for ${entry.attribute}; the source constant has ${entry.members.length} member(s)`
      );
    }
    const generatedMembers = [...generated].map(String).sort().join(",");
    const sourceMembers = [...entry.members].sort().join(",");
    if (generatedMembers !== sourceMembers) {
      throw new Error(
        `${path} enum for ${entry.attribute} is [${generatedMembers}] but its source constant is [${sourceMembers}]`
      );
    }
  }
}
