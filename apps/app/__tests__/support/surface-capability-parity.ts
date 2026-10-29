import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  PRESENTATION,
  type SurfaceCapabilityKind,
} from "@repo/app/shared/lib/surface-capability-kind";
import ts from "typescript6";
import { parseTsx as parse, propsPassedOnAnyMount } from "./jsx-mount-props";
import { localNamesFor } from "./renders-imported-component";
import { resolveModuleFile } from "./resolve-workspace-module";
import { gatedClaimProblem } from "./surface-capability-gate";

/**
 * ISS-8636 — the two independent reads a host↔component capability parity check
 * needs, plus the differ over them.
 *
 * `SessionsListSurfaceV2` derives every affordance from a prop's mere PRESENCE
 * (`favoritesEnabled: Boolean(favorites)`), so a host that omits one renders no
 * affordance at all, indistinguishable from a surface that never had one. Three
 * capabilities left the live Sessions page that way at once with nothing red.
 *
 * The check is only worth anything because its three inputs are three DIFFERENT
 * sources: the declared optional props come from the component's own source, the
 * supplied set from the host's JSX, and the classification from a hand-written
 * ledger. A check that read the component's exported prop type and compared it
 * to itself could not fail — the duplication would be the test.
 *
 * Read from the AST rather than text-scanned: `no-raw-text-source-scan` bans
 * scanning implementation source and points at `ts.createSourceFile`. It matters
 * beyond compliance on these two files, whose docstrings name props in prose.
 */

/** A capability the host wires. Its absence from the host's JSX is a defect. */
export const SUPPLIED = "supplied" as const;

/**
 * A capability this host genuinely does not offer, with the reason. Expressible
 * WITHOUT disabling the check — a host that cannot honestly wire something says
 * so once, here, rather than the omission reading as an oversight forever.
 *
 * ISS-9218 narrowed it: only a `host-capability` prop may be answered this way,
 * and the reason must state the inability rather than point at another entry.
 */
export type NotSupported = { readonly notSupported: string };

/**
 * ISS-9218 — the checked alternative to a reason a human has to grade. The prop
 * IS passable here, but the affordance it configures does not render because
 * `inertWithout` is withheld, or is superseded because `inertUnder` is supplied.
 *
 * Both name another entry in the SAME ledger, so the claim is verified rather
 * than believed: the moment a host starts wiring the companion, the inert claim
 * stops being true and this check reddens.
 */
export type InertCapability =
  | { readonly inertWithout: string }
  | { readonly inertUnder: string };

/**
 * ISS-9223 — the capability this consumer passes on SOME of its mounts and not
 * others, because its own gate decides. `branches-grid-v2.tsx` returns
 * `<GridTableV2 {...gridProps} pinLeadColumn />` or `<GridTableV2
 * {...gridProps} />` off one flag read, and the differ intersects mounts, so
 * the prop reads as withheld — correctly, since a reader with the gate closed
 * does not get it.
 *
 * Neither existing hatch says that honestly: `notSupported` would claim an
 * inability that does not exist (nothing stops this surface pinning), and an
 * inert claim needs a companion in the same ledger, which a gate is not.
 *
 * CHECKED, not believed, exactly like the inert claims: the JSX must actually
 * show the split — at least one mount passing it and at least one withholding
 * it — and the named gate must be read by the CONDITION that chooses between
 * those two mounts, not merely mentioned somewhere in the module. Retire the
 * gate in either direction and this reddens on its own.
 */
export type GatedCapability = { readonly gatedOn: string };

export type CapabilityClassification =
  | typeof SUPPLIED
  | NotSupported
  | InertCapability
  | GatedCapability;

export type HostCapabilityLedger = {
  /** Repo-relative path of the host, named verbatim in every failure. */
  readonly hostPath: string;
  /** Repo-relative path of the component the host mounts. */
  readonly componentPath: string;
  /** The mounted component's exported name. */
  readonly componentName: string;
  /** The module specifier the host imports that component from. */
  readonly componentModule: string;
  /**
   * ISS-9218 — the component's own capability-kind declaration, imported from
   * beside its prop type. It is NOT written per host: what a prop IS cannot
   * differ between two hosts of the same component, and a per-host copy would
   * be the escape hatch again with an extra step.
   */
  readonly kinds: Readonly<Record<string, SurfaceCapabilityKind>>;
  readonly capabilities: Readonly<Record<string, CapabilityClassification>>;
};

