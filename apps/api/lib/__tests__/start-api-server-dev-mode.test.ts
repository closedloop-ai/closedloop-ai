import { describe, expect, it } from "vitest";
import { isNextDevMode } from "../start-api-server";

/**
 * ISS-10335. `startApiServer` hands this straight to `next({ dev })`, so the
 * answer decides whether the process compiles routes on demand or serves the
 * `.next` build baked into the image.
 *
 * The three rows are the three entrypoints that exist: `server:start` (the
 * Dockerfile CMD), `server:dev`, and the containerized Clerk-free API, which
 * runs the production image under `NODE_ENV=test` because
 * `AUTH_MODE=local_trusted` refuses to activate while `NODE_ENV` is production.
 * The `test` row is the one the old `!== "production"` negation got wrong.
 */
describe("isNextDevMode", () => {
  it("is dev only under NODE_ENV=development", () => {
    expect(isNextDevMode({ NODE_ENV: "development" })).toBe(true);
  });

  it("serves the build under NODE_ENV=production", () => {
    expect(isNextDevMode({ NODE_ENV: "production" })).toBe(false);
  });

  it("serves the build under NODE_ENV=test (the Clerk-free e2e API)", () => {
    expect(isNextDevMode({ NODE_ENV: "test" })).toBe(false);
  });

  it("serves the build when NODE_ENV is absent", () => {
    // A bare `node server.js` with no NODE_ENV is a deployment, not a dev loop;
    // starting a dev server there would compile from source at request time.
    expect(isNextDevMode({} as NodeJS.ProcessEnv)).toBe(false);
  });
});
