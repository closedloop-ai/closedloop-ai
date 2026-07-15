export const RdsCaBundleStatus = {
  Drift: "drift",
  FetchFailed: "fetch_failed",
  InvalidBundle: "invalid_bundle",
  Match: "match",
  UnexpectedFailure: "unexpected_failure",
} as const;

export type RdsCaBundleStatus =
  (typeof RdsCaBundleStatus)[keyof typeof RdsCaBundleStatus];

export type RdsCaBundleStatusReport = {
  certificateCount?: number;
  embeddedSha256?: string;
  message: string;
  sourceUrl: string;
  status: RdsCaBundleStatus;
  upstreamSha256?: string;
};
