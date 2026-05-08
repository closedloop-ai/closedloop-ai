-- Drop indexes that are redundant (left-prefix of existing compound index or unique constraint)

-- workstreams: organizationId covered by (organizationId, slug) unique, (organizationId, projectId, state), (organizationId, assigneeId)
DROP INDEX IF EXISTS "workstreams_organization_id_idx";

-- linear_subtasks: workstreamId covered by (workstreamId, isCompleted)
DROP INDEX IF EXISTS "linear_subtasks_workstream_id_idx";

-- github_pr_reviews: pullRequestId covered by unique(pullRequestId, authorLogin)
DROP INDEX IF EXISTS "github_pr_reviews_pull_request_id_idx";

-- api_keys: keyHash covered by unique constraint on key_hash
DROP INDEX IF EXISTS "api_keys_key_hash_idx";
