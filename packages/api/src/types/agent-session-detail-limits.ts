/**
 * ISS-5075: defensive ceiling for a session detail's raw event stream — the read
 * that had an ordering but no bound, so a long-running session materialized
 * every event row into the detail payload, and the branch merged trace's
 * per-session fan-out multiplied that unbounded lane. Read one past the ceiling
 * (`+ 1`, the activity-segment idiom) so the projection can DETECT a read that
 * hit the bound and surface `AgentSessionDetail.eventsTruncated` instead of
 * serving a prefix as the whole stream.
 *
 * Sizing: this lane is NOT the same cardinality as the token-event lane despite
 * sharing a value — the event stream carries per-message AND per-tool rows, so it
 * runs a small multiple of the per-response token stream and hits its ceiling on
 * a materially shorter session. 10k is chosen on its own terms, level with the
 * desktop's own per-session lifecycle-event bound
 * (`BRANCH_ANALYTICS_LIFECYCLE_EVENT_MAX_ROWS`), and is far above any real
 * session.
 *
 * ISS-5407: shared rather than owned by the cloud service, because BOTH detail
 * producers read it — the cloud `agentSessionDetailSelect` and the desktop's
 * local `mapDetail`, whose twin read was uncapped (and kept the multi-KB
 * per-event `data` blob, on the heap-capped db-host worker). One constant is what
 * keeps the two surfaces truncating at the same row and reporting it identically;
 * two parallel constants would drift. Its own lightweight module so the desktop
 * main process can import the value without pulling in the whole
 * `agent-session` type surface.
 */
export const SESSION_DETAIL_EVENT_MAX_ROWS = 10_000;
