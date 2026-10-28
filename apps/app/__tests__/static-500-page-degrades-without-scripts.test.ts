/**
 * ISS-10063 — the condition under which the accepted CSP gap stops being
 * acceptable.
 *
 * WHAT WAS ACCEPTED. Next prerenders its own synthetic `_global-error` at build
 * time and copies the result to `pages/500.html`, which Vercel serves on the
 * original request url when a page crashes outside app-render's recovery
 * (`next start` returns plain text instead, ISS-11059).
 * Built with no request, it carries no nonce: 19 scripts, 0 nonced, measured
 * on a production build of this app under Next 16.3.0 (ISS-9070 / #7088) and
 * again under 16.3.3 (ISS-11059), 18 after ISS-12054 regrouped the same
 * client code into one fewer chunk, and 19 since Next 16.4.1 inlined the
 * chunk-group bootstrap (ISS-12940). This app's policy is
 * ENFORCING on stage and on `app.closedloop.ai` (`lib/content-security-policy`
 * → `enforcesContentSecurityPolicy`), so all of them are blocked. A hash allowance
 * or a per-document exclusion weakens the policy — `proxy.ts`'s matcher runs
 * on `/_global-error` the same as every other route (that is where the nonce
 * CSP above was measured), so carving out an exclusion for it is a policy
 * weakening, not a scoping fix; the root layout is not in that document's tree
 * either, so a nonce it emits never reaches this document. Stripping the
 * scripts needs a patch to Next's own build (weighed and declined in
 * ISS-11059). The operator accepted it on 2026-09-11.
 *
 * WHAT THE ACCEPTANCE RESTS ON, the part this file holds (the built-document
 * half is `scripts/check-static-500.mjs`): that document's sole recovery control is a `<form>` submit, so it still reloads with every
 * script blocked. It degrades instead of dead-ending. Nothing else in this repo
 * holds that — it is Next's component, not ours, and the sibling in the same
 * directory (`builtin/global-error.js`, the RUNTIME error boundary, which is a
 * different document and correctly nonced) already ships an `onClick`. One
 * upstream edit swapping the two, or adding a handler here, turns the page a
 * user lands on when everything else has broken into a dead end, silently.
 *
 * WHY THE ELEMENT TREE AND NOT THE RENDERED HTML. React never serializes an
 * event handler into static markup, so scanning `500.html` for `onclick` comes
 * back clean no matter what the component does. The tree is where a handler is
 * visible at all.
 *
 * NOT COVERED HERE: the script and nonce counts themselves, which need a
 * production build — `scripts/check-static-500.mjs` measures them in the
 * `next-build` CI lane.
 */

import { join } from "node:path";
import { createPagesMapping } from "next/dist/build/route-discovery";
import AppError from "next/dist/client/components/builtin/app-error";
import { findPagesDir } from "next/dist/lib/find-pages-dir";
import type { PAGE_TYPES } from "next/dist/lib/page-types";
import { UNDERSCORE_GLOBAL_ERROR_ROUTE_ENTRY } from "next/dist/shared/lib/entry-constants";
import { describe, expect, it } from "vitest";

const JSX_EVENT_HANDLER_PROP = /^on[A-Z]/;
const BUILT_IN_APP_ERROR_MODULE = /builtin[/\\]app-error\.js$/;
const APP_ROOT = join(import.meta.dirname, "..");
/**
 * `PAGE_TYPES.APP`. Next declares that enum as an ambient `const enum`, which
 * `isolatedModules` forbids reading member-wise, so the member's value is
 * written out and typed back to the enum. A rename upstream does not pass
 * silently: `createPagesMapping` would return no app entries and the assertion
 * below would read `undefined`.
 */
const APP_PAGES_TYPE = "app" as PAGE_TYPES;

type ElementNode = {
  type: unknown;
  props: Record<string, unknown>;
};

type FunctionComponent = (props: Record<string, unknown>) => unknown;

