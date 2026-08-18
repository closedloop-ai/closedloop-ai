import type { SVGProps } from "react";

// Third-party brand marks that lucide-react does not ship an accurate glyph for.
// These are generic, project-agnostic logos (not Closedloop domain concepts), so
// they belong in the design system and are shared by every sign-in surface
// (web sign-in, desktop onboarding) plus the prototypes — one canonical SVG each
// instead of a byte-for-byte copy per file.

// Multi-color Google "G". lucide has no brand-accurate Google logo, so this is
// the official mark. Defaults to 16px to match the sign-in button icons; pass
// width/height or className to override.
export function GoogleGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      height="16"
      viewBox="0 0 24 24"
      width="16"
      {...props}
    >
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09a6.6 6.6 0 0 1 0-4.18V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84Z"
        fill="#FBBC05"
      />
      <path
        d="M12 4.75c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 1.46 14.97.5 12 .5A11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 6.68 9.14 4.75 12 4.75Z"
        fill="#EA4335"
      />
    </svg>
  );
}

// Solid GitHub "invertocat" mark. lucide-react's `Github` is a line-art outline
// (the octocat silhouette with no filled body), so it reads as hollow on a
// filled primary button; this is the official filled mark that reads as a logo.
export function GitHubMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      fill="currentColor"
      height="16"
      viewBox="0 0 24 24"
      width="16"
      {...props}
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}
