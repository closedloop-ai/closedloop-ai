/**
 * PRD-538 R3 (ISS-5352) — the golden-corpus cost oracle.
 *
 * Registration shim only; the suite body lives in golden/golden-cost-oracle.ts
 * (test/golden/ is not scanned by the node test runner). Cost is a pure
 * function of token counts, so unlike the Layer-3 suites this needs no
 * paired UTC/Chicago run.
 */
import { registerGoldenCostOracleSuite } from "./golden/golden-cost-oracle.js";

registerGoldenCostOracleSuite();
