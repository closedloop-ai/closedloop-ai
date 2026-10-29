/**
 * @file artifact-ref-shell-quotes.test.ts
 * @description Tests for `artifact-ref-shell-quotes.ts` — the shell-quote
 * primitives the artifact-ref extractor gates git-command detection on.
 *
 * Two layers, on purpose. The `extractArtifactRefs` regression block below moved
 * here verbatim from `artifact-ref-extractor.test.ts` (ISS-7571): its fixtures
 * are the LITERAL commands that minted phantom branches in real desktop data, so
 * it stays an end-to-end assertion about refs, not about spans. The direct
 * `findQuotedSpans` / `stripQuotedContent` / `shellQuotedSpans` /
 * `matchOutsideQuotes` tests are new: those functions were module-private
 * before the extraction, so the scanner's own edge cases — unterminated quotes,
 * backslash escapes, single-quote literality — were only ever reachable through
 * a whole extractor run.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { extractArtifactRefs } from "../src/main/collectors/parsing/artifact-ref-extractor.js";
import {
  findHeredocSpans,
  findNeutralizedSpans,
  findQuotedSpans,
  matchOutsideQuotes,
  type QuotedSpan,
  shellQuotedSpans,
  stripQuotedContent,
} from "../src/main/collectors/parsing/artifact-ref-shell-quotes.js";
import type { NormalizedToolUse } from "../src/main/collectors/types.js";
import { makeSession, NOW } from "./artifact-ref-session-fixture.js";

// ---------------------------------------------------------------------------
// FEA-2531 hardening: shell-quote-aware git detection. Regression fixtures are
// the LITERAL commands that minted phantom branches (feat, feat/x',
// feat/x','git) in real desktop data — git-command text embedded inside a
// quoted argument of another command must never produce branch/commit refs.
// ---------------------------------------------------------------------------

describe("FEA-2531 hardening: quoted git text is not evidence", () => {
  function branchRefsFor(command: string, output?: string) {
    const session = makeSession({
      toolUses: [{ name: "Bash", timestamp: NOW, input: { command }, output }],
    });
    return extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "branch"
    );
  }

  test("rg pattern containing git push text mints no branch (the `feat` poison)", () => {
    const refs = branchRefsFor(
      'rtk rg -n "git push.*HEAD|set-upstream|--set-upstream|push -u origin HEAD|push origin HEAD|git push origin feat|git push -u origin" apps/desktop/test/artifact-ref-extractor.test.ts apps/desktop/test -l'
    );
    assert.equal(refs.length, 0);
  });

  test("inline -e script with quoted git commands mints no branch (the `feat/x','git` poison)", () => {
    const refs = branchRefsFor(
      "rtk pnpm exec tsx -e \"import { extractArtifactRefs } from './apps/desktop/src/main/collectors/parsing/artifact-ref-extractor.ts'; const cmds = ['git push origin feat/x','git checkout -b feat/x']; console.log(cmds)\""
    );
    assert.equal(refs.length, 0);
  });

  test("rg output echoing push ref-lines is not scanned (command is not a push)", () => {
    const refs = branchRefsFor(
      'rg "git push" apps/desktop/test',
      'test.ts: "To github.com:x/y.git\\n * [new branch]      feat/x -> feat/x"'
    );
    assert.equal(refs.length, 0);
  });

  test("rg output echoing commit summary lines mints no commit refs", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: 'rg "git commit" apps/desktop/test' },
          output: 'test.ts: output: "[feat/x abc1234] work"\n',
        },
      ],
    });
    const commits = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "commit"
    );
    assert.equal(commits.length, 0);
  });

  test("git text inside commit -m body is ignored, chained real push still detected", () => {
    const refs = branchRefsFor(
      'git commit -m "docs: mention git push origin bogus and --delete" && git push origin feat/real'
    );
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.branchName, "feat/real");
    assert.equal(refs[0]?.method, "git_push");
  });

  test("wrapper-prefixed real git commands still count (rtk rewrite)", () => {
    const refs = branchRefsFor("rtk git push origin feat/wrapped");
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.branchName, "feat/wrapped");
  });

  test("cd-chained real push still counts", () => {
    const refs = branchRefsFor(
      "cd /home/user/wt && git push -u origin feat/chained"
    );
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.branchName, "feat/chained");
  });

  test("quoted branch NAME on a real checkout still captures", () => {
    const refs = branchRefsFor('git checkout -b "feat/quoted-ok"');
    assert.equal(refs.length, 1);
    assert.equal(refs[0]?.branchName, "feat/quoted-ok");
  });

  test("echoed gh pr create text does not classify the tool as PR-creating", () => {
    const session = makeSession({
      toolUses: [
        {
          name: "Bash",
          timestamp: NOW,
          input: { command: 'echo "run gh pr create when ready"' },
          output:
            "run gh pr create when ready\nhttps://github.com/closedloop-ai/closedloop-ai/pull/999\n",
        },
      ],
    });
    const prRefs = extractArtifactRefs(session, NOW).filter(
      (r) => r.targetKind === "pull_request"
    );
    assert.equal(prRefs.length, 1);
    assert.equal(prRefs[0]?.relation, "referenced");
  });
});

// ---------------------------------------------------------------------------
// ISS-7571: direct unit coverage of the scanner itself. Everything above proves
// the DEFENSE holds end to end; these prove the two-state scanner's own rules,
// which an extractor-level fixture can only reach indirectly.
// ---------------------------------------------------------------------------

/** A global pattern for `matchOutsideQuotes`, whose `matchAll` requires one. */
const GIT_PUSH_ORIGIN_RE = /git push origin (\S+)/g;

