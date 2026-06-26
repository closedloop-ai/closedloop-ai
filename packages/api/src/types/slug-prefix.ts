import { DocumentType } from "./document";

export const SlugPrefix = {
  Project: "PRO",
  Prd: "PRD",
  Plan: "PLN",
  Feature: "FEA",
  // SESSION artifacts (SES-*). Not in ARTIFACT_SLUG_PREFIXES below because that
  // map is keyed by DocumentType; sessions are not documents, so session
  // creation calls generateSlug(orgId, SlugPrefix.Session) directly.
  Session: "SES",
} as const;
export type SlugPrefix = (typeof SlugPrefix)[keyof typeof SlugPrefix];

export const ARTIFACT_SLUG_PREFIXES: Partial<Record<DocumentType, SlugPrefix>> =
  {
    [DocumentType.Prd]: SlugPrefix.Prd,
    [DocumentType.ImplementationPlan]: SlugPrefix.Plan,
    [DocumentType.Feature]: SlugPrefix.Feature,
  };
