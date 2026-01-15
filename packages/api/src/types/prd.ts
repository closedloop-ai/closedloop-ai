export const PRD_STATUS_OPTIONS = [
  "Draft",
  "Review",
  "Approved",
  "Archived",
] as const;
export type PrdStatus = (typeof PRD_STATUS_OPTIONS)[number];

export const PRD_TEMPLATE_OPTIONS = [
  "Standard PRD",
  "Feature Brief",
  "Bug Fix",
  "Technical Spec",
] as const;
export type PrdTemplate = (typeof PRD_TEMPLATE_OPTIONS)[number];

export type Prd = {
  id: string;
  title: string;
  fileName: string;
  approver: string;
  version: number;
  status: string;
  tags: string[];
  template: string;
  content: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CreatePrdInput = {
  title: string;
  fileName: string;
  approver: string;
  status: PrdStatus;
  tags: string[];
  template: PrdTemplate;
  content?: string;
};

export type UpdatePrdInput = {
  id: string;
  title?: string;
  fileName?: string;
  approver?: string;
  status?: PrdStatus;
  tags?: string[];
  template?: PrdTemplate;
  content?: string;
};
