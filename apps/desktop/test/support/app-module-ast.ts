/**
 * Shared `ts.createSourceFile` inspection of `src/main/app.ts`.
 *
 * WHY AST AT ALL. `app.ts` statically imports `electron`, so it cannot be
 * loaded — let alone driven — from a node test. This is the sanctioned AST guard
 * (see `scripts/lint/rules/no-raw-text-source-scan.ts` and the precedent in
 * `initial-window-reveal-wiring.test.ts`). It covers exactly one property that no
 * runnable test in this package can observe: WHICH frames a boot-time call
 * executes behind. Behavior belongs in a test that drives the electron-free
 * module — `boot-admission-deadline.test.ts` is the pair for the ISS-5990 guard.
 *
 * Extracted from `sync-lane-start-not-renderer-gated.test.ts` (ISS-4717) when
 * ISS-5990 needed the same walk for a second admission path.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CallExpression,
  MethodDeclaration,
  Node,
  SourceFile,
  Statement,
} from "typescript6";
import {
  createSourceFile,
  forEachChild,
  isArrowFunction,
  isAwaitExpression,
  isBlock,
  isCallExpression,
  isCaseClause,
  isDefaultClause,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isParameter,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isSourceFile,
  isVariableDeclaration,
  isVariableStatement,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
} from "typescript6";

const supportDir = path.dirname(fileURLToPath(import.meta.url));
const appModulePath = path.resolve(supportDir, "../../src/main/app.ts");

/** Default for the walks below: exempt nothing, i.e. the ISS-4717 behaviour. */
const NO_BOUNDED_SLOTS: readonly BoundedSlot[] = [];

/** Parse `src/main/app.ts` with parent pointers, which the walks below need. */
export function parseAppModule(): SourceFile {
  return parseModuleSource(readFileSync(appModulePath, "utf8"), appModulePath);
}

/**
 * Parse arbitrary module text the same way {@link parseAppModule} parses the
 * real one.
 *
 * Exists so the walks below can be driven against a FIXTURE rather than only
 * against whatever `app.ts` happens to look like today. A guard whose only input
 * is the file it guards can only be shown to pass — never shown to catch the
 * shape it claims to catch, which is how {@link waitsAround} shipped blind to a
 * preceding sibling `await` (ISS-5990 review).
 */
export function parseModuleSource(
  source: string,
  fileName = appModulePath
): SourceFile {
  return createSourceFile(
    fileName,
    source,
    ScriptTarget.Latest,
    true,
    ScriptKind.TS
  );
}

/** The `DesktopApplication` method named `methodName`. */
export function findMethod(
  methodName: string,
  sourceFile: SourceFile = parseAppModule()
): MethodDeclaration {
  let found: MethodDeclaration | null = null;
  const visit = (node: Node): void => {
    if (found) {
      return;
    }
    if (
      isMethodDeclaration(node) &&
      node.name.getText(sourceFile) === methodName
    ) {
      found = node;
      return;
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  if (!found) {
    throw new Error(`DesktopApplication.${methodName} not found in app.ts`);
  }
  return found;
}

/** The callee name of a call expression, `this.`-qualified or bare. */
export function calleeName(
  node: CallExpression,
  sourceFile: SourceFile
): string {
  const callee = node.expression;
  return isPropertyAccessExpression(callee)
    ? callee.name.getText(sourceFile)
    : callee.getText(sourceFile);
}

/** Every called function/method name inside `methodName`, including nested arrows. */
export function callsInside(methodName: string): string[] {
  const sourceFile = parseAppModule();
  const method = findMethod(methodName, sourceFile);
  const names: string[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node)) {
      names.push(calleeName(node, sourceFile));
    }
    forEachChild(node, visit);
  };
  forEachChild(method, visit);
  return names;
}

/** Every call to `name` in `app.ts`, whether bare or `this.`-qualified. */
export function callSitesOf(
  name: string,
  sourceFile: SourceFile
): CallExpression[] {
  const sites: CallExpression[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node) && calleeName(node, sourceFile) === name) {
      sites.push(node);
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  return sites;
}

