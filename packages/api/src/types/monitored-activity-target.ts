import { ArtifactRefTargetKind } from "./session-artifact-link.ts";

/** The Branch or PR a monitored-activity carrier is attached to. */
export type MonitoredActivityTarget =
  | {
      kind: typeof ArtifactRefTargetKind.Branch;
      repositoryFullName: string;
      branchName: string;
    }
  | {
      kind: typeof ArtifactRefTargetKind.PullRequest;
      repositoryFullName: string;
      prNumber: number;
    };

/**
 * Stable target identity shared by the cloud's resolution and quarantine and
 * by the desktop's sync paging: two refs that the cloud reconciles as one
 * target must page as one target, so both sides derive the key here.
 *
 * Its own module rather than `session-monitored-activity.ts` because that file
 * is imported by `session-artifact-link.ts` for the carrier schema; importing
 * `ArtifactRefTargetKind` back from there would close a cycle.
 */
export function monitoredActivityTargetKey(
  target: MonitoredActivityTarget
): string {
  return target.kind === ArtifactRefTargetKind.Branch
    ? `branch:${target.repositoryFullName}:${target.branchName}`
    : `pull_request:${target.repositoryFullName}#${target.prNumber}`;
}

/**
 * Where a monitored target lives on the provider, or ABSENT when the target
 * names no location a URL can express.
 *
 * Derived from the target rather than taken from the producer, for the reason
 * `pullRequestRefDetailData` derives `htmlUrl` server-side: a compromised
 * producer must not be able to plant an arbitrary href on a record the product
 * renders as a link.
 *
 * Only the `https://github.com/` prefix is this repo's; everything after it is
 * producer-controlled. `repositoryFullName` is bounded at the wire by LENGTH
 * alone (`session-artifact-link.ts`) and normalized only for case, whitespace
 * and `.git`, so `acme/repo?x=1` and `acme/repo/../../other/repo` both reach
 * here intact — and interpolated raw the second resolves to a repository the
 * target never named, which is the forgery this derivation exists to prevent.
 *
 * Two shapes have no href at all rather than a best-effort one: a name the URL
 * parser erases ({@link repositoryUrlPath}) and one `encodeURIComponent` cannot
 * encode ({@link encodedPathSegment}). Withholding the LINK withholds nothing
 * else — the caller files `repositoryFullName` verbatim beside it — and the
 * operand that is missing is real: a name that cannot occupy a path segment
 * has no address on the provider to point at.
 *
 * `branchName` needs only escaping, because {@link repositoryUrlPath} has
 * already fixed the segments ahead of it: whether they are two or one, the
 * furthest a dot segment here can walk is back to what those segments named.
 */
export function monitoredActivityTargetUrl(
  target: MonitoredActivityTarget
): string | undefined {
  const repositoryPath = repositoryUrlPath(target.repositoryFullName);
  if (repositoryPath === undefined) {
    return undefined;
  }
  if (target.kind === ArtifactRefTargetKind.PullRequest) {
    return `https://github.com/${repositoryPath}/pull/${target.prNumber}`;
  }
  const branchSegment = encodedPathSegment(target.branchName);
  if (branchSegment === undefined) {
    return undefined;
  }
  return `https://github.com/${repositoryPath}/tree/${branchSegment}`;
}

/**
 * The `owner/repo` portion of the path: two escaped segments when the name is
 * one, otherwise the whole name escaped into a SINGLE segment — and `undefined`
 * when no segment it would emit survives the URL parser.
 *
 * Escaping alone cannot make the fallback safe. `encodeURIComponent` leaves `.`
 * untouched, and percent-encoding it does not help either — the URL Standard
 * matches `%2e%2e` as a double-dot segment exactly as it matches `..`, which
 * `new URL("https://github.com/a/%2E%2E/b").pathname` shows as `/b`. So what
 * disarms a dot segment is having no segment boundary to operate across, which
 * is what collapsing a malformed name to one segment buys. The resulting link
 * 404s, and 404 is the truth about a name that is not a repository.
 *
 * A name that is ITSELF a dot segment gets nothing from that collapse: there is
 * no boundary left to deny it, and the parser erases the only segment there is,
 * promoting the `/pull/<n>` behind it to the front — `".."` resolved `/pull/5`,
 * naming the repository `pull/5` rather than 404ing on the one the target
 * claimed. No escaping produces a segment the parser keeps, so such a name is
 * reported as locating nothing instead of as locating something else. The check
 * runs on every segment this emits, because the erasure does not care which
 * branch above produced it.
 */
