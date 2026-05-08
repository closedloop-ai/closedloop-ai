-- DropIndex
DROP INDEX "artifacts_organization_id_type_template_for_type_idx";

-- DropIndex
DROP INDEX "comment_reactions_comment_id_idx";

-- DropIndex
DROP INDEX "comments_deleted_at_idx";

-- DropIndex
DROP INDEX "custom_fields_organization_id_idx";

-- DropIndex
DROP INDEX "desktop_command_events_command_id_created_at_idx";

-- DropIndex
DROP INDEX "favorite_projects_user_id_idx";

-- DropIndex
DROP INDEX "github_installations_organization_id_idx";

-- DropIndex
DROP INDEX "judge_human_scores_organization_id_idx";

-- DropIndex
DROP INDEX "judge_scores_metric_name_created_at_idx";

-- DropIndex
DROP INDEX "loops_artifact_id_idx";

-- DropIndex
DROP INDEX "teams_organization_id_idx";

-- DropIndex
DROP INDEX "workstream_events_type_idx";

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compute_targets" ADD CONSTRAINT "compute_targets_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "compute_targets" ADD CONSTRAINT "compute_targets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desktop_commands" ADD CONSTRAINT "desktop_commands_compute_target_id_fkey" FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "desktop_command_events" ADD CONSTRAINT "desktop_command_events_command_id_fkey" FOREIGN KEY ("command_id") REFERENCES "desktop_commands"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "teams" ADD CONSTRAINT "teams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_members" ADD CONSTRAINT "team_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_teams" ADD CONSTRAINT "project_teams_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorite_projects" ADD CONSTRAINT "favorite_projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "favorite_projects" ADD CONSTRAINT "favorite_projects_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_workstream_id_fkey" FOREIGN KEY ("workstream_id") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifacts" ADD CONSTRAINT "artifacts_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_evaluations" ADD CONSTRAINT "artifact_evaluations_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_evaluations" ADD CONSTRAINT "artifact_evaluations_loop_id_fkey" FOREIGN KEY ("loop_id") REFERENCES "loops"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judge_scores" ADD CONSTRAINT "judge_scores_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "artifact_evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judge_scores" ADD CONSTRAINT "judge_scores_prompt_id_fkey" FOREIGN KEY ("prompt_id") REFERENCES "prompt_registry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judge_human_scores" ADD CONSTRAINT "judge_human_scores_evaluation_id_fkey" FOREIGN KEY ("evaluation_id") REFERENCES "artifact_evaluations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judge_human_scores" ADD CONSTRAINT "judge_human_scores_judge_score_id_fkey" FOREIGN KEY ("judge_score_id") REFERENCES "judge_scores"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judge_human_scores" ADD CONSTRAINT "judge_human_scores_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "judge_human_scores" ADD CONSTRAINT "judge_human_scores_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_action_run_performances" ADD CONSTRAINT "github_action_run_performances_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "artifact_ratings" ADD CONSTRAINT "artifact_ratings_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "file_attachments" ADD CONSTRAINT "file_attachments_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_request_ratings" ADD CONSTRAINT "pull_request_ratings_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "github_pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_request_ratings" ADD CONSTRAINT "pull_request_ratings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pull_request_ratings" ADD CONSTRAINT "pull_request_ratings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_workstream_id_fkey" FOREIGN KEY ("workstream_id") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issues" ADD CONSTRAINT "issues_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_workstream_id_fkey" FOREIGN KEY ("workstream_id") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_links" ADD CONSTRAINT "external_links_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_threads" ADD CONSTRAINT "comment_threads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comments" ADD CONSTRAINT "comments_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "comment_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_attachments" ADD CONSTRAINT "comment_attachments_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comment_reactions" ADD CONSTRAINT "comment_reactions_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loops" ADD CONSTRAINT "loops_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loops" ADD CONSTRAINT "loops_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loops" ADD CONSTRAINT "loops_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loops" ADD CONSTRAINT "loops_workstream_id_fkey" FOREIGN KEY ("workstream_id") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loops" ADD CONSTRAINT "loops_compute_target_id_fkey" FOREIGN KEY ("compute_target_id") REFERENCES "compute_targets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "loops" ADD CONSTRAINT "loops_parent_loop_id_fkey" FOREIGN KEY ("parent_loop_id") REFERENCES "loops"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "loop_events" ADD CONSTRAINT "loop_events_loop_id_fkey" FOREIGN KEY ("loop_id") REFERENCES "loops"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prompt_registry" ADD CONSTRAINT "prompt_registry_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_installation_repositories" ADD CONSTRAINT "github_installation_repositories_installation_id_fkey" FOREIGN KEY ("installation_id") REFERENCES "github_installations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_workstream_id_fkey" FOREIGN KEY ("workstream_id") REFERENCES "workstreams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_pull_requests" ADD CONSTRAINT "github_pull_requests_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_pr_review_comments" ADD CONSTRAINT "github_pr_review_comments_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "github_pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_pr_reviews" ADD CONSTRAINT "github_pr_reviews_pull_request_id_fkey" FOREIGN KEY ("pull_request_id") REFERENCES "github_pull_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_fields" ADD CONSTRAINT "custom_fields_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_enum_options" ADD CONSTRAINT "custom_field_enum_options_custom_field_id_fkey" FOREIGN KEY ("custom_field_id") REFERENCES "custom_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_settings" ADD CONSTRAINT "custom_field_settings_custom_field_id_fkey" FOREIGN KEY ("custom_field_id") REFERENCES "custom_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_custom_field_id_fkey" FOREIGN KEY ("custom_field_id") REFERENCES "custom_fields"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_enum_value_id_fkey" FOREIGN KEY ("enum_value_id") REFERENCES "custom_field_enum_options"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_updated_by_id_fkey" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
