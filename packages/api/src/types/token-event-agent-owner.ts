/**
 * ISS-12552 (PRD-800 "Agent ownership of usage is correctable"):
 * the `agentExternalId` a Desktop sends for a token event the main agent
 * owns. The API stores it as no owner, replacing any subagent it held before.
 *
 * Distinct from omission and from `null`: Desktop builds that predate owners
 * send those, and they claim nothing, so a stored owner is left as it is.
 */
export const PARENT_AGENT_EXTERNAL_ID = "$parent" as const;
