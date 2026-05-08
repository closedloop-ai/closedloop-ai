/**
 * Linear integration types for API contract.
 * Used by both apps/api (backend) and apps/app (frontend).
 *
 * Note: LinearTeam is also defined in @repo/linear.
 * The duplication is intentional for proper architectural layering:
 * - This type represents our internal API contract (what we expose to frontend)
 * - @repo/linear type represents the external Linear API contract (what SDK returns)
 * - Prevents low-level packages from depending on high-level API contracts
 * - Allows types to evolve independently if Linear API changes or we add transformations
 */

export type LinearTeam = {
  id: string;
  name: string;
  key: string;
};

export type LinearIntegrationStatus = {
  connected: boolean;
  organizationName?: string;
  defaultTeamId?: string;
  teams?: LinearTeam[];
};

export type ExportToLinearInput = {
  artifactId: string;
  teamId: string;
};

export type ExportedLinearIssue = {
  linearId: string;
  identifier: string;
  url: string;
  title: string;
};

export type ExportToLinearResult = {
  success: boolean;
  issuesCreated: number;
  issues: ExportedLinearIssue[];
};

export type LinearOAuthUrlResponse = {
  url: string;
};

export type LinearDisconnectResponse = {
  disconnected: true;
};

export type ConnectLinearInput = {
  code: string;
  codeVerifier: string;
};

export type ConnectLinearResponse = {
  connected: true;
  organizationName: string;
};
