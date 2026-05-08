import { DocumentType } from "./document";

export const SlugPrefix = {
  Project: "PRO",
  Workstream: "WRK",
  Prd: "PRD",
  Plan: "PLN",
  Feature: "FEA",
} as const;
export type SlugPrefix = (typeof SlugPrefix)[keyof typeof SlugPrefix];

export const ARTIFACT_SLUG_PREFIXES: Partial<Record<DocumentType, SlugPrefix>> =
  {
    [DocumentType.Prd]: SlugPrefix.Prd,
    [DocumentType.ImplementationPlan]: SlugPrefix.Plan,
    [DocumentType.Feature]: SlugPrefix.Feature,
  };
