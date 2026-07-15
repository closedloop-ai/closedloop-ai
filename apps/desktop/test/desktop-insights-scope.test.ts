import assert from "node:assert/strict";
import { test } from "node:test";
import { InsightsScope } from "@closedloop-ai/loops-api/insights";
import { coerceDesktopInsightsScope } from "../src/main/desktop-insights-scope.js";

test("desktop insights rejects team scope instead of returning local self data", () => {
  assert.equal(coerceDesktopInsightsScope(InsightsScope.Team), null);
});

test("desktop insights keeps legacy scope fallback for unknown values", () => {
  assert.equal(coerceDesktopInsightsScope("future-scope"), InsightsScope.Me);
});

test("desktop insights accepts cloud org scope", () => {
  assert.equal(
    coerceDesktopInsightsScope(InsightsScope.Org),
    InsightsScope.Org
  );
});
