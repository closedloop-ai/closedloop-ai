import type { TokenAnalytics } from "../src/shared/agent-db-contract.js";
import { TOKEN_ANALYTICS_BY_MODEL_KEYS } from "../test/fixtures/analytics-golden.js";

// FEA-3901 keys-covered guard (the enforced one — this dir is compiled by
// `typecheck:type-tests`; `test/fixtures/**` is not compiled by any `tsc` script).
//
// Adding a field to the canonical `TokenAnalytics["byModel"][number]` type
// without mirroring it into `TOKEN_ANALYTICS_BY_MODEL_KEYS` (and then into
// `sqlite-golden.json`) fails `tsc` here: a const missing a canonical key is not
// assignable to `Record<keyof …, true>`, whose keys are all required. `keyof`
// includes optional members (e.g. `estimatedCostUsd?`), so the guard also fires
// for a newly-added *optional* field — the exact FEA-2331 silent-drop case.
export const tokenAnalyticsByModelKeysCovered: Record<
  keyof TokenAnalytics["byModel"][number],
  true
> = TOKEN_ANALYTICS_BY_MODEL_KEYS;
