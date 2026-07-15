/** Security modes reported through the Desktop gateway runtime-status contract. */
export const ConnectionSecurityMode = {
  Enhanced: "enhanced",
  SigningUnavailable: "signing_unavailable",
  Standard: "standard",
  Unconfigured: "unconfigured",
} as const;

export type ConnectionSecurityMode =
  (typeof ConnectionSecurityMode)[keyof typeof ConnectionSecurityMode];

/** User-visible gateway connection security status for Desktop settings. */
export type ConnectionSecurityStatus = {
  detail: string;
  mode: ConnectionSecurityMode;
};
