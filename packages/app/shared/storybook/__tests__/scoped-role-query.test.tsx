import { render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  getByRoleInOwnParent,
  queryByRoleInOwnParent,
} from "../scoped-role-query";

describe("getByRoleInOwnParent", () => {
  it("finds a button named by its aria-label", () => {
    const { container } = render(
      <div>
        <button aria-label="Filters" type="button" />
        <button type="button">Group</button>
      </div>
    );

    expect(getByRoleInOwnParent(container, "button", "Filters")).toBe(
      container.querySelector('[aria-label="Filters"]')
    );
  });

  it("finds a button named by its own text", () => {
    const { container } = render(
      <div>
        <button aria-label="Filters" type="button" />
        <button type="button">Group</button>
      </div>
    );

    expect(getByRoleInOwnParent(container, "button", "Group").textContent).toBe(
      "Group"
    );
  });

  it("throws when no element carries the name", () => {
    const { container } = render(<button type="button">Group</button>);

    expect(() => getByRoleInOwnParent(container, "button", "Sort")).toThrow();
  });

  it("throws when the name is not unique in the container", () => {
    const { container } = render(
      <div>
        <section>
          <button type="button">Group</button>
        </section>
        <section>
          <button type="button">Group</button>
        </section>
      </div>
    );

    expect(() => getByRoleInOwnParent(container, "button", "Group")).toThrow();
  });

  it("throws when the named element does not have the role", () => {
    const { container } = render(
      <div>
        <div aria-label="Filters" role="img" />
      </div>
    );

    expect(() =>
      getByRoleInOwnParent(container, "button", "Filters")
    ).toThrow();
  });

  it("throws when the named button is hidden from the accessibility tree", () => {
    const { container } = render(
      <div aria-hidden="true">
        <button aria-label="Filters" type="button" />
      </div>
    );

    expect(() =>
      getByRoleInOwnParent(container, "button", "Filters")
    ).toThrow();
  });
});

