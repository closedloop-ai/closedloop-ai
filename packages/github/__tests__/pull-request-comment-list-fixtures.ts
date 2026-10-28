/** REST list fixtures shared by the pull request comment list suites. */
export function makeIssueComments(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    node_id: `IC_${index + 1}`,
    user: null,
    body: "issue body",
    author_association: "CONTRIBUTOR",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/acme/repo/pull/42#issuecomment-${index + 1}`,
  }));
}

export function makeReviewComments(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    node_id: `PRRC_${index + 1}`,
    path: "src/index.ts",
    line: 20,
    side: "RIGHT",
    start_line: null,
    start_side: null,
    original_line: 20,
    original_start_line: null,
    body: "review body",
    user: null,
    author_association: "MEMBER",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/acme/repo/pull/42#discussion_r${index + 1}`,
    commit_id: "abc123",
    pull_request_review_id: 456,
    in_reply_to_id: null,
  }));
}

export function makeReviews(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    user: null,
    state: "COMMENTED",
    body: "review body",
    submitted_at: "2026-01-01T00:00:00Z",
    html_url: `https://github.com/acme/repo/pull/42#pullrequestreview-${index + 1}`,
  }));
}

/** A paginated GitHub list endpoint over `rows`, honoring `page` and `per_page`. */
export function servePages<T>(rows: T[]) {
  return ({ page, per_page: perPage }: { page: number; per_page: number }) =>
    Promise.resolve({
      data: rows.slice((page - 1) * perPage, page * perPage),
    });
}