/**
 * Every place `app.ts` USES the name `name` as a first-class reference to its own
 * declaration — the caller edges the path walk follows.
 *
 * Three things this deliberately gets right, each of which the earlier
 * call-expression-and-callee-text version got wrong (ISS-5990 review):
 *
 * 1. **Receiver awareness.** `calleeName` collapses `this.foo.start()` to
 *    `"start"`, so matching on callee text alone made the local `start` closure
 *    indistinguishable from `this.server.start()`, `this.costReconciliation.start()`
 *    and eight other unrelated services. Several of those sit directly in `boot()`,
 *    so a walk looking for "who calls `start`" reached `boot` through a NAME
 *    COLLISION and the reachability assertion passed while wired to nothing. Only a
 *    bare `name` or a `this.name` qualification counts here.
 * 2. **References, not just calls.** `schedulePostInitialWindowBootTasks` passes
 *    the closure BY REFERENCE (`scheduleAfterBootAdmission(reveal, start)`); it is
 *    never invoked as `start()` anywhere in `app.ts`. A call-expression-only scan
 *    finds no caller at all, which is why the collision was load-bearing.
 * 3. **Declarations are not usages.** The `const start = …` binding itself must not
 *    count, or every function would be its own caller and the walk would never
 *    terminate at a root.
 */
export function usageSitesOf(name: string, sourceFile: SourceFile): Node[] {
  const sites: Node[] = [];
  const visit = (node: Node): void => {
    if (isIdentifier(node) && node.text === name && isReferenceUse(node)) {
      sites.push(node);
    }
    forEachChild(node, visit);
  };
  forEachChild(sourceFile, visit);
  return sites;
}

/** True when `id` reads a binding of that name rather than declaring or aliasing one. */
function isReferenceUse(id: Node): boolean {
  const parent = id.parent;
  if (!parent) {
    return false;
  }
  // `const start = …`, `foo(start: T)`, `method() {}` — declaration sites.
  if (
    (isVariableDeclaration(parent) ||
      isParameter(parent) ||
      isMethodDeclaration(parent) ||
      isFunctionDeclaration(parent)) &&
    parent.name === id
  ) {
    return false;
  }
  // `{ start: … }` — a property KEY names a field, not this binding.
  if (isPropertyAssignment(parent) && parent.name === id) {
    return false;
  }
  // `x.start` counts only when the receiver is `this`; `this.server.start` does not.
  if (isPropertyAccessExpression(parent) && parent.name === id) {
    return parent.expression.kind === SyntaxKind.ThisKeyword;
  }
  return true;
}

/**
 * A wait that is legitimately BOUNDED by being handed to a wrapper, identified by
 * the EXACT argument slot that wrapper bounds — never "anywhere in its arguments".
 *
 * Position is load-bearing. `scheduleAfterBootAdmission(whenWindowRevealed,
 * bootWork)` bounds only its FIRST argument; `bootWork` runs after admission with
 * no bound at all. A slot-blind exemption would silently bless a raw
 * `whenInitiallyShown()` smuggled into an inlined `bootWork` callback — the exact
 * stranded-headless-boot defect ISS-5990 fixes, re-admitted by its own guard.
 */
export type BoundedSlot = {
  /** The wrapper call that bounds the wait. */
  wrapper: string;
  /** Which positional argument of `wrapper` is the bounded one. */
  argumentIndex: number;
  /** When that argument is an options object, the property that is bounded. */
  property?: string;
};

/**
 * True when `node` sits in a slot that some entry of `slots` declares bounded.
 *
 * Walks the ancestor chain tracking both which argument of an enclosing call the
 * chain passed through and the object-literal property it passed through on the
 * way, so `f(bounded, unbounded)` and `f({ bounded: …, other: … })` are each
 * discriminated by position rather than by mere containment.
 */