describe("queryByRoleInOwnParent", () => {
  it("returns the button when one carries the name", () => {
    const { container } = render(
      <div>
        <button aria-label="More actions" type="button" />
      </div>
    );

    expect(queryByRoleInOwnParent(container, "button", "More actions")).toBe(
      container.querySelector('[aria-label="More actions"]')
    );
  });

  it("returns null when nothing carries the name", () => {
    const { container } = render(
      <div>
        <button aria-label="Filters" type="button" />
      </div>
    );

    expect(
      queryByRoleInOwnParent(container, "button", "More actions")
    ).toBeNull();
  });

  it("returns null when the named element is not a button", () => {
    const { container } = render(
      <div>
        <div aria-label="More actions" role="img" />
      </div>
    );

    expect(
      queryByRoleInOwnParent(container, "button", "More actions")
    ).toBeNull();
  });

  it("finds a button named only by its title", () => {
    const { container } = render(
      <div>
        <button title="More actions" type="button" />
      </div>
    );

    expect(queryByRoleInOwnParent(container, "button", "More actions")).toBe(
      container.querySelector('[title="More actions"]')
    );
  });

  it("finds a button whose name is split across child elements", () => {
    const { container } = render(
      <div>
        <button type="button">
          More <span>actions</span>
        </button>
      </div>
    );

    expect(
      queryByRoleInOwnParent(container, "button", "More actions")
    ).not.toBeNull();
  });

  it("finds a button named by an element elsewhere in the tree", () => {
    const { container } = render(
      <div>
        <p id="more-actions-label">More actions</p>
        <section>
          <button aria-labelledby="more-actions-label" type="button" />
        </section>
      </div>
    );

    expect(
      queryByRoleInOwnParent(container, "button", "More actions")
    ).not.toBeNull();
  });

  it("throws on a duplicate like the container-wide query does", () => {
    const { container } = render(
      <div>
        <section>
          <button title="More actions" type="button" />
        </section>
        <section>
          <button aria-label="More actions" type="button" />
        </section>
      </div>
    );

    expect(() =>
      queryByRoleInOwnParent(container, "button", "More actions")
    ).toThrow();
  });

  it("finds a button whose name comes from an element it owns", () => {
    const { container } = render(
      <div>
        <button aria-owns="owned-label" type="button" />
        <span id="owned-label">More actions</span>
      </div>
    );

    expect(
      queryByRoleInOwnParent(container, "button", "More actions")
    ).not.toBeNull();
  });

  it("counts an input that takes its name from its type", () => {
    const { container } = render(
      <div>
        <section>
          <input type="submit" />
        </section>
        <section>
          <button type="button">Submit</button>
        </section>
      </div>
    );

    expect(() =>
      queryByRoleInOwnParent(container, "button", "Submit")
    ).toThrow();
  });

  it("finds a button whose name joins an embedded image's label and text", () => {
    const { container } = render(
      <div>
        <section>
          <button type="button">
            <span aria-label="Save" role="img" /> changes
          </button>
        </section>
        <section>
          <button type="button">Save changes</button>
        </section>
      </div>
    );

    expect(() =>
      queryByRoleInOwnParent(container, "button", "Save changes")
    ).toThrow();
  });

  it("matches a name split across elements without changing its case", () => {
    const { container } = render(
      <div>
        <button type="button">
          <span>Ο</span>
          <span>Σ</span>
        </button>
      </div>
    );

    expect(queryByRoleInOwnParent(container, "button", "ΟΣ")).not.toBeNull();
  });

  it("finds a button whose name comes from a label of a descendant", () => {
    const { container } = render(
      <div>
        <button type="button">
          <output id="saved-output" />
        </button>
        <label htmlFor="saved-output">Save</label>
      </div>
    );

    expect(queryByRoleInOwnParent(container, "button", "Save")).not.toBeNull();
  });

  it("finds a button whose name comes through a shadow-DOM slot", () => {
    const host = document.createElement("div");
    document.body.append(host);
    host.append("Alpha");
    const shadow = host.attachShadow({ mode: "open" });
    const button = document.createElement("button");
    button.append(document.createElement("slot"));
    shadow.append(button);
    const container = shadow as unknown as HTMLElement;

    try {
      const expected = within(container).queryByRole("button", {
        name: "Alpha",
      });
      expect(expected).not.toBeNull();
      expect(queryByRoleInOwnParent(container, "button", "Alpha")).toBe(
        expected
      );
    } finally {
      host.remove();
    }
  });

  it("finds a button labelled inside its own shadow root", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const label = document.createElement("label");
    label.htmlFor = "shadow-button";
    label.textContent = "Alpha";
    const button = document.createElement("button");
    button.id = "shadow-button";
    shadow.append(label, button);
    const container = shadow as unknown as HTMLElement;

    try {
      const expected = within(container).queryByRole("button", {
        name: "Alpha",
      });
      expect(expected).not.toBeNull();
      expect(queryByRoleInOwnParent(container, "button", "Alpha")).toBe(
        expected
      );
    } finally {
      host.remove();
    }
  });

  it("finds a button labelled inside a detached container", () => {
    const container = document.createElement("div");
    const label = document.createElement("label");
    label.htmlFor = "detached-button";
    label.textContent = "Alpha";
    const button = document.createElement("button");
    button.id = "detached-button";
    container.append(label, button);

    const expected = within(container).queryByRole("button", { name: "Alpha" });
    expect(expected).not.toBeNull();
    expect(queryByRoleInOwnParent(container, "button", "Alpha")).toBe(expected);
  });

  it("finds a labelled button inside an iframe document", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const frameDocument = frame.contentDocument;
    if (frameDocument === null) {
      throw new Error("jsdom gave the iframe no document");
    }
    const label = frameDocument.createElement("label");
    label.htmlFor = "frame-button";
    label.textContent = "Alpha";
    const button = frameDocument.createElement("button");
    button.id = "frame-button";
    button.setAttribute("title", "Beta");
    frameDocument.body.append(label, button);
    const container = frameDocument.body;

    try {
      const expected = within(container).queryByRole("button", {
        name: "Alpha",
      });
      expect(expected).not.toBeNull();
      expect(queryByRoleInOwnParent(container, "button", "Alpha")).toBe(
        expected
      );
    } finally {
      frame.remove();
    }
  });
});