/**
 * Names of the OPTIONAL props `componentName` declares, read off its parameter
 * type literal. Required props are excluded: a host cannot silently drop one,
 * because `tsc` already fails.
 *
 * The literal is reached through a NAMED alias when the component takes one,
 * in its own module or in a sibling it imports the alias from — `componentFile`
 * is what makes the second resolvable. A surface big enough to need this guard
 * is a surface whose props get split out for the 1,000-line ceiling
 * (`SessionsListSurfaceV2Props` did, mid-review), and a reader that only
 * understood an inline literal would fail closed on the refactor rather than on
 * a dropped capability.
 */
export function declaredOptionalProps(
  code: string,
  componentName: string,
  componentFile?: string
): ReadonlySet<string> {
  const source = parse(code);
  const declaration = findFunction(source, componentName);
  if (!declaration) {
    throw new Error(
      `surface-capability-parity: no function declaration named "${componentName}" — the check cannot read its props.`
    );
  }
  const [parameter] = declaration.parameters;
  const typeNode = parameter?.type;
  if (!typeNode) {
    throw new Error(
      `surface-capability-parity: "${componentName}" does not take a single typed prop parameter — the check cannot read its props.`
    );
  }
  const declared = resolvePropTypeLiteral({
    componentFile,
    componentName,
    source,
    typeNode,
  });
  const names = new Set<string>();
  for (const member of declared.literal.members) {
    if (ts.isPropertySignature(member) && member.questionToken) {
      names.add(member.name.getText(declared.source));
    }
  }
  return names;
}

/**
 * Every disagreement between what the component declares, what the host passes,
 * and what the ledger claims — one sentence each, naming the capability AND the
 * host, because a failure that says only "host incomplete" costs the next person
 * the whole investigation.
 */
export function capabilityDrift({
  declaredOptional,
  hostCode,
  ledger,
  supplied,
}: {
  declaredOptional: ReadonlySet<string>;
  /**
   * The host's own source, needed only by a `gatedOn` claim — that hatch is the
   * one whose evidence is not in the intersected `supplied` set. Absent, a
   * `gatedOn` entry is REFUSED rather than believed.
   */
  hostCode?: string;
  ledger: HostCapabilityLedger;
  supplied: ReadonlySet<string>;
}): string[] {
  const problems: string[] = [];
  const { capabilities, componentName, hostPath, kinds } = ledger;
  for (const prop of [...declaredOptional].sort()) {
    if (!Object.hasOwn(kinds, prop)) {
      problems.push(
        `${hostPath}: capability "${prop}" is optional on ${componentName} but its capability-kind map declares no kind for it. Classify it beside the prop type as host-capability or presentation.`
      );
    }
    if (!Object.hasOwn(capabilities, prop)) {
      problems.push(
        `${hostPath}: capability "${prop}" is optional on ${componentName} but this host classifies it nowhere. ${remedyFor(kinds[prop], "record")}`
      );
    }
  }
  for (const prop of Object.keys(capabilities).sort()) {
    if (!declaredOptional.has(prop)) {
      problems.push(
        `${hostPath}: capability "${prop}" is classified here but ${componentName} no longer declares it as optional. Drop the stale entry.`
      );
      continue;
    }
    problems.push(
      ...classificationProblems({ hostCode, ledger, prop, supplied })
    );
  }
  problems.push(...inertCycleProblems(ledger));
  return problems;
}

/**
 * Repo-relative paths of every PRODUCTION module that mounts `exportName` from a
 * module path ending in `moduleSuffix`.
 *
 * Without this the audited host set would be a hand-written array, and a NEW
 * host would be unguarded from birth — the same outage one level up, since
 * nothing would notice a mount that no ledger names. Stories, tests, the demo
 * preview and the prototypes sandbox are excluded: they are fixtures, and a
 * fixture deliberately mounts a partial surface.
 */
export function productionMountsOf({
  exportName,
  moduleSuffix,
  repoRoot,
  searchRoots,
}: {
  exportName: string;
  moduleSuffix: string;
  repoRoot: string;
  searchRoots: readonly string[];
}): string[] {
  const mounts: string[] = [];
  for (const candidate of productionSources(repoRoot, searchRoots)) {
    // A cheap text prefilter so this does not parse every file for every
    // ledger. The AST below is what decides; this only skips files that cannot
    // match.
    if (!candidate.code.includes(moduleSuffix)) {
      continue;
    }
    if (mountsComponent(candidate.code, moduleSuffix, exportName)) {
      mounts.push(candidate.relative);
    }
  }
  return mounts.sort();
}

