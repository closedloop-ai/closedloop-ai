import ts from "typescript6";
import { type ComponentMount, mountsIn, parseTsx } from "./jsx-mount-props";

/**
 * ISS-9223 — what a `gatedOn` claim has to survive before the parity differ
 * accepts it.
 *
 * The claim is "this consumer passes the capability on some mounts and not
 * others, and its own named gate is what decides". Every half is read off the
 * consumer's source rather than graded as prose, because the whole lesson of
 * ISS-9218 is that a free-text escape hatch stops being a check the moment
 * nothing reads it:
 *
 * - the JSX must SHOW the split. A prop no mount passes is simply absent, and a
 *   prop every mount passes is supplied — either way the gate is a fiction and
 *   the ledger has to say something else.
 * - the named gate must be the CONDITION that decides the split, not merely an
 *   identifier the module happens to mention. A reference check alone would let
 *   any unrelated constant already imported for another purpose vouch for the
 *   claim, which is the free-text hatch again wearing an identifier's clothes.
 */
export function gatedClaimProblem({
  gate,
  hostCode,
  moduleSpecifier,
  exportName,
  prop,
  suppliedOnAnyMount,
}: {
  gate: string;
  hostCode: string | undefined;
  moduleSpecifier: string;
  exportName: string;
  prop: string;
  suppliedOnAnyMount: ReadonlySet<string> | undefined;
}): string | undefined {
  if (hostCode === undefined || suppliedOnAnyMount === undefined) {
    return `is declared gated on "${gate}", but this check was given no host source to verify that against. A gated claim is only a claim; pass the host's code so the split can be read.`;
  }
  if (!suppliedOnAnyMount.has(prop)) {
    return `is declared gated on "${gate}", but NO mount in this module passes it, so nothing here is gated — the capability is simply absent. Pass it on the open branch, or classify it as the omission it is.`;
  }
  const source = parseTsx(hostCode);
  const deciding = decidingConditions({
    exportName,
    moduleSpecifier,
    prop,
    source,
  });
  if (deciding.length === 0) {
    return `is declared gated on "${gate}", but no conditional in this module chooses between a mount that passes it and one that does not, so the check cannot see what decides it. Express the split as one conditional over the mounts, or classify the capability without a gate.`;
  }
  if (deciding.some((condition) => !conditionReads(condition, gate, source))) {
    return `is declared gated on "${gate}", which is not read by the condition that actually decides whether this capability is passed. Name the gate that condition reads, or classify the capability as supplied now that nothing withholds it.`;
  }
  return undefined;
}

/**
 * Whether the deciding condition reads `gate`, directly or through the locals it
 * names.
 *
 * The indirection is the normal shape, not an edge case: a surface reads its
 * flag once into a local (`const pinNameColumn =
 * useFeatureFlagEnabledOptional(BRANCHES_PINNED_NAME_COLUMN_FEATURE_FLAG_KEY)`)
 * and branches on THAT. So the condition's own identifiers are followed to
 * their initializers. Bounded by a visited set, and it does not leave the
 * module — a name this file never binds cannot vouch for anything here.
 */
function conditionReads(
  condition: ts.Node,
  gate: string,
  source: ts.SourceFile,
  seen: Set<string> = new Set()
): boolean {
  const names = identifiersIn(condition);
  if (names.has(gate)) {
    return true;
  }
  for (const name of names) {
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const initializer = initializerOf(source, name);
    if (initializer && conditionReads(initializer, gate, source, seen)) {
      return true;
    }
  }
  return false;
}

