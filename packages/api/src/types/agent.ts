export type AgentSummary = {
  id: string;
  name: string;
  slug: string;
  role: string;
  description: string | null;
  enabled: boolean;
  sourceRepo: string;
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

export type {
  ContextPackAgent,
  ContextPackRepoConfig,
} from "@closedloop-ai/loops-api/context-pack";

import type {
  ContextPackAgent,
  ContextPackRepoConfig,
} from "@closedloop-ai/loops-api/context-pack";

export type ContextPackAgentsResponse = {
  agents: ContextPackAgent[];
  repoConfigs: ContextPackRepoConfig[];
  orgId: string;
  generatedAt: string;
};
