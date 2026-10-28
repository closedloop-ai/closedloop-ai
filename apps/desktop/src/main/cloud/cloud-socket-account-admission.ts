import {
  type DesktopAccountAdmission,
  isSameDesktopAccountAdmission,
} from "../session/desktop-account-admission.js";

export type { DesktopAccountAdmission } from "../session/desktop-account-admission.js";

/** Checks an async socket callback against the account generation that started it. */
export function isCloudSocketAccountAdmitted(
  captured: DesktopAccountAdmission | null,
  getCurrent?: () => DesktopAccountAdmission | null
): boolean {
  return !getCurrent || isSameDesktopAccountAdmission(captured, getCurrent());
}
