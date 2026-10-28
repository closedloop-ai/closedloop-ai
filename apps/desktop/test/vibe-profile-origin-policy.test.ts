import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  decideVibeProfileOrigins,
  VibeOriginVerdict,
} from "../scripts/vibe-profile/origin-policy";

const PREVIEW_API = "https://api-stage-git-feat-iss-1-x.preview.stage.example";
const PREVIEW_WEB = "https://app-stage-git-feat-iss-1-x.preview.stage.example";
const LOCAL_API = "http://localhost:3002";
const LOCAL_WEB = "http://localhost:3000";

const NOT_A_URL_RE = /--api-origin must be a URL/;
const NOT_HTTP_RE = /--api-origin must be http\(s\)/;
const API_NOT_ALLOWED_RE =
  /--api-origin must be a loopback origin or https:\/\/api-stage-git-<branch>/;
const WEB_NOT_ALLOWED_RE =
  /--web-origin must be a loopback origin or https:\/\/app-stage-git-<branch>/;
const MIXED_RE =
  /must both be loopback or both be the same stage branch preview/;
const DIFFERENT_BRANCHES_RE =
  /different branch previews \(feat-iss-1-x and other\)/;

function refusalReason(apiOrigin: string, webOrigin: string): string {
  const decision = decideVibeProfileOrigins(apiOrigin, webOrigin);
  if (decision.verdict !== VibeOriginVerdict.Refused) {
    throw new Error(`expected ${apiOrigin} + ${webOrigin} to be refused`);
  }
  return decision.reason;
}

describe("decideVibeProfileOrigins", () => {
  it("accepts every loopback host form, normalized to its origin", () => {
    assert.deepEqual(
      decideVibeProfileOrigins("http://localhost:3004/x", "http://[::1]:3005"),
      {
        verdict: VibeOriginVerdict.Loopback,
        apiOrigin: "http://localhost:3004",
        webOrigin: "http://[::1]:3005",
      }
    );
    assert.deepEqual(
      decideVibeProfileOrigins("https://127.0.0.1:3004", LOCAL_WEB),
      {
        verdict: VibeOriginVerdict.Loopback,
        apiOrigin: "https://127.0.0.1:3004",
        webOrigin: LOCAL_WEB,
      }
    );
  });

  it("accepts the api and app branch aliases of one preview", () => {
    assert.deepEqual(decideVibeProfileOrigins(PREVIEW_API, `${PREVIEW_WEB}/`), {
      verdict: VibeOriginVerdict.BranchPreview,
      apiOrigin: PREVIEW_API,
      webOrigin: PREVIEW_WEB,
      slug: "feat-iss-1-x",
    });
  });

  it("refuses a value that is not an http(s) URL", () => {
    assert.match(refusalReason("not a url", LOCAL_WEB), NOT_A_URL_RE);
    assert.match(refusalReason("file:///tmp", LOCAL_WEB), NOT_HTTP_RE);
    assert.match(refusalReason("localhost:3004", LOCAL_WEB), NOT_HTTP_RE);
  });

  it("refuses production hosts", () => {
    for (const host of [
      "https://api.closedloop.ai",
      "https://app.closedloop.ai",
      "https://api-stage-git-x.preview.closedloop.ai",
      "https://closedloop.ai",
    ]) {
      assert.match(refusalReason(host, PREVIEW_WEB), API_NOT_ALLOWED_RE, host);
    }
    assert.match(
      refusalReason(PREVIEW_API, "https://app.closedloop.ai"),
      WEB_NOT_ALLOWED_RE
    );
  });

  it("refuses stage's main hosts and per-deployment aliases", () => {
    for (const host of [
      "https://api.stage.example",
      "https://api-stage-9q0dlfca0.preview.stage.example",
      "https://api-stage-pin-git-x.preview.stage.example",
    ]) {
      assert.match(refusalReason(host, PREVIEW_WEB), API_NOT_ALLOWED_RE, host);
    }
    assert.match(
      refusalReason(PREVIEW_API, "https://app.stage.example"),
      WEB_NOT_ALLOWED_RE
    );
  });

  it("refuses look-alike preview hosts", () => {
    for (const host of [
      `${PREVIEW_API}.evil.example`,
      "https://api-stage-git-.preview.stage.example",
      "https://api-stage-git--x.preview.stage.example",
      "https://a.api-stage-git-x.preview.stage.example",
      `https://api-stage-git-${"a".repeat(50)}.preview.stage.example`,
      "https://example.com",
    ]) {
      assert.match(refusalReason(host, PREVIEW_WEB), API_NOT_ALLOWED_RE, host);
    }
  });

  it("refuses the app alias as --api-origin and the api alias as --web-origin", () => {
    assert.match(refusalReason(PREVIEW_WEB, PREVIEW_WEB), API_NOT_ALLOWED_RE);
    assert.match(refusalReason(PREVIEW_API, PREVIEW_API), WEB_NOT_ALLOWED_RE);
  });

  it("refuses a preview alias with anything beyond its bare https origin", () => {
    const host = "api-stage-git-feat-iss-1-x.preview.stage.example";
    const cases: [string, string][] = [
      [`http://${host}`, "plain http"],
      [`https://${host}:8443`, "a port"],
      [`https://user@${host}`, "userinfo"],
      [`https://user:pw@${host}`, "userinfo"],
      [`https://${host}/api`, "a path"],
      [`https://${host}/?x=1`, "a query"],
      [`https://${host}/#top`, "a fragment"],
    ];
    for (const [value, part] of cases) {
      assert.equal(
        refusalReason(value, PREVIEW_WEB),
        `--api-origin must be exactly https://${host}, without ${part}`,
        value
      );
    }
  });

  it("refuses plain http on a non-loopback host", () => {
    assert.match(
      refusalReason("http://example.com", LOCAL_WEB),
      API_NOT_ALLOWED_RE
    );
  });

  it("refuses a loopback origin paired with a preview origin, either way round", () => {
    assert.match(refusalReason(LOCAL_API, PREVIEW_WEB), MIXED_RE);
    assert.match(refusalReason(PREVIEW_API, LOCAL_WEB), MIXED_RE);
  });

  it("refuses api and app aliases of different branches", () => {
    assert.match(
      refusalReason(
        PREVIEW_API,
        "https://app-stage-git-other.preview.stage.example"
      ),
      DIFFERENT_BRANCHES_RE
    );
  });
});
