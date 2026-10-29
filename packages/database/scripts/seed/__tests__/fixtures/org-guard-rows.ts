/**
 * Complete Prisma rows for the models the non-empty-org guard reads, so the
 * guard suites' mocks resolve values of the model's real type.
 */

import {
  type Artifact,
  type ArtifactEvaluation,
  ArtifactType,
  type Comment,
  CommentBodyFormat,
  type CustomField,
  CustomFieldType,
  DocumentStatus,
  EvaluationReportType,
  type GitHubInstallation,
  GitHubInstallationStatus,
  type LinearIntegration,
  type Project,
  ProjectStatus,
  type SlackIntegration,
  type Team,
} from "../../../../generated/client";
import { BASELINE_ORG_ID } from "./baseline-org";

// The guard selects only the fields each builder takes; the rest are fixed
// placeholders.
const ROW_TIMESTAMP = new Date(0);

export function gitHubInstallationRow(
  fields: Pick<GitHubInstallation, "id">
): GitHubInstallation {
  return {
    ...fields,
    organizationId: BASELINE_ORG_ID,
    installationId: "1",
    accountId: "1",
    accountLogin: "seed-account",
    accountType: "Organization",
    senderLogin: "seed-sender",
    senderId: "1",
    status: GitHubInstallationStatus.ACTIVE,
    permissions: null,
    events: null,
    repositorySelection: null,
    suspendedAt: null,
    suspendedBy: null,
    claimedAt: null,
    claimedByUserId: null,
    createdAt: ROW_TIMESTAMP,
    updatedAt: ROW_TIMESTAMP,
    pendingNewInstallationId: null,
    provider: "github",
    providerDetail: null,
  };
}

export function linearIntegrationRow(
  fields: Pick<LinearIntegration, "id">
): LinearIntegration {
  return {
    ...fields,
    organizationId: BASELINE_ORG_ID,
    accessTokenEncrypted: null,
    refreshTokenEncrypted: null,
    tokenExpiresAt: null,
    linearOrgId: "linear-org",
    linearOrgName: "Linear Org",
    defaultTeamId: null,
    webhookId: null,
    webhookSecret: null,
    createdAt: ROW_TIMESTAMP,
    updatedAt: ROW_TIMESTAMP,
  };
}

export function slackIntegrationRow(
  fields: Pick<SlackIntegration, "id">
): SlackIntegration {
  return {
    ...fields,
    organizationId: BASELINE_ORG_ID,
    accessToken: "",
    accessTokenEncrypted: null,
    botUserId: "slack-bot",
    teamId: "slack-team",
    teamName: "Slack Team",
    defaultChannelId: null,
    defaultChannelName: null,
    createdAt: ROW_TIMESTAMP,
    updatedAt: ROW_TIMESTAMP,
  };
}

export function projectRow(fields: Pick<Project, "id" | "slug">): Project {
  return {
    ...fields,
    organizationId: BASELINE_ORG_ID,
    name: "Project",
    description: null,
    priority: null,
    status: ProjectStatus.NOT_STARTED,
    assigneeId: null,
    createdById: "user-1",
    targetDate: null,
    codebaseSummary: null,
    lastIndexedAt: null,
    settings: {},
    sortOrder: null,
    createdAt: ROW_TIMESTAMP,
    updatedAt: ROW_TIMESTAMP,
  };
}

export function teamRow(fields: Pick<Team, "id" | "slug">): Team {
  return {
    ...fields,
    organizationId: BASELINE_ORG_ID,
    name: "Team",
    createdAt: ROW_TIMESTAMP,
    updatedAt: ROW_TIMESTAMP,
  };
}

export function artifactRow(fields: Pick<Artifact, "id" | "slug">): Artifact {
  return {
    ...fields,
    organizationId: BASELINE_ORG_ID,
    projectId: null,
    type: ArtifactType.DOCUMENT,
    subtype: null,
    templateForType: null,
    name: "Artifact",
    assigneeId: null,
    status: DocumentStatus.DRAFT,
    priority: null,
    dueDate: null,
    externalUrl: null,
    sortOrder: null,
    createdAt: ROW_TIMESTAMP,
    createdById: null,
    updatedAt: ROW_TIMESTAMP,
  };
}

export function commentRow(fields: Pick<Comment, "id" | "plainText">): Comment {
  return {
    ...fields,
    threadId: "thread-1",
    authorId: "user-1",
    body: {},
    bodyFormat: CommentBodyFormat.MARKDOWN,
    revision: 1,
    externalId: null,
    parentCommentId: null,
    editedAt: null,
    deletedAt: null,
    createdAt: ROW_TIMESTAMP,
    updatedAt: ROW_TIMESTAMP,
  };
}

export function customFieldRow(
  fields: Pick<CustomField, "id" | "name">
): CustomField {
  return {
    ...fields,
    organizationId: BASELINE_ORG_ID,
    description: null,
    fieldType: CustomFieldType.TEXT,
    createdById: null,
    precision: null,
    numberFormat: null,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    isGlobalToOrg: false,
    entityTypes: [],
    referenceTargetSources: [],
    showInTable: false,
    isSearchable: false,
    isSortable: false,
    createdAt: ROW_TIMESTAMP,
    updatedAt: ROW_TIMESTAMP,
  };
}

export function artifactEvaluationRow(
  fields: Pick<ArtifactEvaluation, "id" | "reportId">
): ArtifactEvaluation {
  return {
    ...fields,
    organizationId: BASELINE_ORG_ID,
    artifactId: "artifact-1",
    reportType: EvaluationReportType.PLAN,
    createdAt: ROW_TIMESTAMP,
  };
}
