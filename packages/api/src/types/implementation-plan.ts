import type { Prd } from "./prd";

export const IMPL_PLAN_STATUS_OPTIONS = [
  "Draft",
  "Ready",
  "In Progress",
  "Generating",
  "Failed",
  "Archived",
] as const;
export type ImplPlanStatus = (typeof IMPL_PLAN_STATUS_OPTIONS)[number];

export const IMPL_PLAN_TYPE_OPTIONS = [
  "Standard",
  "Quick",
  "Detailed",
  "Technical",
] as const;
export type ImplPlanType = (typeof IMPL_PLAN_TYPE_OPTIONS)[number];

export type ImplementationPlan = {
  id: string;
  title: string;
  sourcePrdId: string;
  version: number;
  createdBy: string;
  approver: string | null;
  status: string;
  planType: string;
  targetRelease: string | null;
  engineeringTeam: string | null;
  content: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ImplementationPlanWithPrd = ImplementationPlan & {
  sourcePrd: Pick<Prd, "id" | "title">;
};

export type CreateImplementationPlanInput = {
  sourcePrdId: string;
  planType: ImplPlanType;
  targetRelease?: string;
  engineeringTeam?: string;
  createdBy: string;
  approver?: string;
};

export type UpdateImplementationPlanInput = {
  id: string;
  title?: string;
  status?: ImplPlanStatus;
  content?: string;
  approver?: string;
  planType?: ImplPlanType;
  targetRelease?: string;
  engineeringTeam?: string;
};
