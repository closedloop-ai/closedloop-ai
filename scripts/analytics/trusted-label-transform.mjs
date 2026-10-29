import { fileURLToPath } from "node:url";
import ts from "typescript6";
import {
  isProductLabelSource,
  join,
  sourceResolver,
} from "./trusted-label-source.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SOURCE = /\.[jt]sx$/;
const SPACE = /\s+/g;
const ACTION =
  /(?:Button|Link|Trigger|MenuItem|CommandItem|SelectItem|Toggle|Tab|Action|Option)$|^(?:button|a|summary|input)$/;
const HIDDEN = /(?:^|\s)sr-only(?:\s|$)/;

export function transformTrustedLabels(code, filename, options = {}) {
  const file = filename.split("?")[0];
  if (
    !(SOURCE.test(file) && (options.includeTests || isProductLabelSource(file)))
  ) {
    return { code, dependencies: [] };
  }
  const resolver = sourceResolver(options.root ?? ROOT);
  const source = resolver.source(file, code);
  const insertions = [];
  function attribute(opening, name) {
    return opening.attributes.properties.find(
      (prop) => ts.isJsxAttribute(prop) && prop.name.getText() === name
    );
  }
  function attributeValues(opening, name) {
    const prop = attribute(opening, name);
    if (!prop) {
      return null;
    }
    return resolver.values(prop.initializer);
  }
  function text(node, accessible = false) {
    if (ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText();
      return name === "svg" || name === "input" || isLucideIcon(source, name)
        ? [""]
        : null;
    }
    if (!(ts.isJsxElement(node) || ts.isJsxFragment(node))) {
      return resolver.values(node);
    }
    if (ts.isJsxElement(node)) {
      const opening = node.openingElement;
      if (hiddenElement(opening, accessible)) {
        return [""];
      }
      // A nested action owns its own provenance; a parent never authorizes it.
      if (ACTION.test(opening.tagName.getText()) && node !== current) {
        return null;
      }
    }
    return node.children.reduce(
      (result, child) => join(result, text(child, accessible)),
      [""]
    );
  }
  let current;
  function forwarded(node, property) {
    if (!node) {
      return false;
    }
    if (ts.isJsxExpression(node)) {
      return node.expression ? forwarded(node.expression, property) : true;
    }
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      return node.children.every((child) => forwarded(child, property));
    }
    const literal = text(node);
    if (literal?.every((value) => value.trim() === "")) {
      return true;
    }
    for (let scope = node.parent; scope; scope = scope.parent) {
      if (!ts.isFunctionLike(scope)) {
        continue;
      }
      return scope.parameters.some((parameter) =>
        parameterForwards(parameter, node, property)
      );
    }
    return false;
  }
  function hasHiddenStyle(opening) {
    const style = attribute(opening, "style")?.initializer;
    if (
      !(
        style &&
        ts.isJsxExpression(style) &&
        style.expression &&
        ts.isObjectLiteralExpression(style.expression)
      )
    ) {
      return false;
    }
    return style.expression.properties.some(
      (prop) =>
        ts.isPropertyAssignment(prop) &&
        ((prop.name.getText() === "display" &&
          resolver
            .values(prop.initializer)
            ?.every((value) => value === "none")) ||
          (prop.name.getText() === "visibility" &&
            resolver
              .values(prop.initializer)
              ?.every((value) => value === "hidden")))
    );
  }
  function hiddenElement(opening, accessible) {
    return (
      opening.tagName.getText() === "svg" ||
      attributeValues(opening, "aria-hidden")?.every(
        (value) => value === "true"
      ) ||
      isAlwaysHiddenAttribute(attribute(opening, "hidden")) ||
      hasHiddenStyle(opening) ||
      (!accessible &&
        attributeValues(opening, "className")?.some((name) =>
          HIDDEN.test(name)
        ))
    );
  }
  function sourceAttribute(node, opening, channel, candidates) {
    const propName =
      {
        accessible: "aria-label",
        tooltip: "title",
        label: "data-analytics-label",
      }[channel] ?? selfClosingTextProperty(node, opening);
    const owner = propName ? attribute(opening, propName) : node;
    if (
      !owner ||
      (ts.isJsxSelfClosingElement(node) && !propName && !candidates)
    ) {
      return "";
    }
    const lastSpread = opening.attributes.properties.findLastIndex(
      ts.isJsxSpreadAttribute
    );
    if (spreadOwnsChannel(node, opening, propName, owner, lastSpread)) {
      return "";
    }
    if (
      !candidates &&
      forwarded(propName ? owner.initializer : node, propName ?? "children")
    ) {
      return "";
    }
    const normalized = [
      ...new Set(
        (candidates ?? [])
          .map((value) => value.replace(SPACE, " ").trim())
          .filter(Boolean)
      ),
    ];
    return ` data-analytics-${channel}-source={${JSON.stringify(JSON.stringify(normalized))}}`;
  }
  function visit(node) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      current = node;
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (
        ["Fragment", "React.Fragment", "Suspense", "React.Suspense"].includes(
          opening.tagName.getText()
        ) ||
        opening.tagName.getText().endsWith(".Provider")
      ) {
        ts.forEachChild(node, visit);
        return;
      }
      const channels = {
        visible: ts.isJsxElement(node)
          ? text(node)
          : attributeValues(opening, selfClosingTextProperty(node, opening)),
        accessible: attributeValues(opening, "aria-label"),
        tooltip: attributeValues(opening, "title"),
        label: attributeValues(opening, "data-analytics-label"),
        text: ts.isJsxElement(node)
          ? text(node, true)
          : attributeValues(opening, selfClosingTextProperty(node, opening)),
      };
      const added =
        Object.entries(channels)
          .map(([channel, candidates]) =>
            sourceAttribute(node, opening, channel, candidates)
          )
          .join("") + actionMarker(opening);
      if (added) {
        insertions.push([opening.attributes.end, added]);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  let transformed = code;
  for (const [position, added] of insertions.sort(
    ([left], [right]) => right - left
  )) {
    transformed =
      transformed.slice(0, position) + added + transformed.slice(position);
  }
  return {
    code: transformed,
    dependencies: resolver
      .dependencies()
      .filter((dependency) => dependency !== file),
  };
}