function bashArgv(argv: string[]): NormalizedToolUse {
  return { name: "Bash", timestamp: NOW, input: { command: argv } };
}

describe("findQuotedSpans", () => {
  test("unquoted command has no spans", () => {
    assert.deepEqual(findQuotedSpans("git push origin feat/x"), []);
  });

  test("a closed double-quoted span is inclusive of both quote marks", () => {
    // `"abc"` occupies [5,10): the opening quote at 5, the closing one at 9.
    assert.deepEqual(findQuotedSpans('echo "abc"'), [{ start: 5, end: 10 }]);
  });

  test("an unterminated quote extends to end-of-string", () => {
    const cmd = 'rg "git push';
    assert.deepEqual(findQuotedSpans(cmd), [{ start: 3, end: cmd.length }]);
  });

  test("a backslash-escaped quote OUTSIDE quotes opens no span", () => {
    assert.deepEqual(findQuotedSpans('echo \\" x'), []);
  });

  test("a backslash-escaped quote INSIDE double quotes does not close the span", () => {
    const cmd = '"a\\"b"';
    assert.deepEqual(findQuotedSpans(cmd), [{ start: 0, end: cmd.length }]);
  });

  test("single-quoted content is literal — a backslash does not escape the closer", () => {
    // `'a\'` closes at the second quote (POSIX: no escapes inside single
    // quotes), leaving the trailing `'` to open its own unterminated span.
    assert.deepEqual(findQuotedSpans("echo 'a\\' b'"), [
      { start: 5, end: 9 },
      { start: 11, end: 12 },
    ]);
  });
});

describe("stripQuotedContent", () => {
  test("no spans returns the command unchanged", () => {
    const cmd = "git push origin feat/x";
    assert.equal(stripQuotedContent(cmd, []), cmd);
  });

  test("quote marks are kept, content is blanked, length is preserved", () => {
    const cmd = 'echo "abc"';
    const stripped = stripQuotedContent(cmd, findQuotedSpans(cmd));
    assert.equal(stripped, 'echo "   "');
    assert.equal(stripped.length, cmd.length);
  });

  test("an unterminated span blanks through end-of-string", () => {
    const cmd = 'rg "git push';
    const stripped = stripQuotedContent(cmd, findQuotedSpans(cmd));
    assert.equal(stripped, 'rg "        ');
    assert.equal(stripped.length, cmd.length);
  });

  test("git-command text inside a quoted argument survives as blanks only", () => {
    const cmd = 'rg "git push origin feat/x" apps';
    const stripped = stripQuotedContent(cmd, findQuotedSpans(cmd));
    assert.equal(stripped.includes("git push"), false);
    assert.equal(stripped.endsWith('" apps'), true);
  });
});

