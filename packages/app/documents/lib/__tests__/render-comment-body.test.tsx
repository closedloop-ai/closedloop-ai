import { render } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { renderCommentBody } from "../render-comment-body";

const NAMES = ["Marcus Lee", "Marcus"];

function renderBodyToContainer(body: string, names: readonly string[]) {
  const { container } = render(<p>{renderCommentBody(body, names)}</p>);
  return container;
}

describe("renderCommentBody", () => {
  test("returns plain text when there are no member names", () => {
    const container = renderBodyToContainer("Ping @Marcus Lee please", []);
    expect(container.textContent).toBe("Ping @Marcus Lee please");
    expect(container.querySelector("span")).toBeNull();
  });

  test("chips an @mention that matches a known member name", () => {
    const container = renderBodyToContainer("Ping @Marcus Lee please", NAMES);
    const chip = container.querySelector("span");
    expect(chip?.textContent).toBe("@Marcus Lee");
  });

  test("prefers the longest matching name so a full name is one chip", () => {
    // "@Marcus" is also a member; longest-first must chip "@Marcus Lee" whole.
    const container = renderBodyToContainer("cc @Marcus Lee", NAMES);
    const chips = container.querySelectorAll("span");
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe("@Marcus Lee");
  });

  test("does not chip an @token that is not a known member", () => {
    const container = renderBodyToContainer("see @nobody here", NAMES);
    expect(container.querySelector("span")).toBeNull();
    expect(container.textContent).toBe("see @nobody here");
  });

  test("does not chip a member name embedded mid-token (left boundary)", () => {
    // "x@Ada.com" contains "@Ada" but the "@" is not at a whitespace/edge
    // boundary, so it must stay plain text when "Ada" is a member.
    const container = renderBodyToContainer("mail x@Ada.com now", ["Ada"]);
    expect(container.querySelector("span")).toBeNull();
    expect(container.textContent).toBe("mail x@Ada.com now");
  });

  test("does not chip a longer word that starts with a member name (right boundary)", () => {
    // "@Adaline" starts with "@Ada" but is not closed by a whitespace/edge
    // boundary, so it must not chip when "Ada" is a member.
    const container = renderBodyToContainer("hi @Adaline there", ["Ada"]);
    expect(container.querySelector("span")).toBeNull();
    expect(container.textContent).toBe("hi @Adaline there");
  });

  test("chips a member mention at the end of the body", () => {
    const container = renderBodyToContainer("cc @Ada", ["Ada"]);
    expect(container.querySelector("span")?.textContent).toBe("@Ada");
  });
});
