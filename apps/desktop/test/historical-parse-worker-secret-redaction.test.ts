import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  boundedDiagnosticText,
  createHistoricalWorkerStderrSummarizer,
} from "../src/main/collectors/engine/historical-parse-worker-diagnostics.js";
import { HistoricalParseWorkerLimits } from "../src/main/collectors/engine/historical-parse-worker-limits-and-clamping.js";

/**
 * ISS-6898. The historical-parse worker's stderr/diagnostic sanitizer used to
 * carry its OWN credential alternation — six regexes — instead of deriving from
 * `SECRET_VALUE_REPLACE_PATTERN`, the telemetry redaction SSOT. Seven families
 * therefore reached `this.log(summary)` verbatim out of worker stderr, on a
 * worker whose input corpus is agent transcripts.
 *
 * These tests drive the PRODUCTION entry points — `createHistoricalWorkerStderrSummarizer`
 * (what the runner's stderr pipe calls, review of PR #6476) and
 * `boundedDiagnosticText` (the thrown-error path in
 * `historical-parse-worker-protocol.ts`) — never the redactor directly, so a
 * family the sanitizer does not know shows up here as a leak rather than as an
 * untested regex. Every family below therefore runs through the accumulator, not
 * through a single-chunk shape no caller produces.
 *
 * Every fixture is checked ONE FAMILY PER CALL. The stderr preview is capped at
 * 512 bytes, so a single blob carrying every family would be truncated and the
 * suite would go green on bytes that were merely cut off rather than redacted.
 * `previewIsWhole` pins that the cap never did the work.
 *
 * Failure output carries family LABELS only. An `assert.ok(!summary.includes(secret))`
 * message would print the credential into stdout and the CI log; these compare
 * booleans and report the label.
 */

/**
 * One synthetic credential per family this sink must scrub. Every value is
 * obviously fake (`SYNTHETIC` + filler) while still matching the real provider
 * grammar, so it exercises the same alternative a live credential would.
 *
 * All but the last come from `SECRET_VALUE_REPLACE_PATTERN`. `AKIA` is the one
 * rule this sink deliberately keeps of its own, because the shared telemetry
 * vocabulary does not carry AWS — so it needs pinning here or a future
 * "derive everything from the SSOT" cleanup silently deletes it.
 */
const SECRET_FAMILIES = [
  // The seven ISS-6898 named as escaping.
  {
    label: "ya29 (google access token)",
    secret: "ya29.SYNTHETIC0000000000000000",
  },
  {
    label: "1// (google refresh token)",
    secret: "1//SYNTHETIC00000000000000000000",
  },
  {
    label: "glpat (gitlab pat)",
    secret: "glpat-SYNTHETIC00000000000000000000",
  },
  {
    label: "npm_ (npm token)",
    secret: "npm_SYNTHETIC00000000000000000000",
  },
  {
    label: "re_ (resend key)",
    secret: "re_SYNTHETIC0000000000",
  },
  {
    label: "sk_live (stripe)",
    secret: "sk_live_SYNTHETIC0000000000",
  },
  {
    label: "sk_test (stripe)",
    secret: "sk_test_SYNTHETIC0000000000",
  },
  {
    label: "ghu (github user-to-server)",
    secret: "ghu_SYNTHETIC00000000000000000000",
  },
  // The families the six deleted local regexes already covered, at the shapes a
  // real provider issues. These pin that the swap did not TRADE coverage at
  // those shapes. They are not evidence of a pure widening — the sanitizer's
  // header states the three places the SSOT is narrower than the local rules
  // were (the `Bearer` and Slack length floors, and `?`/`#` in a URL password),
  // and those are the SSOT's adjudicated judgement, not something this suite
  // re-litigates.
  {
    label: "sk- (openai)",
    secret: "sk-proj-SYNTHETIC000000000000",
  },
  {
    label: "ghp (github pat)",
    secret: "ghp_SYNTHETIC00000000000000000000",
  },
  {
    label: "github_pat (fine-grained)",
    secret: "github_pat_SYNTHETIC11AAAAAAAAAAAAAAAAAAAAAAAA",
  },
  {
    label: "xoxb (slack)",
    secret: "xoxb-000000000000-000000000000-SYNTHETICabcdefgh",
  },
  {
    label: "AKIA (aws access key)",
    secret: "AKIASYNTHETIC0000000",
  },
] as const;

