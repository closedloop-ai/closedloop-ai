/**
 * Parity between a hand-written `.d.mts` ambient declaration and the runtime
 * `.mjs` module it describes.
 *
 * WHY (ISS-6211): `preview-heavy-migrations-core.d.mts` restated the two
 * preview migration lists as literal tuples. Nothing checked the copy, and it
 * drifted — the declaration named 5 skip entries and 1 plain-build entry while
 * the runtime module had grown to 9 and 2. A declaration is invisible at
 * runtime, so the drift could not surface as a test failure anywhere; it just
 * described a module that no longer existed.
 *
 * The contract this encodes: the `.mjs` is the ONE owned source. The `.d.mts`
 * may name the exports and may leave their contents unrestated
 * (`readonly string[]`), but any value it DOES restate must equal the runtime
 * value exactly.
 *
 * Parsed with `ts.createSourceFile` and asserted on the resolved AST — the
 * mechanism AGENTS.md ("Test Practices") sanctions in place of a raw-text scan,
 * so a reorder or a rename cannot fake agreement and a comment cannot satisfy
 * it.
 */

import ts from "typescript6";

/**
 * What a declared type claims the runtime export IS, independent of whether it
 * also spells the values out.
 *
 * A widened declaration still makes a claim — `readonly string[]` promises an
 * array of strings — and that claim is checkable even when there are no
 * literals to compare. Collapsing "declares a function" and "declares widened
 * data" into one unrestated bucket is what let a `readonly string[]` sit over a
 * runtime array of numbers with parity reporting agreement.
 */
export const DeclaredShape = {
  /** A function signature: the runtime export must be callable. */
  Function: "function",
  /** A string, a string literal, or any array/tuple/union of those. */
  StringValues: "stringValues",
  /** A type this comparator cannot check any runtime value against. */
  Unverifiable: "unverifiable",
} as const;
export type DeclaredShape = (typeof DeclaredShape)[keyof typeof DeclaredShape];

/** One `export declare`d name and the string values its type restates. */
export type DeclaredExport = {
  name: string;
  /** The base shape the declared type promises consumers. */
  shape: DeclaredShape;
  /**
   * `true` when the declared type spells any value out — in a tuple, an array
   * or `ReadonlyArray` of literals, a union, or behind a local type alias —
   * rather than widening it (`readonly string[]`, a function signature). Only a
   * restating declaration can drift.
   */
  restatesValues: boolean;
  /** The string literals in the declared type, in source order. */
  literals: readonly string[];
};

/** A runtime export, reduced to the string values parity can compare. */
export type RuntimeExport = {
  name: string;
  /** `null` when the value is neither a string nor an array of strings. */
  values: readonly string[] | null;
  /** `true` when the runtime export is callable. */
  isFunction: boolean;
  /** What the runtime value actually is, for the failure message. */
  description: string;
};

const CONTRACT =
  "The `.mjs` runtime module is the one owned source for these values. Its `.d.mts` sibling may name an export and leave its contents unrestated (`readonly string[]`), but any value the declaration DOES spell out must equal the runtime value exactly. Remedy: delete the restated literals from the declaration, or update them to match the runtime module. Exemption: none — a declaration that describes a module that does not exist is never correct.";

/**
 * The exported value declarations of an ambient `.d.mts`, resolved from its AST.
 *
 * Only value declarations are collected (`export const`, `export function`);
 * pure `type`/`interface` exports carry no runtime counterpart to compare.
 */
export function parseDeclaredExports(
  source: string,
  fileName: string
): DeclaredExport[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS
  );
  const localAliases = collectLocalTypeAliases(sourceFile);
  const declared: DeclaredExport[] = [];
  for (const statement of sourceFile.statements) {
    if (!isExported(statement)) {
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      declared.push({
        name: statement.name.text,
        shape: DeclaredShape.Function,
        restatesValues: false,
        literals: [],
      });
      continue;
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) {
        continue;
      }
      const shape = classifyDeclaredShape(declaration.type, localAliases);
      const literals =
        shape === DeclaredShape.Function
          ? []
          : collectStringLiterals(declaration.type, localAliases);
      declared.push({
        name: declaration.name.text,
        shape,
        // Derived from the literals themselves, NOT from the type node's shape.
        // Keying on `isTupleTypeNode` missed every other way a declaration can
        // spell values out — `readonly ("a" | "b")[]`, `ReadonlyArray<"a">`, a
        // bare union — and each of those would then have drifted in silence,
        // which is the fail-open this whole change exists to close. It also
        // stops a widening tuple (`readonly [string, ...string[]]`) from being
        // reported as a restatement of nothing.
        restatesValues: literals.length > 0,
        literals,
      });
    }
  }
  return declared;
}

