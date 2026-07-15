/**
 * FEA-2646 Layer 1 golden tests under TZ=America/Chicago.
 *
 * Paired with golden-layer1.utc.test.ts: both must be green AND produce
 * identical parse results — raw-transcript parsing must be timezone-independent
 * (the UTC-drawn-as-local bug class this whole effort exists to catch).
 */
import "./golden/set-tz-chicago.js";
import { registerGoldenLayer1Suite } from "./golden/golden-corpus.js";

registerGoldenLayer1Suite();