/**
 * Every production `.tsx` under `searchRoots`, read once. The walk costs seconds
 * across `apps` and `packages`, and each ledger would otherwise repeat it.
 */
function productionSources(
  repoRoot: string,
  searchRoots: readonly string[]
): readonly { code: string; relative: string }[] {
  const key = `${repoRoot}\u0000${searchRoots.join(",")}`;
  const cached = sourceCache.get(key);
  if (cached) {
    return cached;
  }
  const sources: { code: string; relative: string }[] = [];
  for (const root of searchRoots) {
    for (const file of walkTsx(path.join(repoRoot, root))) {
      const relative = path.relative(repoRoot, file).split(path.sep).join("/");
      if (isFixturePath(relative)) {
        continue;
      }
      sources.push({ code: readFileSync(file, "utf8"), relative });
    }
  }
  sourceCache.set(key, sources);
  return sources;
}

function mountsComponent(
  code: string,
  moduleSuffix: string,
  exportName: string
): boolean {
  const source = parse(code);
  const locals = new Set<string>();
  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.endsWith(moduleSuffix)
    ) {
      for (const name of localNamesFor(
        source,
        statement.moduleSpecifier.text,
        exportName
      )) {
        locals.add(name);
      }
    }
  }
  if (locals.size === 0) {
    return false;
  }
  let rendered = false;
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      locals.has(node.tagName.getText(source))
    ) {
      rendered = true;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return rendered;
}

function isFixturePath(relative: string): boolean {
  return (
    relative.includes("__tests__") ||
    relative.includes(".stories.") ||
    relative.includes("-demo.") ||
    relative.startsWith("apps/storybook/stories/") ||
    relative.startsWith("apps/prototypes/")
  );
}

function* walkTsx(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) {
        continue;
      }
      yield* walkTsx(full);
      continue;
    }
    if (entry.name.endsWith(".tsx")) {
      yield full;
    }
  }
}

/**
 * The prop type literal `typeNode` denotes, with the source file it was parsed
 * from so its member names read against the right text.
 *
 * Refuses rather than guesses at every step it cannot follow — an alias to an
 * intersection, a re-export chain, a package specifier. An under-read prop set
 * is the failure mode this whole check exists to stop, so a reader that quietly
 * returned the props it happened to understand would be the silence one level
 * up.
 */
function resolvePropTypeLiteral({
  componentFile,
  componentName,
  source,
  typeNode,
}: {
  componentFile: string | undefined;
  componentName: string;
  source: ts.SourceFile;
  typeNode: ts.TypeNode;
}): { literal: ts.TypeLiteralNode; source: ts.SourceFile } {
  if (ts.isTypeLiteralNode(typeNode)) {
    return { literal: typeNode, source };
  }
  if (
    !(ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName))
  ) {
    throw new Error(
      `surface-capability-parity: "${componentName}" does not take a single inline prop type literal — the check cannot read its props.`
    );
  }
  const aliasName = typeNode.typeName.text;
  const local = aliasLiteralIn(source, aliasName);
  if (local) {
    return { literal: local, source };
  }
  const imported = importedAliasLiteral({
    aliasName,
    componentFile,
    componentName,
    source,
  });
  return imported;
}

/** The type literal a `type X = { … }` alias declares in `source`, if any. */
function aliasLiteralIn(
  source: ts.SourceFile,
  aliasName: string
): ts.TypeLiteralNode | undefined {
  for (const statement of source.statements) {
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text === aliasName &&
      ts.isTypeLiteralNode(statement.type)
    ) {
      return statement.type;
    }
  }
  return undefined;
}

/**
 * The same alias, followed one hop into the module the component imports it
 * from — the shape a props split leaves behind, whether the split landed in a
 * relative sibling or, for a `packages/*` component, in a `@repo/<pkg>` subpath
 * of its own package.
 */
