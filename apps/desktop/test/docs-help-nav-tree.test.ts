/**
 * @file docs-help-nav-tree.test.ts
 * @description Behavioral tests for the FEA-3844 / PRD-555 M2 Help-view nav tree:
 * the pure `buildDocsNavTree` grouper (`src/main/docs-help/docs-nav-tree.ts`) and
 * the `nav()` service op + IPC handler it powers. Proves the `mint.json` group +
 * page order is preserved, ungrouped pages fall under the trailing "More" bucket,
 * the empty bundle yields an empty tree, and the handler rejects untrusted
 * senders — invoking the real registrations, not source-text scans.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDocsHelpService,
  type DocsHelpService,
} from "../src/main/docs-help/docs-bundle.js";
import type { DocsBundle } from "../src/main/docs-help/docs-bundle-types.js";
import {
  buildDocsNavTree,
  UNGROUPED_NAV_LABEL,
} from "../src/main/docs-help/docs-nav-tree.js";
import { registerDocsHelpIpcHandlers } from "../src/main/ipc/docs-help-ipc.js";
import {
  DocsHelpIpcChannel,
  type DocsHelpNavResult,
} from "../src/shared/docs-help-contract.js";

type Handler = (event: unknown, ...args: unknown[]) => unknown;

function fixtureBundle(): DocsBundle {
  return {
    sourceCommit: "deadbeef",
    generatedAt: new Date(0).toISOString(),
    docsSiteUrl: "https://closedloop.ai/docs",
    pages: [
      {
        path: "getting-started/overview",
        title: "Getting Started",
        group: "Getting Started",
        headings: [],
        body: "Intro.",
      },
      {
        path: "getting-started/api-keys",
        title: "API keys",
        group: "Getting Started",
        headings: [],
        body: "Keys.",
      },
      {
        path: "concepts/loops",
        title: "Loops",
        group: "Concepts",
        headings: [],
        body: "Loops.",
      },
      // An un-navigated page (no `group`) — must fall under the trailing bucket.
      {
        path: "changelog",
        title: "Changelog",
        headings: [],
        body: "Changes.",
      },
    ],
  };
}

test("buildDocsNavTree preserves mint.json group and page order", () => {
  const tree = buildDocsNavTree(fixtureBundle().pages);
  assert.deepEqual(
    tree.map((group) => group.group),
    ["Getting Started", "Concepts", UNGROUPED_NAV_LABEL]
  );
  assert.deepEqual(
    tree[0].pages.map((page) => page.path),
    ["getting-started/overview", "getting-started/api-keys"]
  );
});

test("buildDocsNavTree buckets ungrouped pages under the trailing group", () => {
  const tree = buildDocsNavTree(fixtureBundle().pages);
  const last = tree.at(-1);
  assert.equal(last?.group, UNGROUPED_NAV_LABEL);
  assert.deepEqual(
    last?.pages.map((page) => page.path),
    ["changelog"]
  );
});

test("buildDocsNavTree keeps the More bucket last even when an ungrouped page comes first", () => {
  const tree = buildDocsNavTree([
    { path: "root", title: "Root" },
    { path: "guide/intro", title: "Intro", group: "Guide" },
  ]);
  assert.deepEqual(
    tree.map((group) => group.group),
    ["Guide", UNGROUPED_NAV_LABEL]
  );
});

test("nav() service op returns the grouped tree", () => {
  const service: DocsHelpService = createDocsHelpService(fixtureBundle());
  const result = service.nav();
  assert.equal(result.groups.length, 3);
  assert.equal(result.groups[0].group, "Getting Started");
});

test("nav() over an empty bundle returns an empty tree", () => {
  const empty: DocsBundle = {
    sourceCommit: "",
    generatedAt: new Date(0).toISOString(),
    docsSiteUrl: "https://closedloop.ai/docs",
    pages: [],
  };
  const service = createDocsHelpService(empty);
  assert.deepEqual(service.nav().groups, []);
});

test("the nav IPC handler returns the tree for a trusted sender", () => {
  const service = createDocsHelpService(fixtureBundle());
  const handlers = new Map<string, Handler>();
  registerDocsHelpIpcHandlers(
    { handle: (channel, listener) => handlers.set(channel, listener) },
    { isTrustedSender: () => true, docsHelp: service }
  );
  const result = handlers.get(DocsHelpIpcChannel.Nav)?.({
    sender: { id: 1 },
  }) as DocsHelpNavResult;
  assert.equal(result.groups.length, 3);
  assert.deepEqual(
    result.groups.map((group) => group.group),
    ["Getting Started", "Concepts", UNGROUPED_NAV_LABEL]
  );
});
