/**
 * FEA-2649 Layer 3 golden tests under TZ=America/Chicago.
 *
 * Paired with golden-layer3.utc.test.ts — see that file. Local-day/hour
 * bucketed facts assert against the tz_dependent.chicago section of
 * packages/golden-sessions/corpus-expectations.yaml.
 */
import "./golden/set-tz-chicago.js";
import { registerGoldenLayer3Suite } from "./golden/golden-layer3.js";

registerGoldenLayer3Suite();