describe("shellQuotedSpans", () => {
  test("a bundled argv element is marked quoted from its join separator", () => {
    const argv = ["rg", "git push origin feat/x"];
    const cmd = argv.join(" ");
    assert.deepEqual(shellQuotedSpans(bashArgv(argv), cmd), [
      { start: 2, end: cmd.length },
    ]);
    assert.equal(
      stripQuotedContent(cmd, shellQuotedSpans(bashArgv(argv), cmd)).includes(
        "git push"
      ),
      false
    );
  });

  test("a tokenized argv push stays visible", () => {
    const argv = ["git", "push", "origin", "feat/x"];
    const cmd = argv.join(" ");
    assert.deepEqual(shellQuotedSpans(bashArgv(argv), cmd), []);
    assert.equal(stripQuotedContent(cmd, []), cmd);
  });

  test("the first argv element is never marked, even when it has whitespace", () => {
    const argv = ["git push", "origin"];
    assert.deepEqual(shellQuotedSpans(bashArgv(argv), argv.join(" ")), []);
  });

  test("a string command falls back to real shell quotes only", () => {
    const cmd = 'rg "git push origin feat/x"';
    const tu: NormalizedToolUse = {
      name: "Bash",
      timestamp: NOW,
      input: { command: cmd },
    };
    assert.deepEqual(shellQuotedSpans(tu, cmd), findQuotedSpans(cmd));
  });
});

describe("matchOutsideQuotes", () => {
  test("skips a match inside a quoted span and returns the next one outside", () => {
    const cmd = 'echo "git push origin feat/a" && git push origin feat/b';
    const match = matchOutsideQuotes(
      cmd,
      GIT_PUSH_ORIGIN_RE,
      findQuotedSpans(cmd)
    );
    assert.equal(match?.[1], "feat/b");
  });

  test("returns null when every match sits inside a quoted span", () => {
    const cmd = 'echo "git push origin feat/a"';
    assert.equal(
      matchOutsideQuotes(cmd, GIT_PUSH_ORIGIN_RE, findQuotedSpans(cmd)),
      null
    );
  });

  test("returns the first match when there are no spans", () => {
    const cmd = "git push origin feat/a && git push origin feat/b";
    const match = matchOutsideQuotes(cmd, GIT_PUSH_ORIGIN_RE, []);
    assert.equal(match?.[1], "feat/a");
  });

  test("handles unsorted spans (as from shellQuotedSpans with argv)", () => {
    const cmd =
      'git push origin feat/x "git push origin feat/y" git push origin feat/z';
    const spans: QuotedSpan[] = [
      { start: 50, end: 70 },
      { start: 23, end: 49 },
    ];
    const match = matchOutsideQuotes(cmd, GIT_PUSH_ORIGIN_RE, spans);
    assert.equal(match?.[1], "feat/x");
  });

  test("returns null when the entire command is one quoted span", () => {
    const cmd = '"git push origin feat/a"';
    const match = matchOutsideQuotes(
      cmd,
      GIT_PUSH_ORIGIN_RE,
      findQuotedSpans(cmd)
    );
    assert.equal(match, null);
  });
});

// ---------------------------------------------------------------------------
// ISS-8473: a heredoc BODY is data the shell feeds to stdin and never executes.
// A body line that BEGINS with a command was positionally indistinguishable
// from a real invocation, so the command-position anchor could not reject it
// and `git push` / `git checkout -b` / the commit patterns — which have no
// anchor at all — minted from the same shape.
//
// Two layers again, and both are needed. The span cases below state what the
// scanner does at the offsets `stripQuotedContent` consumes; the `refsFor`
// cases state the only thing a reader actually cares about, which is whether a
// branch record gets minted. Each minting fixture is written as an independent
// literal, and every one of them was MEASURED minting on `origin/main`.

