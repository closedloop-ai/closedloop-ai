/** ISS-11127: analytics-only endpoints, independent of authorize/token. */
export const DesktopSignInAnalyticsPath = {
  Register: "/desktop/analytics/sign-in/register",
  Report: "/desktop/analytics/sign-in/report",
} as const;

export type DesktopSignInAnalyticsRegistration = {
  codeChallenge: string;
  flowId: string;
};
export type DesktopSignInAnalyticsReport = { codeChallenge: string };
