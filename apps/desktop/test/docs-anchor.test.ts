/**
 * @file docs-anchor.test.ts
 * @description Behavioral tests for the FEA-3846 / PRD-555 M4 contextual
 * docs-anchor declarations (`src/renderer/navigation/docs-anchor.ts`). Proves the
 * flagship screens declare anchors, that `staticDocsAnchorFor` resolves them, and
 * — crucially — that every declared `page` maps to a REAL page in the Fumadocs
 * bundle (`apps/web/content/docs`, and every declared `heading` to a real `##`
 * heading on that page), so a "Help on this" link can never dangle at a
 * non-existent doc. The docs cross-check reads the source `.mdx` (declarative
 * data, not implementation source-text).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { slugifyHeading } from "../src/renderer/components/help/help-slug.js";
import {
  NAV_DOCS_ANCHORS,
  staticDocsAnchorFor,
} from "../src/renderer/navigation/docs-anchor.js";
import { NavId } from "../src/renderer/navigation/route-table.js";

const DESKTOP_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const DOCS_DIR = join(DESKTOP_DIR, "..", "web", "content", "docs");

const HEADING_LINE_RE = /^##\s+(.+?)\s*$/;

/** The `##` heading slugs present in a Fumadocs page's `.mdx` source. */
function headingSlugsForPage(page: string): string[] {
  const source = readFileSync(join(DOCS_DIR, `${page}.mdx`), "utf8");
  const slugs: string[] = [];
  for (const line of source.split("\n")) {
    const match = HEADING_LINE_RE.exec(line);
    if (match) {
      slugs.push(slugifyHeading(match[1]));
    }
  }
  return slugs;
}

/** Whether an `apps/web/content/docs` page (`.mdx`) exists for a bundle path. */
function pageExists(page: string): boolean {
  try {
    readFileSync(join(DOCS_DIR, `${page}.mdx`), "utf8");
    return true;
  } catch {
    return false;
  }
}

test("declares docs anchors for the screens with on-topic docs pages", () => {
  // Only screens whose docs page genuinely documents them get an anchor. Sessions
  // now has a dedicated `mechanisms/sessions` page (ISS-4587), so it deep-links
  // there; Branches has no dedicated page yet and stays omitted (see
  // NAV_DOCS_ANCHORS).
  for (const navId of [NavId.Settings, NavId.Diagnostics, NavId.Sessions]) {
    const anchor = staticDocsAnchorFor(navId);
    assert.ok(anchor, `expected a docs anchor for ${navId}`);
    assert.ok(anchor.page.length > 0, `anchor for ${navId} has a page`);
  }
});

test("returns null for a screen with no declared anchor", () => {
  // No dedicated docs page yet → no anchor, so the button self-hides rather than
  // deep-linking "Help on this screen" to a page that documents neither.
  assert.equal(staticDocsAnchorFor(NavId.Branches), null);
  // Approvals is not a flagship M4 screen — no anchor, so no affordance.
  assert.equal(staticDocsAnchorFor(NavId.Approvals), null);
});

test("every declared anchor page maps to a real docs page", () => {
  for (const [navId, anchor] of Object.entries(NAV_DOCS_ANCHORS)) {
    assert.ok(anchor, `${navId} anchor is defined`);
    assert.ok(
      pageExists(anchor.page),
      `docs page "${anchor.page}" (declared for ${navId}) must exist under apps/web/content/docs`
    );
  }
});

test("every declared anchor heading matches a real heading on its page", () => {
  for (const [navId, anchor] of Object.entries(NAV_DOCS_ANCHORS)) {
    if (!anchor?.heading) {
      continue;
    }
    const slugs = headingSlugsForPage(anchor.page);
    assert.ok(
      slugs.includes(anchor.heading),
      `heading "${anchor.heading}" (declared for ${navId}) must be a "##" heading on ${anchor.page}.mdx (found: ${slugs.join(", ")})`
    );
  }
});

test("all keys are valid NavIds", () => {
  const navIds = new Set<string>(Object.values(NavId));
  for (const key of Object.keys(NAV_DOCS_ANCHORS)) {
    assert.ok(navIds.has(key), `${key} is a NavId`);
  }
});

// Guard: the docs-mdx cross-check above only has teeth if the fixtures it reads
// actually exist. If someone moves apps/web/content/docs, this fails loudly
// instead of the cross-check silently passing on an empty directory.
test("Fumadocs fixture directory is present", () => {
  const entries = readdirSync(DOCS_DIR, { withFileTypes: true });
  const dirNames = new Set(
    entries.filter((e) => e.isDirectory()).map((e) => e.name)
  );
  for (const section of ["mechanisms", "resources"]) {
    assert.ok(
      dirNames.has(section),
      `expected apps/web/content/docs/${section} to exist`
    );
  }
});
