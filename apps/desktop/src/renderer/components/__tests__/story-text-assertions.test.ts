// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  assertButtonPresent,
  assertTextAbsent,
  waitForText,
} from "../story-text-assertions";

function makeRoot(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el;
}

describe("waitForText", () => {
  it("resolves immediately when the text is already present", async () => {
    const root = makeRoot("<p>hello world</p>");
    await waitForText(root, "hello");
  });

  it("resolves after the text appears asynchronously", async () => {
    vi.useFakeTimers();
    const root = makeRoot("<p>loading</p>");

    const task = waitForText(root, "ready");
    await vi.advanceTimersByTimeAsync(50);
    root.innerHTML = "<p>ready</p>";
    await vi.advanceTimersByTimeAsync(50);
    await task;

    vi.useRealTimers();
  });

  it("throws when the text never appears", async () => {
    vi.useFakeTimers();
    const root = makeRoot("<p>nothing here</p>");

    const task = waitForText(root, "missing").catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await task;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('"missing" never appeared');

    vi.useRealTimers();
  });
});

describe("assertTextAbsent", () => {
  it("passes when the text is not rendered", () => {
    const root = makeRoot("<p>hello</p>");
    assertTextAbsent(root, "goodbye");
  });

  it("throws when the text is rendered", () => {
    const root = makeRoot("<p>secret</p>");
    expect(() => assertTextAbsent(root, "secret")).toThrow(
      '"secret" must not appear'
    );
  });
});

describe("assertButtonPresent", () => {
  it("passes when a matching button exists", () => {
    const root = makeRoot("<button>Save</button><button>Cancel</button>");
    assertButtonPresent(root, "Save");
  });

  it("throws when no matching button exists", () => {
    const root = makeRoot("<button>Save</button>");
    expect(() => assertButtonPresent(root, "Delete")).toThrow(
      'No button labelled "Delete"'
    );
  });
});
