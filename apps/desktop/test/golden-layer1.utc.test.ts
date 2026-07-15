/**
 * FEA-2646 Layer 1 golden tests under TZ=UTC.
 *
 * The same suite runs under America/Chicago (golden-layer1.chicago.test.ts);
 * both must be green AND produce identical parse results — raw-transcript
 * parsing must be timezone-independent (the UTC-drawn-as-local bug class).
 */
import "./golden/set-tz-utc.js";
import { registerGoldenLayer1Suite } from "./golden/golden-corpus.js";

registerGoldenLayer1Suite();
