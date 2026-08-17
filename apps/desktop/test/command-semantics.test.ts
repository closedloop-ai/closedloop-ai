/**
 * @file command-semantics.test.ts
 * @description FEA-4010 (AA-04): behavior tests for the harness-blind shell
 * command-effect reading that makes `explore` structurally reachable.
 *
 * These assert the CONTRACT, not the taxonomy contents: read-only work is
 * recognized, anything mutating or unreadable stays out, and the safety direction
 * (ambiguity ⇒ `Unknown` ⇒ no phase) holds. Two regression classes are pinned
 * explicitly because both were live bugs found by measuring the corpus.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  CommandEffect,
  classifyCommandEffect,
} from "../src/main/collectors/evidence/command-semantics.js";

describe("AA-04 command effect: read-only investigation", () => {
  test("plain coreutils inspection is read-only", () => {
    for (const command of [
      "cat package.json",
      "head -20 README.md",
      "wc -l src/index.ts",
      "ls -la",
      "pwd",
      "grep -rn TODO src",
      "find . -name '*.ts'",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.ReadOnly,
        command
      );
    }
  });

  test("mixed-mode tools are read-only ONLY on their read subcommands", () => {
    for (const command of [
      "git status --short",
      "git log -1 --stat",
      "git show HEAD:file.ts",
      "git diff --cached",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.ReadOnly,
        command
      );
    }
    // A non-read git subcommand must NOT be laundered into exploration.
    for (const command of ["git add file.ts", "git fetch origin"]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.Unknown,
        command
      );
    }
  });

  test("a two-level subcommand (`<tool> <noun> <verb>`) is recognized", () => {
    assert.equal(
      classifyCommandEffect("gh pr view 204 --comments"),
      CommandEffect.ReadOnly
    );
    assert.equal(
      classifyCommandEffect("gh run list --workflow ci"),
      CommandEffect.ReadOnly
    );
  });

  test("a stream processor's SCRIPT can write, and then it is not reading", () => {
    // sed/awk are read-only only because they normally write to stdout. The
    // script lives inside quotes that token scanning blanks, so these are
    // checked against the raw line.
    for (const command of [
      "sed -n '1w marker.txt' input.txt",
      "sed 's/a/b/w changed.txt' input.txt",
      `awk '{print > "out.txt"}' data.txt`,
      `awk 'BEGIN{system("rm -rf build")}'`,
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.Mutating,
        command
      );
    }
  });

  test("an ordinary stream-processor script is still reading", () => {
    // 312 of the corpus's read-only lines invoke sed/awk; the write check must
    // not sweep them up.
    for (const command of [
      "sed -n '1,220p' apps/desktop/package.json",
      "sed -n '/RUNNER_RATES/,/};/p' scripts/rates.ts",
      "awk '{print $1}' data.txt",
      "awk -F, '{print $2, $3}' report.csv",
      "sed 's/foo/bar/g' input.txt",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.ReadOnly,
        command
      );
    }
  });

  test("a stream processor reads unless it edits in place", () => {
    assert.equal(
      classifyCommandEffect("sed -n '1,220p' apps/desktop/package.json"),
      CommandEffect.ReadOnly
    );
    assert.equal(
      classifyCommandEffect("awk '{print $1}' data.txt"),
      CommandEffect.ReadOnly
    );
    assert.equal(
      classifyCommandEffect("sed -i 's/a/b/' src/app.ts"),
      CommandEffect.Mutating
    );
  });
});

describe("AA-04 command effect: mutation is never read as exploration", () => {
  test("mutating heads and write redirection are mutating", () => {
    for (const command of [
      "rm -rf build",
      "mkdir -p out",
      "mv a.ts b.ts",
      "cp a.ts b.ts",
      "chmod +x run.sh",
      "echo hi > out.txt",
      "cat template >> dest.txt",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.Mutating,
        command
      );
    }
  });

  test("a read-only head cannot launder a mutating argument", () => {
    // `find` reads, but `-exec rm` does not.
    assert.equal(
      classifyCommandEffect("find . -name '*.tmp' -exec rm {} ;"),
      CommandEffect.Mutating
    );
    assert.equal(
      classifyCommandEffect("find build -name '*.map' -delete"),
      CommandEffect.Mutating
    );
  });

  test("the whole `find` action family counts, not just bare -exec", () => {
    // `\b` does not end a match at `-exec|dir`, so a bare `-exec` alternative
    // silently misses the `dir` and `-ok` spellings that also run a command.
    for (const command of [
      "find . -name '*.tmp' -execdir rm -f {} +",
      "find . -name '*.tmp' -ok rm {} ;",
      "find . -name '*.tmp' -okdir rm {} ;",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.Mutating,
        command
      );
    }
  });

  test("a redirection to a real file is a write whatever descriptor it uses", () => {
    for (const command of [
      "cat input.txt 2>errors.log",
      "cat input.txt &>combined.log",
      "grep -rn TODO src 2> /tmp/search-errors.log",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.Mutating,
        command
      );
    }
  });

  test("discarding or duplicating a descriptor is not a write", () => {
    // 90 corpus lines depend on this exemption; only `&N` and /dev/null qualify.
    for (const command of [
      "cat app.log 2>/dev/null",
      "ls -d build/ 2>/dev/null | sort",
      "grep -rn TODO src >/dev/null",
      "cat app.log 1>&2",
    ]) {
      assert.notEqual(
        classifyCommandEffect(command),
        CommandEffect.Mutating,
        command
      );
    }
  });

  test("a backgrounded sibling command is its own segment", () => {
    // A standalone `&` separates two commands; only `&&` and redirection
    // plumbing (`2>&1`, `&>`) use the character for something else.
    assert.equal(
      classifyCommandEffect("cat input.txt & rm -rf build"),
      CommandEffect.Mutating
    );
    assert.equal(
      classifyCommandEffect("cat input.txt & wc -l input.txt"),
      CommandEffect.ReadOnly
    );
  });

  test("a write flag counts when bundled or attached to its value", () => {
    for (const command of [
      "sed -Ei 's/a/b/' src/app.ts",
      "sed -ne '1,5p' -i src/app.ts",
      "sort -uo sorted.csv data.csv",
      "yq -i '.a = 1' config.yaml",
      "yq --inplace '.a = 1' config.yaml",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.Mutating,
        command
      );
    }
  });

  test("bundled-flag detection stays scoped to the declaring head", () => {
    // `grep`/`rg` declare no write flags, so their `-i`/`-o` are never consulted
    // — this is the `-i` overload trap guarded at the bundling layer.
    for (const command of [
      "grep -in needle haystack.txt",
      "rg -io 'v[0-9]+' src",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.ReadOnly,
        command
      );
    }
  });

  test("one unreadable segment forces the whole line to Unknown", () => {
    // The `cat` is read-only, but what the custom script does is unknowable —
    // the line must not be reported as exploration on the strength of the `cat`.
    assert.equal(
      classifyCommandEffect("cat input.txt | ./scripts/mystery-build.sh"),
      CommandEffect.Unknown
    );
  });
});

describe("AA-04 command effect: read-only is not the same claim as exploring", () => {
  test("a no-op or wait changes nothing, but is not investigation either", () => {
    // A read-only verdict becomes EXPLORATION evidence downstream, so `sleep 30`
    // must not be read-only just because it mutates nothing.
    for (const command of ["sleep 30", "true", "false", "test -f README.md"]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.Unknown,
        command
      );
    }
  });

  test("a no-op is transparent when the line also does real reading", () => {
    // The wait anchors time; the `cat` is what makes this exploration.
    assert.equal(
      classifyCommandEffect("sleep 3; cat build/output.log"),
      CommandEffect.ReadOnly
    );
  });
});

describe("AA-04 command effect: mixed-mode subcommand paths", () => {
  test("a read word after a mutating operation cannot launder the line", () => {
    for (const command of [
      "git add status",
      "npm audit fix",
      "git branch list",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.Unknown,
        command
      );
    }
  });

  test("a global option's VALUE does not consume the subcommand slot", () => {
    // `-C <dir>` / `-R <repo>` put a non-flag token before the real operation.
    assert.equal(
      classifyCommandEffect("git -C /srv/app status --short"),
      CommandEffect.ReadOnly
    );
    assert.equal(
      classifyCommandEffect("git --git-dir /srv/app/.git log -1"),
      CommandEffect.ReadOnly
    );
    assert.equal(
      classifyCommandEffect("gh -R closedloop-ai/symphony-alpha pr view 1"),
      CommandEffect.ReadOnly
    );
  });

  test("a two-token read path is recognized on its own terms", () => {
    for (const command of [
      "gh auth status",
      "gh pr checks 2028",
      "gh run view 12345",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.ReadOnly,
        command
      );
    }
  });
});

describe("AA-04 command effect: measured regression traps", () => {
  test("`-i` is not treated as in-place outside the heads where it means that", () => {
    // Live bug: a blanket `-i` veto marked ordinary searches/requests as mutating.
    // `-i` is ignore-case for grep/rg and include-headers for curl.
    assert.notEqual(
      classifyCommandEffect("grep -i needle haystack.txt"),
      CommandEffect.Mutating
    );
    assert.equal(
      classifyCommandEffect("grep -i needle haystack.txt"),
      CommandEffect.ReadOnly
    );
    assert.notEqual(
      classifyCommandEffect("curl -i -sS http://127.0.0.1:4820/health"),
      CommandEffect.Mutating
    );
  });

  test("redirection inside a QUOTED argument is not a file write", () => {
    // Live bug: searching for a conflict marker read as a redirect, so genuine
    // investigation was recorded as mutation.
    assert.equal(
      classifyCommandEffect(`rg -n "^(<<<<<<<|=======|>>>>>>>)" apps/desktop`),
      CommandEffect.ReadOnly
    );
    assert.equal(
      classifyCommandEffect(`grep -n '2>&1 >> log' src`),
      CommandEffect.ReadOnly
    );
  });

  test("stderr plumbing is not a file write", () => {
    assert.equal(
      classifyCommandEffect("cat app.log 2>&1"),
      CommandEffect.ReadOnly
    );
  });

  test("a nested command hides behind the outer head, so it vetoes read-only", () => {
    // `$(…)`/backticks are not segment separators, so the outer read-only head
    // resolves first and the nested command is never examined. Claiming
    // exploration here would fabricate the one signal this module must not fake.
    for (const command of [
      "echo $(rm -rf build)",
      "echo `rm -rf build`",
      "cat $(mktemp)",
      // Double quotes do NOT make substitution literal — this still runs `rm`.
      'echo "cleanup: $(rm -rf dist)"',
      // Process substitution is the same hole in different syntax.
      "cat <(rm -rf build)",
      "diff <(rm -rf a) b.txt",
    ]) {
      assert.notEqual(
        classifyCommandEffect(command),
        CommandEffect.ReadOnly,
        command
      );
    }
  });

  test("a nested command inside SINGLE quotes is literal text, not a command", () => {
    // Single quotes are the one form that suppresses substitution, so a search
    // pattern that merely contains the characters stays genuine investigation.
    assert.equal(
      classifyCommandEffect("grep -n 'total=$(wc -l)' notes.md"),
      CommandEffect.ReadOnly
    );
  });

  test("an observed mutation outranks the substitution veto", () => {
    // The veto must not erase a mutation we DID see — that would cost implement
    // evidence to protect explore.
    assert.equal(
      classifyCommandEffect("rm -rf $(cat stale-dirs.txt)"),
      CommandEffect.Mutating
    );
    assert.equal(
      classifyCommandEffect("cp $(ls -t | head -1) backup/"),
      CommandEffect.Mutating
    );
  });

  test("a write FLAG on a read-only head is a mutation", () => {
    // These heads read by default but write when told to name an output file.
    assert.equal(
      classifyCommandEffect("sort -o sorted.csv data.csv"),
      CommandEffect.Mutating
    );
    assert.equal(
      classifyCommandEffect("sort --output=sorted.csv data.csv"),
      CommandEffect.Mutating
    );
    assert.equal(
      classifyCommandEffect("find . -name '*.ts' -fprint matches.txt"),
      CommandEffect.Mutating
    );
  });

  test("`-o` is not treated as a write flag outside the heads where it means that", () => {
    // The `-i` trap in another costume: `-o` is logical-OR for `find` and
    // only-matching for `grep`/`rg`. 17 corpus lines depend on this.
    for (const command of [
      "find . -name '*.ts' -o -name '*.tsx'",
      "grep -o 'FEA-[0-9]*' notes.md",
      "rg -o --no-filename 'v[0-9]+' src",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.ReadOnly,
        command
      );
    }
  });

  test("an inherited-property head cannot crash or fake a match", () => {
    // The head token comes from untrusted agent-authored command text; a plain
    // object registry would resolve these to truthy non-Set values.
    for (const command of [
      "constructor foo",
      "__proto__ bar",
      "toString",
      "hasOwnProperty x",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.Unknown,
        command
      );
    }
  });
});

describe("AA-04 command effect: generality (no org-specific vocabulary)", () => {
  test("an unrecognized WRAPPER is skipped structurally, not by name", () => {
    // The corpus leads 47% of its lines with a bespoke two-token sandbox proxy.
    // Wrappers must work without being enumerated — these are four different
    // ecosystems' wrappers plus an invented one, none of them named in the module.
    for (const command of [
      "zzq sandbox grep -rn TODO src",
      "sudo cat /etc/hosts",
      "env -i ls -la",
      "nice -n 10 wc -l big.csv",
      "bundle exec git status",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.ReadOnly,
        command
      );
    }
  });

  test("a SCRIPT invocation is not scanned past as if it were a wrapper", () => {
    // The scan cannot tell a wrapper that execs its argument from a program that
    // consumes one, so a bespoke script — the likelier second case — is refused
    // rather than classified from whatever token follows it.
    for (const command of [
      "./scripts/deploy.sh cat input.txt",
      "tools/run.py ls -la",
      "/usr/local/bin/custom-runner grep -rn TODO src",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.Unknown,
        command
      );
    }
    // A program in a STANDARD system directory is still the program of that
    // name; only those directories are assumed.
    for (const command of [
      "/bin/cat /etc/hosts",
      "/usr/bin/git status",
      "/usr/local/bin/rg -n TODO src",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.ReadOnly,
        command
      );
    }
  });

  test("a bespoke path does not inherit its basename's semantics", () => {
    // A basename is not evidence of behaviour — `./tools/cat` is whatever the
    // repo put there. Trusting it because coreutils has a `cat` would be the
    // inconsistent half of refusing `./scripts/deploy.sh`.
    for (const command of [
      "./tools/cat input.txt",
      "/tmp/git status",
      "vendor/bin/grep -rn TODO src",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.Unknown,
        command
      );
    }
  });

  test("a non-JS/TS stack is read identically", () => {
    for (const command of [
      "cargo tree",
      "go list ./...",
      "kubectl get pods",
      "docker ps -a",
      "brew list --versions",
    ]) {
      assert.equal(
        classifyCommandEffect(command),
        CommandEffect.ReadOnly,
        command
      );
    }
  });

  test("`cd <dir> &&` navigation classifies on the real command", () => {
    // ~24% of corpus lines take this shape; `cd` itself must be transparent.
    assert.equal(
      classifyCommandEffect("cd /srv/app && git log --oneline -5"),
      CommandEffect.ReadOnly
    );
    assert.equal(
      classifyCommandEffect("cd /srv/app && rm -rf dist"),
      CommandEffect.Mutating
    );
  });

  test("a leading environment assignment is transparent", () => {
    assert.equal(
      classifyCommandEffect("LC_ALL=C sort data.csv"),
      CommandEffect.ReadOnly
    );
    assert.equal(
      classifyCommandEffect("PGPASSWORD=x psql -c 'select 1'"),
      CommandEffect.Unknown
    );
  });

  test("a general-purpose interpreter stays Unknown even when it looks like reading", () => {
    // A one-liner can open files for write; only the safe direction is honest.
    assert.equal(
      classifyCommandEffect(`perl -e 'print "hi"'`),
      CommandEffect.Unknown
    );
    assert.equal(
      classifyCommandEffect("python3 tools/analyze.py --mode local"),
      CommandEffect.Unknown
    );
  });

  test("an empty or whitespace command is Unknown, never read-only", () => {
    assert.equal(classifyCommandEffect(""), CommandEffect.Unknown);
    assert.equal(classifyCommandEffect("   "), CommandEffect.Unknown);
  });
});
