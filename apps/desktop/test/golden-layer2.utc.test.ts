/**
 * FEA-2647 Layer 2 golden tests under TZ=UTC.
 *
 * The same suite runs under America/Chicago (golden-layer2.chicago.test.ts);
 * both must be green AND deep-equal the SAME frozen per-store snapshots —
 * the NormalizedSession → SQLite write path must be timezone-independent
 * (the UTC-drawn-as-local bug class, at the storage layer).
 *
 * Snapshot regeneration (GOLDEN_L2_WRITE_SNAPSHOTS=1) is permitted from THIS
 * suite only — see golden-layer2.ts.
 */
import "./golden/set-tz-utc.js";
import { registerGoldenLayer2Suite } from "./golden/golden-layer2.js";

registerGoldenLayer2Suite();
