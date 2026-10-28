/**
 * The desktop sidebar's invite affordance label (ISS-10362).
 *
 * ITS OWN CONSTANT, and deliberately NOT shared with the dialog it opens. The
 * shared `InviteTeamDialog`'s title happens to read the same words today, and
 * the e2e spec asserts the footer row's ABSENCE against this label and the
 * dialog's PRESENCE against that one. Pinning both to a single symbol would
 * make rewording either of them silently satisfy the absence assertion off the
 * other's string — an absence assertion that matches nothing always passes, so
 * the regression it exists to catch (the footer row coming back) would sail
 * through. Separate owners, separate constants.
 *
 * `src/shared` rather than the component's own module so the Playwright e2e
 * spec can import it without pulling the renderer's React tree into the test
 * process.
 */
export const DESKTOP_SIDEBAR_INVITE_LABEL = "Invite your team";