describe("the static 500 document Next serves under the enforcing CSP", () => {
  it("is the built-in app-error component, not the runtime global-error", async () => {
    // The mapping is what makes the component below the one that reaches
    // `pages/500.html`; asserting the component alone would measure a module
    // the build had stopped using. `appDirOnly` is not ours to declare either:
    // `next build` derives it from whether this app has a `pages/` directory
    // (`build/index.js` → `findPagesDir`, then `!appDirOnly && !pagesDir`), and
    // `createPagesMapping` inserts the synthetic entry only when it is true. So
    // read it from the filesystem the same way — adding `apps/app/pages/` moves
    // production's 500 to `pages/_error`, and this file must red rather than
    // silently keep measuring a document the server no longer serves.
    const { pagesDir, appDir } = findPagesDir(APP_ROOT);
    expect(pagesDir).toBeUndefined();

    const mapping = await createPagesMapping({
      isDev: false,
      pageExtensions: ["tsx", "ts"],
      pagePaths: [],
      pagesType: APP_PAGES_TYPE,
      pagesDir,
      appDir,
      appDirOnly: pagesDir === undefined,
    });

    expect(mapping[UNDERSCORE_GLOBAL_ERROR_ROUTE_ENTRY]).toMatch(
      BUILT_IN_APP_ERROR_MODULE
    );
  });

  it("offers exactly one control: an enabled submit inside a form that re-requests this url as a GET", () => {
    const nodes = flattenElements(AppError());
    const forms = nodes.filter((node) => node.type === "form");

    expect(forms).toHaveLength(1);
    expect(nodes.filter((node) => node.type === "button")).toHaveLength(1);
    expect(nodes.filter((node) => node.type === "a")).toHaveLength(0);

    // The default form semantics ARE the recovery: an absent `action` submits
    // to the current url, an absent `method` makes that a GET, so pressing
    // Reload retries the request that failed. Setting either — to anything,
    // including an equivalent spelling — changes how a scriptless browser
    // resubmits, and leaves every count above identical.
    expect(forms[0]?.props.action).toBeUndefined();
    expect(forms[0]?.props.method).toBeUndefined();

    // And the control has to be inside that form and pressable. A submit moved
    // out of the form, or shipped `disabled`, is a dead end on the one page
    // that has to work when everything else is broken — also with the counts
    // unchanged. The document holds one button and the form subtree holds one,
    // so they are the same button; comparing the two walks by identity instead
    // would red on any component between them, which is not the contract.
    const submits = flattenElements(forms[0]).filter(
      (node) => node.type === "button"
    );

    expect(submits).toHaveLength(1);
    expect(submits[0]?.props.type).toBe("submit");
    expect(submits[0]?.props.disabled).toBeFalsy();
  });

  it("attaches no event handler anywhere in that document", () => {
    expect(eventHandlerPropsIn(AppError())).toEqual([]);
  });

  it("finds handlers when a document has them", () => {
    // The control for the case above. `flattenElements` walking into nothing,
    // or a props shape it does not recognise, would report an empty handler
    // list for a document full of them and read as green.
    const withHandler = {
      type: "div",
      props: {
        children: { type: "button", props: { onClick: () => undefined } },
      },
    };

    expect(eventHandlerPropsIn(withHandler)).toEqual(["onClick"]);
  });

  it("finds a handler a component hides one level down", () => {
    // The shape a leaf-stopping walker misses, and the one Next would produce
    // by replacing the inline submit with a component of its own: the tree
    // exposes only the component element, and the handler is in its output.
    const Reload = () => ({
      type: "button",
      props: { onClick: () => undefined },
    });
    const withComponent = {
      type: "div",
      props: { children: { type: Reload, props: {} } },
    };

    expect(eventHandlerPropsIn(withComponent)).toEqual(["onClick"]);
  });

  it("refuses an element it cannot walk rather than calling it a leaf", () => {
    // A `memo`, `forwardRef`, lazy, or Fragment element is an object or symbol
    // type this walker cannot open. Treating one as a safe leaf is how the
    // handler assertion above would go green over a document it never read.
    expect(() =>
      flattenElements({ type: Symbol.for("react.memo"), props: {} })
    ).toThrow("cannot walk element type");
  });
});

/** Every `on[A-Z]` prop anywhere in `node`'s tree. */
function eventHandlerPropsIn(node: unknown): string[] {
  return flattenElements(node).flatMap((element) =>
    Object.keys(element.props).filter((prop) =>
      JSX_EVENT_HANDLER_PROP.test(prop)
    )
  );
}

/**
 * Every React element in `node`'s tree, depth-first, the root included.
 *
 * A function component is invoked and its OUTPUT walked, not its `children`
 * prop: children it never renders are not in the document, and a handler Next
 * adds inside a component it swaps the inline submit for is exactly one level
 * down. Anything else non-host cannot be opened here, so it throws — an
 * element this file cannot read is the last thing it should call safe.
 */
function flattenElements(node: unknown): ElementNode[] {
  if (Array.isArray(node)) {
    return node.flatMap((child) => flattenElements(child));
  }
  if (!isElementNode(node)) {
    return [];
  }
  if (isFunctionComponent(node.type)) {
    return [node, ...flattenElements(node.type(node.props))];
  }
  if (typeof node.type !== "string") {
    throw new Error(
      `cannot walk element type ${String(node.type)} in the static 500 document`
    );
  }
  return [node, ...flattenElements(node.props.children)];
}

function isElementNode(value: unknown): value is ElementNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "props" in value &&
    typeof (value as ElementNode).props === "object" &&
    (value as ElementNode).props !== null
  );
}

function isFunctionComponent(value: unknown): value is FunctionComponent {
  return typeof value === "function";
}
