import type { LoopRequestBody } from "@closedloop-ai/loops-api/desktop-request";

/**
 * Asserts at compile time that every key named below really exists on the
 * canonical wire contract. `Omit`/`Extract` accept keys that do not exist and
 * silently no-op, which would let a rename quietly disable a projection; the
 * `K extends keyof T` constraint turns that into a `tsc` error instead.
 */
type CanonicalKey<K extends keyof LoopRequestBody> = K;

/** Fields the dispatcher always sends, even though Desktop tolerates absence. */
type DispatcherRequiredKey = CanonicalKey<"apiBaseUrl">;

/**
 * Fields the dispatcher always sends but may send as an explicit `null`.
 *
 * This is the only place the producer's projection of the wire contract differs
 * from the Desktop parser's, and it is stated once rather than by re-declaring
 * the payload. Desktop keeps reading these as optional because an older
 * dispatcher can omit them entirely.
 */
type DispatcherNullableKey = CanonicalKey<
  | "artifactSlug"
  | "committer"
  | "localRepoPath"
  | "parentBranchName"
  | "parentLoopId"
  | "parentSessionId"
  | "prompt"
  | "repo"
>;

/** Fields the dispatcher sources from a broader upstream type than Desktop parses. */
type DispatcherWidenedKey = CanonicalKey<"artifacts">;

type LoopRequestArtifact = LoopRequestBody["artifacts"][number];

/**
 * Typed body for the symphony_loop relay operation dispatched to the
 * electron harness via the desktop gateway. Used by loop-desktop.ts when
 * building the POST body for the /api/gateway/symphony/loop endpoint.
 *
 * ISS-5154 (review on #4447): this is DERIVED from `LoopRequestBody`, the one
 * canonical declaration of the wire contract, which lives in
 * `@closedloop-ai/loops-api/desktop-request` because that is the package the Desktop
 * gateway parses the payload with (`packages/api` already depends on
 * `@closedloop-ai/loops-api`, so the contract cannot live here without a cycle).
 *
 * It used to be a second, independent declaration of the same payload, and that
 * split is exactly how `s3StateKey` and `branchMaterialization` reached the
 * producer and the runtime without ever reaching the Desktop parser's type.
 * Deriving it means the next field cannot be added to the producer without
 * being added to the canonical contract first: an unknown key in the
 * `satisfies LoopBody` literal in `buildDesktopLoopExecutionBody` is a
 * compile error, and the canonical contract's own schema-coverage guard then
 * forces the field into `LoopRequestBodySchema` too.
 */
export type LoopBody = Omit<
  LoopRequestBody,
  DispatcherNullableKey | DispatcherRequiredKey | DispatcherWidenedKey
> &
  Required<Pick<LoopRequestBody, DispatcherRequiredKey>> & {
    [K in DispatcherNullableKey]-?: NonNullable<LoopRequestBody[K]> | null;
  } & {
    /**
     * The dispatcher forwards context-pack artifacts whose `type` is the
     * upstream open `string`; Desktop narrows it to `LoopArtifactType` at the
     * parse boundary. Every other member stays derived from the contract.
     */
    artifacts: Array<Omit<LoopRequestArtifact, "type"> & { type: string }>;
  };
