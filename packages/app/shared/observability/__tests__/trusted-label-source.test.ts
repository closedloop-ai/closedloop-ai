import ts from "typescript6";
import { describe, expect, it } from "vitest";
import { sourceResolver } from "../../../../../scripts/analytics/trusted-label-source.mjs";

function labelValues(code: string) {
  const resolver = sourceResolver("/virtual");
  const source = resolver.source("/virtual/page.tsx", code);
  const results: (string[] | null)[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText() === "button"
    ) {
      const child = node.children[0];
      if (child && ts.isJsxExpression(child)) {
        results.push(resolver.values(child.expression));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return results;
}

describe("trusted label source provenance", () => {
  it("resolves static object copy and finite indexed choices", () => {
    expect(
      labelValues(`const COPY = { save: "Save", cancel: "Cancel" } as const;
      const key = busy ? "save" : "cancel";
      <><button>{COPY.save}</button><button>{COPY[key]}</button></>`)
    ).toEqual([["Save"], ["Save", "Cancel"]]);
  });

  it("resolves static menu arrays through map and filter", () => {
    expect(
      labelValues(`const ITEMS = [{label:"Dashboard"}, {label:"Sessions"}];
      ITEMS.filter(item => item.enabled).map(item => <button>{item.label}</button>);`)
    ).toEqual([["Dashboard", "Sessions"]]);
  });

  it("resolves destructured static map labels without trusting customer maps", () => {
    expect(
      labelValues(`const ITEMS = [{label:"Dashboard"}];
      ITEMS.map(({label: title}) => <button>{title}</button>);
      customers.map(({label: title}) => <button>{title}</button>);`)
    ).toEqual([["Dashboard"], null]);
  });

  it("rejects customer values even when another branch contains static copy", () => {
    expect(
      labelValues(`const ITEMS = [{label:"Save"}, {label:customerName}];
      ITEMS.map(item => <button>{item.label}</button>);
      const COPY = {label: "Save", ...customer}; <button>{COPY.label}</button>;`)
    ).toEqual([null, null]);
  });

  it("honors local loop, catch, and switch shadows of product copy", () => {
    expect(
      labelValues(`const label = "Save";
      for (const label of customers) { <button>{label}</button>; }
      try {} catch (label) { <button>{label}</button>; }
      switch (kind) { case 1: const label = customer; <button>{label}</button>; }
      function View({label}) {return <button>{label}</button>}`)
    ).toEqual([null, null, null, null]);
  });

  it.each([
    "COPY.label = customer;",
    "Object.assign(COPY, customer);",
    "mutate(COPY);",
    "const alias = COPY; alias.label = customer;",
    "function later() { COPY.label = customer; }",
    "const escaped = { copy: COPY };",
    "const alias = (COPY); mutate(alias);",
    "const alias = flag ? COPY : other; mutate(alias);",
    "alias = COPY;",
    "const escaped = [COPY]; mutate(escaped);",
    "<Other copy={COPY} />;",
    "(COPY).label = customer;",
    "const escape = () => COPY;",
    "const alias = COPY || other; mutate(alias);",
  ])("rejects mutable or escaping source objects: %s", (mutation) => {
    expect(
      labelValues(
        `const COPY = {label: "Save"}; ${mutation} <button>{COPY.label}</button>`
      )
    ).toEqual([null]);
  });

  it.each([
    "ITEMS.push(customer); ITEMS.map(item => <button>{item.label}</button>)",
    "ITEMS.filter(item => mutate(item)).map(item => <button>{item.label}</button>)",
    "ITEMS.map(item => {item.label = customer; return <button>{item.label}</button>})",
    "ITEMS.map(item => {expose(item); return <button>{item.label}</button>})",
  ])("rejects mutable mapped elements: %s", (expression) => {
    expect(
      labelValues(`const ITEMS = [{label: "Save"}]; ${expression}`)
    ).toEqual([null]);
  });

  it("fails closed on cycles and unproven array transforms", () => {
    expect(
      labelValues(`const A=B; const B=A; <button>{A}</button>;
      const ITEMS = [{label:"Save"}];
      ITEMS.map(item => customer).map(item => <button>{item.label}</button>);`)
    ).toEqual([null, null]);
  });
});
