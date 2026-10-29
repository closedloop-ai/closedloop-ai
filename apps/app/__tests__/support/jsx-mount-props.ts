import ts from "typescript6";
import { spreadPropNames } from "./jsx-spread-props";
import { localNamesFor } from "./renders-imported-component";

/**
 * ISS-9223 — reading what a module's JSX actually passes to a component it
 * imports.
 *
 * Split out of `surface-capability-parity.ts`, which had grown three
 * responsibilities: prop-type resolution, repo-walk mount discovery, and this —
 * the per-mount attribute read. It moved rather than being copied because
 * `surface-capability-gate.ts` needs the same mount walk to check a `gatedOn`
 * claim, and importing the differ from the gate the differ calls would be a
 * cycle.
 */

/**
 * Prop names the host's JSX passes to the component it imports as `exportName`
 * from `moduleSpecifier`. Resolves the imported BINDING, so an aliased import
 * still matches.
 *
 * A host that renders the component on SEVERAL branches supplies a capability
 * only when EVERY branch passes it — the sets are intersected, not unioned. An
 * early `return <Surface rows usage />` on the errored path is the original
 * outage's own shape, and a union would report the affordances that branch drops
 * as supplied.
 *
 * Reads attribute PRESENCE, not value: `favorites={undefined}` counts as
 * supplied, because that is the distinction the surface itself cannot make
 * either (`favoritesEnabled: Boolean(favorites)` is evaluated at runtime, off a
 * value no static read can see). What this check owns is the host's wiring; a
 * supplied prop whose value is conditionally undefined needs a behavioural test.
 *
 * A SPREAD contributes the prop set `spreadPropNames` can prove it carries, and
 * throws when it cannot prove one — a check that quietly treated an unreadable
 * spread as "nothing supplied", or as "everything", would be exactly the silent
 * degradation this guard exists to stop.
 */
export function propsPassedToImported(
  code: string,
  moduleSpecifier: string,
  exportName: string
): ReadonlySet<string> {
  const [first, ...rest] = mountPropSets(code, moduleSpecifier, exportName).map(
    (mount) => mount.props
  );
  const shared = new Set(first);
  for (const mount of rest) {
    for (const name of shared) {
      if (!mount.has(name)) {
        shared.delete(name);
      }
    }
  }
  return shared;
}

/**
 * ISS-9223 — the prop names ANY mount passes, the union to
 * {@link propsPassedToImported}'s intersection.
 *
 * The two together are what make a `gatedOn` claim checkable: in the union and
 * not the intersection is a capability this consumer passes on some mounts and
 * withholds on others, which is the only shape that claim may describe.
 */
export function propsPassedOnAnyMount(
  code: string,
  moduleSpecifier: string,
  exportName: string
): ReadonlySet<string> {
  const union = new Set<string>();
  for (const mount of mountPropSets(code, moduleSpecifier, exportName)) {
    for (const name of mount.props) {
      union.add(name);
    }
  }
  return union;
}

/** One JSX mount of the component: the element node and the props it passes. */
export type ComponentMount = {
  readonly node: ts.JsxSelfClosingElement | ts.JsxOpeningElement;
  readonly props: ReadonlySet<string>;
};

/** Every mount of `exportName` in `code`, in source order. */
export function mountPropSets(
  code: string,
  moduleSpecifier: string,
  exportName: string
): readonly ComponentMount[] {
  return mountsIn(parseTsx(code), moduleSpecifier, exportName);
}

/** The same walk, against an already-parsed source. */
export function mountsIn(
  source: ts.SourceFile,
  moduleSpecifier: string,
  exportName: string
): readonly ComponentMount[] {
  const locals = localNamesFor(source, moduleSpecifier, exportName);
  const mounts: ComponentMount[] = [];
  const visit = (node: ts.Node) => {
    if (
      (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) &&
      locals.has(node.tagName.getText(source))
    ) {
      const props = new Set<string>();
      collectAttributes(node, source, exportName, props);
      mounts.push({ node, props });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  if (mounts.length === 0) {
    throw new Error(
      `surface-capability-parity: the host never renders "${exportName}" from "${moduleSpecifier}" — the check has nothing to compare.`
    );
  }
  return mounts;
}

/**
 * `fileName` is the module's REAL path when the caller has one, and it is
 * load-bearing rather than cosmetic: it is the only thing an imported prop set
 * can be resolved against (`jsx-spread-props` → `resolveModuleFile`). Callers
 * that hold only a string keep the synthetic default and keep the old behaviour
 * — a spread of an imported constant is then refused, not guessed at.
 */
export function parseTsx(code: string, fileName = "host.tsx"): ts.SourceFile {
  return ts.createSourceFile(
    fileName,
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
}

function collectAttributes(
  node: ts.JsxSelfClosingElement | ts.JsxOpeningElement,
  source: ts.SourceFile,
  exportName: string,
  names: Set<string>
): void {
  const describeHost = () => `the host's <${exportName}> mount`;
  for (const attribute of node.attributes.properties) {
    if (ts.isJsxSpreadAttribute(attribute)) {
      for (const name of spreadPropNames(
        attribute.expression,
        source,
        describeHost
      )) {
        names.add(name);
      }
      continue;
    }
    names.add(attribute.name.getText(source));
  }
}