function importedAliasLiteral({
  aliasName,
  componentFile,
  componentName,
  source,
}: {
  aliasName: string;
  componentFile: string | undefined;
  componentName: string;
  source: ts.SourceFile;
}): { literal: ts.TypeLiteralNode; source: ts.SourceFile } {
  const origin = importOriginOf(source, aliasName);
  if (!(origin && componentFile)) {
    throw new Error(
      `surface-capability-parity: "${componentName}" types its props as "${aliasName}", which the check cannot resolve to a type literal. Declare it in the component's own module, or import it from a relative sibling.`
    );
  }
  const resolved = resolveModuleFile(componentFile, origin.moduleSpecifier);
  if (!resolved) {
    throw new Error(
      `surface-capability-parity: "${componentName}" imports its prop type "${aliasName}" from "${origin.moduleSpecifier}", which the check cannot resolve to a file.`
    );
  }
  const declaring = parse(readFileSync(resolved, "utf8"));
  const literal = aliasLiteralIn(declaring, origin.exportedName);
  if (!literal) {
    throw new Error(
      `surface-capability-parity: "${origin.exportedName}" in "${origin.moduleSpecifier}" is not a plain type literal, so the props "${componentName}" accepts cannot be read.`
    );
  }
  return { literal, source: declaring };
}

/** The module and exported name a local type binding came from, if imported. */
function importOriginOf(
  source: ts.SourceFile,
  localName: string
): { exportedName: string; moduleSpecifier: string } | undefined {
  for (const statement of source.statements) {
    if (
      !(
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier)
      )
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!(bindings && ts.isNamedImports(bindings))) {
      continue;
    }
    for (const element of bindings.elements) {
      if (element.name.text === localName) {
        return {
          exportedName: element.propertyName?.text ?? element.name.text,
          moduleSpecifier: statement.moduleSpecifier.text,
        };
      }
    }
  }
  return undefined;
}

function findFunction(
  source: ts.SourceFile,
  name: string
): ts.FunctionDeclaration | undefined {
  let match: ts.FunctionDeclaration | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      match = node;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return match;
}

const SKIPPED_DIRS = new Set([
  ".next",
  ".turbo",
  "build",
  "dist",
  "e2e",
  "generated",
  "node_modules",
  "storybook-static",
]);

const sourceCache = new Map<string, { code: string; relative: string }[]>();

/**
 * The mounts of `componentName` that NO ledger classifies — the discovery
 * check's whole decision, lifted out of the spec so it can be executed against
 * synthetic ledgers rather than only against whatever the repo happens to
 * contain today (whitlockk + codex review).
 *
 * The audited unit is a (component, host) PAIR, not a host. Matching a mount
 * against every ledger's `hostPath` regardless of component lets one
 * component's ledger vouch for another's mount: `sessions-v2-page.tsx` is
 * ledgered for `SessionsListV2Host`, so an unclassified direct
 * `SessionsListSurfaceV2` mount added to that same file would read as covered
 * and the guard would stay green while capabilities dropped — the fail-open
 * this check exists to close, one level up.
 */
export function unledgeredMounts({
  componentName,
  ledgers,
  mounts,
}: {
  componentName: string;
  ledgers: readonly HostCapabilityLedger[];
  mounts: readonly string[];
}): string[] {
  const ledgered = new Set(
    ledgers
      .filter((entry) => entry.componentName === componentName)
      .map((entry) => entry.hostPath)
  );
  return mounts.filter((mount) => !ledgered.has(mount));
}

/**
 * What a host may do about a capability it is not passing, by kind — the half
 * of every failure message that tells the reader which escape hatches this prop
 * actually has.
 */
function remedyFor(
  kind: SurfaceCapabilityKind | undefined,
  verb: "record" | "reclassify"
): string {
  if (kind === PRESENTATION) {
    return `Pass it, or ${verb} it as inertWithout the companion this host withholds — "notSupported" is not available to a presentation prop.`;
  }
  return `Pass it, or ${verb} it as notSupported with the reason.`;
}

