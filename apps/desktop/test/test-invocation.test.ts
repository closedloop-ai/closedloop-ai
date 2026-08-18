/**
 * @file test-invocation.test.ts
 * @description FEA-4010 (AA-09, test detection): the parsed-head runner taxonomy
 * that replaced a substring alternation.
 *
 * The cases below are organized around the two failure directions the golden
 * corpus actually exhibited, because both were live defects rather than
 * hypotheticals:
 *   - FABRICATED validation — `which pytest`, `ls .venv/bin/pytest`,
 *     `cat vitest.config.mts` and a heredoc quoting a test command all counted as
 *     test runs. Each one CLAIMS validate time for work that ran no tests.
 *   - MISSED validation — `pnpm turbo test` and `node --test` / `tsx --test`
 *     spell the invocation with a task name or a flag instead of a runner's name.
 *
 * Generality fixtures (PLN-1490) cover Ruby, Python, Go, Rust, .NET, JVM, Elixir
 * and Swift, none of which this repo is written in.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  packageBinaryName,
  splitSegments,
  stripHeredocBodies,
} from "../src/main/collectors/evidence/command-tokens.js";
import { isTestInvocation } from "../src/main/collectors/evidence/test-invocation.js";

describe("FEA-4010 (AA-09): test invocation detection", () => {
  test("a runner named in ARGUMENT position is not a test run", () => {
    // Every one of these fired under the old substring regex. They read or
    // locate a test artifact; none executes one, so counting them fabricates
    // validate time out of exploration.
    for (const command of [
      "which pytest",
      "ls .venv/bin/pytest",
      "cat vitest.config.mts",
      "cat examples/demo-app/pytest.ini",
      "wc -l apps/desktop/test/attribution.test.ts",
      "grep -n 'setupFiles' apps/app/vitest.config.mts",
      "nl -ba scripts/deploy/boundary.test.ts",
      "find . -name '*.test.ts'",
    ]) {
      assert.equal(isTestInvocation(command), false, command);
    }
  });

  test("a runner named inside QUOTED text is text being searched for", () => {
    assert.equal(
      isTestInvocation('rg -n "tsx --test|pnpm .*test" justfile package.json'),
      false
    );
    assert.equal(isTestInvocation('grep -r "vitest" src/'), false);
  });

  test("a HEREDOC body is prose, not commands", () => {
    // A corpus session writes a PR body whose "Test plan" quotes a test command.
    // Bodies contain newlines and newline separates segments, so without this the
    // prose arrives as its own command segment and reads as a run that never was.
    const command = [
      "cat > /tmp/pr-body.md <<'EOF'",
      "## Test plan",
      "- `npx tsx --test apps/desktop/test/collectors-parsers.test.ts` — passes.",
      "- `pnpm test` — green.",
      "EOF",
    ].join("\n");
    assert.equal(isTestInvocation(command), false);
  });

  test("writing a test FILE is not running one", () => {
    const command = [
      "cat > /tmp/test-fs-mock.ts << 'EOF'",
      'import { vi } from "vitest";',
      "EOF",
    ].join("\n");
    assert.equal(isTestInvocation(command), false);
  });

  test("the POSIX `test` builtin is not a test runner", () => {
    // `test` in HEAD position is the file-predicate builtin; `test` as a package
    // script name is a suite. Position is the whole difference.
    assert.equal(isTestInvocation("test -f plugins/helpers.py && pwd"), false);
    assert.equal(
      isTestInvocation('test -f "$HOME/.claude/x" && echo OK'),
      false
    );
    assert.equal(isTestInvocation("pnpm test"), true);
  });

  test("dedicated runners in head position are test runs", () => {
    for (const command of [
      "vitest run packages/app/lib/__tests__/derivations.test.ts",
      "pytest plugins/tools/python -q",
      "jest --coverage",
      "mocha spec/",
    ]) {
      assert.equal(isTestInvocation(command), true, command);
    }
  });

  test("a package-manager-installed binary resolves by its published name", () => {
    // `.venv/bin/pytest` IS pytest by the packaging tool's contract — a narrower
    // claim than trusting any path, so a bespoke `./tools/pytest` stays unknown.
    assert.equal(isTestInvocation(".venv/bin/pytest plugins/tools -q"), true);
    assert.equal(isTestInvocation("./node_modules/.bin/vitest run"), true);
    assert.equal(isTestInvocation("vendor/bin/phpunit tests/"), true);
    assert.equal(isTestInvocation("./tools/pytest something"), false);
  });

  test("task runners resolve through their operation word", () => {
    for (const command of [
      "pnpm test",
      "pnpm -C apps/desktop test",
      "npm run test",
      "npm run test:unit",
      "yarn test",
      "pnpm turbo test --filter=app",
      "turbo run test",
      "nx test my-lib",
      // A NAMESPACED script invoked directly, with and without a global option.
      // The operation word is colon-shaped, which is also the shape of a flag's
      // value — resolving it on shape alone made every `test:*` script invisible,
      // including this repo's own documented desktop invocation.
      "pnpm test:node",
      "pnpm -C apps/desktop test:node",
      "yarn test:e2e",
    ]) {
      assert.equal(isTestInvocation(command), true, command);
    }
    // The global option's own value is still not mistaken for the operation.
    assert.equal(isTestInvocation("pnpm -C apps/desktop lint:fix"), false);
  });

  test("task runners DELEGATE to the program they invoke", () => {
    for (const command of [
      "pnpm exec vitest run src/",
      "pnpm -C apps/desktop exec tsx --test test/contract.test.ts",
      "npx vitest run",
      "python3 -m pytest tests/",
    ]) {
      assert.equal(isTestInvocation(command), true, command);
    }
    // ...and delegating to something that is NOT a runner stays false.
    assert.equal(
      isTestInvocation("npx biome check apps/app/lib/__tests__/repos.test.ts"),
      false
    );
    assert.equal(
      isTestInvocation("pnpm exec ultracite check lib/__tests__/repos.test.ts"),
      false
    );
    assert.equal(isTestInvocation("pnpm -C apps/desktop lint"), false);
  });

  test("a runtime's built-in runner is selected by flag", () => {
    assert.equal(isTestInvocation("node --test scripts/__tests__/"), true);
    assert.equal(
      isTestInvocation("npx tsx --test --test-concurrency=1 test/db.test.ts"),
      true
    );
    // The same runtime without the flag is just running a program.
    assert.equal(isTestInvocation("node scripts/build.mjs"), false);
    assert.equal(isTestInvocation("tsx scripts/derive.ts"), false);
    // Past a bare `--` the flags belong to the SCRIPT, so a program with its own
    // `--test` option is not selecting the runtime's built-in runner.
    assert.equal(isTestInvocation("node scripts/release.mjs -- --test"), false);
  });

  test("a runner asked to ENUMERATE its tests ran none of them", () => {
    // A runner head otherwise means execution unconditionally, so a collection
    // mode minted `validate` time for work that verified nothing. Enumerating a
    // suite is investigation, the same class of read as grepping for a test name.
    for (const command of [
      // JS/TS
      "vitest list",
      "jest --listTests",
      "mocha --dry-run test/",
      // Python
      "pytest --collect-only",
      "pytest --co -q",
      "tox --listenvs",
      // Ruby
      "rspec --dry-run",
      "cucumber --dry-run",
      // PHP
      "phpunit --list-tests",
      // C/C++
      "ctest -N",
      "ctest --show-only",
      // Go / Rust / .NET, reached through the TASK path rather than a bare head
      "go test -list .",
      "cargo nextest list",
      "dotnet test --list-tests",
      // ...and through a delegating runner
      "npx vitest list",
      "pnpm exec jest --listTests",
      "pnpm -C apps/desktop exec pytest --collect-only",
    ]) {
      assert.equal(isTestInvocation(command), false, command);
    }
  });

  test("a collection FLAG does not disarm the runs it sits beside", () => {
    // The test is "did it enumerate INSTEAD of executing", not "did it print
    // something", so the ordinary invocations stay test runs.
    for (const command of [
      "vitest --run",
      "jest",
      "pytest -q",
      "ctest",
      "go test ./...",
      "rspec spec/models",
      // Past a bare `--` the arguments belong to the tests, not the runner.
      "pytest -- --collect-only",
    ]) {
      assert.equal(isTestInvocation(command), true, command);
    }
  });

  test("a separator the shell would not act on is not a separator", () => {
    // ESCAPED: `find -exec … \;` ends its argument list with a literal semicolon.
    assert.equal(isTestInvocation(String.raw`echo ok \; pnpm test`), false);
    assert.deepEqual(
      splitSegments(String.raw`find . -exec rm {} \; && echo done`),
      [String.raw`find . -exec rm {} \; `, " echo done"]
    );
    // COMMENTED: everything after an unquoted `#` opening a word is dropped.
    assert.equal(isTestInvocation("echo ok # && pnpm test"), false);
    // A control operator ends a word with no space required, so a `#` directly
    // after one opens a comment just as it does after a space.
    assert.equal(isTestInvocation("echo ok;# pnpm test"), false);
    assert.equal(isTestInvocation("echo ok&&# pnpm test"), false);
    assert.equal(isTestInvocation("echo ok|# pnpm test"), false);
    // ...but a `#` inside a word, after an expansion, or inside quotes is
    // ordinary text. Recognizing a comment DROPS a command, so the safe
    // direction is to recognize fewer of them.
    assert.equal(isTestInvocation("echo a#b && pnpm test"), true);
    assert.equal(isTestInvocation("echo $# && pnpm test"), true);
    assert.equal(isTestInvocation(`echo 'a # b' && pnpm test`), true);
    // A real separator following an escaped one still separates.
    assert.equal(
      isTestInvocation(String.raw`find . -exec grep -l x {} \; ; pnpm test`),
      true
    );
    // The redirection guard survives the rewrite.
    assert.deepEqual(splitSegments("pnpm test 2>&1"), ["pnpm test 2>&1"]);
  });

  test("runtime options end at the ENTRY POINT", () => {
    // `--test` after the script belongs to the script, not to the runtime.
    assert.equal(isTestInvocation("node script.mjs --test"), false);
    assert.equal(isTestInvocation("tsx cli.ts --test"), false);
    // Two of the three entry spellings START WITH A DASH, so "doesn't look like
    // a flag" is not sufficient to find them: `-` names stdin as the program,
    // and `-e`/`-p` carry the program as their value.
    assert.equal(isTestInvocation("node - --test"), false);
    assert.equal(isTestInvocation("cat s.mjs | node - --test"), false);
    assert.equal(isTestInvocation(`node -e "require('./x')" --test`), false);
    assert.equal(isTestInvocation(`node -p "1" --test`), false);
    // Before the entry, the runtime's own flag still selects the built-in runner...
    assert.equal(isTestInvocation("node --test script.mjs"), true);
    assert.equal(isTestInvocation("node --test"), true);
    // ...including past an option whose separated value is NOT the program.
    assert.equal(
      isTestInvocation("node --import ./reg.mjs --test test/a.test.ts"),
      true
    );
  });

  test("a delegated operand is a PROGRAM, not a task name", () => {
    // `run` names a script; `exec`/`dlx`/`x` execute a binary, and a binary
    // called `test` is not the `test` script.
    assert.equal(isTestInvocation("pnpm run test"), true);
    assert.equal(isTestInvocation("pnpm exec test"), false);
    assert.equal(isTestInvocation("pnpm dlx test"), false);
    // A head that runs a MODULE by name has no task taxonomy to consult.
    assert.equal(isTestInvocation("python test"), false);
    assert.equal(isTestInvocation("python3 test"), false);
    // The delegating forms that name a real runner still resolve.
    assert.equal(isTestInvocation("pnpm exec vitest run"), true);
    assert.equal(isTestInvocation("python3 -m pytest tests/"), true);
  });

  test("a project-qualified task resolves to its terminal name", () => {
    // Gradle's standard cross-project form; the prefix selects WHERE the task
    // runs, not WHICH task it is.
    assert.equal(isTestInvocation("gradle :app:test"), true);
    assert.equal(isTestInvocation("gradle :app:check"), true);
    assert.equal(isTestInvocation("sbt core/test"), true);
    // The scoping rule still holds on the terminal name.
    assert.equal(isTestInvocation("gradle :app:build"), false);
    // ...and a namespaced npm script is NOT a project path.
    assert.equal(isTestInvocation("pnpm test:node"), true);
    assert.equal(isTestInvocation("pnpm lint:fix"), false);
  });

  test("a task name is scoped to the head that gives it meaning", () => {
    // The `HEAD_WRITE_FLAGS` lesson applied to task names: `check` runs the suite
    // for gradle and merely type-checks for cargo.
    assert.equal(isTestInvocation("gradle check"), true);
    assert.equal(isTestInvocation("cargo check"), false);
    assert.equal(isTestInvocation("mvn verify"), true);
    assert.equal(isTestInvocation("cargo build"), false);
  });

  test("an unrecognized WRAPPER is scanned past structurally", () => {
    // The corpus leads 47% of its lines with a bespoke sandbox wrapper. It is
    // never named — the scan walks past what it does not recognize.
    assert.equal(isTestInvocation("rtk pnpm -C apps/desktop test"), true);
    assert.equal(isTestInvocation("someproxy vitest run"), true);
    assert.equal(isTestInvocation("sudo -E pytest tests/"), true);
  });

  test("a recognized command CONSUMES its arguments, ending the scan", () => {
    // Without this the wrapper scan walks past `ls` and resolves its ARGUMENT as
    // the command, inventing a pytest run out of a directory listing.
    assert.equal(isTestInvocation("rtk ls .venv/bin/pytest"), false);
    assert.equal(isTestInvocation("cat node_modules/.bin/vitest"), false);
  });

  test("any segment running tests makes the line a test run", () => {
    assert.equal(isTestInvocation("pnpm build && pnpm test"), true);
    assert.equal(isTestInvocation("cd apps/desktop && pytest -q"), true);
    assert.equal(isTestInvocation("pnpm lint && pnpm typecheck"), false);
  });

  test("a positional argument that merely mentions tests is not an operation", () => {
    assert.equal(isTestInvocation("pnpm add test-helpers"), false);
    assert.equal(isTestInvocation("npm install jest --save-dev"), false);
    assert.equal(isTestInvocation("git commit -m 'fix jest flake'"), false);
  });

  test("generality: stacks this repo is not written in", () => {
    for (const command of [
      "bundle exec rspec spec/models",
      "go test ./...",
      "cargo test --workspace",
      "dotnet test",
      "mix test",
      "swift test",
      "mvn test",
      "rake spec",
      "make check",
      "deno test --allow-read",
      "flutter test",
    ]) {
      assert.equal(isTestInvocation(command), true, command);
    }
  });

  test("empty and whitespace input is not a test run", () => {
    assert.equal(isTestInvocation(""), false);
    assert.equal(isTestInvocation("   "), false);
  });
});

describe("FEA-4010 (AA-09): shared command lexing", () => {
  test("stripHeredocBodies keeps the opening line and drops the body", () => {
    const stripped = stripHeredocBodies(
      ["cat > out.md <<'EOF'", "rm -rf /", "EOF", "echo done"].join("\n")
    );
    assert.equal(stripped.includes("rm -rf /"), false);
    assert.equal(stripped.includes("cat > out.md"), true);
    assert.equal(stripped.includes("echo done"), true);
  });

  test("an UNTERMINATED heredoc drops everything after it", () => {
    // A truncated transcript: text whose delimiter never arrived cannot be
    // confidently attributed, so the safe direction is to drop it.
    const stripped = stripHeredocBodies(
      ["cat > out.md <<'EOF'", "some prose", "pnpm test"].join("\n")
    );
    assert.equal(stripped.includes("pnpm test"), false);
  });

  test("a here-STRING is an argument, not a body", () => {
    const command = "grep foo <<< 'haystack'";
    assert.equal(stripHeredocBodies(command), command);
  });

  test("a here-STRING does not swallow the lines after it", () => {
    // The single-line case above cannot observe this: the misfire only drops
    // SUBSEQUENT lines. A lookahead alone could not exclude `<<<` — the match
    // simply retried one character later and succeeded from the third `<`,
    // capturing the here-string's own word as a delimiter nothing ever closed.
    const command = ["grep foo <<< 'haystack'", "pnpm test"].join("\n");
    assert.equal(stripHeredocBodies(command), command);
    assert.equal(isTestInvocation(command), true);
  });

  test("a line with no heredoc is returned unchanged", () => {
    const command = "pnpm test && echo ok";
    assert.equal(stripHeredocBodies(command), command);
  });

  test("stripping is IDEMPOTENT", () => {
    // The readers are layered, so the same line gets stripped more than once.
    // If the `<<DELIM` operator survived, the second pass would see an opener
    // whose delimiter line had already been removed, call it unterminated, and
    // swallow everything after it — reintroducing the exact defect on a caller
    // that did the right thing twice.
    const command = [
      "cat > out.md <<'EOF'",
      "Test plan: ran the suite.",
      "EOF",
      "pnpm test",
    ].join("\n");
    const once = stripHeredocBodies(command);
    assert.equal(once.includes("pnpm test"), true);
    assert.equal(stripHeredocBodies(once), once);
    assert.equal(isTestInvocation(once), true);
  });

  test("packageBinaryName resolves only package-manager bin directories", () => {
    assert.equal(packageBinaryName("node_modules/.bin/vitest"), "vitest");
    assert.equal(packageBinaryName(".venv/bin/pytest"), "pytest");
    assert.equal(packageBinaryName("vendor/bin/phpunit"), "phpunit");
    // A bespoke path is not evidence of the program it is named after.
    assert.equal(packageBinaryName("./tools/pytest"), null);
    assert.equal(packageBinaryName("pytest"), null);
  });
});
