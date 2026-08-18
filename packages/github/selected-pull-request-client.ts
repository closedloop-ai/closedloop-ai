/** The caller-authorized GitHub methods required to acquire selected-PR evidence. */
export type SelectedPullRequestOctokit = {
  rest: {
    pulls: {
      get(parameters: PullRequestParameters): Promise<{ data: unknown }>;
      listFiles(
        parameters: PullRequestFileParameters
      ): Promise<{ data: unknown }>;
    };
    repos: {
      compareCommitsWithBasehead(
        parameters: CompareCommitsParameters
      ): Promise<{ data: unknown }>;
    };
  };
};

/** Caller-authorized methods required only by selected-PR checks acquisition. */
export type SelectedPullRequestChecksOctokit = {
  graphql(
    query: string,
    parameters: SelectedPullRequestChecksGraphqlParameters
  ): Promise<unknown>;
  rest: {
    pulls: {
      get(parameters: PullRequestParameters): Promise<{ data: unknown }>;
    };
  };
};

type PullRequestParameters = {
  owner: string;
  repo: string;
  pull_number: number;
  request: { signal: AbortSignal };
};

type PullRequestFileParameters = PullRequestParameters & {
  page: number;
  per_page: number;
};

type CompareCommitsParameters = {
  owner: string;
  repo: string;
  basehead: string;
  request: { signal: AbortSignal };
};

type SelectedPullRequestChecksGraphqlParameters = {
  owner: string;
  repo: string;
  headSha: string;
  after: string | null;
  pageSize: number;
  request: { signal: AbortSignal };
};
