/**
 * FEA-2647 Layer 2 golden tests under TZ=America/Chicago.
 *
 * The same suite runs under UTC (golden-layer2.utc.test.ts); both must be
 * green AND deep-equal the SAME frozen per-store snapshots — the
 * NormalizedSession → SQLite write path must be timezone-independent.
 *
 * GOLDEN_L2_WRITE_SNAPSHOTS is rejected here (UTC suite is the sole snapshot
 * writer — the two TZ files run as concurrent child processes).
 */
import "./golden/set-tz-chicago.js";
import { registerGoldenLayer2Suite } from "./golden/golden-layer2.js";

registerGoldenLayer2Suite();
