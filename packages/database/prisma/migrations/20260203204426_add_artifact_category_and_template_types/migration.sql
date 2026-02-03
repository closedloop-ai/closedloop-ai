-- CreateEnum
CREATE TYPE "WorkstreamType" AS ENUM ('FEATURE_DELIVERY', 'BUG_FIX', 'TECH_DEBT', 'SPIKE');

-- CreateEnum
CREATE TYPE "WorkstreamState" AS ENUM ('INITIATED', 'REQUIREMENTS_GENERATING', 'REQUIREMENTS_PENDING_APPROVAL', 'DESIGN_IN_PROGRESS', 'DESIGN_PENDING_APPROVAL', 'IMPLEMENTATION_PLANNING', 'IMPLEMENTATION_IN_PROGRESS', 'IMPLEMENTATION_PENDING_REVIEW', 'CODE_REVIEW_RUNNING', 'CODE_REVIEW_PENDING_APPROVAL', 'VISUAL_QA_RUNNING', 'VISUAL_QA_PENDING_APPROVAL', 'MERGING', 'DEPLOYED', 'COMPLETED', 'BLOCKED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ArtifactType" AS ENUM ('PRD', 'ISSUE', 'BUG', 'FIGMA_DESIGN', 'IMPLEMENTATION_PLAN', 'IMPLEMENTATION_STRATEGY', 'CODE_REVIEW_REPORT', 'VISUAL_QA_REPORT', 'ACCESSIBILITY_REPORT', 'TEST_REPORT', 'COMPLETION_SUMMARY', 'PULL_REQUEST', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "ArtifactStatus" AS ENUM ('DRAFT', 'REVIEW', 'APPROVED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ArtifactCategory" AS ENUM ('DOCUMENT', 'WORKFLOW', 'BRANCH');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVISION_REQUESTED');

-- CreateEnum
CREATE TYPE "ApproverRole" AS ENUM ('PM', 'DESIGNER', 'TECH_LEAD', 'ENGINEER', 'STAKEHOLDER');

-- CreateEnum
CREATE TYPE "FileUploadType" AS ENUM ('SCREENSHOT', 'ATTACHMENT', 'REPORT_IMAGE');

-- CreateEnum
CREATE TYPE "WorkstreamEventType" AS ENUM ('STATE_CHANGED', 'ARTIFACT_CREATED', 'ARTIFACT_UPDATED', 'APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'APPROVAL_REJECTED', 'REVISION_REQUESTED', 'LINEAR_ISSUE_CREATED', 'LINEAR_ISSUE_UPDATED', 'LINEAR_SUBTASK_CREATED', 'GITHUB_PR_CREATED', 'GITHUB_PR_MERGED', 'GITHUB_ACTION_TRIGGERED', 'GITHUB_ACTION_COMPLETED', 'SLACK_NOTIFICATION_SENT', 'COMMENT_ADDED', 'ASSIGNEE_CHANGED', 'BLOCKED', 'UNBLOCKED');

-- CreateEnum
CREATE TYPE "LinearSyncStatus" AS ENUM ('SYNCED', 'PENDING', 'ERROR');

-- CreateEnum
CREATE TYPE "GitHubPRState" AS ENUM ('OPEN', 'MERGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "GitHubActionStatus" AS ENUM ('PENDING', 'QUEUED', 'RUNNING', 'SUCCESS', 'FAILURE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TeamRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "ProjectPriority" AS ENUM ('NOT_SET', 'LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "preview_schemas" (
    "schema_name" TEXT NOT NULL,
    "branch" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "preview_schemas_pkey" PRIMARY KEY ("schema_name")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "clerk_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "anthropic_api_key" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "clerk_id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "email" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "avatar_url" TEXT,
    "phone_number" TEXT,
    "role" "ApproverRole" NOT NULL DEFAULT 'ENGINEER',
    "linear_id" TEXT,
    "slack_id" TEXT,
    "github_username" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "priority" "ProjectPriority" NOT NULL DEFAULT 'NOT_SET',
    "owner_id" UUID,
    "target_date" TIMESTAMP(3),
    "codebase_summary" TEXT,
    "last_indexed_at" TIMESTAMP(3),
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repositories" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "github_id" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL DEFAULT 'main',
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "repositories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_members" (
    "id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'MEMBER',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_teams" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "team_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workstreams" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "WorkstreamType" NOT NULL DEFAULT 'FEATURE_DELIVERY',
    "state" "WorkstreamState" NOT NULL DEFAULT 'INITIATED',
    "state_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_id" UUID NOT NULL,
    "assigned_to_id" UUID,
    "has_ui_changes" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMP(3),
    "metrics" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workstreams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workstream_events" (
    "id" UUID NOT NULL,
    "workstream_id" UUID NOT NULL,
    "type" "WorkstreamEventType" NOT NULL,
    "from_state" "WorkstreamState",
    "to_state" "WorkstreamState",
    "actor_id" UUID,
    "actor_type" TEXT NOT NULL DEFAULT 'system',
    "data" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workstream_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "artifacts" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workstream_id" UUID,
    "project_id" UUID,
    "parent_id" UUID,
    "type" "ArtifactType" NOT NULL,
    "category" "ArtifactCategory" NOT NULL DEFAULT 'DOCUMENT',
    "title" TEXT NOT NULL,
    "file_name" TEXT,
    "approver" TEXT,
    "status" "ArtifactStatus" NOT NULL DEFAULT 'DRAFT',
    "content" TEXT,
    "external_url" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "is_latest" BOOLEAN NOT NULL DEFAULT true,
    "document_slug" TEXT,
    "generated_by" UUID,
    "owner_id" UUID,
    "token_usage" JSONB,
    "target_repo" TEXT,
    "target_branch" TEXT,
    "template_for_type" "ArtifactType",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_uploads" (
    "id" UUID NOT NULL,
    "artifact_id" UUID,
    "type" "FileUploadType" NOT NULL,
    "bucket" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "viewport" JSONB,
    "page_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "file_uploads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "workstream_id" UUID NOT NULL,
    "artifact_id" UUID NOT NULL,
    "required_role" "ApproverRole" NOT NULL,
    "approver_id" UUID,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "feedback" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decided_at" TIMESTAMP(3),

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "workstream_id" UUID NOT NULL,
    "agent_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "token_usage" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "comments" (
    "id" UUID NOT NULL,
    "workstream_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "artifact_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linear_integrations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "token_expires_at" TIMESTAMP(3),
    "linear_org_id" TEXT NOT NULL,
    "linear_org_name" TEXT NOT NULL,
    "default_team_id" TEXT,
    "webhook_id" TEXT,
    "webhook_secret" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "linear_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linear_issues" (
    "id" UUID NOT NULL,
    "workstream_id" UUID NOT NULL,
    "linear_id" TEXT NOT NULL,
    "linear_key" TEXT NOT NULL,
    "linear_url" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "team_key" TEXT NOT NULL,
    "sync_status" "LinearSyncStatus" NOT NULL DEFAULT 'SYNCED',
    "last_synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sync_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "linear_issues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "linear_subtasks" (
    "id" UUID NOT NULL,
    "workstream_id" UUID NOT NULL,
    "linear_id" TEXT NOT NULL,
    "linear_key" TEXT NOT NULL,
    "linear_url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "is_completed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "linear_subtasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_installations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "installation_id" INTEGER NOT NULL,
    "account_login" TEXT NOT NULL,
    "account_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_installations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_pull_requests" (
    "id" UUID NOT NULL,
    "workstream_id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "github_id" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "html_url" TEXT NOT NULL,
    "head_branch" TEXT NOT NULL,
    "base_branch" TEXT NOT NULL,
    "head_sha" TEXT,
    "state" "GitHubPRState" NOT NULL DEFAULT 'OPEN',
    "merged_at" TIMESTAMP(3),
    "merge_commit_sha" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_action_runs" (
    "id" UUID NOT NULL,
    "workstream_id" UUID NOT NULL,
    "repository_id" UUID NOT NULL,
    "run_id" BIGINT,
    "workflow_name" TEXT NOT NULL,
    "status" "GitHubActionStatus" NOT NULL DEFAULT 'PENDING',
    "conclusion" TEXT,
    "html_url" TEXT NOT NULL,
    "trigger_event" TEXT NOT NULL,
    "trigger_data" JSONB,
    "session_id" TEXT,
    "job_type" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_action_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "slack_integrations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "access_token" TEXT NOT NULL,
    "bot_user_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "team_name" TEXT NOT NULL,
    "default_channel_id" TEXT,
    "default_channel_name" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "slack_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_clerk_id_key" ON "organizations"("clerk_id");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_clerk_id_key" ON "users"("clerk_id");

-- CreateIndex
CREATE INDEX "users_linear_id_idx" ON "users"("linear_id");

-- CreateIndex
CREATE INDEX "users_slack_id_idx" ON "users"("slack_id");

-- CreateIndex
CREATE INDEX "users_github_username_idx" ON "users"("github_username");

-- CreateIndex
CREATE UNIQUE INDEX "users_organization_id_email_key" ON "users"("organization_id", "email");

-- CreateIndex
CREATE INDEX "projects_organization_id_idx" ON "projects"("organization_id");

-- CreateIndex
CREATE INDEX "projects_owner_id_idx" ON "projects"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_github_id_key" ON "repositories"("github_id");

-- CreateIndex
CREATE INDEX "repositories_project_id_idx" ON "repositories"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "repositories_owner_name_key" ON "repositories"("owner", "name");

-- CreateIndex
CREATE INDEX "teams_organization_id_idx" ON "teams"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "teams_organization_id_slug_key" ON "teams"("organization_id", "slug");

-- CreateIndex
CREATE INDEX "team_members_user_id_idx" ON "team_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_members_team_id_user_id_key" ON "team_members"("team_id", "user_id");

-- CreateIndex
CREATE INDEX "project_teams_team_id_idx" ON "project_teams"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_teams_project_id_team_id_key" ON "project_teams"("project_id", "team_id");

-- CreateIndex
CREATE INDEX "workstreams_organization_id_idx" ON "workstreams"("organization_id");

-- CreateIndex
CREATE INDEX "workstreams_organization_id_project_id_state_idx" ON "workstreams"("organization_id", "project_id", "state");

-- CreateIndex
CREATE INDEX "workstreams_organization_id_assigned_to_id_idx" ON "workstreams"("organization_id", "assigned_to_id");

-- CreateIndex
CREATE INDEX "workstreams_project_id_idx" ON "workstreams"("project_id");

-- CreateIndex
CREATE INDEX "workstream_events_workstream_id_type_idx" ON "workstream_events"("workstream_id", "type");

-- CreateIndex
CREATE INDEX "workstream_events_workstream_id_created_at_idx" ON "workstream_events"("workstream_id", "created_at");

-- CreateIndex
CREATE INDEX "workstream_events_type_idx" ON "workstream_events"("type");

-- CreateIndex
CREATE INDEX "artifacts_organization_id_workstream_id_type_is_latest_idx" ON "artifacts"("organization_id", "workstream_id", "type", "is_latest");

-- CreateIndex
CREATE INDEX "artifacts_organization_id_project_id_type_is_latest_idx" ON "artifacts"("organization_id", "project_id", "type", "is_latest");

-- CreateIndex
CREATE INDEX "artifacts_organization_id_parent_id_type_is_latest_idx" ON "artifacts"("organization_id", "parent_id", "type", "is_latest");

-- CreateIndex
CREATE INDEX "artifacts_organization_id_type_template_for_type_idx" ON "artifacts"("organization_id", "type", "template_for_type");

-- CreateIndex
CREATE INDEX "artifacts_workstream_id_idx" ON "artifacts"("workstream_id");

-- CreateIndex
CREATE INDEX "artifacts_project_id_idx" ON "artifacts"("project_id");

-- CreateIndex
CREATE INDEX "artifacts_parent_id_idx" ON "artifacts"("parent_id");

-- CreateIndex
CREATE INDEX "artifacts_owner_id_idx" ON "artifacts"("owner_id");

-- CreateIndex
CREATE UNIQUE INDEX "artifacts_organization_id_template_for_type_key" ON "artifacts"("organization_id", "template_for_type");

-- CreateIndex
CREATE INDEX "file_uploads_artifact_id_idx" ON "file_uploads"("artifact_id");

-- CreateIndex
CREATE INDEX "file_uploads_bucket_key_idx" ON "file_uploads"("bucket", "key");

-- CreateIndex
CREATE INDEX "approvals_project_id_idx" ON "approvals"("project_id");

-- CreateIndex
CREATE INDEX "approvals_workstream_id_status_idx" ON "approvals"("workstream_id", "status");

-- CreateIndex
CREATE INDEX "approvals_artifact_id_idx" ON "approvals"("artifact_id");

-- CreateIndex
CREATE INDEX "approvals_approver_id_status_idx" ON "approvals"("approver_id", "status");

-- CreateIndex
CREATE INDEX "conversations_workstream_id_agent_type_idx" ON "conversations"("workstream_id", "agent_type");

-- CreateIndex
CREATE INDEX "messages_conversation_id_created_at_idx" ON "messages"("conversation_id", "created_at");

-- CreateIndex
CREATE INDEX "comments_workstream_id_created_at_idx" ON "comments"("workstream_id", "created_at");

-- CreateIndex
CREATE INDEX "comments_author_id_idx" ON "comments"("author_id");

-- CreateIndex
CREATE INDEX "comments_artifact_id_idx" ON "comments"("artifact_id");

-- CreateIndex
CREATE UNIQUE INDEX "linear_integrations_organization_id_key" ON "linear_integrations"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "linear_issues_workstream_id_key" ON "linear_issues"("workstream_id");

-- CreateIndex
CREATE UNIQUE INDEX "linear_issues_linear_id_key" ON "linear_issues"("linear_id");

-- CreateIndex
CREATE INDEX "linear_issues_linear_key_idx" ON "linear_issues"("linear_key");

-- CreateIndex
CREATE INDEX "linear_issues_sync_status_idx" ON "linear_issues"("sync_status");

-- CreateIndex
CREATE UNIQUE INDEX "linear_subtasks_linear_id_key" ON "linear_subtasks"("linear_id");

-- CreateIndex
CREATE INDEX "linear_subtasks_workstream_id_idx" ON "linear_subtasks"("workstream_id");

-- CreateIndex
CREATE INDEX "linear_subtasks_workstream_id_is_completed_idx" ON "linear_subtasks"("workstream_id", "is_completed");

-- CreateIndex
CREATE UNIQUE INDEX "github_installations_organization_id_key" ON "github_installations"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_installations_installation_id_key" ON "github_installations"("installation_id");

-- CreateIndex
CREATE INDEX "github_pull_requests_workstream_id_state_idx" ON "github_pull_requests"("workstream_id", "state");

-- CreateIndex
CREATE INDEX "github_pull_requests_repository_id_idx" ON "github_pull_requests"("repository_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_pull_requests_repository_id_number_key" ON "github_pull_requests"("repository_id", "number");

-- CreateIndex
CREATE INDEX "github_action_runs_workstream_id_status_idx" ON "github_action_runs"("workstream_id", "status");

-- CreateIndex
CREATE INDEX "github_action_runs_workstream_id_workflow_name_idx" ON "github_action_runs"("workstream_id", "workflow_name");

-- CreateIndex
CREATE UNIQUE INDEX "github_action_runs_repository_id_run_id_key" ON "github_action_runs"("repository_id", "run_id");

-- CreateIndex
CREATE UNIQUE INDEX "slack_integrations_organization_id_key" ON "slack_integrations"("organization_id");