/** Everything wrong with ONE classified capability, in this host's ledger. */
function classificationProblems({
  hostCode,
  ledger,
  prop,
  supplied,
}: {
  hostCode: string | undefined;
  ledger: HostCapabilityLedger;
  prop: string;
  supplied: ReadonlySet<string>;
}): string[] {
  const { capabilities, componentName, hostPath, kinds } = ledger;
  const classification = capabilities[prop] as CapabilityClassification;
  const isSupplied = supplied.has(prop);
  if (classification === SUPPLIED) {
    if (isSupplied) {
      return [];
    }
    return [
      `${hostPath}: capability "${prop}" is classified supplied but this host does not pass it to ${componentName}, so the affordance never renders. ${remedyFor(kinds[prop], "reclassify")}`,
    ];
  }
  if (isSupplied) {
    return [
      `${hostPath}: capability "${prop}" is classified ${describeClassification(classification)} but this host does pass it to ${componentName}. Reclassify it as supplied.`,
    ];
  }
  if ("notSupported" in classification) {
    return notSupportedProblems({
      ledger,
      prop,
      reason: classification.notSupported,
    });
  }
  if ("gatedOn" in classification) {
    return gatedProblems({
      gate: classification.gatedOn,
      hostCode,
      ledger,
      prop,
    });
  }
  return inertProblems({
    companion:
      "inertUnder" in classification
        ? classification.inertUnder
        : classification.inertWithout,
    ledger,
    prop,
    requiresSuppliedCompanion: "inertUnder" in classification,
  });
}

function describeClassification(
  classification: NotSupported | InertCapability | GatedCapability
): string {
  if ("notSupported" in classification) {
    return `notSupported ("${classification.notSupported}")`;
  }
  if ("gatedOn" in classification) {
    return `gated on "${classification.gatedOn}"`;
  }
  if ("inertWithout" in classification) {
    return `inert without "${classification.inertWithout}"`;
  }
  return `inert under "${classification.inertUnder}"`;
}

/**
 * ISS-9218 — the two things `notSupported` must survive: it has to be ADMISSIBLE
 * for this prop's kind, and its reason has to state an inability.
 */
function notSupportedProblems({
  ledger,
  prop,
  reason,
}: {
  ledger: HostCapabilityLedger;
  prop: string;
  reason: string;
}): string[] {
  const { componentName, hostPath, kinds } = ledger;
  const problems: string[] = [];
  if (kinds[prop] === PRESENTATION) {
    problems.push(
      `${hostPath}: capability "${prop}" is presentation on ${componentName}, so "notSupported" cannot be true of it — nothing stops this host passing a value, and omitting it silently swaps in the surface's own default. Pass it, or declare it inertWithout the companion this host withholds.`
    );
  }
  const shape = reasonShapeProblem(reason);
  if (shape) {
    problems.push(`${hostPath}: capability "${prop}" ${shape}`);
  }
  return problems;
}

/**
 * ISS-9218 — why the reason is not a reason. `"See onPageSizeChange."` passed
 * for months: free text nothing read, pointing at another entry instead of
 * naming what this host lacks.
 */
function reasonShapeProblem(reason: string): string | undefined {
  const trimmed = reason.trim();
  if (!trimmed) {
    return "is notSupported with no reason at all. State why this host cannot support it.";
  }
  if (BARE_CROSS_REFERENCE.test(trimmed)) {
    return `gives "${trimmed}" as its notSupported reason, which only points at another entry instead of stating why this host cannot support it. Say what this host lacks, or declare it inertWithout/inertUnder that entry so the guard checks the dependency rather than a reader grading a sentence.`;
  }
  if (trimmed.length < MIN_NOT_SUPPORTED_REASON_LENGTH) {
    return `gives "${trimmed}" as its notSupported reason, which is too short to state why this host cannot support it.`;
  }
  return undefined;
}

function gatedProblems({
  gate,
  hostCode,
  ledger,
  prop,
}: {
  gate: string;
  hostCode: string | undefined;
  ledger: HostCapabilityLedger;
  prop: string;
}): string[] {
  const problem = gatedClaimProblem({
    exportName: ledger.componentName,
    gate,
    hostCode,
    moduleSpecifier: ledger.componentModule,
    prop,
    suppliedOnAnyMount:
      hostCode === undefined
        ? undefined
        : propsPassedOnAnyMount(
            hostCode,
            ledger.componentModule,
            ledger.componentName
          ),
  });
  return problem ? [`${ledger.hostPath}: capability "${prop}" ${problem}`] : [];
}

/**
 * ISS-9218 — the inert claim, checked against the ledger it was made in rather
 * than believed. `inertWithout` needs its companion WITHHELD here; `inertUnder`
 * needs it SUPPLIED. Either way the claim expires on its own the moment the host
 * changes, which is what a free-text reason never did.
 */
