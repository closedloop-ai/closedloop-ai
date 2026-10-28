export const PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS = [
  // ISS-12552: perf-only lookup for a tied receipt's contesting claim; sync
  // reconciliation reads it correctly without the index.
  "20261023030106_iss12552_operation_evidence_contested_receipt_index",
  // ISS-12552: perf-only lookup index for allocation's cross-session usage
  // read; the read is correct without it, so previews can prestamp it.
  "20261023030103_iss12552_token_event_source_identity_index",
  "20261022022501_prd726_project_hierarchy_page_indexes",
  "20261021150000_iss12776_agent_session_events_covering_index",
  "20261021040344_iss12780_receipt_created_at_index",
  "20261021040000_iss12775_comments_thread_live_cover_index",
  "20261021020100_iss12657_artifacts_assigned_priority_index",
  "20261021020000_iss12657_artifacts_assigned_status_index",
  // ISS-12650: additive non-unique lookup for per-parent child rank.
  "20261021150200_iss12650_artifact_link_child_order_index",
  "20261013120100_monitored_retained_uncertified_index",
  "20261013120000_monitored_retained_target_index",
  "20261012170100_iss12251_artifacts_assignee_type_created_index",
  "20261012120000_iss12251_artifacts_assigned_non_session_index",
  "20261008172000_route_analytics_covering_indexes",
  "20261007200600_iss12209_session_name_override_feed_index",
  "20261006160000_iss10565_token_events_session_received_index",
  "20261006150000_session_external_id_replay_index",
  "20261003195257_iss10994_activity_v1_action_cursor_actor",
  "20261002145523_iss10992_push_history_index",
  "20260721160000_fea3638_insights_perf_indexes_concurrent",
  "20260722000000_prd536_g7_session_transcript_identity_index",
  "20260724010000_fea3930_search_document_slug_lookup_index",
  "20260730180000_iss4565_session_detail_model_index_concurrent",
  "20260731130000_iss4543_compute_target_ingestion_health_scan_index",
  "20260802190000_iss4832_compute_target_heartbeat_group_index",
  "20260811120100_fea3001_file_attachment_reconcile_queue_index",
  "20260811130000_session_detail_source_loop_id_index",
  "20260812120000_iss6104_agent_components_org_pack_id_index",
  "20260815120000_iss6452_repository_authority_lower_name_indexes",
  "20260820140200_iss6757_invocation_component_key_normalized_index",
  "20260820120200_iss6756_component_session_usage_normalized_key_index",
  "20260921190000_iss10815_component_session_usage_version_hash_index",
  "20260820150000_iss7211_custom_field_value_facet_indexes",
  "20260823140000_iss7513_insights_event_window_index",
  "20260826211706_iss7476_observed_repository_due_rotation_index",
  "20260827130000_iss7804_artifact_reference_search_org_updated_index",
  "20260827130100_iss7804_artifact_reference_search_org_type_updated_index",
  "20260830120000_iss8496_artifact_cascade_fk_indexes",
  "20260831160000_iss8453_queued_commands_by_target_idx",
  "20260901120100_iss8674_queued_depth_idx",
  "20260901130100_iss8674_queued_depth_sweep_idx",
  "20260905120100_iss7223_desktop_command_queued_at_idx",
  "20260906120100_iss9618_routines_due_idx",
  "20260906120200_iss9618_routine_runs_settle_idx",
  "20260907140100_iss9665_search_document_priority_idx",
  "20260908120000_iss9627_artifacts_org_id_idx",
  "20260913120000_iss9776_artifacts_documents_ordered_read_idx",
  "20260914120000_iss10171_session_detail_last_activity_artifact_idx",
  "20260917204047_iss9930_pensero_backfill_day_last_success_at_idx",
  "20260918053500_iss10009_branch_activity_push_loc_read_index",
  "20260918175023_iss9278_pr_identity_read_index",
  "20260925001451_iss10458_activity_org_transaction_id_index",
  // ISS-11141: additive Insights query indexes; previews can prestamp these perf-only reads.
  "20260926150100_add_session_mesh_reporting_indexes",
  "20261001185259_iss11212_pr_comments_reconcile_index",
  "20261001220001_desktop_sign_in_analytics_attempt_expiry_index",
  // ISS-11812: additive index for the Mesh insights rollup join; perf-only, so
  // previews can prestamp it rather than pay the concurrent build.
  "20261001224500_session_mesh_metric_events_message_idx",
  "20261002161501_iss11212_pr_comments_reconcile_due_index",
];

export const PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS = [
  "20260723030001_fea3857_search_document_concurrent_indexes",
  "20260812150000_iss6058_branch_activity_fk_indexes",
  // ISS-9671. Plain-built rather than perf-skipped because the index is a
  // CORRECTNESS constraint, not a perf index: it is the run sync-up upsert's ON
  // CONFLICT arbiter. Perf-skipping it would leave a preview schema without the
  // key the upsert arbitrates on.
  "20260907120000_iss9671_routine_runs_routine_scoped_source_unique",
  // ISS-10170. Plain-built rather than perf-skipped for the same reason as
  // ISS-9671: the index is a CORRECTNESS constraint, not a perf index — it is
  // the target of `pull_request_detail_branch_artifact_tenant_fkey`, and a
  // preview schema that skipped it would fail the very next migration's
  // ADD CONSTRAINT with "there is no unique constraint matching given keys".
  "20260915180000_iss10170_artifacts_org_id_unique",
];

export const PREVIEW_SKIP_OPT_OUT_MARKER = "preview-skip: no";

const SQL_LINE_COMMENT_REGEX = /--[^\n]*/g;
const SQL_BLOCK_COMMENT_REGEX = /\/\*[\s\S]*?\*\//g;
const CREATE_INDEX_CONCURRENTLY_REGEX = /create\s+index\s+concurrently/i;
const NON_INDEX_ONLY_DDL_REGEX =
  /\b(?:create\s+unique\s+index|create\s+table|alter\s+table|drop\s+table|drop\s+index|alter\s+index|create\s+type|alter\s+type|drop\s+type|create\s+trigger|create\s+(?:or\s+replace\s+)?function|create\s+(?:materialized\s+)?view|create\s+schema|create\s+sequence|add\s+constraint|insert\s+into|update|delete\s+from)\b/i;
const ANY_CONCURRENT_INDEX_BUILD_REGEX =
  /create\s+(?:unique\s+)?index\s+concurrently/i;

export function isPreviewSkippableConcurrentIndexSql(sql) {
  const code = stripSqlComments(sql);
  if (!CREATE_INDEX_CONCURRENTLY_REGEX.test(code)) {
    return false;
  }
  return !NON_INDEX_ONLY_DDL_REGEX.test(code);
}

export function containsConcurrentIndexBuild(sql) {
  return ANY_CONCURRENT_INDEX_BUILD_REGEX.test(stripSqlComments(sql));
}

function stripSqlComments(sql) {
  return sql
    .replace(SQL_BLOCK_COMMENT_REGEX, " ")
    .replace(SQL_LINE_COMMENT_REGEX, " ");
}
