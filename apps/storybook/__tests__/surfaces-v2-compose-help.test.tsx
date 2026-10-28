import { DocsHelpMatchField } from "@repo/app/help/lib/docs-help-payload";
import {
  DOCS_HELP_NAV_PATH,
  DOCS_HELP_PAGE_PATH,
  DOCS_HELP_SEARCH_PATH,
  DocsCorpusFailureReason,
} from "@repo/app/help/lib/web-help-contract";
import { render } from "@testing-library/react";
import { createElement, isValidElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromSource, planned } from "../stories/surfaces-v2/compose";
import {
  type DocsHelpCorpus,
  DocsHelpFetch,
  docsNavFixture,
  docsSearchHitsFixture,
} from "../stories/surfaces-v2/fixtures/help-fixtures";

const STILL_PENDING = "still-pending";
const ORIGIN = "http://localhost";
const KNOWN_PAGE_PATH = "getting-started/index";

describe("fromSource", () => {
  it("wraps a single decorator in an array and keeps meta decorators after story ones", () => {
    const storyDecorator = vi.fn();
    const metaDecorator = vi.fn();
    const result = fromSource(
      { decorators: [metaDecorator] },
      { decorators: storyDecorator }
    );
    expect(result.decorators).toEqual([storyDecorator, metaDecorator]);
  });

  it("yields empty lists when neither side declares decorators, loaders or beforeEach", () => {
    const result = fromSource({}, {});
    expect(result.decorators).toEqual([]);
    expect(result.loaders).toEqual([]);
    expect(result.beforeEach).toEqual([]);
  });

  it("orders meta loaders and beforeEach before the story's", () => {
    const metaLoader = vi.fn();
    const storyLoader = vi.fn();
    const metaBefore = vi.fn();
    const storyBefore = vi.fn();
    const result = fromSource(
      { beforeEach: metaBefore, loaders: [metaLoader] },
      { beforeEach: [storyBefore], loaders: storyLoader }
    );
    expect(result.loaders).toEqual([metaLoader, storyLoader]);
    expect(result.beforeEach).toEqual([metaBefore, storyBefore]);
  });

  it("drops the source name and legacy story field and merges args with the story winning", () => {
    const result = fromSource(
      { args: { a: 1, b: 1 } },
      { args: { b: 2 }, name: "Old Name", story: { name: "legacy" } }
    );
    expect(result.args).toEqual({ a: 1, b: 2 });
    expect(result).not.toHaveProperty("name");
    expect(result).not.toHaveProperty("story");
  });

  it("merges parameters when both sides have them and tolerates either being absent", () => {
    const both = fromSource(
      { parameters: { layout: "centered" } },
      { parameters: { backgrounds: { disable: true } } }
    );
    expect(both.parameters).toMatchObject({
      backgrounds: { disable: true },
      layout: "centered",
    });
    expect(
      fromSource({}, { parameters: { layout: "padded" } }).parameters
    ).toMatchObject({ layout: "padded" });
    expect(
      fromSource({ parameters: { layout: "padded" } }, {}).parameters
    ).toMatchObject({ layout: "padded" });
  });

  it("prefers the story render over the meta render", () => {
    const storyRender = vi.fn();
    const metaRender = vi.fn();
    expect(
      fromSource({ render: metaRender }, { render: storyRender }).render
    ).toBe(storyRender);
  });

  it("falls back to the meta render when the story has none", () => {
    const metaRender = vi.fn();
    expect(fromSource({ render: metaRender }, {}).render).toBe(metaRender);
  });

  it("renders the meta component with the merged args when neither side has a render", () => {
    const Component = (props: { label?: string }) =>
      createElement("span", null, props.label);
    const result = fromSource(
      { args: { label: "meta" }, component: Component },
      { args: { label: "story" } }
    );
    const { render: renderStory } = result;
    expect(typeof renderStory).toBe("function");
    expect(result.args).toEqual({ label: "story" });
    const element = (renderStory as (args: object | undefined) => unknown)(
      result.args
    );
    expect(isValidElement(element)).toBe(true);
    expect((element as { type: unknown }).type).toBe(Component);
    expect((element as { props: unknown }).props).toEqual({ label: "story" });
  });

  it("leaves render unset when no source supplies one or a component", () => {
    expect(fromSource({}, {})).not.toHaveProperty("render");
  });
});

describe("planned", () => {
  it("renders the planned page with its type, title and note and disables controls", () => {
    const story = planned({
      note: "Waiting on design.",
      page: "Billing",
      pageType: "Settings",
      state: "Empty",
    });
    expect(story.parameters).toEqual({ controls: { disable: true } });
    const renderPlanned = story.render as () => React.ReactElement;
    const { container } = render(renderPlanned());
    expect(container.querySelector("h1")?.textContent).toBe("Billing · Empty");
    expect(container.textContent).toContain("Settings");
    expect(container.textContent).toContain(
      "Planned. No story renders this yet."
    );
    expect(container.textContent).toContain("Waiting on design.");
  });
});