/**
 * Every way the declaration and the runtime module disagree, as operator-facing
 * messages. An empty array is parity.
 *
 * Fails closed on a declaration that parsed to nothing: an unreadable or
 * restructured `.d.mts` must not read as "no disagreements found".
 */
export function findDeclarationParityProblems(
  declared: readonly DeclaredExport[],
  runtime: readonly RuntimeExport[]
): string[] {
  if (declared.length === 0) {
    throw new Error(
      `No exported value declarations were parsed from the declaration file, so parity could not be evaluated and this fails closed rather than reporting agreement. ${CONTRACT}`
    );
  }
  const problems: string[] = [];
  const declaredByName = new Map(declared.map((entry) => [entry.name, entry]));
  const runtimeByName = new Map(runtime.map((entry) => [entry.name, entry]));

  for (const entry of runtime) {
    if (!declaredByName.has(entry.name)) {
      problems.push(
        `Runtime module exports "${entry.name}" but the declaration file does not declare it, so every consumer of that export fails to typecheck. ${CONTRACT}`
      );
    }
  }
  for (const entry of declared) {
    const runtimeEntry = runtimeByName.get(entry.name);
    if (!runtimeEntry) {
      problems.push(
        `Declaration file declares "${entry.name}" but the runtime module does not export it, so consumers typecheck against a value that is undefined at runtime. ${CONTRACT}`
      );
      continue;
    }
    problems.push(...compareDeclaredToRuntime(entry, runtimeEntry));
  }
  return problems;
}

/**
 * The declared base shape is checked FIRST, and for every declaration — not
 * only the ones that restate literals.
 *
 * Skipping straight to the literal comparison meant a widened
 * `readonly string[]` was never checked against anything, so a runtime export
 * that had become an array of numbers, an object, or `undefined` still read as
 * parity while consumers typechecked against `string[]`. Fail-closed means the
 * declaration's whole claim is verified or the comparator says it could not
 * verify it.
 */
function compareDeclaredToRuntime(
  entry: DeclaredExport,
  runtimeEntry: RuntimeExport
): string[] {
  if (entry.shape === DeclaredShape.Function) {
    if (runtimeEntry.isFunction) {
      return [];
    }
    return [
      `Declaration of "${entry.name}" declares a function but the runtime export is ${runtimeEntry.description}, so consumers typecheck against a callable the module does not export. ${CONTRACT}`,
    ];
  }
  if (entry.shape === DeclaredShape.Unverifiable) {
    return [
      `Declaration of "${entry.name}" uses a type this comparator cannot check any runtime value against, so parity cannot be verified and fails closed rather than reporting agreement. Declare the export with a string-valued or function type, or teach this comparator the type. ${CONTRACT}`,
    ];
  }
  if (runtimeEntry.values === null) {
    return [
      `Declaration of "${entry.name}" declares string values but the runtime export is ${runtimeEntry.description}, so the declared contract cannot be verified and consumers typecheck against a shape the module does not have. ${CONTRACT}`,
    ];
  }
  if (!entry.restatesValues) {
    return [];
  }
  if (sameOrderedValues(entry.literals, runtimeEntry.values)) {
    return [];
  }
  return [
    `Declaration of "${entry.name}" restates ${JSON.stringify(entry.literals)} but the runtime module exports ${JSON.stringify(runtimeEntry.values)}. ${CONTRACT}`,
  ];
}

/** Reduces a runtime export to the string values parity can compare. */
export function toRuntimeExport(name: string, value: unknown): RuntimeExport {
  if (typeof value === "function") {
    return { name, values: null, isFunction: true, description: "a function" };
  }
  if (typeof value === "string") {
    return {
      name,
      values: [value],
      isFunction: false,
      description: "a string",
    };
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return {
      name,
      values: [...value],
      isFunction: false,
      description: "an array of strings",
    };
  }
  return {
    name,
    values: null,
    isFunction: false,
    description: describeRuntimeValue(value),
  };
}

function isExported(statement: ts.Statement): boolean {
  return Boolean(
    ts.canHaveModifiers(statement) &&
      ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
  );
}

/** The file's own `type X = …` aliases, so a reference to one can be expanded. */
function collectLocalTypeAliases(
  sourceFile: ts.SourceFile
): ReadonlyMap<string, ts.TypeNode> {
  const aliases = new Map<string, ts.TypeNode>();
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement)) {
      aliases.set(statement.name.text, statement.type);
    }
  }
  return aliases;
}

/**
 * Every string literal the declared type spells out, in source order.
 *
 * References to a type alias declared in the same file are expanded, because
 * `type SkipList = readonly ["a", "b"]` hides the literals behind a name and
 * would otherwise read as a widened declaration with nothing to compare — a
 * fail-open. `visited` stops a self-referential alias from recursing forever.
 */
