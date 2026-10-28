/**
 * A zero-dependency module rather than an export off `ApprovalsPanel.tsx`: the
 * desktop Playwright spec loader cannot resolve the panel's extensionless
 * `@closedloop-ai/design-system/...` imports, so a spec importing the panel aborts.
 */

/** The risk-tier badge when the request carries no tier. */
export const APPROVAL_RISK_TIER_FALLBACK_LABEL = "unknown";
