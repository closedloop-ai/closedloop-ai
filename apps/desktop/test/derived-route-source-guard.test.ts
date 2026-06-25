import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const RENDERER_ROOT = join(import.meta.dirname, "..", "src", "renderer");
const ROUTE_BODY_FILES = [
  join(RENDERER_ROOT, "App.tsx"),
  join(RENDERER_ROOT, "components", "features", "CoreFeaturesView.tsx"),
  join(
    RENDERER_ROOT,
    "components",
    "derived",
    "desktop-derived-telemetry-view.tsx"
  ),
];
const LEGACY_AGGREGATE_RENDERER_RE =
  /window\.desktopApi\.db\.(?:getWorkflowData|getTools|getSubAgents)|\bgetWorkflowData\b|\bgetTools\b|\bgetSubAgents\b/;
const FORBIDDEN_SHARED_ROUTE_EXPANSION_RE =
  /<iframe\b|from\s+["'][^"']*(?:liveblocks|document-editor|document-table|react-markdown|markdown)|closedloop-electron/;

test("derived telemetry route bodies do not call legacy aggregate DB methods", () => {
  const violations = ROUTE_BODY_FILES.filter((filePath) =>
    LEGACY_AGGREGATE_RENDERER_RE.test(readFileSync(filePath, "utf8"))
  );

  assert.deepEqual(violations, []);
});

test("derived telemetry routes do not add iframe, collaborative document, markdown, or deprecated repo expansion", () => {
  const violations = ROUTE_BODY_FILES.filter((filePath) =>
    FORBIDDEN_SHARED_ROUTE_EXPANSION_RE.test(readFileSync(filePath, "utf8"))
  );

  assert.deepEqual(violations, []);
});
