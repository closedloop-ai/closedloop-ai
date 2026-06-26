# Desktop API Route Guidelines

- When multiple desktop route files share the same wire-contract types, define those types in `apps/api/app/desktop/contract.ts` instead of duplicating route-local copies.
- For TTL-backed state machines, check expiry at every non-terminal branch that can remain in progress, including after claim/consume transitions. A consumed, claimed, or in-progress record must not remain pollable forever after its TTL unless readiness has already been proven.
