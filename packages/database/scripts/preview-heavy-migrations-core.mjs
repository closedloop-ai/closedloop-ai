export const PREVIEW_SKIPPABLE_CONCURRENT_INDEX_MIGRATIONS = [
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
];

export const PREVIEW_PLAIN_BUILD_CONCURRENT_INDEX_MIGRATIONS = [
  "20260723030001_fea3857_search_document_concurrent_indexes",
  "20260812150000_iss6058_branch_activity_fk_indexes",
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
