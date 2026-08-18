/**
 * FEA-2650 Layer 4 golden tests under TZ=America/Chicago.
 *
 * The same suite runs under UTC (golden-layer4.utc.test.ts); the
 * edge-expectation literals differ per TZ (the written-down semantic).
 *
 * GOLDEN_L4_WRITE_SNAPSHOTS is rejected here (UTC suite is the sole fixture
 * writer — the two TZ files run as concurrent child processes).
 */
import "./golden/set-tz-chicago.js";
import { registerGoldenLayer4Suite } from "./golden/golden-layer4.js";

registerGoldenLayer4Suite({
  tz: "America/Chicago",
  edgeExpectations: {
    tz: "America/Chicago",
    // 2026-06-21T03:00:00Z → CDT (UTC-5) = June 20 22:00 → day '2026-06-20' hour 22
    crossMidnight: { day: "2026-06-20", hour: 22, agent: 1, human: 0 },
    // 2026-03-08T07:30:00Z → CST (UTC-6, pre-jump) = 01:30 → day '2026-03-08' hour 1
    // 2026-03-08T08:30:00Z → CDT (UTC-5, post-jump) = 03:30 → day '2026-03-08' hour 3
    // (hour 2 does not exist on spring-forward day)
    dstSpring: [
      { day: "2026-03-08", hour: 1, agent: 1, human: 0 },
      { day: "2026-03-08", hour: 3, agent: 1, human: 0 },
    ],
    // 2026-11-01T06:30:00Z → CDT (UTC-5, first pass) = 01:30 → hour 1
    // 2026-11-01T07:30:00Z → CST (UTC-6, second pass) = 01:30 → hour 1
    // Both UTC instants COLLAPSE into one local (day,hour) = ('2026-11-01', 1)
    // heatmap cell with agent=2 (double-counted local hour, the fall-back semantic).
    dstFall: [{ day: "2026-11-01", hour: 1, agent: 2, human: 0 }],
    autonomy: {
      // CDT offset (UTC-5) doesn't shift these mid-day instants to a different date
      agentOnlyDay: "2026-06-18",
      agentOnlyValue: 100,
      humanOnlyDay: "2026-06-17",
      humanOnlyValue: 0,
      mixedDay: "2026-06-19",
      mixedValue: 75,
      noActivityDay: "2026-06-16",
      noActivityValue: null,
    },
    // Complete nonzero cell maps per window under CDT/CST
    springWindowCells: [
      // dstSpring: 07:30Z = CST hour 1, 08:30Z = CDT hour 3
      { day: "2026-03-08", hour: 1, agent: 1, human: 0 },
      { day: "2026-03-08", hour: 3, agent: 1, human: 0 },
    ],
    juneWindowCells: [
      // autonomyHuman: 09/10/11 UTC → CDT 04/05/06 on 2026-06-17
      { day: "2026-06-17", hour: 4, agent: 0, human: 1 },
      { day: "2026-06-17", hour: 5, agent: 0, human: 1 },
      { day: "2026-06-17", hour: 6, agent: 0, human: 1 },
      // autonomyAgent: 09/10/11 UTC → CDT 04/05/06 on 2026-06-18
      { day: "2026-06-18", hour: 4, agent: 1, human: 0 },
      { day: "2026-06-18", hour: 5, agent: 1, human: 0 },
      { day: "2026-06-18", hour: 6, agent: 1, human: 0 },
      // autonomyMixed: 09/10/11/12 UTC → CDT 04/05/06/07 on 2026-06-19
      { day: "2026-06-19", hour: 4, agent: 0, human: 1 },
      { day: "2026-06-19", hour: 5, agent: 1, human: 0 },
      { day: "2026-06-19", hour: 6, agent: 1, human: 0 },
      { day: "2026-06-19", hour: 7, agent: 1, human: 0 },
      // crossMidnight: 10:00Z = CDT 05:00 on 06-20 (human), 03:00Z = CDT 22:00 on 06-20 (agent)
      { day: "2026-06-20", hour: 5, agent: 0, human: 1 },
      { day: "2026-06-20", hour: 22, agent: 1, human: 0 },
    ],
    fallWindowCells: [
      // dstFall: both instants collapse to hour 1 on 2026-11-01
      { day: "2026-11-01", hour: 1, agent: 2, human: 0 },
    ],
  },
});