describe("findHeredocSpans", () => {
  test("a body span runs newline-to-newline so both boundaries survive stripping", () => {
    const cmd = "cat <<EOF\nbody\nEOF";
    // [9,15) — the newline ending `cat <<EOF` through the newline before `EOF`.
    assert.deepEqual(findHeredocSpans(cmd), [{ start: 9, end: 15 }]);
    const stripped = stripQuotedContent(cmd, findHeredocSpans(cmd));
    assert.equal(stripped, "cat <<EOF\n    \nEOF");
    assert.equal(stripped.length, cmd.length);
  });

  test("a command AFTER the terminator is outside the span", () => {
    const cmd = "cat <<EOF\nnotes\nEOF\ngit push origin feat/after";
    const stripped = stripQuotedContent(cmd, findHeredocSpans(cmd));
    assert.equal(stripped.endsWith("\nEOF\ngit push origin feat/after"), true);
  });

  test("a herestring is not a heredoc and opens no span", () => {
    assert.deepEqual(findHeredocSpans('grep x <<<"a b"'), []);
    assert.deepEqual(findHeredocSpans("grep x <<<word\ngit push origin f"), []);
  });

  test("a quoted delimiter still names the terminator", () => {
    const single = "cat <<'EOF'\nbody\nEOF";
    assert.deepEqual(findHeredocSpans(single), [{ start: 11, end: 17 }]);
    const double = 'cat <<"EOF"\nbody\nEOF';
    assert.deepEqual(findHeredocSpans(double), [{ start: 11, end: 17 }]);
  });

  test("`<<-` accepts a tab-indented terminator", () => {
    const cmd = "cat <<-EOF\n\tbody\n\tEOF";
    assert.deepEqual(findHeredocSpans(cmd), [{ start: 10, end: 17 }]);
    // The mirror: a PLAIN `<<EOF` requires the terminator line to be exactly
    // the delimiter, so a tab-indented `EOF` does not close it and the body
    // runs to end-of-string (the conservative unterminated case).
    const plain = "cat <<EOF\n\tEOF";
    assert.deepEqual(findHeredocSpans(plain), [
      { start: 9, end: plain.length },
    ]);
  });

  test("two heredocs opened on one line consume their bodies in order", () => {
    const cmd = "diff <<A <<B\nfirst\nA\nsecond\nB\ntail";
    assert.deepEqual(findHeredocSpans(cmd), [
      { start: 12, end: 19 },
      { start: 20, end: 28 },
    ]);
    const stripped = stripQuotedContent(cmd, findHeredocSpans(cmd));
    assert.equal(stripped.endsWith("\nB\ntail"), true);
    assert.equal(stripped.includes("first"), false);
    assert.equal(stripped.includes("second"), false);
  });

  test("an unterminated heredoc is neutralized through end-of-string", () => {
    const cmd = "cat <<EOF\ngit push origin feat/x";
    assert.deepEqual(findHeredocSpans(cmd), [{ start: 9, end: cmd.length }]);
  });

  test("a heredoc opener inside a quoted argument opens no span", () => {
    assert.deepEqual(findHeredocSpans('echo "a <<EOF b"\ngit status'), []);
  });

  test("a command with no heredoc is untouched", () => {
    assert.deepEqual(findHeredocSpans("git push origin feat/x"), []);
  });
});

describe("findNeutralizedSpans", () => {
  test("carries both the quoted spans and the heredoc bodies", () => {
    const cmd = 'echo "q" <<EOF\nbody\nEOF';
    assert.deepEqual(findNeutralizedSpans(cmd), [
      ...findQuotedSpans(cmd),
      ...findHeredocSpans(cmd),
    ]);
    const stripped = stripQuotedContent(cmd, findNeutralizedSpans(cmd));
    assert.equal(stripped.includes("q"), false);
    assert.equal(stripped.includes("body"), false);
  });
});

