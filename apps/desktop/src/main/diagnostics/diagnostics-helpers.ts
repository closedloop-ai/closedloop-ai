/**
 * Shared diagnostics text helpers.
 */

/** Remove ANSI escape sequences from a string. */
const ANSI_PATTERN =
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}
