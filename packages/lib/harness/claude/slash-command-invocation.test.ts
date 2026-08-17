/**
 * ISS-4767: unit tests for the shared slash-command block recognizer — the one
 * reading of `<command-name>/<command-message>/<command-args>` that both the
 * desktop DB importer (via `parse-claude`'s `slashCommands` metadata) and the
 * cloud session-detail trace chip run, so the two cannot drift.
 */

import { describe, expect, it } from "vitest";
import {
  findSlashCommandInvocations,
  isNamedSlashCommandInvocation,
  normalizeSlashCommandName,
} from "./slash-command-invocation";

/** The verbatim `/resume` turn text captured on session SES-73062. */
const RESUME_INVOCATION =
  "<command-name>/resume</command-name>\n            <command-message>resume</command-message>\n            <command-args></command-args>";

describe("findSlashCommandInvocations", () => {
  it("reads the reported /resume turn as one invocation", () => {
    expect(findSlashCommandInvocations(RESUME_INVOCATION)).toEqual([
      {
        name: "/resume",
        message: "resume",
        args: null,
        start: 0,
        end: RESUME_INVOCATION.length,
      },
    ]);
  });

  it("keeps message and args when both are populated, in any tag order", () => {
    const text =
      "<command-message>deploy</command-message>\n<command-name>/deploy</command-name>\n<command-args>prod</command-args>";

    expect(findSlashCommandInvocations(text)).toEqual([
      {
        name: "/deploy",
        message: "deploy",
        args: "prod",
        start: 0,
        end: text.length,
      },
    ]);
  });

  it("adds the leading slash when the harness omitted it", () => {
    const [invocation] = findSlashCommandInvocations(
      "<command-name>clear</command-name>"
    );

    expect(invocation?.name).toBe("/clear");
  });

  it("reports the block bounds so surrounding prose survives", () => {
    const text = "before <command-name>/clear</command-name> after";
    const [invocation] = findSlashCommandInvocations(text);

    expect(text.slice(0, invocation?.start)).toBe("before ");
    expect(text.slice(invocation?.end)).toBe(" after");
  });

  it("splits back-to-back commands into separate invocations", () => {
    const invocations = findSlashCommandInvocations(
      "<command-name>/first</command-name>\n<command-name>/second</command-name>"
    );

    expect(invocations.map((invocation) => invocation.name)).toEqual([
      "/first",
      "/second",
    ]);
  });

  it("does not join runs separated by prose", () => {
    const invocations = findSlashCommandInvocations(
      "<command-name>/first</command-name> and then <command-args>x</command-args>"
    );

    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.args).toBeNull();
  });

  it("ignores a wrapper run with no command name", () => {
    expect(
      findSlashCommandInvocations(
        "<command-args>2257 --no-merge</command-args>"
      )
    ).toEqual([]);
  });

  // ISS-4767 extraction parity: the regex this recognizer replaced
  // (`/<command-name>([^<]+)<\/command-name>/g`) matched a whitespace-only body
  // and normalized it to a meaningless `"/"` command. That entry is KEPT, so the
  // recognizer changes no persisted value and no ARRAY POSITION — `slashCommands`
  // indices are fed to `commandUserTurnId` and persisted as anchor values, so
  // dropping one would renumber every later userTurnId-less command.
  it("keeps a whitespace-only command name, matching the replaced scan", () => {
    expect(
      findSlashCommandInvocations("<command-name>   </command-name>")
    ).toEqual([{ name: "/", message: null, args: null, start: 0, end: 32 }]);
  });

  // Empty is not whitespace: the old `[^<]+` needed at least one character, so a
  // truly empty tag produced no entry and must still produce none.
  it("emits nothing for a genuinely empty command name", () => {
    expect(
      findSlashCommandInvocations("<command-name></command-name>")
    ).toEqual([]);
  });

  // The degenerate entry exists for positional parity, not for display.
  it("marks a bare-slash invocation as unnamed for renderers", () => {
    const [blank] = findSlashCommandInvocations(
      "<command-name> </command-name>"
    );
    const [named] = findSlashCommandInvocations(
      "<command-name>/go</command-name>"
    );

    expect(isNamedSlashCommandInvocation(blank)).toBe(false);
    expect(isNamedSlashCommandInvocation(named)).toBe(true);
  });

  // Everything the harness DOES emit keeps the old scan's count and order, so
  // already-imported sessions need no re-derivation.
  it("matches the replaced scan's count and order on realistic transcripts", () => {
    const text = `${RESUME_INVOCATION}\nthen later\n<command-name>clear</command-name>\n<command-args>--all</command-args>`;
    const legacy = [...text.matchAll(/<command-name>([^<]+)<\/command-name>/g)]
      .map((match) => match[1].trim())
      .map((name) => (name.startsWith("/") ? name : `/${name}`));

    expect(findSlashCommandInvocations(text).map((i) => i.name)).toEqual(
      legacy
    );
  });

  // wongk (#4248): the renderer only ever sees `NormalizedMessage.text` after
  // the 4,096-byte cap, and that cut can land inside the run's last field. The
  // orphaned tail must stay part of the SAME invocation — otherwise the caller's
  // generic unterminated-tag folding renders one command as two chips.
  it("absorbs a trailing command field whose closer truncation removed", () => {
    const text =
      "<command-name>/review</command-name>\n<command-args>--fix packages/ap";

    expect(findSlashCommandInvocations(text)).toEqual([
      {
        name: "/review",
        message: null,
        args: "--fix packages/ap",
        start: 0,
        end: text.length,
      },
    ]);
  });

  it("absorbs a truncated trailing message and still ends at the text end", () => {
    const text = "<command-name>/review</command-name>\n<command-message>look";
    const [invocation] = findSlashCommandInvocations(text);

    expect(invocation.message).toBe("look");
    expect(invocation.end).toBe(text.length);
  });

  // A repeated tag starts the NEXT invocation; truncation must not smuggle a
  // second command's field into the first one's block.
  it("does not absorb a trailing field the run already carries", () => {
    const text =
      "<command-name>/review</command-name>\n<command-args>--fix</command-args>\n<command-args>--all";
    const [invocation] = findSlashCommandInvocations(text);

    expect(invocation.args).toBe("--fix");
    expect(invocation.end).toBe(text.indexOf("</command-args>") + 15);
  });

  // A half-read command name would name a command the user may not have typed,
  // so it stays generic harness noise rather than becoming a confident chip.
  it("does not turn a truncated command-name into an invocation", () => {
    expect(findSlashCommandInvocations("<command-name>/rev")).toEqual([]);
  });

  it("reports nothing for text whose angle brackets were already stripped", () => {
    expect(
      findSlashCommandInvocations(
        "command-name/resumecommand-messagecommand-args"
      )
    ).toEqual([]);
  });
});

describe("normalizeSlashCommandName", () => {
  it("trims and preserves an existing leading slash", () => {
    expect(normalizeSlashCommandName("  /resume  ")).toBe("/resume");
  });
});
