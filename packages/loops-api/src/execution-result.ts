/**
 * The characters this repo's branch names actually use. Deliberately narrower
 * than `git check-ref-format`, which also admits `@`, so `@@@` stays refused
 * (ISS-7567) — but it must not refuse a ref developers really push. `+` is
 * legal in a git ref and `worktree-kerensa+quoted-text-comments-poc` is on
 * `origin`; without it, `staging-integration-tests.yml` POSTs that ref to
 * `/preview-schemas/ensure` and the 400 reds the deploy job (review: whitlockk).
 */
export const BRANCH_NAME_REGEX = /^[A-Za-z0-9+._/-]+$/;
