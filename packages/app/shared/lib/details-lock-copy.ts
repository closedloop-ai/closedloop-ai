/**
 * The lock wording for a value git, the provider, the harness or the platform
 * writes — read by the Branch and Session Details hosts' `automaticField`
 * (ISS-12470) and by `ARTIFACT_STATUS_READ_ONLY_COPY`'s `MachineWritten` entry,
 * so a changed sentence cannot reach only one of them.
 *
 * It sits here rather than beside the `DetailsReadOnlyReason` type it rides,
 * because that type lives in the `preview/details-design` tree and production
 * hosts must not source user-visible copy from preview (operator ruling,
 * 2026-10-14, on PR #8810).
 */
export const automaticReason =
  "Set automatically, so it cannot be changed here.";
