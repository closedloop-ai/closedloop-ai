/**
 * Signed Layer 3 corpus contract consumed by the golden aggregation suites.
 *
 * Schema v2 moves local-calendar token analytics into the timezone-dependent
 * section so UTC and America/Chicago runs can carry distinct signed facts.
 */
export type CorpusYaml = {
  schema_version: number;
  status: string;
  reference_now: string;
  oracle: {
    turns_user_total: number;
    turns_assistant_total: number;
    tokens_by_model: Record<
      string,
      { input: number; output: number; cache_read: number; cache_write: number }
    >;
  };
  store_tokens_by_model: Record<
    string,
    { input: number; output: number; cache_read: number; cache_write: number }
  >;
  corpus: {
    dossiers_total: number;
    sessions_imported: number;
    by_harness: Record<string, number>;
    sessions_by_status_store: Record<string, number>;
  };
  summary: {
    total_sessions: number;
    active_sessions: number;
    total_agents: number;
    total_events: number;
    distinct_event_types: number;
    total_tokens_usage: number;
  };
  windows: Record<
    string,
    {
      sessions: number;
      prior_window_sessions: number;
      has_full_prior_period: boolean;
      cost_usd_store: number;
      usage_totals: {
        tokens: number;
        input: number;
        output: number;
        cache_read: number;
        cache_write: number;
        models_in_use: number;
      };
      per_model_spend_usd: Record<string, number>;
      pr_captured: number;
      median_pr_size: number | null;
      // ISS-5412: nullable — a window where no captured PR carries line counts
      // has an UNKNOWN KLOC, not a KLOC of 0. The checked-in SIGNED corpus still
      // records the pre-ISS-5412 `0` for such windows; nothing asserts this key
      // against production, so amending it is a separate oracle-protocol change.
      kloc_captured: number | null;
      ttm_median_ms: number | null;
      tool_events: number;
    }
  >;
  cost_conservation_by_session: Record<
    string,
    { token_usage_usd: number; token_events_usd: number }
  >;
  workflow: {
    total_agents: number;
    total_subagents: number;
    main_count: number;
    completed_agents: number;
    error_agents: number;
    success_rate: number;
    avg_depth: number;
    avg_duration_sec: number;
    subagent_types: Record<string, number>;
  };
  core_features: {
    distinct_tools: number;
    tool_invocations_total: number;
    tool_counts: Record<string, number>;
    skill_invocation_events: number;
    pull_request_artifacts: number;
    created_link_artifacts: number;
  };
  sessions_page: {
    total: number;
    terminal: number;
    waiting: number;
    running_filter_matches: number;
  };
  branches: {
    active_write_links: number;
    distinct_push_qualified_branch_keys: number;
    pull_request_rows: number;
  };
  tz_dependent: Record<
    "utc" | "chicago",
    {
      token_analytics_30d: {
        totals: {
          input: number;
          output: number;
          cache_read: number;
          cache_write: number;
        };
        by_model: Record<
          string,
          {
            input: number;
            output: number;
            sessions: number;
            cost_usd_events: number;
          }
        >;
      };
      autonomy_by_day: Record<
        string,
        { agent: number; total: number; index: number }
      >;
      heatmap_day_totals: Record<string, { human: number; agent: number }>;
      sessions_started_per_day: Record<string, number>;
      token_events_cost_per_day_30d: Record<string, number>;
    }
  >;
};
