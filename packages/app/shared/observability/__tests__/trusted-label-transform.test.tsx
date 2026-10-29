import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript6";
import { afterEach, describe, expect, it } from "vitest";

// Use Node's build-time module loader, as the production integrations do.
// Vite's browser URL rewriting otherwise changes this build module's import.meta.url.
const { transformTrustedLabels } = createRequire(
  path.join(process.cwd(), "package.json")
)("../../scripts/analytics/trusted-label-transform.mjs") as {
  transformTrustedLabels: (
    source: string,
    filename: string,
    options: { root: string; includeTests?: boolean }
  ) => { code: string; dependencies: string[] };
};
const COPY_DEPENDENCY = /copy\.ts$/;

import { buttonName } from "../button-click-tracker";

const directories: string[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.remove();
  }
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(
  source: string,
  props: Record<string, unknown> = {},
  copies?: string,
  selector = "button"
) {
  const root = mkdtempSync(path.join(tmpdir(), "trusted-button-"));
  directories.push(root);
  if (copies) {
    writeFileSync(path.join(root, "copy.ts"), copies);
  }
  const filename = path.join(root, "view.tsx");
  const transformed = transformTrustedLabels(source, filename, {
    root,
    includeTests: true,
  });
  function evaluate(
    code: string
  ): Record<string, React.ComponentType<Record<string, unknown>>> {
    const result = ts.transpileModule(code, {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    });
    const exports = {};
    const require = (specifier: string) =>
      specifier === "lucide-react"
        ? createRequire(path.join(process.cwd(), "package.json"))(specifier)
        : evaluate(readFileSync(path.resolve(root, `${specifier}.ts`), "utf8"));
    new Function("React", "exports", "require", result.outputText)(
      React,
      exports,
      require
    );
    return exports;
  }
  const component = evaluate(transformed.code).default;
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(React.createElement(component, props));
  document.body.append(host);
  hosts.push(host);
  const button = host.querySelector(selector);
  if (!button) {
    throw new Error("Fixture did not render a button");
  }
  return { button, transformed };
}

const provenance = (button: Element, channel = "visible") =>
  JSON.parse(button.getAttribute(`data-analytics-${channel}-source`) || "[]");