function identifiersIn(node: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (child: ts.Node) => {
    if (ts.isIdentifier(child)) {
      names.add(child.text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

/** The initializer of the sole `name = …` declaration in this module, if one. */
function initializerOf(
  source: ts.SourceFile,
  name: string
): ts.Expression | undefined {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found.length === 1 ? found[0] : undefined;
}

/**
 * EVERY condition that chooses between a mount passing `prop` and a mount
 * withholding it — the nodes whose tests are the gates.
 *
 * Both `a ? <X p/> : <X/>` and an `if`/`else` over two returns qualify: what
 * matters is that one branch carries a passing mount and the other carries a
 * withholding one, which is the only shape a gated claim may describe.
 *
 * ALL of them, not the first (davetho review). Stopping at the first split
 * this walk happened to reach let a host with a SECOND, independent
 * `GridTableV2` split withhold the same capability behind an entirely different
 * condition while the ledger's `gatedOn` claim stayed green on the first — a
 * gate vouching for a split it does not control, which is the same false green
 * this whole check exists to stop. The caller requires the declared gate to
 * control each one.
 *
 * A matched node is not descended into, so what is collected is the set of
 * OUTERMOST splits. A conditional nested inside a split is part of how that
 * split renders rather than a second independent decision, and grading it
 * separately would redden a host whose inner branch legitimately reads
 * something else.
 */
function decidingConditions({
  exportName,
  moduleSpecifier,
  prop,
  source,
}: {
  exportName: string;
  moduleSpecifier: string;
  prop: string;
  source: ts.SourceFile;
}): readonly ts.Expression[] {
  const mounts = mountsIn(source, moduleSpecifier, exportName);
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    const branches = branchesOf(node);
    if (branches && splitsOn(branches, mounts, prop)) {
      found.push(branches.condition);
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

type Branches = {
  readonly condition: ts.Expression;
  readonly whenTrue: ts.Node;
  readonly whenFalse: ts.Node | undefined;
};

function branchesOf(node: ts.Node): Branches | undefined {
  if (ts.isConditionalExpression(node)) {
    return {
      condition: node.condition,
      whenFalse: node.whenFalse,
      whenTrue: node.whenTrue,
    };
  }
  if (ts.isIfStatement(node)) {
    return {
      condition: node.expression,
      whenFalse: node.elseStatement,
      whenTrue: node.thenStatement,
    };
  }
  return undefined;
}

/**
 * Whether these branches genuinely disagree about `prop` — one side mounts the
 * component WITH it and the other mounts it WITHOUT. A conditional where only
 * one side mounts at all is not a split; it is a mount and an absence.
 */
function splitsOn(
  branches: Branches,
  mounts: readonly ComponentMount[],
  prop: string
): boolean {
  const { whenFalse, whenTrue } = branches;
  if (!whenFalse) {
    return false;
  }
  const inTrue = mountsWithin(mounts, whenTrue);
  const inFalse = mountsWithin(mounts, whenFalse);
  const passes = (side: readonly ComponentMount[]) =>
    side.some((mount) => mount.props.has(prop));
  const withholds = (side: readonly ComponentMount[]) =>
    side.some((mount) => !mount.props.has(prop));
  return (
    (passes(inTrue) && withholds(inFalse)) ||
    (passes(inFalse) && withholds(inTrue))
  );
}

/** The mounts whose element node lies inside `container`'s source span. */
function mountsWithin(
  mounts: readonly ComponentMount[],
  container: ts.Node
): readonly ComponentMount[] {
  return mounts.filter(
    (mount) =>
      mount.node.getStart() >= container.getStart() &&
      mount.node.getEnd() <= container.getEnd()
  );
}

/**
 * Whether `name` is an IDENTIFIER this module really binds or references, read
 * off the AST.
 *
 * Exists so a suite can prove a negative case is not passing merely because the
 * name it named is absent, WITHOUT text-scanning the source: a `toContain` over
 * the file is the raw-text scan `no-raw-text-source-scan` bans, and this seam
 * reaches its host through a dynamic path the gate cannot see, so nothing but
 * this would have stopped it (whitlockk review). It is also the stricter read — a
 * substring matches a prose mention in a docstring or a longer identifier that
 * merely contains the name, and neither is a reference {@link conditionReads}
 * could ever follow.
 */
export function moduleReferencesIdentifier(
  code: string,
  name: string
): boolean {
  return identifiersIn(parseTsx(code)).has(name);
}
