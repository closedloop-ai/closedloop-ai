import ts from "typescript6";

/**
 * Scalar-alias resolution for the date-revival discovery walk (ISS-6208).
 *
 * A contract only spells its scalar inline half the time. `createdAt:
 * IsoTimestamp` and `createdAt: TimestampSchema` both name a scalar declared
 * elsewhere, and the structural walk that follows the reference arrives at a
 * bare `string` with no property key still attached — so neither the `Date` side
 * nor the `string` side collects the key, and the derived table agrees with the
 * checked-in one on the same OMISSION. These helpers classify the far end of
 * such a reference so the walk can carry the OWNING property name through the
 * hop.
 *
 * Only a genuinely scalar far end is classified. An alias for an object type, an
 * array, or a `z.object({…})` schema resolves to nothing here: attributing an
 * object's inner `string` to the property that holds it would suppress revival
 * on a key that endpoint never served as a scalar at all.
 */

/** `z.date()` / `z.coerce.date()` — the Zod spellings that infer to `Date`. */
export const ZOD_DATE_CALLEE = /^z\.(coerce\.)?date$/;
/** `z.string()` — the Zod spelling that infers to `string`. */
export const ZOD_STRING_CALLEE = /^z\.string$/;
/** The Zod namespace root, which is never an alias worth resolving. */
const ZOD_NAMESPACE = "z";
/** Resolved by the walk's own `Date` handling, never as an alias hop. */
const DATE_TYPE = "Date";

export type ScalarKind = "date" | "string";

/** A property whose declared type names a scalar declared somewhere else. */
export type PendingAttribution = {
  /** The alias or schema name still to resolve. */
  name: string;
  /** The property key whatever that name resolves to belongs to. */
  ownerKey: string;
};

/** A Zod field initializer: a resolved scalar, or another name to follow. */
export type ZodScalar = { kind: ScalarKind } | { alias: string };

/**
 * The scalar a type node resolves to on its own, without following any name.
 * A nullable union (`IsoTimestamp | null`) is the same scalar as its one real
 * member, which is how an optional timestamp keeps its classification.
 */
export function scalarKindOfType(type: ts.TypeNode): ScalarKind | undefined {
  const members = scalarMembers(type);
  if (members.length > 1 || members[0] !== type) {
    const kinds = members.map(scalarKindOfType);
    if (kinds.includes("date")) {
      return "date";
    }
    return kinds.includes("string") ? "string" : undefined;
  }
  if (ts.isTypeReferenceNode(type)) {
    return type.typeName.getText() === DATE_TYPE ? "date" : undefined;
  }
  if (type.kind === ts.SyntaxKind.StringKeyword) {
    return "string";
  }
  if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
    return "string";
  }
  return undefined;
}

/**
 * The name a type node defers to when it is a bare reference to another type.
 * A generic reference (`Paginated<Thing>`) is deliberately not one: its scalar,
 * if any, is already syntactically present in the type argument.
 */
export function scalarAliasName(type: ts.TypeNode): string | undefined {
  const members = scalarMembers(type);
  if (members.length > 1 || members[0] !== type) {
    for (const member of members) {
      const name = scalarAliasName(member);
      if (name) {
        return name;
      }
    }
    return undefined;
  }
  if (
    ts.isTypeReferenceNode(type) &&
    !type.typeArguments &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text !== DATE_TYPE
  ) {
    return type.typeName.text;
  }
  return undefined;
}

/**
 * Classify a Zod field initializer, following the modifier chain
 * (`.optional()`, `.nullable()`) down to the schema that actually declares the
 * type. A bare identifier is a reusable schema to resolve on the next hop.
 */
export function classifyZodScalar(
  expression: ts.Expression
): ZodScalar | undefined {
  if (ts.isIdentifier(expression)) {
    return expression.text === ZOD_NAMESPACE
      ? undefined
      : { alias: expression.text };
  }
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression.getText();
    if (ZOD_DATE_CALLEE.test(callee)) {
      return { kind: "date" };
    }
    if (ZOD_STRING_CALLEE.test(callee)) {
      return { kind: "string" };
    }
    return classifyZodScalar(expression.expression);
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return classifyZodScalar(expression.expression);
  }
  return undefined;
}

/** Whether a type node is the `null` or `undefined` half of a nullable union. */
function isNullish(type: ts.TypeNode): boolean {
  if (type.kind === ts.SyntaxKind.UndefinedKeyword) {
    return true;
  }
  return (
    ts.isLiteralTypeNode(type) &&
    type.literal.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * The members worth classifying: a parenthesized type unwrapped, a union
 * reduced to its non-nullish members, anything else returned as itself. The
 * identity return is what lets the callers above detect "nothing to unwrap".
 */
function scalarMembers(type: ts.TypeNode): readonly ts.TypeNode[] {
  if (ts.isParenthesizedTypeNode(type)) {
    return scalarMembers(type.type);
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.filter((member) => !isNullish(member));
  }
  return [type];
}
