/**
 * ISS-12535 (PRD-807, data controls): who an explicitly shared session is
 * visible to. Exactly the two audiences the ISS-12533 share review sheet
 * offers (ISS-12533 thread th_uEmQBXTwNEUqEdCFgl_sd, PRD-796 open question),
 * with the same string values.
 *
 * A dependency-free leaf in shared/ so the policy view's exception list and
 * the share review sheet can name the same audiences without importing each
 * other. The sheet (PR #8845) is not on main yet and still declares its own
 * `ShareAudience` with these values; when it lands it can import this one
 * instead, and nothing that stores an audience has to change.
 */
export const ShareAudience = {
  OnlyMe: "only-me",
  Organization: "organization",
} as const;
export type ShareAudience = (typeof ShareAudience)[keyof typeof ShareAudience];