describe("DocsHelpFetch", () => {
  const realFetch = vi.fn();
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    realFetch.mockReset();
    realFetch.mockResolvedValue(new Response("passthrough"));
    globalThis.fetch = realFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mountWith(corpus: DocsHelpCorpus) {
    return render(
      <DocsHelpFetch corpus={corpus}>
        <p>child</p>
      </DocsHelpFetch>
    );
  }

  async function get(path: string): Promise<Response> {
    return await globalThis.fetch(`${ORIGIN}${path}`);
  }

  async function settles(promise: Promise<Response>) {
    return await Promise.race([promise, Promise.resolve(STILL_PENDING)]);
  }

  it("serves the nav groups when the corpus is ok", async () => {
    mountWith({ nav: "ok" });
    const response = await get(DOCS_HELP_NAV_PATH);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ navGroups: docsNavFixture });
  });

  it("never settles the nav read when pending", async () => {
    mountWith({ nav: "pending" });
    expect(await settles(get(DOCS_HELP_NAV_PATH))).toBe(STILL_PENDING);
  });

  it("answers 503 with the not-deployed reason", async () => {
    mountWith({ nav: "not-deployed" });
    const response = await get(DOCS_HELP_NAV_PATH);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      reason: DocsCorpusFailureReason.NotDeployed,
    });
  });

  it("answers 500 with the read-failed reason for any other nav state", async () => {
    mountWith({ nav: "failed" });
    const response = await get(DOCS_HELP_NAV_PATH);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      reason: DocsCorpusFailureReason.ReadFailed,
    });
  });

  it("serves a known page by default and 404s an unknown or missing path", async () => {
    mountWith({ nav: "ok" });
    const known = await get(`${DOCS_HELP_PAGE_PATH}?path=${KNOWN_PAGE_PATH}`);
    expect(known.status).toBe(200);
    expect(((await known.json()) as { page: { path: string } }).page.path).toBe(
      KNOWN_PAGE_PATH
    );
    expect((await get(`${DOCS_HELP_PAGE_PATH}?path=nope`)).status).toBe(404);
    // No path param at all looks up the empty key.
    expect((await get(DOCS_HELP_PAGE_PATH)).status).toBe(404);
  });

  it("never settles a pending page read", async () => {
    mountWith({ nav: "ok", page: "pending" });
    expect(
      await settles(get(`${DOCS_HELP_PAGE_PATH}?path=${KNOWN_PAGE_PATH}`))
    ).toBe(STILL_PENDING);
  });

  it("answers a failed page read with 500", async () => {
    mountWith({ nav: "ok", page: "failed" });
    expect(
      (await get(`${DOCS_HELP_PAGE_PATH}?path=${KNOWN_PAGE_PATH}`)).status
    ).toBe(500);
  });

  it("answers a missing page read with 404 even for a known path", async () => {
    mountWith({ nav: "ok", page: "missing" });
    expect(
      (await get(`${DOCS_HELP_PAGE_PATH}?path=${KNOWN_PAGE_PATH}`)).status
    ).toBe(404);
  });

  it("serves the default search hits, custom hits, pending and failed", async () => {
    const { unmount } = mountWith({ nav: "ok" });
    expect(await (await get(DOCS_HELP_SEARCH_PATH)).json()).toEqual({
      hits: docsSearchHitsFixture,
    });
    unmount();

    const custom = [
      {
        excerpt: "x",
        group: "g",
        matchField: DocsHelpMatchField.Body,
        path: "p",
        score: 1,
        title: "t",
      },
    ];
    const second = mountWith({ nav: "ok", search: custom });
    expect(await (await get(DOCS_HELP_SEARCH_PATH)).json()).toEqual({
      hits: custom,
    });
    second.unmount();

    const third = mountWith({ nav: "ok", search: "pending" });
    expect(await settles(get(DOCS_HELP_SEARCH_PATH))).toBe(STILL_PENDING);
    third.unmount();

    mountWith({ nav: "ok", search: "failed" });
    expect((await get(DOCS_HELP_SEARCH_PATH)).status).toBe(500);
  });

  it("hands unrelated requests, including URL and Request inputs, to the real fetch", async () => {
    mountWith({ nav: "ok" });
    await globalThis.fetch(new URL(`${ORIGIN}/api/other`));
    await globalThis.fetch(new Request(`${ORIGIN}/api/another`));
    expect(realFetch).toHaveBeenCalledTimes(2);
  });

  it("answers docs paths given as a Request", async () => {
    mountWith({ nav: "ok" });
    const response = await globalThis.fetch(
      new Request(`${ORIGIN}${DOCS_HELP_NAV_PATH}`)
    );
    expect(response.status).toBe(200);
    expect(realFetch).not.toHaveBeenCalled();
  });

  it("answers docs paths given as a URL", async () => {
    mountWith({ nav: "ok" });
    const response = await globalThis.fetch(
      new URL(`${ORIGIN}${DOCS_HELP_NAV_PATH}`)
    );
    expect(response.status).toBe(200);
    expect(realFetch).not.toHaveBeenCalled();
  });

  it("restores the previous fetch on unmount", () => {
    const { unmount } = mountWith({ nav: "ok" });
    expect(globalThis.fetch).not.toBe(realFetch);
    unmount();
    expect(globalThis.fetch).toBe(realFetch);
  });
});