/** `Bearer <token>` and `scheme://user:pass@` only redact in their real form. */
const CONTEXTUAL_SECRETS = [
  {
    label: "Bearer header credential",
    secret: "SYNTHETICbearertokenvalue0000",
    render: (secret: string) => `Bearer ${secret}`,
  },
  {
    label: "URL userinfo credential",
    secret: "SYNTHETICurlpassword0000",
    render: (secret: string) =>
      `connect failed: postgres://svc:${secret}@db.internal:5432/app`,
  },
] as const;

const REDACTED_TOKEN_SEGMENT = "[redacted-token]";
/** One base64 line of an (unterminated) PEM private-key block. */
const PEM_BODY_LINE =
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQSYNTHETICKEY00";
const SUMMARY_PREFIX_PATTERN =
  /^historical parse worker stderr \(\d+ bytes\): /;

/**
 * The preview is byte-capped, so a fixture that gets truncated would pass the
 * leak assertion for the wrong reason. Every case asserts this first.
 */
function previewIsWhole(summary: string): boolean {
  return (
    !summary.endsWith("...") &&
    Buffer.byteLength(summary.replace(SUMMARY_PREFIX_PATTERN, ""), "utf8") <
      HistoricalParseWorkerLimits.maxWorkerStderrPreviewBytes
  );
}

/**
 * Throws rather than asserts, so the two preconditions can live here instead of
 * being restated in every case: `noMisplacedAssertion` forbids an assertion
 * outside a test body, and a thrown error reddens the case just the same.
 */
function summarizeOrThrow(line: string): string {
  // The trailing newline makes the fixture ONE complete run, so the accumulator
  // summarizes it now rather than holding it for a terminator that never comes.
  const summary = createHistoricalWorkerStderrSummarizer().push(
    Buffer.from(`${line}\n`)
  );
  if (summary === null) {
    throw new Error("expected a stderr summary, got the ignorable-noise null");
  }
  if (!previewIsWhole(summary)) {
    throw new Error("fixture hit the byte cap — truncated, not redacted");
  }
  return summary;
}

