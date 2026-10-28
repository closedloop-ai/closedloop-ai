import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import {
  GitHubMark,
  GoogleGlyph,
} from "@repo/design-system/components/ui/brand-icons";
import type { ComponentType, SVGProps } from "react";

type SignInProviderMark = ComponentType<SVGProps<SVGSVGElement>>;

/**
 * Brand mark per sign-in provider. Owned here rather than by either surface so
 * the onboarding auth transition and the Settings Profile sign-in rows
 * (ISS-8364) show the same glyph for the same provider — a second copy is how
 * the two would drift.
 *
 * Typed as an exhaustive `Record` over {@link DesktopSignInProvider}: a new
 * provider fails `tsc` here instead of silently rendering no mark.
 */
export const SIGN_IN_PROVIDER_MARK = {
  [DesktopSignInProvider.GitHub]: GitHubMark,
  [DesktopSignInProvider.Google]: GoogleGlyph,
} as const satisfies Record<DesktopSignInProvider, SignInProviderMark>;
