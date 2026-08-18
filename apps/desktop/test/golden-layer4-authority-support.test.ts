import assert from "node:assert/strict";
import test from "node:test";
import { InsightsTileAvailabilityState } from "@closedloop-ai/loops-api/insights";
import { assertRegisteredAuthorityDivergence } from "./golden/golden-layer4-authority-support.js";

const AVAILABILITY_KEY =
  "render.delivery.tileAvailability.chart:branchesWithoutPr";
const STOPPED_DIVERGING_RE = /stopped diverging/;
const THIRD_VALUE_RE = /third value/;

test("authority divergence pins the current fail-closed value", () => {
  assert.equal(
    assertRegisteredAuthorityDivergence(
      AVAILABILITY_KEY,
      InsightsTileAvailabilityState.Unavailable,
      InsightsTileAvailabilityState.Available
    ),
    `golden-l4-corpus ${AVAILABILITY_KEY}`
  );
});

test("authority divergence rejects both resolution and third-value drift", () => {
  assert.throws(
    () =>
      assertRegisteredAuthorityDivergence(
        AVAILABILITY_KEY,
        InsightsTileAvailabilityState.Available,
        InsightsTileAvailabilityState.Available
      ),
    STOPPED_DIVERGING_RE
  );
  assert.throws(
    () =>
      assertRegisteredAuthorityDivergence(
        AVAILABILITY_KEY,
        "loading",
        InsightsTileAvailabilityState.Available
      ),
    THIRD_VALUE_RE
  );
});
