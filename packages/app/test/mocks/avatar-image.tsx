type AvatarModule = typeof import("@repo/design-system/components/ui/avatar");

/**
 * Shared `vi.mock` factory for `@repo/design-system/components/ui/avatar` that
 * replaces ONLY `AvatarImage`.
 *
 * Radix's `AvatarImage` gates its commit on a real image LOAD, and jsdom never
 * loads one — measured, not assumed: rendering an avatar unmocked yields
 * `container.querySelectorAll("img").length === 0`, so any assertion about the
 * photo's `alt` passes vacuously in BOTH directions. Every suite that asserts
 * what an avatar contributes to the accessibility tree needs this, so it lives
 * here rather than being re-pasted per file (ISS-7441 review).
 *
 * The stand-in is prop-for-prop what Radix itself renders once loaded
 * (`<Primitive.img {...imageProps} />`, i.e. a bare `<img>` carrying the `alt`
 * and `src` it was handed) — EXCEPT when `src` is falsy, which real Radix
 * never "loads" and so never renders as an `<img>` either. An EMPTY string
 * counts as absent, matching the collaboration mock: fixtures already carry
 * `avatarUrl: ""`, and a mock that rendered an `<img src="">` for one while
 * Radix took the fallback would let those suites pass against the wrong DOM
 * (whitlockk, PR #7393). (ISS-8972:
 * `AvatarImage` is now always mounted with a possibly-undefined `src`, never
 * conditionally mounted by its caller, so this mock is what decides whether a
 * picture rendered — the caller no longer does). The single thing it drops
 * for a REAL `src` is the load gate — which is precisely what jsdom cannot
 * supply, and the reason the real `AvatarFallback` still renders alongside
 * the photo where production would hide it. `Avatar` and `AvatarFallback`
 * come through `importOriginal` untouched.
 *
 * It forwards only `alt` and `src` — no rest spread — so an `aria-label` added
 * to a component under test never reaches this DOM. That bound is deliberate
 * and load-bearing (whitlockk, PR #5531): a suite using this mock cannot claim an
 * avatar is nameless however the name is spelled, only that it carries no
 * `alt`. The unfiltered claim belongs to an e2e driving real Radix —
 * `e2e/document-activity-actor-kind.spec.ts` for `ActivityActor`,
 * `e2e/sessions-owner-avatar-name.spec.ts` for `CommentAvatar`.
 *
 * So a suite importing this mock must scope its own wording to `alt` and say
 * which e2e owns the rest. Claiming "unfiltered" over this stand-in is the
 * false-green this bound exists to make impossible (whitlockk, PR #6640).
 *
 * ```ts
 * vi.mock("@repo/design-system/components/ui/avatar", avatarImageMockModule);
 * ```
 */
export async function avatarImageMockModule(
  importOriginal: <T>() => Promise<T>
) {
  return {
    ...(await importOriginal<AvatarModule>()),
    AvatarImage: ({ alt, src }: { alt: string; src?: string }) =>
      src ? (
        // biome-ignore lint/performance/noImgElement: must be the raw element Radix itself renders — a next/image wrapper would not carry the alt through verbatim, which is the whole subject.
        // biome-ignore lint/correctness/useImageSize: a test double for a node the DS sizes with a class; dimensions would be fiction and no consumer measures layout.
        <img alt={alt} src={src} />
      ) : null,
  };
}