describe("historical parse worker stderr secret redaction (ISS-6898)", () => {
  for (const family of SECRET_FAMILIES) {
    test(`redacts ${family.label} out of worker stderr`, () => {
      const summary = summarizeOrThrow(
        `parse failed: unexpected token ${family.secret}`
      );

      assert.equal(
        summary.includes(family.secret),
        false,
        `${family.label} survived into the stderr summary`
      );
      assert.ok(summary.includes(REDACTED_TOKEN_SEGMENT));
      assert.ok(summary.includes("parse failed"));
    });

    test(`redacts ${family.label} out of a thrown-error diagnostic`, () => {
      const bounded = boundedDiagnosticText(
        `worker threw: Error: bad credential ${family.secret}`
      );

      assert.equal(
        bounded.includes(family.secret),
        false,
        `${family.label} survived into the bounded diagnostic`
      );
      assert.ok(bounded.includes(REDACTED_TOKEN_SEGMENT));
    });
  }

  for (const family of CONTEXTUAL_SECRETS) {
    test(`redacts ${family.label} out of worker stderr`, () => {
      const summary = summarizeOrThrow(family.render(family.secret));

      assert.equal(
        summary.includes(family.secret),
        false,
        `${family.label} survived into the stderr summary`
      );
      assert.ok(summary.includes(REDACTED_TOKEN_SEGMENT));
    });
  }

  test("a credentialed URL keeps the host and path a connection failure needs", () => {
    const summary = summarizeOrThrow(
      "connect failed: postgres://svc:SYNTHETICurlpassword0000@db.internal:5432/app"
    );

    assert.equal(summary.includes("SYNTHETICurlpassword0000"), false);
    assert.ok(
      summary.includes("db.internal:5432/app"),
      "the host and path were destroyed along with the credential"
    );
  });

  test("a credential-named key at end of line does not eat the next line", () => {
    // `SECRET_ASSIGNMENT_RE`'s `\s*` spans a newline, so the key-named pass has
    // to run AFTER line breaks collapse. Run it before and `access_token:`
    // reaches onto the next line and destroys its first word.
    const summary = summarizeOrThrow(
      ["request rejected, access_token:", "Unauthorized (401)"].join("\n")
    );

    assert.ok(
      summary.includes("Unauthorized"),
      "the next line's first word was consumed by the assignment rule"
    );
  });

  test("keeps ordinary stderr diagnosable", () => {
    const summary = summarizeOrThrow(
      "parse failed at relative-parser.ts:42 for session 01J8ZK: unexpected end of JSON input"
    );

    assert.ok(summary.includes("relative-parser.ts:42"));
    assert.ok(summary.includes("unexpected end of JSON input"));
    assert.equal(summary.includes(REDACTED_TOKEN_SEGMENT), false);
  });

  test("an unterminated PEM header takes its key material and nothing else", () => {
    // The shared vocabulary's truncated-block fallback is line-oriented, so
    // redaction has to run BEFORE line breaks collapse to `" | "`. Collapse
    // first and the fallback has no newline left to stop at, so it swallows
    // every remaining diagnostic in the chunk.
    const summary = summarizeOrThrow(
      [
        "worker failed reading key material",
        "-----BEGIN PRIVATE KEY-----",
        PEM_BODY_LINE,
        "parse failed at relative-parser.ts:42: unexpected end of JSON input",
      ].join("\n")
    );

    assert.equal(summary.includes(PEM_BODY_LINE), false);
    assert.ok(summary.includes(REDACTED_TOKEN_SEGMENT));
    assert.ok(summary.includes("worker failed reading key material"));
    assert.ok(
      summary.includes("parse failed at relative-parser.ts:42"),
      "the diagnostic after the PEM block was destroyed, not redacted"
    );
  });

  test("an unterminated PEM header is taken whole on CRLF stderr too", () => {
    // The shared fallback's per-line lookahead is `(?=\n|$)`, so a Windows
    // worker's `\r\n` defeats it on every base64 line and leaves the key body
    // in the log while redacting only the `-----BEGIN` header. Line endings are
    // normalized before the value pass for exactly this reason.
    const summary = summarizeOrThrow(
      [
        "-----BEGIN PRIVATE KEY-----",
        PEM_BODY_LINE,
        "parse failed at relative-parser.ts:42",
      ].join("\r\n")
    );

    assert.equal(
      summary.includes(PEM_BODY_LINE),
      false,
      "the PEM body survived a CRLF chunk"
    );
    assert.ok(summary.includes("parse failed at relative-parser.ts:42"));
  });

  test("keys over a short Bearer credential behind an Authorization header", () => {
    // The SSOT's `bearerToken` carries a 12-character floor this sink's old
    // local rule did not, so the value pass declines `tok90123` and the
    // key-named pass is the only thing left that can reach it — which it can
    // only do by stepping over the `Bearer` scheme word (review of PR #6476).
    const summary = summarizeOrThrow(
      "worker request rejected, Authorization: Bearer tok90123"
    );

    assert.equal(
      summary.includes("tok90123"),
      false,
      "the short Bearer credential survived into the stderr summary"
    );
    assert.ok(summary.includes("Authorization=[redacted-secret]"));
  });

  test("keys over a Basic credential behind an Authorization header", () => {
    // Same scheme-word step, on a shape NEITHER the old local `Bearer` rule nor
    // the shared vocabulary ever matched.
    const summary = summarizeOrThrow(
      "worker request rejected, Authorization: Basic U1lOVEhFVElDOmh1bnRlcjI="
    );

    assert.equal(
      summary.includes("U1lOVEhFVElDOmh1bnRlcjI="),
      false,
      "the Basic credential survived into the stderr summary"
    );
    assert.ok(summary.includes("Authorization=[redacted-secret]"));
  });

  test("still keys over a credential-named assignment whose value is not token-shaped", () => {
    const summary = summarizeOrThrow("env dump: DATABASE_PASSWORD=hunter2");

    assert.ok(summary.includes("DATABASE_PASSWORD=[redacted-secret]"));
    assert.equal(summary.includes("hunter2"), false);
  });
});