function selfClosingTextProperty(node, opening) {
  if (!ts.isJsxSelfClosingElement(node)) {
    return undefined;
  }
  for (const name of ["children", "value"]) {
    if (
      opening.attributes.properties.some(
        (prop) => ts.isJsxAttribute(prop) && prop.name.getText() === name
      )
    ) {
      return name;
    }
  }
  return undefined;
}

function isLucideIcon(source, name) {
  return source.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.moduleSpecifier.text !== "lucide-react"
    ) {
      return false;
    }
    const imports = statement.importClause?.namedBindings;
    return (
      imports &&
      ts.isNamedImports(imports) &&
      imports.elements.some((element) => element.name.text === name)
    );
  });
}

function actionMarker(opening) {
  if (
    !(
      ts.isIdentifier(opening.tagName) &&
      ["div", "span", "li", "tr", "section"].includes(opening.tagName.text)
    )
  ) {
    return "";
  }
  if (
    opening.attributes.properties.some(
      (prop) =>
        ts.isJsxAttribute(prop) &&
        prop.name.getText() === "data-analytics-action"
    )
  ) {
    return "";
  }
  const handler = opening.attributes.properties.find(
    (prop) => ts.isJsxAttribute(prop) && prop.name.getText() === "onClick"
  );
  const expression = handler?.initializer;
  if (
    !(expression && ts.isJsxExpression(expression) && expression.expression)
  ) {
    return "";
  }
  if (
    ts.isArrowFunction(expression.expression) ||
    ts.isFunctionExpression(expression.expression)
  ) {
    return ' data-analytics-action="true"';
  }
  if (ts.isIdentifier(expression.expression)) {
    return ` data-analytics-action={typeof ${expression.expression.text} === "function" ? "true" : undefined}`;
  }
  return "";
}

export function trustedLabelPlugin() {
  return {
    name: "trusted-click-labels",
    enforce: "pre",
    transform(code, id) {
      const result = transformTrustedLabels(code, id);
      for (const dependency of result.dependencies) {
        this.addWatchFile(dependency);
      }
      return result.code === code ? null : { code: result.code, map: null };
    },
  };
}

function parameterForwards(parameter, node, property) {
  if (ts.isObjectBindingPattern(parameter.name) && ts.isIdentifier(node)) {
    return parameter.name.elements.some(
      (binding) =>
        ts.isIdentifier(binding.name) &&
        binding.name.text === node.text &&
        (binding.propertyName?.getText().replaceAll('"', "") ??
          binding.name.text) === property
    );
  }
  if (ts.isIdentifier(parameter.name) && ts.isPropertyAccessExpression(node)) {
    return (
      ts.isIdentifier(node.expression) &&
      node.expression.text === parameter.name.text &&
      node.name.text === property
    );
  }
  return false;
}

function spreadOwnsChannel(node, opening, propName, owner, lastSpread) {
  if (lastSpread < 0) {
    return false;
  }
  if (propName) {
    return opening.attributes.properties.indexOf(owner) < lastSpread;
  }
  return ts.isJsxSelfClosingElement(node);
}

function isAlwaysHiddenAttribute(attribute) {
  if (!attribute) {
    return false;
  }
  if (!attribute.initializer) {
    return true;
  }
  return (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression?.kind === ts.SyntaxKind.TrueKeyword
  );
}
