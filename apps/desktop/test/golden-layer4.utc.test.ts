/**
 * FEA-2650 Layer 4 golden tests under TZ=UTC.
 *
 * The same suite runs under America/Chicago (golden-layer4.chicago.test.ts);
 * the edge-expectation literals differ per TZ (the written-down semantic).
 *
 * Fixture regeneration (GOLDEN_L4_WRITE_SNAPSHOTS=1) is permitted from THIS
 * suite only — see golden-layer4.ts.
 */
import "./golden/set-tz-utc.js";
import { registerGoldenLayer4Suite } from "./golden/golden-layer4.js";

registerGoldenLayer4Suite({
  tz: "UTC",
  edgeExpectations: {
    tz: "UTC",
    // 2026-06-21T03:00:00Z → UTC day '2026-06-21' hour 3
    crossMidnight: { day: "2026-06-21", hour: 3, agent: 1, human: 0 },
    // 2026-03-08T07:30:00Z → UTC day '2026-03-08' hour 7
    // 2026-03-08T08:30:00Z → UTC day '2026-03-08' hour 8
    dstSpring: [
      { day: "2026-03-08", hour: 7, agent: 1, human: 0 },
      { day: "2026-03-08", hour: 8, agent: 1, human: 0 },
    ],
    // 2026-11-01T06:30:00Z → UTC day '2026-11-01' hour 6
    // 2026-11-01T07:30:00Z → UTC day '2026-11-01' hour 7
    dstFall: [
      { day: "2026-11-01", hour: 6, agent: 1, human: 0 },
      { day: "2026-11-01", hour: 7, agent: 1, human: 0 },
    ],
    autonomy: {
      agentOnlyDay: "2026-06-18",
      agentOnlyValue: 100,
      humanOnlyDay: "2026-06-17",
      humanOnlyValue: 0,
      mixedDay: "2026-06-19",
      mixedValue: 75,
      noActivityDay: "2026-06-16",
      noActivityValue: null,
    },
    // Complete nonzero cell maps per window under UTC
    springWindowCells: [
      // dstSpring session only
      { day: "2026-03-08", hour: 7, agent: 1, human: 0 },
      { day: "2026-03-08", hour: 8, agent: 1, human: 0 },
    ],
    juneWindowCells: [
      // autonomyHuman: 3 human turns at 09/10/11 UTC on 2026-06-17
      { day: "2026-06-17", hour: 9, agent: 0, human: 1 },
      { day: "2026-06-17", hour: 10, agent: 0, human: 1 },
      { day: "2026-06-17", hour: 11, agent: 0, human: 1 },
      // autonomyAgent: 3 assistant turns at 09/10/11 UTC on 2026-06-18
      { day: "2026-06-18", hour: 9, agent: 1, human: 0 },
      { day: "2026-06-18", hour: 10, agent: 1, human: 0 },
      { day: "2026-06-18", hour: 11, agent: 1, human: 0 },
      // autonomyMixed: 1 human at 09, 3 assistant at 10/11/12 UTC on 2026-06-19
      { day: "2026-06-19", hour: 9, agent: 0, human: 1 },
      { day: "2026-06-19", hour: 10, agent: 1, human: 0 },
      { day: "2026-06-19", hour: 11, agent: 1, human: 0 },
      { day: "2026-06-19", hour: 12, agent: 1, human: 0 },
      // crossMidnight: human at 10 UTC on 06-20, assistant at 03 UTC on 06-21
      { day: "2026-06-20", hour: 10, agent: 0, human: 1 },
      { day: "2026-06-21", hour: 3, agent: 1, human: 0 },
    ],
    fallWindowCells: [
      // dstFall session only
      { day: "2026-11-01", hour: 6, agent: 1, human: 0 },
      { day: "2026-11-01", hour: 7, agent: 1, human: 0 },
    ],
  },
});
