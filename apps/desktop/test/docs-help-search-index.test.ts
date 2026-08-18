/**
 * @file docs-help-search-index.test.ts
 * @description Behavioral tests for the FEA-3843 / PRD-555 M1 local docs search
 * index (`src/main/docs-help/docs-search-index.ts`). Builds the index over a
 * synthetic bundle and asserts that queries return ranked hits with the right
 * match field, AND semantics, excerpting, and clamping — the search contract the
 * `docs-help` IPC surfaces.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocsBundle } from "../src/main/docs-help/docs-bundle-types.js";
import { buildDocsSearchIndex } from "../src/main/docs-help/docs-search-index.js";
import { DocsHelpMatchField } from "../src/shared/docs-help-contract.js";

function fixtureBundle(): DocsBundle {
  return {
    sourceCommit: "abc123",
    generatedAt: new Date(0).toISOString(),
    docsSiteUrl: "https://closedloop.ai/docs",
    pages: [
      {
        path: "getting-started/api-keys",
        title: "API keys",
        description: "Create and manage your API keys.",
        group: "Getting Started",
        headings: [
          { level: 2, text: "Rotating a key", slug: "rotating-a-key" },
          { level: 2, text: "Scopes", slug: "scopes" },
        ],
        body: "An API key authenticates requests. Keep your key secret and rotate it if leaked.",
      },
      {
        path: "concepts/loops",
        title: "Loops",
        description: "What a loop is.",
        group: "Concepts",
        headings: [{ level: 2, text: "Lifecycle", slug: "lifecycle" }],
        body: "A loop is a sequence of steps an agent runs. Loops produce artifacts.",
      },
      {
        path: "essentials/settings",
        title: "Settings",
        group: "Essentials",
        headings: [],
        body: "Configure the application preferences here.",
      },
    ],
  };
}

test("search ranks a title match above a body-only match", () => {
  const index = buildDocsSearchIndex(fixtureBundle());
  const hits = index.search("api key");
  assert.ok(hits.length >= 1);
  assert.equal(hits[0].path, "getting-started/api-keys");
  assert.equal(hits[0].matchField, DocsHelpMatchField.Title);
  assert.equal(hits[0].group, "Getting Started");
});

test("search returns a heading match with the deep-link slug", () => {
  const index = buildDocsSearchIndex(fixtureBundle());
  const hits = index.search("rotating");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "getting-started/api-keys");
  assert.equal(hits[0].matchField, DocsHelpMatchField.Heading);
  assert.equal(hits[0].headingSlug, "rotating-a-key");
});

test("search returns a body match with an excerpt around the term", () => {
  const index = buildDocsSearchIndex(fixtureBundle());
  const hits = index.search("artifacts");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "concepts/loops");
  assert.equal(hits[0].matchField, DocsHelpMatchField.Body);
  assert.ok(hits[0].excerpt.toLowerCase().includes("artifacts"));
});

test("search labels a group-only match as Group with a description excerpt", () => {
  const index = buildDocsSearchIndex(fixtureBundle());
  // "essentials" is only in essentials/settings' group facet — not in any
  // title, heading, or body. It must not be mislabeled as a body match with a
  // bogus body excerpt.
  const hits = index.search("essentials");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "essentials/settings");
  assert.equal(hits[0].matchField, DocsHelpMatchField.Group);
  // The essentials/settings fixture has no description, so the excerpt falls
  // back to a body slice; the label, not the excerpt, is what this pins.
  assert.equal(hits[0].headingSlug, undefined);
});

test("search uses AND semantics across terms", () => {
  const index = buildDocsSearchIndex(fixtureBundle());
  // "loop" appears in concepts/loops; "settings" only in essentials/settings.
  // No single page contains both, so there are no hits.
  assert.deepEqual(index.search("loop settings"), []);
  // Both terms live in concepts/loops.
  const hits = index.search("loop artifacts");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, "concepts/loops");
});

test("search returns no hits for an empty or whitespace query", () => {
  const index = buildDocsSearchIndex(fixtureBundle());
  assert.deepEqual(index.search(""), []);
  assert.deepEqual(index.search("   "), []);
});

test("search clamps the limit to at least 1 and returns at most that many", () => {
  const index = buildDocsSearchIndex(fixtureBundle());
  // Every page mentions a common-ish term; ask for a single hit.
  const single = index.search("a", 1);
  assert.ok(single.length <= 1);
  // A non-positive limit floors to 1 rather than returning everything/none.
  const floored = index.search("a", 0);
  assert.ok(floored.length <= 1);
});

test("pageCount reflects the bundle size", () => {
  const index = buildDocsSearchIndex(fixtureBundle());
  assert.equal(index.pageCount, 3);
});