function collectStringLiterals(
  type: ts.TypeNode | undefined,
  localAliases: ReadonlyMap<string, ts.TypeNode>,
  visited: ReadonlySet<string> = new Set()
): string[] {
  if (!type) {
    return [];
  }
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    // `isStringLiteralLike`, not `isStringLiteral`: a backtick literal type
    // (`` `a` ``) parses as a NoSubstitutionTemplateLiteral, which the narrower
    // predicate misses — a tuple copied with backticks would then collect no
    // literals, read as widened, and drift in silence.
    if (ts.isStringLiteralLike(node)) {
      literals.push(node.text);
      return;
    }
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) {
      const aliasName = node.typeName.text;
      const alias = localAliases.get(aliasName);
      if (alias && !visited.has(aliasName)) {
        literals.push(
          ...collectStringLiterals(
            alias,
            localAliases,
            new Set([...visited, aliasName])
          )
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(type);
  return literals;
}

function sameOrderedValues(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/** Generic type references whose single argument carries the element type. */
const ARRAY_TYPE_REFERENCE_NAMES = new Set(["Array", "ReadonlyArray"]);

/**
 * The base shape a declared type promises, without regard to whether it also
 * spells the values out.
 *
 * Anything this cannot categorize is `Unverifiable` rather than "fine": an
 * unrecognized declared type is a claim the comparator cannot check, and a
 * guard that cannot evaluate must fail rather than pass.
 */
function classifyDeclaredShape(
  type: ts.TypeNode | undefined,
  localAliases: ReadonlyMap<string, ts.TypeNode>
): DeclaredShape {
  if (type && ts.isFunctionTypeNode(type)) {
    return DeclaredShape.Function;
  }
  if (isStringValuedType(type, localAliases, new Set())) {
    return DeclaredShape.StringValues;
  }
  return DeclaredShape.Unverifiable;
}

/** Whether every leaf of the declared type is `string` or a string literal. */
function isStringValuedType(
  type: ts.TypeNode | undefined,
  localAliases: ReadonlyMap<string, ts.TypeNode>,
  visited: ReadonlySet<string>
): boolean {
  if (!type) {
    return false;
  }
  if (ts.isLiteralTypeNode(type)) {
    return ts.isStringLiteralLike(type.literal);
  }
  if (type.kind === ts.SyntaxKind.StringKeyword) {
    return true;
  }
  if (
    ts.isParenthesizedTypeNode(type) ||
    ts.isRestTypeNode(type) ||
    ts.isOptionalTypeNode(type) ||
    ts.isNamedTupleMember(type)
  ) {
    return isStringValuedType(type.type, localAliases, visited);
  }
  if (ts.isTypeOperatorNode(type)) {
    return (
      type.operator === ts.SyntaxKind.ReadonlyKeyword &&
      isStringValuedType(type.type, localAliases, visited)
    );
  }
  if (ts.isArrayTypeNode(type)) {
    return isStringValuedType(type.elementType, localAliases, visited);
  }
  if (ts.isTupleTypeNode(type)) {
    return type.elements.every((member) =>
      isStringValuedType(member, localAliases, visited)
    );
  }
  if (ts.isUnionTypeNode(type)) {
    return type.types.every((member) =>
      isStringValuedType(member, localAliases, visited)
    );
  }
  if (ts.isTypeReferenceNode(type)) {
    return isStringValuedTypeReference(type, localAliases, visited);
  }
  return false;
}

/**
 * A local alias is expanded; `Array`/`ReadonlyArray` are unwrapped to their
 * element type. Any other reference — including an alias that recurses into
 * itself — is unknown, and unknown fails closed.
 */
function isStringValuedTypeReference(
  type: ts.TypeReferenceNode,
  localAliases: ReadonlyMap<string, ts.TypeNode>,
  visited: ReadonlySet<string>
): boolean {
  if (!ts.isIdentifier(type.typeName)) {
    return false;
  }
  const aliasName = type.typeName.text;
  const alias = localAliases.get(aliasName);
  if (alias) {
    return (
      !visited.has(aliasName) &&
      isStringValuedType(alias, localAliases, new Set([...visited, aliasName]))
    );
  }
  const [elementType] = type.typeArguments ?? [];
  if (ARRAY_TYPE_REFERENCE_NAMES.has(aliasName) && elementType) {
    return isStringValuedType(elementType, localAliases, visited);
  }
  return false;
}

/** What a runtime value the comparator cannot reduce to strings actually is. */
function describeRuntimeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    const offending = value.find((item) => typeof item !== "string");
    return `an array containing a non-string entry (${typeof offending})`;
  }
  return `a value of type "${typeof value}"`;
}