describe("source provenance survives real JSX compilation and rendering", () => {
  it("preserves source offsets for JSX nested inside a parent attribute", () => {
    const { button } = fixture(`
      function Panel({action, ...props}) { return <section {...props}>{action}</section>; }
      export default function View() {
        return <Panel title="Actions" action={<button title="Save changes">Save</button>} />;
      }
    `);
    expect(buttonName(button)).toBe("Save");
    expect(provenance(button)).toEqual(["Save"]);
    expect(provenance(button, "tooltip")).toEqual(["Save changes"]);
  });

  it("distinguishes literal Save from a customer title equal to Save", () => {
    const literal = fixture(
      "export default function View() { return <button>Save</button>; }"
    );
    const customer = fixture(
      "export default function View({title}) { return <button>{title}</button>; }",
      { title: "Save" }
    );
    expect(provenance(literal.button)).toEqual(["Save"]);
    expect(provenance(customer.button)).toEqual([]);
    expect(buttonName(literal.button)).toBe("Save");
    expect(buttonName(customer.button)).toBe("Activate action");
  });

  it("resolves imported primitive copy constants and reports the dependency", () => {
    const { button, transformed } = fixture(
      'import { SAVE as label } from "./copy"; export default function View() { return <button>{label}</button>; }',
      {},
      'export const SAVE = "Save";'
    );
    expect(provenance(button)).toEqual(["Save"]);
    expect(buttonName(button)).toBe("Save");
    expect(transformed.dependencies).toContainEqual(
      expect.stringMatching(COPY_DEPENDENCY)
    );
  });

  it("trusts all-static conditional branches but rejects a mixed customer branch", () => {
    const trusted = fixture(
      'export default function View({ready}) { return <button>{ready ? "Save" : "Cancel"}</button>; }',
      { ready: true }
    );
    const mixed = fixture(
      'export default function View({ready,title}) { return <button>{ready ? "Save" : title}</button>; }',
      { ready: false, title: "Save" }
    );
    expect(provenance(trusted.button)).toEqual(["Save", "Cancel"]);
    expect(provenance(mixed.button)).toEqual([]);
    expect(buttonName(mixed.button)).toBe("Activate action");
  });

  it.each([
    'const label = "Save"; export default function View({label}) { return <button>{label}</button>; }',
    'const label = "Save"; export default function View({title}) { const label = title; return <button>{label}</button>; }',
    'const label = "Save"; export default function View({title}) { for (const label of [title]) { return <button>{label}</button>; } }',
    'const label = "Save"; export default function View({title}) { try { throw title; } catch (label) { return <button>{label}</button>; } }',
  ])(
    "does not resolve a shadowed binding to outer static copy: %s",
    (source) => {
      const { button } = fixture(source, { title: "Save", label: "Save" });
      expect(provenance(button)).toEqual([]);
      expect(buttonName(button)).toBe("Activate action");
    }
  );

  it("preserves provenance through a transparent props-forwarding wrapper", () => {
    const { button } = fixture(
      "function ForwardButton(props) { return <button {...props} />; } export default function View() { return <ForwardButton>Save</ForwardButton>; }"
    );
    expect(provenance(button)).toEqual(["Save"]);
    expect(buttonName(button)).toBe("Save");
  });

  it("clears forwarded provenance when a wrapper replaces visible children", () => {
    const { button } = fixture(
      "function ReplaceButton({title,...props}) { return <button {...props}>{title}</button>; } export default function View({title}) { return <ReplaceButton title={title}>Save</ReplaceButton>; }",
      { title: "Save" }
    );
    expect(provenance(button)).toEqual([]);
    expect(buttonName(button)).toBe("Activate action");
  });

  it("clears forwarded accessible provenance when a wrapper replaces aria-label", () => {
    const { button } = fixture(
      'function ReplaceButton({title,...props}) { return <button {...props} aria-label={title} />; } export default function View({title}) { return <ReplaceButton title={title} aria-label="Save" />; }',
      { title: "Save" }
    );
    expect(provenance(button, "accessible")).toEqual([]);
    expect(buttonName(button)).toBe("Activate action");
  });
});

describe("production loader and fixture exclusions", () => {
  it.each([
    "mock.tsx",
    "mock-detail.tsx",
    "session-mock-data.tsx",
    "__mocks__/button.tsx",
  ])("does not instrument %s", (name) => {
    const source =
      "export default function View() { return <button>Save</button>; }";
    const result = transformTrustedLabels(
      source,
      path.join(tmpdir(), "provenance-sources", name),
      { root: tmpdir() }
    );
    expect(result.code).toBe(source);
    expect(result.dependencies).toEqual([]);
  });

  it("executes the async Node loader and registers imported copy dependencies", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "trusted-loader-"));
    directories.push(root);
    const copyPath = path.join(root, "copy.ts");
    writeFileSync(copyPath, 'export const LABEL = "Save";');
    const dependencies: string[] = [];
    type Done = (error: Error | null, code?: string) => void;
    type LoaderContext = {
      async: () => Done;
      resourcePath: string;
      getOptions: () => { root: string };
      addDependency: (dependency: string) => void;
    };
    const loader = createRequire(path.join(process.cwd(), "package.json"))(
      "../../scripts/analytics/trusted-label-loader.cjs"
    ) as (this: LoaderContext, source: string) => void;
    const transformed = await new Promise<string>((resolve, reject) => {
      loader.call(
        {
          async: () => (error, code) =>
            error ? reject(error) : resolve(code ?? ""),
          resourcePath: path.join(root, "view.tsx"),
          getOptions: () => ({ root }),
          addDependency: (dependency) => dependencies.push(dependency),
        },
        'import {LABEL} from "./copy"; export default function View() { return <button>{LABEL}</button>; }'
      );
    });
    expect(dependencies).toEqual([copyPath]);
    const compiled = ts.transpileModule(transformed, {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        module: ts.ModuleKind.CommonJS,
      },
    }).outputText;
    const exports: { default?: React.ComponentType } = {};
    new Function("React", "exports", "require", compiled)(
      React,
      exports,
      () => ({ LABEL: "Save" })
    );
    if (!exports.default) {
      throw new Error("Loader output failed to export the fixture");
    }
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(React.createElement(exports.default));
    const button = host.querySelector("button");
    if (!button) {
      throw new Error("Loader output failed to render the fixture");
    }
    expect(provenance(button)).toEqual(["Save"]);
    expect(buttonName(button)).toBe("Save");
  });
});