export function isInBoundedSlot(
  node: Node,
  slots: readonly BoundedSlot[],
  sourceFile: SourceFile
): boolean {
  let child: Node = node;
  let parent: Node | undefined = node.parent;
  let property: string | null = null;
  while (parent) {
    if (isPropertyAssignment(parent) && parent.initializer === child) {
      property = parent.name.getText(sourceFile);
    }
    if (isCallExpression(parent)) {
      // `indexOf` over `findIndex`, per Biome `useIndexOf`; the widening cast is
      // identity-comparison only — `NodeArray<Expression>` cannot take a `Node`.
      const argumentIndex = (parent.arguments as readonly Node[]).indexOf(
        child
      );
      if (argumentIndex >= 0) {
        const wrapper = calleeName(parent, sourceFile);
        const matched = slots.some(
          (slot) =>
            slot.wrapper === wrapper &&
            slot.argumentIndex === argumentIndex &&
            (slot.property === undefined || slot.property === property)
        );
        if (matched) {
          return true;
        }
        property = null;
      }
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/**
 * Every name from `watched` appearing anywhere under `node`, minus the ones
 * sitting in a slot `slots` declares bounded.
 *
 * The exemption exists because a wait CAN be legitimately bounded by handing it
 * to a wrapper (ISS-5990); without it, wrapping a wait would read identically to
 * awaiting it raw and the guard would forbid its own fix.
 */
function watchedNamesIn(
  node: Node,
  watched: ReadonlySet<string>,
  slots: readonly BoundedSlot[],
  sourceFile: SourceFile
): string[] {
  const names: string[] = [];
  const visit = (current: Node): void => {
    if (
      isIdentifier(current) &&
      watched.has(current.text) &&
      !isInBoundedSlot(current, slots, sourceFile)
    ) {
      names.push(current.text);
    }
    forEachChild(current, visit);
  };
  visit(node);
  return names;
}

/**
 * The watched waits `node` executes BEHIND — walking the full ancestor chain,
 * deliberately across function boundaries.
 *
 * Three shapes defer a node. Two are ancestors: an `await <wait>()` above it,
 * and a callback position — `node` living inside an argument of some call whose
 * callee mentions a watched wait, which is exactly
 * `X.whenInitiallyShown().then(() => { … })`. Crossing arrow/function boundaries
 * is the whole point: on PR #4665 the lane start was two hops from its
 * `.then(...)`, which is why a check scoped to one method body could not see it.
 *
 * The third is not an ancestor at all, and the walk was blind to it: a PRECEDING
 * SIBLING `await` in the same statement list. The plainest way to re-gate boot
 * is also the one no ancestor chain contains —
 *
 *     await this.rendererGates.whenInitialRendererMounted();
 *     this.startSyncLanesAtBoot();
 *
 * — where the lane start is deferred exactly as completely as by any callback,
 * and the guard reported nothing (ISS-5990 review). Order, not containment, is
 * the property that decides it, so {@link precedingAwaitedWaits} looks only at
 * statements that run BEFORE the one the walk came up through.
 *
 * All three resolve local bindings, because indirection is orthogonal to which
 * shape defers. Teaching only the sibling branch caught the hypothetical
 * `await mounted;` and missed the HISTORICAL shape — `app.ts` defers boot in
 * CALLBACK position, so `const mounted = …; void mounted.then(() => { … });`
 * strands it exactly as the raw `.then()` did and the walk reported nothing
 * (ISS-5990 review, round 2). Unlike `whenInitiallyShown`, the renderer-gate
 * names have no per-call-site backstop, so this walk is all that watches them.
 */
export function waitsAround(
  node: Node,
  watched: ReadonlySet<string>,
  slots: readonly BoundedSlot[] = NO_BOUNDED_SLOTS,
  sourceFile: SourceFile = parseAppModule()
): string[] {
  const names: string[] = [];
  let child: Node = node;
  let parent: Node | undefined = node.parent;
  while (parent) {
    const deferring = deferringAncestorExpression(parent, child);
    names.push(
      ...(deferring === null
        ? precedingAwaitedWaits(parent, child, watched, slots, sourceFile)
        : deferringNamesIn(deferring, parent, watched, slots, sourceFile))
    );
    child = parent;
    parent = parent.parent;
  }
  return names;
}

/**
 * The expression `parent` defers `child` behind, or `null` when `parent` is not
 * one of the two deferring ancestor shapes.
 *
 * ONE function, not a branch each: `await <expr>` and `<expr>(…child…)` defer
 * their subject identically, so anything one of them must see about that subject
 * the other must see too. As two branches with two bodies they drifted — round 2
 * taught only the sibling-`await` path to resolve local bindings, leaving both of
 * these blind to the very indirection it had just closed (ISS-5990 review).
 */
function deferringAncestorExpression(parent: Node, child: Node): Node | null {
  if (isAwaitExpression(parent)) {
    return parent.expression;
  }
  if (
    isCallExpression(parent) &&
    parent.arguments.some((argument) => argument === child)
  ) {
    return parent.expression;
  }
  return null;
}

/**
 * The watched waits `expression` names, directly or through a local binding that
 * is in scope where `at` sits.
 */
function deferringNamesIn(
  expression: Node,
  at: Node,
  watched: ReadonlySet<string>,
  slots: readonly BoundedSlot[],
  sourceFile: SourceFile
): string[] {
  return [
    ...watchedNamesIn(expression, watched, slots, sourceFile),
    ...aliasedWatchedNamesIn(
      expression,
      aliasesInScopeOf(at),
      watched,
      slots,
      sourceFile
    ),
  ];
}

/** The statements `node` runs in order, when `node` is a statement list owner. */
function statementListOf(node: Node): readonly Statement[] | null {
  if (
    isBlock(node) ||
    isSourceFile(node) ||
    isCaseClause(node) ||
    isDefaultClause(node)
  ) {
    return node.statements;
  }
  return null;
}

/**
 * The watched waits AWAITED by the statements of `parent` that run before
 * `child`.
 *
 * Deliberately one-directional: a wait awaited AFTER the call defers nothing,
 * and treating the whole enclosing block as deferring would condemn correct
 * wiring — including the real `boot()`.
 */
function precedingAwaitedWaits(
  parent: Node,
  child: Node,
  watched: ReadonlySet<string>,
  slots: readonly BoundedSlot[],
  sourceFile: SourceFile
): string[] {
  const names: string[] = [];
  for (const statement of precedingStatementsOf(parent, child)) {
    names.push(...awaitedWatchedNamesIn(statement, watched, slots, sourceFile));
  }
  return names;
}

/**
 * The statements of `parent` that run before `child`, or none when `parent` owns
 * no statement list or `child` runs first.
 */
function precedingStatementsOf(
  parent: Node,
  child: Node
): readonly Statement[] {
  const statements = statementListOf(parent);
  if (statements === null) {
    return [];
  }
  const index = (statements as readonly Node[]).indexOf(child);
  return index > 0 ? statements.slice(0, index) : [];
}

/**
 * Every local binding readable at `node`, resolved the way the language resolves
 * it: innermost enclosing statement list first, then outward, and only bindings
 * declared BEFORE the statement the walk came up through.
 *
 * Replaces a flat scan of ONE statement list, which missed a binding declared in
 * a nested block: in `if (headless) { const mounted = …; await mounted; }` the
 * `await` suspends the whole method, so everything after the block is deferred,
 * but the declaration is not a statement of the block being walked.
 *
 * Still not a file-wide lookup, and not every declaration under a preceding
 * statement either — a binding from a SIBLING block is not in scope and must not
 * resolve. A guard that fires on correct code gets deleted.
 */
function aliasesInScopeOf(node: Node): ReadonlyMap<string, Node> {
  const aliases = new Map<string, Node>();
  let child: Node = node;
  let parent: Node | undefined = node.parent;
  while (parent) {
    addUnshadowed(
      aliases,
      localAliasInitializers(precedingStatementsOf(parent, child))
    );
    child = parent;
    parent = parent.parent;
  }
  return aliases;
}

/** Merge `from` into `into` without overwriting: the inner binding shadows. */
function addUnshadowed(
  into: Map<string, Node>,
  from: ReadonlyMap<string, Node>
): void {
  for (const [name, initializer] of from) {
    if (!into.has(name)) {
      into.set(name, initializer);
    }
  }
}

/**
 * The initializer each `const`/`let` binding declared by `statements` reads.
 *
 * Exists because the walk matches on an expression's TEXT, so `const revealed =
 * …whenInitiallyShown(); await revealed;` defers boot exactly as the inline call
 * does and the guard reported nothing (ISS-5990 review).
 *
 * Collects declarations only; {@link aliasesInScopeOf} decides which statement
 * lists to collect from and in what order.
 */
function localAliasInitializers(
  statements: readonly Statement[]
): Map<string, Node> {
  const aliases = new Map<string, Node>();
  for (const statement of statements) {
    if (!isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (isIdentifier(declaration.name) && declaration.initializer) {
        aliases.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return aliases;
}

/**
 * The watched waits reached from `expression` through the local bindings it
 * reads, following a binding whose initializer is itself a binding.
 *
 * Only a binding READ counts: `x.revealed` names a property, not the local
 * `revealed`, and a `const` that never defers anything defers nothing — so this
 * is called only on an `await` operand or a callback-taking callee.
 *
 * Chained rather than one-hop: `const g = gates.whenInitialRendererMounted();
 * const mounted = g; await mounted;` defers boot exactly as the direct binding
 * does, and one hop was an arbitrary place to stop. `resolved` terminates a
 * `const a = b; const b = a;` cycle and keeps a name from reporting twice.
 */
function aliasedWatchedNamesIn(
  expression: Node,
  aliases: ReadonlyMap<string, Node>,
  watched: ReadonlySet<string>,
  slots: readonly BoundedSlot[],
  sourceFile: SourceFile,
  resolved: Set<string> = new Set<string>()
): string[] {
  if (aliases.size === 0) {
    return [];
  }
  const names: string[] = [];
  const visit = (current: Node): void => {
    const initializer = aliasInitializerRead(current, aliases, resolved);
    if (initializer) {
      names.push(
        ...watchedNamesIn(initializer, watched, slots, sourceFile),
        ...aliasedWatchedNamesIn(
          initializer,
          aliases,
          watched,
          slots,
          sourceFile,
          resolved
        )
      );
    }
    forEachChild(current, visit);
  };
  visit(expression);
  return names;
}

/**
 * The initializer `current` reads through a not-yet-followed local binding, or
 * `undefined`. Marks the binding followed, so the caller's recursion terminates.
 */
function aliasInitializerRead(
  current: Node,
  aliases: ReadonlyMap<string, Node>,
  resolved: Set<string>
): Node | undefined {
  if (!(isIdentifier(current) && isLocalBindingRead(current))) {
    return undefined;
  }
  if (resolved.has(current.text)) {
    return undefined;
  }
  const initializer = aliases.get(current.text);
  if (initializer) {
    resolved.add(current.text);
  }
  return initializer;
}

/** True when `id` reads a local binding rather than naming a property. */
function isLocalBindingRead(id: Node): boolean {
  const parent = id.parent;
  if (!parent) {
    return false;
  }
  if (isPropertyAccessExpression(parent) && parent.name === id) {
    return false;
  }
  return !(isPropertyAssignment(parent) && parent.name === id);
}

/**
 * The watched waits `node` awaits in its OWN execution.
 *
 * Stops at every function boundary: an `await` inside a callback a statement
 * merely DEFINES (`registerHandler(async () => { await … })`) does not suspend
 * the statement list it sits in, and a fire-and-forget call that is never
 * awaited defers nothing either. Counting those would fire the guard on wiring
 * that is already correct.
 *
 * Each `await` resolves indirection against the bindings in scope at that
 * `await` — not at the statement list this walk started from — so a binding
 * declared inside a nested block is seen; see {@link aliasesInScopeOf}.
 */
function awaitedWatchedNamesIn(
  node: Node,
  watched: ReadonlySet<string>,
  slots: readonly BoundedSlot[],
  sourceFile: SourceFile
): string[] {
  const names: string[] = [];
  const visit = (current: Node): void => {
    if (
      isArrowFunction(current) ||
      isFunctionExpression(current) ||
      isFunctionDeclaration(current) ||
      isMethodDeclaration(current)
    ) {
      return;
    }
    if (isAwaitExpression(current)) {
      names.push(
        ...deferringNamesIn(
          current.expression,
          current,
          watched,
          slots,
          sourceFile
        )
      );
    }
    forEachChild(current, visit);
  };
  visit(node);
  return names;
}

/** The nearest NAMED function/method enclosing `node`, skipping anonymous callbacks. */
export function enclosingNamedFunction(
  node: Node,
  sourceFile: SourceFile
): string | null {
  let current: Node | undefined = node.parent;
  while (current) {
    if (isMethodDeclaration(current) || isFunctionDeclaration(current)) {
      return current.name?.getText(sourceFile) ?? null;
    }
    if (
      (isArrowFunction(current) || isFunctionExpression(current)) &&
      current.parent &&
      isVariableDeclaration(current.parent)
    ) {
      return current.parent.name.getText(sourceFile);
    }
    current = current.parent;
  }
  return null;
}

/**
 * Walk outward from every call site of `callName` through its callers,
 * collecting the `watched` waits found on the way and the roots the walk
 * terminated at.
 *
 * Removing an inner gate proves nothing on its own: what decides whether a piece
 * of boot work ever runs is whether ANY frame on the path from `boot()` down to
 * it is parked on a signal the main process cannot produce for itself.
 */
export function callPathFrom(
  callName: string,
  watched: ReadonlySet<string>,
  slots: readonly BoundedSlot[] = NO_BOUNDED_SLOTS,
  sourceFile: SourceFile = parseAppModule()
): { waits: string[]; roots: string[] } {
  const waits: string[] = [];
  const roots: string[] = [];
  const visited = new Set<string>();
  let frontier: Node[] = usageSitesOf(callName, sourceFile);

  // Bounded so a mutually-recursive refactor cannot hang the suite; `visited`
  // already makes the walk converge, and the real paths are 2-3 hops.
  for (let hop = 0; hop < 16 && frontier.length > 0; hop += 1) {
    const next: Node[] = [];
    for (const site of frontier) {
      waits.push(...waitsAround(site, watched, slots, sourceFile));
      const owner = enclosingNamedFunction(site, sourceFile);
      if (owner === null || visited.has(owner)) {
        continue;
      }
      visited.add(owner);
      const callers = usageSitesOf(owner, sourceFile);
      if (callers.length === 0) {
        roots.push(owner);
        continue;
      }
      next.push(...callers);
    }
    frontier = next;
  }
  return { waits, roots };
}
