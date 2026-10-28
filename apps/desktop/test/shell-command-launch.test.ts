import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { shellCommandLaunches } from "../src/main/collectors/parsing/shell-command-launch.js";

const GH_EXECUTABLE = /^gh(?:\.exe)?$/i;

function launchesGh(command: string): boolean {
  return shellCommandLaunches(command, (word) => {
    const normalized = word.replaceAll("\\", "/");
    return GH_EXECUTABLE.test(
      normalized.slice(normalized.lastIndexOf("/") + 1)
    );
  });
}

describe("shellCommandLaunches", () => {
  test("finds commands after operators and control-flow words", () => {
    assert.equal(launchesGh("git fetch && gh pr view 1"), true);
    assert.equal(launchesGh("if test -f marker; then gh pr view 1; fi"), true);
    assert.equal(launchesGh("while test -f marker; do gh status; done"), true);
  });

  test("finds commands launched through common shell prefixes", () => {
    for (const command of [
      "exec gh pr view",
      "command gh pr view",
      "doas gh pr view",
      "nice gh pr view",
      "sudo gh pr view",
      "setsid gh pr view",
      "stdbuf -o0 gh pr view",
      "time gh pr view",
      "nohup gh pr view",
      "timeout 5 gh pr view",
      "echo 1 | xargs gh pr view",
      "env -u GH_TOKEN gh pr view",
    ]) {
      assert.equal(launchesGh(command), true, command);
    }
  });

  test("accounts for prefix options that consume values", () => {
    assert.equal(launchesGh("sudo -u root gh pr view"), true);
    assert.equal(launchesGh("doas -u root gh pr view"), true);
    assert.equal(launchesGh("nice -n 10 gh pr view"), true);
    assert.equal(launchesGh("stdbuf -o 0 gh pr view"), true);
    assert.equal(launchesGh("time -p gh pr view"), true);
    assert.equal(launchesGh("timeout -k 1 5 gh pr view"), true);
    assert.equal(launchesGh("xargs -I value gh pr view"), true);
    assert.equal(launchesGh("command -v gh"), false);
  });

  test("finds commands in static case arms without treating the case word as a command", () => {
    assert.equal(launchesGh("case x in a) gh pr view;; esac"), true);
    assert.equal(launchesGh("case gh in a) echo ok;; esac"), false);
  });

  test("finds command substitutions inside and outside double quotes", () => {
    assert.equal(launchesGh('echo "$(gh pr view 1)"'), true);
    assert.equal(launchesGh('OUT="$(gh pr view 1)"'), true);
    assert.equal(launchesGh('echo "`gh pr view 1`"'), true);
    assert.equal(launchesGh("echo $(gh pr view 1)"), true);
  });

  test("handles redirections before a command", () => {
    assert.equal(launchesGh("2>/dev/null gh pr view 1"), true);
    assert.equal(launchesGh("> out.txt gh pr view 1"), true);
    assert.equal(launchesGh(">out.txt gh pr view 1"), true);
    assert.equal(launchesGh("echo ok > out.txt gh pr view 1"), false);
  });

  test("ignores comments, heredoc bodies, and ordinary arguments", () => {
    assert.equal(launchesGh("echo ok # ignored && gh pr view 1"), false);
    assert.equal(launchesGh("cat <<EOF\ngh pr view 1\nEOF"), false);
    assert.equal(launchesGh("echo gh pr view 1"), false);
    assert.equal(launchesGh("ghostscript input.ps"), false);
  });
});
