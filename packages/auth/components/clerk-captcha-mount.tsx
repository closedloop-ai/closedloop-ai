/**
 * The DOM element Clerk's Smart CAPTCHA widget mounts into.
 *
 * ISS-11429. Clerk's bot protection needs an element with this exact id to be
 * in the document when a CUSTOM sign-up flow runs. The prebuilt `<SignUp>`
 * embed renders its own, so the dedicated `/sign-up` page never needed one —
 * but the custom flows do not, and on the prod host over 14 days
 * `Cannot initialize Smart CAPTCHA widget because the 'clerk-captcha' DOM
 * element was not found; falling back to …` fired on `/sso-callback` for two
 * separate sessions, with no element of this id anywhere in the repo.
 *
 * "Falling back to" is the part that matters: Clerk does not fail, it silently
 * downgrades to its invisible widget, so the flow keeps working until the
 * challenge is one the invisible widget cannot serve. Mounting the element is
 * what makes the outcome DETERMINISTIC rather than dependent on which challenge
 * the account happens to draw.
 *
 * The id is Clerk's contract, not ours, which is why it is a named constant
 * here and not a literal at two call sites.
 */
export const CLERK_CAPTCHA_ELEMENT_ID = "clerk-captcha";

/**
 * Renders nothing visible. It is a mount point, so it carries no copy, no
 * spacing and no role — Clerk owns whatever it puts inside, and an empty
 * container with a visible box would read as a broken widget on the many flows
 * where no challenge is ever served.
 */
export const ClerkCaptchaMount = () => <div id={CLERK_CAPTCHA_ELEMENT_ID} />;
