/**
 * FEA-2649 Layer 3 golden tests under TZ=UTC.
 *
 * The same suite runs under America/Chicago (golden-layer3.chicago.test.ts);
 * TZ-invariant aggregation facts must be green in both, and day/hour-bucketed
 * facts assert against their own tz_dependent section of
 * packages/golden-sessions/corpus-expectations.yaml.
 */
import "./golden/set-tz-utc.js";
import { registerGoldenLayer3Suite } from "./golden/golden-layer3.js";

registerGoldenLayer3Suite();