describe("product labels across supported control shapes", () => {
  it.each(["Avg / session", "N/A", "Closedloop.ai"])(
    "preserves legitimate product copy %s but not equal customer text",
    (label) => {
      const trusted = fixture(
        `export default function View() { return <button>${label}</button>; }`
      );
      const customer = fixture(
        "export default function View({title}) { return <button>{title}</button>; }",
        { title: label }
      );
      expect(buttonName(trusted.button)).toBe(label);
      expect(buttonName(customer.button)).toBe("Activate action");
    }
  );

  it("preserves product text beside an actual imported Lucide icon", () => {
    const { button } = fixture(
      'import {Save as SaveIcon} from "lucide-react"; function Button(props) { return <button {...props}/>; } export default function View() { return <Button><SaveIcon/>Save</Button>; }'
    );
    expect(button.querySelector("svg")).not.toBeNull();
    expect(buttonName(button)).toBe("Save");
  });

  it("does not authorize arbitrary components just because their name ends in Icon", () => {
    const { button } = fixture(
      "function CustomerIcon({title}) { return <span>{title}</span>; } export default function View({title}) { return <button><CustomerIcon title={title}/>Save</button>; }",
      { title: "" }
    );
    expect(buttonName(button)).toBe("Activate action");
  });

  it.each([
    "hidden",
    'aria-hidden="true"',
    'className="sr-only"',
    'style={{display:"none"}}',
    'style={{visibility:"hidden"}}',
  ])("omits nested hidden text with %s", (hidden) => {
    const { button } = fixture(
      `export default function View({title}) { return <button>Save<span ${hidden}>{title}</span></button>; }`,
      { title: "private repository" }
    );
    expect(buttonName(button)).toBe("Save");
  });

  it.each([
    "function ForwardButton({children,...props}) { return <button {...props}>{children}</button>; }",
    "function ForwardButton(props) { return <button {...props}>{props.children}</button>; }",
  ])("preserves function-parameter children forwarding: %s", (wrapper) => {
    const { button } = fixture(
      `${wrapper} export default function View() { return <ForwardButton>Save</ForwardButton>; }`
    );
    expect(buttonName(button)).toBe("Save");
  });

  it("clears inherited input provenance when the value is replaced with customer text", () => {
    const { button } = fixture(
      'function InputButton({title,...props}) { return <input {...props} value={title}/>; } export default function View({title}) { return <InputButton type="button" value="Save" title={title}/>; }',
      { title: "Save" },
      undefined,
      "input"
    );
    expect(buttonName(button)).toBe("Activate action");
  });

  it.each(["aria-labelledby", "aria-describedby"])(
    "uses a static referenced %s label but rejects customer text",
    (attribute) => {
      const trusted = fixture(
        `export default function View() { return <><span id="label">Save</span><button ${attribute}="label" /></>; }`
      );
      expect(buttonName(trusted.button)).toBe("Save");
      trusted.button.parentElement?.remove();
      const customer = fixture(
        `export default function View({title}) { return <><span id="label">{title}</span><button ${attribute}="label" /></>; }`,
        { title: "Save" }
      );
      expect(buttonName(customer.button)).toBe("Activate action");
    }
  );

  it.each([true, false])(
    "marks custom clickable div only when its handler is a function: %s",
    (enabled) => {
      const { button } = fixture(
        "export default function View({handler}) { return <div onClick={handler}>Save</div>; }",
        { handler: enabled ? () => undefined : undefined },
        undefined,
        "div"
      );
      expect(button.getAttribute("data-analytics-action")).toBe(
        enabled ? "true" : null
      );
    }
  );
});