describe("ISS-8473: a command inside a heredoc body mints no record", () => {
  function branchNamesFor(command: string): string[] {
    const session = makeSession({
      toolUses: [{ name: "Bash", timestamp: NOW, input: { command } }],
    });
    return extractArtifactRefs(session, NOW)
      .filter((ref) => ref.targetKind === "branch")
      .map((ref) => ref.branchName ?? "");
  }

  // The three shapes MEASURED minting on `fix/iss-8336-gh-pr-create-matcher-ssot`
  // (ISS-8473's table), each through the real `extractArtifactRefs`.
  test("a line-initial body command mints nothing, for gh AND for git", () => {
    assert.deepEqual(
      branchNamesFor("cat <<EOF\ngh pr create --head feat/from-a-runbook\nEOF"),
      []
    );
    assert.deepEqual(
      branchNamesFor(
        "cat <<EOF\ngit push -u origin feat/pushed-in-heredoc\nEOF"
      ),
      []
    );
    assert.deepEqual(
      branchNamesFor(
        "cat <<EOF\ngit checkout -b feat/branched-in-heredoc\nEOF"
      ),
      []
    );
  });

  // The traps ISS-8473 names. Each pairs the neutralized shape with a real
  // invocation the SAME fixture must still mint, so a scanner that simply
  // swallowed the rest of the command would fail here rather than look fixed.
  test("the delimiter forms neutralize their own body and nothing after it", () => {
    const shapes: readonly [string, string, string[]][] = [
      [
        "tab-stripped",
        "cat <<-EOF\n\tgit push origin feat/tabbed\n\tEOF\ngit push origin feat/real",
        ["feat/real"],
      ],
      [
        "single-quoted delimiter",
        "cat <<'EOF'\ngit push origin feat/sq\nEOF\ngit push origin feat/after-sq",
        ["feat/after-sq"],
      ],
      [
        "double-quoted delimiter",
        'cat <<"EOF"\ngit push origin feat/dq\nEOF\ngit push origin feat/after-dq',
        ["feat/after-dq"],
      ],
      [
        "two heredocs on one line",
        "diff <<A <<B\ngit push origin feat/a\nA\ngit push origin feat/b\nB\ngit push origin feat/real2",
        ["feat/real2"],
      ],
      [
        "empty body",
        "cat <<EOF\nEOF\ngit push origin feat/after-empty",
        ["feat/after-empty"],
      ],
    ];
    for (const [label, command, expected] of shapes) {
      assert.deepEqual(branchNamesFor(command), expected, label);
    }
  });

  // The shapes that carry a `<<` which is NOT an opener. Every one of these was
  // measured DESTROYING a real branch record: a wrongly-opened heredoc finds no
  // terminator, and the unterminated fallback then blanks the rest of the
  // command. That is strictly worse than the phantom ISS-8473 set out to remove,
  // so each shape asserts the real branch on the following line SURVIVES —
  // never merely that no phantom appeared, which `[]` would also satisfy.
  test("a `<<` that is not a heredoc opener destroys no following evidence", () => {
    const shapes: readonly [string, string, string[]][] = [
      [
        // The reviewer's exact literal: no spaces anywhere.
        "arithmetic shift, no spaces",
        "echo $((1<<2))\ngit push origin feat/w",
        ["feat/w"],
      ],
      [
        "arithmetic shift, spaced",
        "echo $((1 << 20))\ngit push origin feat/x",
        ["feat/x"],
      ],
      [
        "arithmetic shift, tight",
        "echo $(( 1 <<2 ))\ngit push origin feat/y",
        ["feat/y"],
      ],
      [
        // The operand is a NAME here, so rejecting numeric delimiters alone
        // does not save this one — the arithmetic context has to be tracked.
        "arithmetic shift, variable operand",
        "echo $((1 << n))\ngit push origin feat/z",
        ["feat/z"],
      ],
      ["shell comment", "# see a << b\ngit push origin feat/c", ["feat/c"]],
      [
        // The quote opens on an EARLIER line, so a per-line view of quote state
        // reads this `<<` as bare command structure.
        "quoted argument spanning lines",
        'gh pr comment 1 --body "line1\nline2 << line3"\ngit push origin feat/q',
        ["feat/q"],
      ],
    ];
    for (const [label, command, expected] of shapes) {
      assert.deepEqual(branchNamesFor(command), expected, label);
    }
  });

  // A herestring feeds ONE line of stdin and opens no body, so the lines after
  // it are ordinary commands. Neutralizing them would be a real evidence loss.
  test("a herestring does not neutralize the lines after it", () => {
    assert.deepEqual(
      branchNamesFor("grep x <<<word\ngit push origin feat/after-herestring"),
      ["feat/after-herestring"]
    );
  });

  // The conservative direction: an opener with no terminator swallows the rest
  // of the command rather than guessing where the body stopped. Stated so the
  // cost is on the record — this is a deliberate false negative, and a false
  // negative here costs an unrecorded branch while a false positive fabricates
  // one with real push evidence attached.
  test("an unterminated heredoc neutralizes through end-of-string", () => {
    assert.deepEqual(
      branchNamesFor("cat <<EOF\ngit push origin feat/unterminated"),
      []
    );
  });

  // PR #7209 review. A body is stdin data, so its punctuation is prose — but
  // the quote scan ran over the raw command, so an apostrophe in a body opened
  // a quote nothing closes, and the unterminated-quote rule extended that span
  // to end-of-string. MEASURED on the parent commit: the fixture below stripped
  // to `"cat <<EOF\n                                   "` and yielded `[]`.
  // Each case asserts the real branch after the terminator SURVIVES — `[]`
  // would satisfy a "no phantom" assertion while the evidence was being eaten.
  test("inert punctuation in a body eats no command after the terminator", () => {
    const shapes: readonly [string, string, string[]][] = [
      [
        "apostrophe in body",
        "cat <<EOF\ndon't\nEOF\ngit push origin feat/real",
        ["feat/real"],
      ],
      [
        "lone double quote in body",
        'cat <<EOF\nsay "hi\nEOF\ngit push origin feat/dq-body',
        ["feat/dq-body"],
      ],
      [
        // The body's own `git push` stays neutralized; only the real one mints.
        "apostrophe body that also carries a push",
        "cat <<EOF\nit's git push origin feat/phantom\nEOF\ngit push origin feat/kept",
        ["feat/kept"],
      ],
    ];
    for (const [label, command, expected] of shapes) {
      assert.deepEqual(branchNamesFor(command), expected, label);
    }
  });

  // PR #7209 review. A delimiter is a shell WORD and may mix quoted fragments,
  // so `<<E"OF"` names `EOF`. Reading only the first fragment named a
  // terminator that never appears, and the unterminated fallback then blanked
  // the rest of the command.
  test("a mixed-quoted delimiter word still names its terminator", () => {
    const shapes: readonly [string, string, string[]][] = [
      [
        "quote in the middle",
        'cat <<E"OF"\nbody\nEOF\ngit push origin feat/real',
        ["feat/real"],
      ],
      [
        "leading quoted fragment",
        "cat <<'E'OF\nbody\nEOF\ngit push origin feat/lead",
        ["feat/lead"],
      ],
      [
        "backslash-escaped delimiter char",
        "cat <<E\\OF\nbody\nEOF\ngit push origin feat/esc",
        ["feat/esc"],
      ],
      [
        // A QUOTED numeric delimiter is a real heredoc; only an unquoted
        // numeric word is an arithmetic operand. Both halves matter, so the
        // body is neutralized AND the following push survives.
        "quoted numeric delimiter",
        'cat <<"2"\ngit push origin feat/in-body\n2\ngit push origin feat/after',
        ["feat/after"],
      ],
    ];
    for (const [label, command, expected] of shapes) {
      assert.deepEqual(branchNamesFor(command), expected, label);
    }
  });

  // PR #7209 review. The opener scan tested span membership once per character
  // against a list of every quoted span, which is O(n²) on a command carrying
  // many short quoted arguments — an ordinary transcript shape, and command
  // text arrives with no length cap. The mask that replaced it is asserted here
  // by BEHAVIOUR on a quote-heavy input, because a wall-clock assertion is
  // banned by `scripts/lint/rules/no-timing-assertions.ts`; timing belongs in
  // `vitest bench`. This pins that the rewrite did not change the answer.
  test("a quote-heavy command still resolves its real push", () => {
    const noise = Array.from({ length: 2000 }, (_, i) => `'a${i}'`).join(" ");
    assert.deepEqual(branchNamesFor(`echo ${noise}\ngit push origin feat/q`), [
      "feat/q",
    ]);
    // The same noise must not stop a heredoc body being neutralized either.
    assert.deepEqual(
      branchNamesFor(
        `echo ${noise}\ncat <<EOF\ngit push origin feat/phantom\nEOF`
      ),
      []
    );
  });
});
