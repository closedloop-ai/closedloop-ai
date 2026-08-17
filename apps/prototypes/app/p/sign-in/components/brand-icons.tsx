import type { SVGProps } from "react";

// Canonical Google + GitHub brand marks now live in the design system
// (`@repo/design-system/components/ui/brand-icons`) so every sign-in surface shares
// one SVG each. Import GoogleGlyph / GitHubMark from there directly; this module
// only owns the Closedloop-specific wordmark below.

// Simplified Closedloop wordmark mark used in the top-left of the sign-in page.
export const ClosedloopMark = (props: SVGProps<SVGSVGElement>) => (
  <svg aria-hidden="true" fill="none" viewBox="0 0 24 24" {...props}>
    <circle
      className="text-primary"
      cx="12"
      cy="12"
      r="8.5"
      stroke="currentColor"
      strokeDasharray="40 14"
      strokeLinecap="round"
      strokeWidth="3"
    />
    <circle className="fill-primary" cx="19.5" cy="6" r="2.6" />
  </svg>
);
