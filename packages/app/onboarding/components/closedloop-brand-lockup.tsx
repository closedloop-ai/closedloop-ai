type ClosedloopMarkProps = {
  /** Sizing utilities for the SVG root. Defaults to the sidebar's size. */
  className?: string;
};

type ClosedloopBrandLockupProps = {
  /** Wrapper utilities, for a host that needs its own spacing. */
  className?: string;
  /** Sizing utilities for the mark. Defaults to the approved lockup size. */
  markClassName?: string;
};

/**
 * The Closedloop brand mark.
 *
 * ISS-11470: hoisted here from `apps/desktop/src/renderer/components/layout/`.
 * It lived under the desktop renderer, which `apps/app` cannot import, so the
 * web onboarding host had no mark to reach and fell back to a bare
 * `<span>Closedloop.ai</span>` — leaving each shell with a different HALF of the
 * same lockup. Owning it in `packages/app` is what lets both pass the same
 * component; it is not design-system code, because a Closedloop logo is not
 * project-agnostic. It sits in the onboarding slice rather than `shared/`
 * because `shared/` is reserved for cross-FEATURE code and every consumer of
 * this lockup is an onboarding host — being used by two SHELLS is not the same
 * thing (`packages/app/AGENTS.md` -> File Organization).
 *
 * Re-inlining the paths in a second production component would be the
 * SSOT-drift-by-copy this repo calls out by name: the accent stop is a literal
 * brand color rather than a theme token, so two copies drift silently the first
 * time the brand moves.
 *
 * The literal `#41A3FF` is deliberate and not a token violation — a logo is
 * fixed artwork, not themed surface, and it must render identically in light and
 * dark. The other path takes `currentColor` so the mark inherits whatever it
 * sits on.
 *
 * `aria-hidden` is load-bearing for {@link ClosedloopBrandLockup}: the mark
 * contributes no accessible name, so the adjacent wordmark is the single
 * announcement rather than a duplicate of it.
 */
export function ClosedloopMark({ className = "size-4" }: ClosedloopMarkProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      viewBox="0 0 100 100"
    >
      <path
        d="M0.424623 49.6765C0.339767 56.2176 1.55939 62.7103 4.01272 68.7779C6.46604 74.8455 10.1042 80.3673 14.7161 85.0227C19.3281 89.6781 24.8219 93.3744 30.8788 95.8973C36.9358 98.4202 43.4352 99.7193 50 99.7193C56.5648 99.7193 63.0643 98.4202 69.1212 95.8973C75.1782 93.3744 80.672 89.6781 85.2839 85.0227C89.8958 80.3673 93.534 74.8455 95.9873 68.7779C98.4406 62.7103 99.6603 56.2176 99.5754 49.6765C99.5754 49.5115 99.5754 49.3546 99.5754 49.1895H71.7496C71.7496 49.3546 71.7496 49.5115 71.7496 49.6765C71.7496 53.9658 70.473 58.1587 68.0814 61.7249C65.6898 65.2912 62.2906 68.0706 58.3136 69.7117C54.3367 71.3527 49.9606 71.7817 45.739 70.9443C41.5174 70.1069 37.6398 68.0408 34.5966 65.0072C31.5535 61.9737 29.4815 58.109 28.6428 53.902C27.804 49.695 28.2361 45.3346 29.8845 41.3723C31.5329 37.4101 34.3235 34.0239 37.9033 31.6421C41.4831 29.2603 45.6914 27.9899 49.9959 27.9915H50.0704L50.0373 0.280626C43.524 0.275203 37.0735 1.54886 31.0545 4.02881C25.0354 6.50876 19.5659 10.1464 14.9583 14.7338C10.3508 19.3211 6.69575 24.7683 4.20197 30.764C1.70819 36.7597 0.424621 43.1863 0.424623 49.6765Z"
        fill="currentColor"
      />
      <path
        d="M57.1534 0.801147V29.2137C60.1811 30.2616 62.939 31.9629 65.2303 34.1961C67.5215 36.4293 69.2895 39.1392 70.4077 42.1323H99.004C97.3792 31.6897 92.4381 22.0411 84.906 14.6024C77.3738 7.16375 67.6471 2.32669 57.1534 0.801147Z"
        fill="#41A3FF"
      />
    </svg>
  );
}

/**
 * The approved brand lockup: the mark and the "Closedloop.ai" wordmark together.
 *
 * ISS-11470. The prototype
 * (`apps/prototypes/app/p/web-onboarding-flow/components/auth-card.tsx`) pairs
 * them; production shipped neither shell that way — web passed the wordmark with
 * no mark, desktop the mark with no wordmark. Both onboarding hosts now pass
 * THIS, so the two surfaces cannot drift apart again by each building their own.
 *
 * The wordmark is real text, not artwork: it stays selectable and readable, and
 * it is the lockup's only accessible name because the mark is `aria-hidden`.
 */
export function ClosedloopBrandLockup({
  className = "flex items-center gap-2",
  markClassName = "size-7",
}: ClosedloopBrandLockupProps) {
  return (
    <div className={className}>
      <ClosedloopMark className={markClassName} />
      <span className="font-semibold text-lg tracking-tight">
        Closedloop.ai
      </span>
    </div>
  );
}
