import { afterEach, describe, expect, it } from "vitest";
import {
  APP_UNDO_IGNORE_ATTRIBUTE,
  isEditableEventTarget,
} from "../editable-event-target";

/**
 * ISS-9092 AC2 — the refusal that keeps app undo out of anything the user is
 * typing in.
 *
 * This is the defect the ticket names as most likely to ship: stealing Cmd+Z
 * from a text field makes the app feel broken in the most visible way possible.
 * Every case here is therefore a POSITIVE (the guard refuses) except the last
 * block, which pins that the guard does not refuse everywhere — a predicate
 * that simply returned `true` would satisfy every other case in this file and
 * disable the whole feature.
 */

function mount(html: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("elements that own a native undo stack", () => {
  it("refuses inside a textarea", () => {
    const host = mount("<textarea></textarea>");
    expect(isEditableEventTarget(host.querySelector("textarea"))).toBe(true);
  });

  it("refuses inside a select", () => {
    const host = mount("<select><option>a</option></select>");
    expect(isEditableEventTarget(host.querySelector("select"))).toBe(true);
  });

  /*
   * An ALLOW-list of non-text types, so a type nobody anticipated is treated as
   * typable. `search`, `url`, `tel` and a bare `<input>` are every bit as
   * typable as `type="text"`, and a deny-list naming only the remembered ones
   * silently un-protects the rest.
   */
  it.each(["text", "search", "url", "tel", "email", "password", "number"])(
    "refuses inside input[type=%s]",
    (type) => {
      const host = mount(`<input type="${type}">`);
      expect(isEditableEventTarget(host.querySelector("input"))).toBe(true);
    }
  );

  it("refuses inside an input with no type at all", () => {
    const host = mount("<input>");
    expect(isEditableEventTarget(host.querySelector("input"))).toBe(true);
  });

  it("refuses inside an input whose type it has never heard of", () => {
    const host = mount('<input type="some-future-text-type">');
    expect(isEditableEventTarget(host.querySelector("input"))).toBe(true);
  });
});

describe("the contenteditable host the Yjs editor renders", () => {
  it("refuses on the editable host itself", () => {
    const host = mount('<div contenteditable="true"></div>');
    expect(isEditableEventTarget(host.querySelector("[contenteditable]"))).toBe(
      true
    );
  });

  /*
   * `closest`, not an identity check: the Yjs editor and several rich inputs put
   * focus on a DESCENDANT of the contenteditable host, so a check against the
   * target alone reports "not editable" for the exact surface this guard exists
   * to protect.
   */
  it("refuses on a descendant of the editable host", () => {
    const host = mount(
      '<div contenteditable="true"><p><span id="leaf">x</span></p></div>'
    );
    expect(isEditableEventTarget(host.querySelector("#leaf"))).toBe(true);
  });

  /*
   * The ancestor walk. A `contenteditable="false"` ISLAND reports
   * `isContentEditable === false`, but the editor around it still owns Cmd+Z —
   * so stopping at the nearest match would hand the chord to the app layer in
   * the middle of the document editor.
   */
  it("refuses inside a contenteditable=false island nested in an editable host", () => {
    const host = mount(
      '<div contenteditable="true"><div contenteditable="false" id="island">x</div></div>'
    );
    expect(isEditableEventTarget(host.querySelector("#island"))).toBe(true);
  });
});

describe("the declarative opt-out", () => {
  it("refuses inside a subtree marked with the opt-out attribute", () => {
    const host = mount(
      `<div ${APP_UNDO_IGNORE_ATTRIBUTE}><button id="b">x</button></div>`
    );
    expect(isEditableEventTarget(host.querySelector("#b"))).toBe(true);
  });
});

describe("what the guard must NOT refuse", () => {
  /*
   * Without these, a predicate hardcoded to `true` passes this whole file and
   * the shortcut never fires anywhere.
   */
  it("allows a plain button", () => {
    const host = mount('<button id="b">x</button>');
    expect(isEditableEventTarget(host.querySelector("#b"))).toBe(false);
  });

  it("allows a table cell", () => {
    const host = mount(
      '<table><tbody><tr><td id="c">x</td></tr></tbody></table>'
    );
    expect(isEditableEventTarget(host.querySelector("#c"))).toBe(false);
  });

  it.each(["checkbox", "radio", "button", "submit", "range", "color", "file"])(
    "allows input[type=%s], which accepts no free text",
    (type) => {
      const host = mount(`<input type="${type}">`);
      expect(isEditableEventTarget(host.querySelector("input"))).toBe(false);
    }
  );

  it("allows a standalone contenteditable=false region", () => {
    const host = mount('<div contenteditable="false" id="r">x</div>');
    expect(isEditableEventTarget(host.querySelector("#r"))).toBe(false);
  });

  it("allows a non-Element target", () => {
    expect(isEditableEventTarget(null)).toBe(false);
    expect(isEditableEventTarget(new EventTarget())).toBe(false);
  });
});
