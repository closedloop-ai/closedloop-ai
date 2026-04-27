export type AgentSummary = {
  id: string;
  name: string;
  slug: string;
  role: string;
  description: string | null;
  enabled: boolean;
  sourceRepo: string | null;
  currentVersion: number;
  createdAt: Date;
  updatedAt: Date;
};

export type AgentDetail = AgentSummary & {
  prompt: string;
  bootstrapRunId: string | null;
  createdBy: { id: string; firstName: string | null; lastName: string | null };
};

export type AgentVersionSummary = {
  id: string;
  version: number;
  name: string;
  changeNote: string | null;
  changedBy: { id: string; firstName: string | null; lastName: string | null };
  createdAt: Date;
};

export type AgentVersionDetail = AgentVersionSummary & {
  prompt: string;
};

export type CreateAgentRequest = {
  name: string;
  role: string;
  description?: string;
  prompt: string;
  sourceRepo?: string;
  bootstrapRunId?: string;
};

export type UpdateAgentRequest = {
  name?: string;
  description?: string;
  prompt?: string;
  enabled?: boolean;
  changeNote?: string;
};

export type BulkIngestAgentItem = {
  name: string;
  role: string;
  description?: string;
  prompt: string;
};

export type BulkIngestAgentRequest = {
  agents: BulkIngestAgentItem[];
  bootstrapRunId: string;
  sourceRepo: string;
  criticGates?: Record<string, unknown>;
};

export type AgentListResponse = {
  agents: AgentSummary[];
  total: number;
};

export type BulkIngestAgentResponse = {
  created: number;
  updated: number;
  agents: AgentSummary[];
};

export type RepoBootstrapConfigResponse = {
  repoFullName: string;
  criticGates: Record<string, unknown>;
  updatedAt: Date;
};

export type ContextPackAgent = {
  slug: string;
  name: string;
  prompt: string;
};

export type ContextPackRepoConfig = {
  repoFullName: string;
  criticGates: Record<string, unknown>;
};

export type ContextPackAgentsResponse = {
  agents: ContextPackAgent[];
  repoConfigs: ContextPackRepoConfig[];
  orgId: string;
  generatedAt: string;
};