/**
 * A stderr `data` event is not a record boundary, so before PR #6476's review a
 * credential straddling two of them missed every pattern and reached
 * `this.log()` as two halves that reconstruct it. Every fixture below is SPLIT
 * mid-credential on purpose: revert the line assembly and each one goes red with
 * two summaries instead of one.
 *
 * Split points are chosen so NEITHER half matches its family on its own — the
 * AWS half carries 3 of the 16 required body characters, the GitLab half 15 of
 * the required 20 — so a green here is the accumulator working, not the
 * redactor incidentally catching a fragment.
 */
describe("historical parse worker stderr chunk boundaries (ISS-6898)", () => {
  /** Every summary the accumulator emitted across the chunk sequence. */
  function summarizeChunks(chunks: readonly string[]): string[] {
    const summarizer = createHistoricalWorkerStderrSummarizer();
    const summaries: string[] = [];
    for (const chunk of chunks) {
      const summary = summarizer.push(Buffer.from(chunk));
      if (summary !== null) {
        summaries.push(summary);
      }
    }
    const tail = summarizer.flush();
    if (tail !== null) {
      summaries.push(tail);
    }
    return summaries;
  }

  const SPLIT_SECRETS = [
    {
      label: "AKIA (aws access key)",
      secret: "AKIASYNTHETIC0000000",
      head: "parse failed: unexpected token AKIASYN",
      tail: "THETIC0000000\n",
    },
    {
      label: "glpat (gitlab pat)",
      secret: "glpat-SYNTHETIC00000000000000000000",
      head: "parse failed: unexpected token glpat-SYNTHETIC000000",
      tail: "00000000000000\n",
    },
  ] as const;

  for (const family of SPLIT_SECRETS) {
    test(`redacts ${family.label} split across two stderr chunks`, () => {
      const summaries = summarizeChunks([family.head, family.tail]);
      const logged = summaries.join(" ");

      assert.equal(
        summaries.length,
        1,
        "the split credential was logged as two summaries, which reconstruct it"
      );
      assert.equal(
        logged.includes(family.secret),
        false,
        `${family.label} survived the chunk boundary into the stderr summary`
      );
      assert.equal(
        logged.includes(family.head.slice(-8)),
        false,
        `${family.label}'s leading half reached the log on its own`
      );
      assert.ok(logged.includes(REDACTED_TOKEN_SEGMENT));
      assert.ok(logged.includes("parse failed"));
    });
  }

  test("redacts a PEM private key whose body arrives in later chunks", () => {
    // A LINE boundary is not enough for the one family whose match spans lines.
    // Send the header as its own `data` event and the base64 body in later ones
    // and the line rule alone redacts the header, then logs the key material in
    // clear — chunking, not content, decides whether the key leaks. Revert the
    // carried PEM context and the body lines come back into the log.
    const summaries = summarizeChunks([
      "worker failed reading key material\n-----BEGIN PRIVATE KEY-----\n",
      `${PEM_BODY_LINE}\n`,
      `${PEM_BODY_LINE}\n-----END PRIVATE KEY-----\nparse failed at relative-parser.ts:42\n`,
    ]);
    const logged = summaries.join(" ");

    assert.equal(
      logged.includes(PEM_BODY_LINE),
      false,
      "the PEM body reached the log once its lines arrived in their own chunks"
    );
    assert.ok(logged.includes(REDACTED_TOKEN_SEGMENT));
    assert.ok(logged.includes("worker failed reading key material"));
    assert.ok(
      logged.includes("parse failed at relative-parser.ts:42"),
      "the diagnostic after the block was destroyed, not redacted"
    );
  });

  test("a truncated PEM block stops redacting once its body ends", () => {
    // A truncated block never sends a footer, so a footer-only closing rule
    // latches the context on for the rest of a resident worker's life and
    // destroys every later base64-shaped diagnostic word. The window ends where
    // the shared fallback's own line walk ends: at the first non-body line.
    const summarizer = createHistoricalWorkerStderrSummarizer();

    summarizer.push(Buffer.from("-----BEGIN PRIVATE KEY-----\n"));
    const body = summarizer.push(
      Buffer.from(`${PEM_BODY_LINE}\nworker exited with code 1\n`)
    );
    const after = summarizer.push(Buffer.from("retryingParse\n"));

    assert.equal(
      body?.includes(PEM_BODY_LINE),
      false,
      "the carried context did not reach the continuation chunk's key material"
    );
    assert.ok(body?.includes("worker exited with code 1"));
    assert.ok(
      after?.includes("retryingParse"),
      "the context latched on past the end of the key body"
    );
  });

  test("carries PEM context across a colourised body line", () => {
    // Framing has to read the SAME text the redaction does. Decide it on the raw
    // chunk and an ANSI-wrapped body line is not body-shaped, so the window
    // drops and the key material after it is logged in clear — while the same
    // bytes in one chunk redact.
    const summarizer = createHistoricalWorkerStderrSummarizer();

    summarizer.push(Buffer.from("-----BEGIN PRIVATE KEY-----\n"));
    const body = summarizer.push(
      Buffer.from(`\u001b[31m${PEM_BODY_LINE}\u001b[39m\n`)
    );
    const next = summarizer.push(Buffer.from(`${PEM_BODY_LINE}\n`));

    assert.equal(
      body?.includes(PEM_BODY_LINE),
      false,
      "a colourised key line reached the log"
    );
    assert.equal(
      next?.includes(PEM_BODY_LINE),
      false,
      "the colourised line dropped the carried header for the lines after it"
    );
  });

  test("does not carry PEM context past a blank line", () => {
    // A blank line ends the shared fallback's body walk — `[A-Za-z0-9+/=]+`
    // needs a character — so the carried window has to end there too, or the
    // split case redacts a diagnostic the whole-chunk case leaves alone.
    const summarizer = createHistoricalWorkerStderrSummarizer();

    summarizer.push(Buffer.from("-----BEGIN PRIVATE KEY-----\n"));
    summarizer.push(Buffer.from("\n"));
    const after = summarizer.push(Buffer.from("retryingParse\n"));

    assert.ok(
      after?.includes("retryingParse"),
      "the window stayed open across a blank line"
    );
  });

  test("keeps PEM context across a suppressed Node warning", () => {
    // An ignorable run is DISCARDED, so it says nothing about the framing.
    // Advance the window on it and a SQLite warning landing between a header and
    // its body puts the key material in the log in clear.
    const summarizer = createHistoricalWorkerStderrSummarizer();

    summarizer.push(Buffer.from("-----BEGIN PRIVATE KEY-----\n"));
    assert.equal(
      summarizer.push(
        Buffer.from(
          "(node:41402) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n"
        )
      ),
      null
    );
    const body = summarizer.push(Buffer.from(`${PEM_BODY_LINE}\n`));

    assert.equal(
      body?.includes(PEM_BODY_LINE),
      false,
      "the key body reached the log after a suppressed run closed the window"
    );
    assert.ok(body?.includes(REDACTED_TOKEN_SEGMENT));
  });

  test("does not mark a continuation run that carries no key material", () => {
    // The context is only worth applying to a run that OPENS on key material;
    // prefixing any other one stamps a `[redacted-token]` onto stderr that held
    // no credential.
    const summarizer = createHistoricalWorkerStderrSummarizer();

    summarizer.push(Buffer.from("-----BEGIN PRIVATE KEY-----\n"));
    const after = summarizer.push(
      Buffer.from("worker exited with code 1, no key was read\n")
    );

    assert.equal(
      after?.includes(REDACTED_TOKEN_SEGMENT),
      false,
      "a phantom redaction marker was logged for a run with no key material"
    );
    assert.ok(after?.includes("worker exited with code 1"));
  });

  test("stops carrying PEM context once the block's footer arrives", () => {
    // The context is a redaction WINDOW, not a mode switch: hold it open past
    // the `-----END` armor line and every later base64-shaped diagnostic word is
    // destroyed rather than merely redacted.
    const summarizer = createHistoricalWorkerStderrSummarizer();

    summarizer.push(Buffer.from("-----BEGIN PRIVATE KEY-----\n"));
    summarizer.push(
      Buffer.from(`${PEM_BODY_LINE}\n-----END PRIVATE KEY-----\n`)
    );
    // A one-word line drawn only from the base64 alphabet: exactly what the
    // shared truncated-block fallback consumes while a header is in front of it,
    // so it survives only because the footer closed the window.
    const after = summarizer.push(
      Buffer.from("retryingParse\nparse failed at relative-parser.ts:42\n")
    );

    assert.ok(after?.includes("parse failed at relative-parser.ts:42"));
    assert.ok(
      after?.includes("retryingParse"),
      "a plain diagnostic line was redacted as key material after the footer"
    );
  });

  test("flushes an unterminated last line rather than dropping it", () => {
    // The line a dying worker writes last is usually the one saying why, and it
    // frequently has no terminator. Holding it for a newline that never comes
    // would trade a leak for a silence.
    const summarizer = createHistoricalWorkerStderrSummarizer();

    assert.equal(
      summarizer.push(Buffer.from("worker died: unexpected end of JSON input")),
      null,
      "an unterminated line was summarized before its terminator arrived"
    );

    const flushed = summarizer.flush();
    assert.ok(flushed?.includes("unexpected end of JSON input"));
    assert.equal(summarizer.flush(), null, "flush did not clear the carry");
  });

  test("an over-cap buffer still carries its trailing partial line", () => {
    // The cap is measured on the REMAINDER, not on everything buffered. Measure
    // it on the whole buffer and a long line followed by the head of a
    // credential drops that head on the floor, so the next chunk's tail is
    // logged on its own and the two halves reconstruct it — the exact leak the
    // accumulator exists to close.
    const summarizer = createHistoricalWorkerStderrSummarizer();
    const secret = "AKIASYNTHETIC0000000";

    assert.equal(
      summarizer.push(
        Buffer.from(
          "x".repeat(HistoricalParseWorkerLimits.maxWorkerStderrCarryBytes - 1)
        )
      ),
      null
    );
    const logged = [
      summarizer.push(Buffer.from("\nparse failed: unexpected token AKIASYN")),
      summarizer.push(Buffer.from("THETIC0000000\n")),
      summarizer.flush(),
    ]
      .filter((summary) => summary !== null)
      .join(" ");

    assert.equal(
      logged.includes(secret),
      false,
      "the credential survived an over-cap buffer into the stderr summary"
    );
    assert.equal(
      logged.includes("AKIASYN"),
      false,
      "the credential's leading half reached the log on its own"
    );
    assert.ok(logged.includes(REDACTED_TOKEN_SEGMENT));
  });

  test("summarizes rather than buffering past the carry cap", () => {
    // stderr is under no obligation to ever send a newline. Unbounded, the carry
    // would be a main-process memory leak traded for the split-token guarantee.
    const summarizer = createHistoricalWorkerStderrSummarizer();
    const oversized = "x".repeat(
      HistoricalParseWorkerLimits.maxWorkerStderrCarryBytes + 1
    );

    assert.notEqual(
      summarizer.push(Buffer.from(oversized)),
      null,
      "a newline-free stream buffered past the cap instead of logging"
    );
    assert.equal(
      summarizer.flush(),
      null,
      "the carry was not cleared when the cap fired"
    );
  });
});