function inertProblems({
  companion,
  ledger,
  prop,
  requiresSuppliedCompanion,
}: {
  companion: string;
  ledger: HostCapabilityLedger;
  prop: string;
  requiresSuppliedCompanion: boolean;
}): string[] {
  const { capabilities, hostPath } = ledger;
  const form = requiresSuppliedCompanion ? "inert under" : "inert without";
  if (companion === prop) {
    return [
      `${hostPath}: capability "${prop}" is declared ${form} itself, which asserts nothing. Name the OTHER capability that makes it inert.`,
    ];
  }
  if (!Object.hasOwn(capabilities, companion)) {
    return [
      `${hostPath}: capability "${prop}" is declared ${form} "${companion}", which this host classifies nowhere. Name a capability this ledger carries.`,
    ];
  }
  const companionSupplied = capabilities[companion] === SUPPLIED;
  if (companionSupplied === requiresSuppliedCompanion) {
    return [];
  }
  if (requiresSuppliedCompanion) {
    return [
      `${hostPath}: capability "${prop}" is declared inert under "${companion}", but this host does not supply "${companion}", so nothing supersedes it and its own value is what the surface would use. Pass it.`,
    ];
  }
  return [
    `${hostPath}: capability "${prop}" is declared inert without "${companion}", but this host DOES supply "${companion}", so the affordance it configures renders and omitting it changes what the reader sees. Pass it.`,
  ];
}

/**
 * A reason that is only a pointer — "See onPageSizeChange.", "Same as above" —
 * with no sentence of its own before the terminator.
 */
const BARE_CROSS_REFERENCE =
  /^(?:see(?:\s+also)?|same\s+as|as\s+(?:above|per)|ditto)\b[^.!?]*[.!?]?$/i;

/**
 * Short enough that nothing below it can name both the host's lack and its
 * consequence. Calibrated on the shortest reason both ledgers actually carry.
 */
const MIN_NOT_SUPPORTED_REASON_LENGTH = 40;

/** The other entry an inert claim leans on, or nothing for a non-inert one. */
function inertCompanion(
  classification: CapabilityClassification
): string | undefined {
  if (typeof classification !== "object") {
    return undefined;
  }
  if ("inertWithout" in classification) {
    return classification.inertWithout;
  }
  if ("inertUnder" in classification) {
    return classification.inertUnder;
  }
  return undefined;
}

/**
 * ISS-9218 (review cid 3937680744) — an inert claim is only a CHECK because it
 * points at another entry the guard reads. A ring of them points at nothing
 * outside itself: `a` inert without `b` and `b` inert without `a` both pass,
 * because each one's companion is duly withheld — the free-text escape hatch
 * again, spelled with two keys and a green suite. Self-reference is the one-node
 * case and keeps its own, more specific message in `inertProblems`.
 */
function inertCycleProblems(ledger: HostCapabilityLedger): string[] {
  const { capabilities, hostPath } = ledger;
  const companionOf = new Map<string, string>();
  for (const [prop, classification] of Object.entries(capabilities)) {
    const companion = inertCompanion(classification);
    if (companion !== undefined && companion !== prop) {
      companionOf.set(prop, companion);
    }
  }
  const problems: string[] = [];
  const reported = new Set<string>();
  for (const start of [...companionOf.keys()].sort()) {
    const cycle = cycleFrom(start, companionOf);
    if (!cycle) {
      continue;
    }
    const key = cycle.join(" → ");
    if (reported.has(key)) {
      continue;
    }
    reported.add(key);
    const chain = [...cycle, cycle[0]].map((name) => `"${name}"`).join(" → ");
    problems.push(
      `${hostPath}: capabilities ${chain} declare one another inert in a closed ring, so every claim in it is vouched for only by another member and all of them can be withheld with nothing checked. Break the ring: at least one of them must be passed, or answered as notSupported with the reason.`
    );
  }
  return problems;
}

/**
 * The cycle `start` reaches, rotated to its lexicographically smallest member so
 * every entry on a ring reports the same chain and it is emitted once.
 */
function cycleFrom(
  start: string,
  companionOf: ReadonlyMap<string, string>
): string[] | undefined {
  const walked: string[] = [];
  const seen = new Set<string>();
  let node: string | undefined = start;
  while (node !== undefined && !seen.has(node)) {
    seen.add(node);
    walked.push(node);
    node = companionOf.get(node);
  }
  if (node === undefined) {
    return undefined;
  }
  const ring = walked.slice(walked.indexOf(node));
  const pivot = ring.indexOf([...ring].sort()[0]);
  return [...ring.slice(pivot), ...ring.slice(0, pivot)];
}