function repositoryUrlPath(repositoryFullName: string): string | undefined {
  const segments = repositoryFullName.split("/");
  const namesOneRepository =
    segments.length === 2 &&
    segments.every(
      (segment) => segment.length > 0 && !DOT_ONLY_SEGMENT_RE.test(segment)
    );
  const parts = namesOneRepository ? segments : [repositoryFullName];
  const encoded: string[] = [];
  for (const part of parts) {
    const segment = encodedPathSegment(part);
    if (
      segment === undefined ||
      segment.length === 0 ||
      ERASED_PATH_SEGMENT_RE.test(segment)
    ) {
      return undefined;
    }
    encoded.push(segment);
  }
  return encoded.join("/");
}

/**
 * One producer-controlled value as a path segment, or `undefined` when it has
 * no encoding at all.
 *
 * `encodeURIComponent` THROWS `URIError` on a lone surrogate, which JSON admits
 * and the wire schema's length bound does not exclude. The caller runs inside
 * the session sync transaction, so a throw here rolls back a whole delivery and
 * does it again on every redelivery — a poison pill, not a rejection. A name
 * UTF-8 cannot represent locates nothing, which is an answer the caller can
 * file.
 */
function encodedPathSegment(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch {
    return undefined;
  }
}

const DOT_ONLY_SEGMENT_RE = /^\.+$/;

/**
 * The two segments the URL parser removes from a path. Matched against the
 * ENCODED segment, which is why the percent spellings the URL Standard also
 * removes (`%2e`, `%2e%2e`, `.%2e`) cannot reach it: `encodeURIComponent`
 * escapes a literal `%` to `%25` first, so `"%2e%2e"` emits `%252e%252e` and
 * resolves intact. Three or more dots is not a dot segment and keeps its link.
 */
const ERASED_PATH_SEGMENT_RE = /^\.{1,2}$/;

/**
 * How the cloud's ingest classifier settled a monitored target no delivery
 * resolved.
 *
 * Here rather than beside the classifier in `apps/api` because it crosses a
 * package boundary: it is the `disposition` of a
 * `MonitoredActivityRetainedSnapshot`, and `packages/api/AGENTS.md` holds a
 * nested structured payload value to the same rule as any other contract
 * value — define it here and import the const members everywhere. The
 * classifier imports them back.
 *
 * Only the vocabulary moves. Which member is terminal and which still holds a
 * Session's acknowledgement stays server-side, keyed off the classifier's own
 * exhaustive `Record`: that answer is about the cloud's retry behaviour, not
 * about what a reader of the row is being told.
 */
export const MonitoredTargetDisposition = {
  IntentionallyAbsent: "intentionally_absent",
  /**
   * The PR lane would have materialized this target on this delivery and the
   * organization cannot fetch the repository, so no delivery ever will.
   *
   * Acknowledged on exactly the same terms as `IntentionallyAbsent` and split
   * out of it for attribution only (ISS-9182 review r4053480710): the two are
   * different facts — one is the provider saying no such PR exists, the other
   * is a PR that may well exist behind a read this lane cannot perform — and
   * PLN-2061 M2 discards the desktop's evidence for both, so telling them
   * apart after the fact must not require a database query.
   */
  RepositoryUnfetchable: "repository_unfetchable",
  RepositoryOutOfScope: "repository_out_of_scope",
  RepositoryIdentityUnknown: "repository_identity_unknown",
  AuthorityConflict: "authority_conflict",
  ProviderIdentityAmbiguous: "provider_identity_ambiguous",
  TargetNotMaterialized: "target_not_materialized",
  /**
   * ISS-11427: a disposition that WAS retry-owned, held past the wall-clock
   * ceiling and resolved by the server instead of being left to the desktop's
   * bounded `ack_omitted` budget.
   *
   * Never returned by `classifyTarget` — it is substituted for the classified
   * disposition per CANDIDATE, over a retry-owned disposition only. The ceiling
   * is measured from the later of the cloud's own hold start and the activity's
   * `occurredAt`, and because `retryRequired` is ONE boolean per session, a
   * single held candidate past it expires every held sibling on that delivery.
   * The rationale, the ceiling, and why the substitution loses nothing live on
   * `apps/api/app/agent-sessions/service/monitored-activity-hold-ceiling.ts`.
   */
  HoldExpired: "hold_expired",
} as const;
export type MonitoredTargetDisposition =
  (typeof MonitoredTargetDisposition)[keyof typeof MonitoredTargetDisposition];

/**
 * How a `HoldExpired` retained row expired (#8737, operator ruling 2026-10-12:
 * "Give B its own hold"). `OwnAge`: the candidate's own hold ran past the
 * ceiling, so a later delivery settles its target without holding it again.
 * `Escalation`: the whole-session escalation swept it in beside another
 * target, so a later delivery gives it a fresh hold. Absent on rows written
 * before the field existed, and read as `OwnAge`, so those stay settled.
 */
export const MonitoredHoldExpiryCause = {
  OwnAge: "own_age",
  Escalation: "escalation",
} as const;
export type MonitoredHoldExpiryCause =
  (typeof MonitoredHoldExpiryCause)[keyof typeof MonitoredHoldExpiryCause];
