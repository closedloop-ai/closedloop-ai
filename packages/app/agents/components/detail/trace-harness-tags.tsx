"use client";

import { cn } from "@repo/design-system/lib/utils";
import {
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  findSlashCommandInvocations,
  isNamedSlashCommandInvocation,
  normalizeSlashCommandName,
} from "@repo/lib/harness/claude/slash-command-invocation";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import type { TraceJumpHandler } from "./trace-markdown";

export type TracePart =
  | { kind: "md"; id: number; text: string }
  | { kind: "tag"; id: number; name: string; inner: string }
  | {
      kind: "command";
      id: number;
      name: string;
      message: string | null;
      args: string | null;
    };

type TraceRange = { start: number; end: number };

/** A source range plus the `TracePart` it folds into. */
type TraceBlock = TraceRange & { part: TracePart };

/**
 * Matches Claude Code harness wrapper tags — paired, hyphenated, lowercase tag
 * names like `<command-name>…</command-name>`, `<local-command-caveat>…</…>`,
 * `<system-reminder>…</…>`. The hyphen requirement keeps prose and generics
 * (`Array<string>`) from matching, so only true harness noise is collapsed.
 */
const HARNESS_TAG = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)>([\s\S]*?)<\/\1>/g;
/**
 * Matches a harness wrapper whose *closing* tag was cut upstream — an opener with
 * no matching `</…>` before end of text. Upstream truncation (`truncateText`'s
 * 4096-byte cap in `packages/lib/harness/parser-utils.ts`, `truncateDetail`'s
 * char cap in the session-detail projection) can drop the closer, and a
 * paired-only match would then leak the raw opener — the exact XML leak this
 * folding closes. Anchored to end-of-string so a well-formed pair (handled by
 * `HARNESS_TAG`) never reaches it.
 */
const UNTERMINATED_HARNESS_TAG = /<([a-z][a-z0-9]*(?:-[a-z0-9]+)+)>([\s\S]*)$/;
const FENCE = /```[\s\S]*?```/g;
const INLINE_CODE = /`[^`\n]*`/g;

/**
 * Friendly labels for the handful of Claude Code harness wrappers we actually
 * see on the timeline, so a collapsed chip reads "Command output" instead of the
 * raw tag name. Anything unmapped falls back to the tag name via
 * `harnessTagLabel`.
 */
const HARNESS_TAG_LABELS: Readonly<Record<string, string>> = {
  "local-command-stdout": "Command output",
  "local-command-stderr": "Command error output",
  "local-command-caveat": "Caveat",
  "command-name": "Command",
  "command-message": "Command message",
  "command-args": "Command arguments",
  "system-reminder": "System reminder",
};

function harnessTagLabel(name: string): string {
  return HARNESS_TAG_LABELS[name] ?? name;
}

function collectRanges(text: string, pattern: RegExp): TraceRange[] {
  const ranges: TraceRange[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    ranges.push({ start, end: start + match[0].length });
  }
  return ranges;
}

function isInsideAny(
  ranges: readonly TraceRange[],
  start: number,
  end: number
): boolean {
  return ranges.some((range) => start >= range.start && end <= range.end);
}

function pushMarkdownPart(parts: TracePart[], id: number, text: string): void {
  if (text.trim().length === 0) {
    return;
  }
  parts.push({ kind: "md", id, text });
}

/**
 * Splits trace text into markdown spans and collapsible harness-tag blocks,
 * skipping any tag matches that fall inside fenced or inline code. Shared by
 * the message-row body (`TraceMessageBody`) and the event/system-row renderer
 * so both fold harness wrapper tags identically instead of leaking raw XML.
 */
export function parseTraceParts(text: string): TracePart[] {
  const protectedRanges = [
    ...collectRanges(text, FENCE),
    ...collectRanges(text, INLINE_CODE),
  ];
  const commandBlocks = collectCommandBlocks(text, protectedRanges);
  const blocks = [
    ...commandBlocks,
    ...collectTagBlocks(text, protectedRanges, commandBlocks),
  ].sort((a, b) => a.start - b.start);

  const parts: TracePart[] = [];
  let cursor = 0;
  for (const block of blocks) {
    // The two block lists are collected independently, so they can OVERLAP:
    // a command invocation nested inside a wrapper tag
    // (`<local-command-stdout>…<command-name>/a</command-name>…</…>`) yields an
    // outer tag block AND an inner command block. Emitting both would render
    // the inner chip twice and rewind the cursor, re-emitting the wrapper's raw
    // closing tag as markdown — the exact XML leak this folding closes. The
    // enclosing block wins; its own `renderInner` recursion re-runs this
    // splitter over the inner text, so the nested command still folds.
    if (block.start < cursor) {
      continue;
    }
    pushMarkdownPart(parts, cursor, text.slice(cursor, block.start));
    parts.push(block.part);
    cursor = block.end;
  }
  cursor = foldUnterminatedTag(parts, text, cursor, protectedRanges);
  pushMarkdownPart(parts, cursor, text.slice(cursor));
  return parts;
}

/**
 * ISS-4767: folds a whole slash-command invocation — the
 * `<command-name>/<command-message>/<command-args>` run the harness re-injects
 * for a typed `/resume` — into ONE block, so the turn reads as the command it
 * was instead of three opaque "Command" chips. The block boundaries come from
 * the shared harness core (`findSlashCommandInvocations`), the same recognizer
 * that produces the session's persisted `slashCommands` metadata, so the chip
 * cannot disagree with the data about where an invocation starts and ends or
 * what it names.
 *
 * The chip COUNT can still differ from `slashCommands.length`: a `<command-name>`
 * quoted inside fenced or inline code is documentation, not an invocation, so it
 * is excluded here (the parser has no such notion), and the renderer only ever
 * sees the byte-truncated message text.
 */
function collectCommandBlocks(
  text: string,
  protectedRanges: readonly TraceRange[]
): TraceBlock[] {
  const blocks: TraceBlock[] = [];
  for (const invocation of findSlashCommandInvocations(text)) {
    // A degenerate whitespace-only `<command-name>` is kept by the recognizer
    // for positional parity with the persisted `slashCommands` array, but there
    // is no command to name, so it stays generic harness noise here.
    if (
      !isNamedSlashCommandInvocation(invocation) ||
      isInsideAny(protectedRanges, invocation.start, invocation.end)
    ) {
      continue;
    }
    blocks.push({
      start: invocation.start,
      end: invocation.end,
      part: {
        kind: "command",
        id: invocation.start,
        name: invocation.name,
        message: invocation.message,
        args: invocation.args,
      },
    });
  }
  return blocks;
}

function collectTagBlocks(
  text: string,
  protectedRanges: readonly TraceRange[],
  commandBlocks: readonly TraceBlock[]
): TraceBlock[] {
  const blocks: TraceBlock[] = [];
  for (const match of text.matchAll(HARNESS_TAG)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (
      isInsideAny(protectedRanges, start, end) ||
      isInsideAny(commandBlocks, start, end)
    ) {
      continue;
    }
    blocks.push({
      start,
      end,
      part: { kind: "tag", id: start, name: match[1], inner: match[2].trim() },
    });
  }
  return blocks;
}

/**
 * Folds a harness opener whose closer was cut upstream (truncation) into a chip,
 * so a `<local-command-stdout>…` with no `</…>` collapses instead of leaking the
 * raw opener. Only inspects the tail after the last paired match, skips openers
 * inside code, and returns the advanced cursor so the opener text is not
 * re-emitted as markdown.
 */
function foldUnterminatedTag(
  parts: TracePart[],
  text: string,
  cursor: number,
  protectedRanges: readonly TraceRange[]
): number {
  const tail = text.slice(cursor);
  const match = UNTERMINATED_HARNESS_TAG.exec(tail);
  if (!match) {
    return cursor;
  }
  const start = cursor + (match.index ?? 0);
  if (isInsideAny(protectedRanges, start, text.length)) {
    return cursor;
  }
  pushMarkdownPart(parts, cursor, text.slice(cursor, start));
  parts.push({
    kind: "tag",
    id: start,
    name: match[1],
    inner: match[2].trim(),
  });
  return text.length;
}

/**
 * The shared chip shell: a `st-tag` disclosure whose head shows `label` (plus an
 * optional `headExtra` beside it) and whose body is revealed on toggle. Both
 * chip flavours compose it so the toggle, chevron, `aria-expanded`, and the
 * stopPropagation contract live in one place and cannot drift apart.
 *
 * `expandable` is the CALLER's decision, never inferred from `children`. The
 * generic wrapper chip has always been a disclosure even when its inner text is
 * empty (`<command-args></command-args>`), and it must stay one — inferring
 * "nothing inside ⇒ static" silently removed that affordance with the ISS-4767
 * flag OFF. Only the command chip, which knows it has no detail rows to show,
 * asks for the static head; it carries `st-tag-head-static`, which drops the
 * pointer cursor and the hover lift, because a chip that cannot open must not
 * look like it can.
 */
function TraceChipShell({
  label,
  labelClassName,
  headExtra,
  expandable,
  children,
}: Readonly<{
  label: string;
  labelClassName?: string;
  headExtra?: ReactNode;
  expandable: boolean;
  children?: ReactNode;
}>) {
  const [open, setOpen] = useState(false);
  const head = (
    <>
      <span className={cn("st-tag-name", labelClassName)}>{label}</span>
      {headExtra}
    </>
  );

  if (!expandable) {
    return (
      <div className="st-tag">
        <span className="st-tag-head st-tag-head-static">{head}</span>
      </div>
    );
  }

  return (
    <div className={cn("st-tag", open && "open")}>
      <button
        aria-expanded={open}
        className="st-tag-head"
        onClick={(event) => {
          // The event/system row can itself be a clickable jump target; keep the
          // toggle from bubbling so peeking at a chip never also scrolls the
          // timeline (matches the `#row` links' stopPropagation below).
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        type="button"
      >
        {open ? (
          <ChevronDownIcon aria-hidden className="st-tag-chev size-3.5" />
        ) : (
          <ChevronRightIcon aria-hidden className="st-tag-chev size-3.5" />
        )}
        {head}
      </button>
      {open ? <div className="st-tag-body">{children}</div> : null}
    </div>
  );
}

/**
 * Collapsible chip for a single harness wrapper tag. The inner content is
 * hidden until expanded; callers supply `renderInner` so each surface controls
 * how the (already-folded) inner text is rendered — the message body recurses
 * through markdown, while event/system rows keep plain text plus `#row` links.
 */
export function TraceTagChip({
  name,
  inner,
  onJump,
  renderInner,
}: Readonly<{
  name: string;
  inner: string;
  onJump?: TraceJumpHandler;
  renderInner: (inner: string, onJump?: TraceJumpHandler) => ReactNode;
}>) {
  return (
    <TraceChipShell expandable label={harnessTagLabel(name)}>
      {inner ? renderInner(inner, onJump) : null}
    </TraceChipShell>
  );
}

/** In-chip labels for the invocation's detail rows. */
const COMMAND_DETAIL_LABELS: Readonly<Record<string, string>> = {
  [COMMAND_MESSAGE_TAG]: "Message",
  [COMMAND_ARGS_TAG]: "Arguments",
};

/**
 * ISS-4767: chip for a whole slash-command invocation. The command itself is
 * the label — a `/resume` turn reads "/resume", not three unlabelled "Command"
 * chips.
 *
 * The ARGUMENTS ride in the head beside the name (truncated when long), so the
 * row reads like the command line the user actually typed: `/review --fix
 * packages/app`, not a bare `/review` you must expand to understand. Only the
 * harness's `<command-message>` stays folded — and only when it says something
 * the head did not. The harness echoes the command back in that field for a
 * bare invocation (`/resume` → message "resume"), so a message that merely
 * restates the command is dropped: the disclosure must open onto something new
 * or it should not be offered at all.
 *
 * The full argument string is still reachable when it is truncated, as its own
 * detail row, so the chip never withholds the value it elided.
 */
export function TraceCommandChip({
  name,
  message,
  args,
  onJump,
  renderValue,
}: Readonly<{
  name: string;
  message: string | null;
  args: string | null;
  onJump?: TraceJumpHandler;
  /**
   * Renders a detail value the owning surface's way — the same seam
   * `TraceTagChip` uses for its inner text, so the identical string never
   * renders one way in this chip and another in the wrapper chip beside it.
   */
  renderValue: (value: string, onJump?: TraceJumpHandler) => ReactNode;
}>) {
  const details = collectCommandDetails(name, message, args);

  return (
    <TraceChipShell
      expandable={details.length > 0}
      headExtra={
        args ? (
          <span className="st-tag-args mono" title={args}>
            {args}
          </span>
        ) : null
      }
      label={name}
      labelClassName="st-tag-name-cmd mono"
    >
      <dl>
        {details.map((detail) => (
          <div className="st-tag-detail st-toolrow-field" key={detail.label}>
            <dt className="st-toolrow-field-label">{detail.label}</dt>
            <dd>{renderValue(detail.value, onJump)}</dd>
          </div>
        ))}
      </dl>
    </TraceChipShell>
  );
}

/**
 * The invocation's expandable rows. Arguments only earn a row when the head had
 * to elide them — otherwise the head already shows the whole value and the row
 * would just say it twice.
 */
function collectCommandDetails(
  name: string,
  message: string | null,
  args: string | null
): { label: string; value: string }[] {
  const details: { label: string; value: string }[] = [];
  if (message && normalizeSlashCommandName(message) !== name) {
    details.push({
      label: COMMAND_DETAIL_LABELS[COMMAND_MESSAGE_TAG],
      value: message,
    });
  }
  if (args && args.length > INLINE_ARGS_MAX_LENGTH) {
    details.push({
      label: COMMAND_DETAIL_LABELS[COMMAND_ARGS_TAG],
      value: args,
    });
  }
  return details;
}

/**
 * Argument length above which the head's ellipsis is assumed to be hiding
 * something, so the full value also gets a detail row. Kept in step with
 * `.st-tag-args`'s `max-width: 32ch` in `styles-trace-chips.css` — the CSS owns
 * the visual truncation, this owns whether the value is still reachable.
 */
const INLINE_ARGS_MAX_LENGTH = 32;

const TRACE_LINK_PATTERN = /(#\d+)/g;

/**
 * Renders trace text with `#<row>` jump links turned into inline buttons that
 * call `onJump`. Without an `onJump` handler the text is returned unchanged.
 */
export function renderTraceLinks(
  text: string,
  onJump?: TraceJumpHandler
): ReactNode {
  if (!onJump) {
    return text;
  }
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(TRACE_LINK_PATTERN)) {
    const part = match[0];
    const matchIndex = match.index;
    if (matchIndex > cursor) {
      parts.push(text.slice(cursor, matchIndex));
    }
    const row = Number(part.slice(1));
    parts.push(
      <button
        className="st-link inline border-0 bg-transparent p-0 font-[inherit]"
        key={`${part}-${matchIndex}`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (Number.isFinite(row)) {
            onJump?.(row);
          }
        }}
        type="button"
      >
        {part}
      </button>
    );
    cursor = matchIndex + part.length;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts.length > 0 ? parts : text;
}

/**
 * Renders an event/system row's text: folds Claude Code harness wrapper tags
 * (e.g. `<local-command-stdout>…</…>`) into collapsible chips using the same
 * `parseTraceParts` splitter the message body uses, so raw XML no longer leaks
 * into event lines. Surrounding prose — and the inner content of each chip —
 * keeps its `#row` jump links via `renderTraceLinks`. The common no-tag case
 * short-circuits straight to `renderTraceLinks`.
 */
export function renderTraceEventContent(
  text: string,
  onJump?: TraceJumpHandler
): ReactNode {
  const parts = parseTraceParts(text);
  if (parts.every((part) => part.kind === "md")) {
    return renderTraceLinks(text, onJump);
  }
  return parts.map((part) => renderTraceEventPart(part, onJump));
}

/**
 * Renders a folded `command` part. Shared by both surfaces' part renderers so
 * the chip's props cannot drift between the event row and the message body;
 * each passes its own value renderer.
 */
export function renderCommandPart(
  part: Extract<TracePart, { kind: "command" }>,
  onJump: TraceJumpHandler | undefined,
  renderValue: (value: string, onJump?: TraceJumpHandler) => ReactNode
): ReactNode {
  return (
    <TraceCommandChip
      args={part.args}
      key={`command-${part.id}-${part.name}`}
      message={part.message}
      name={part.name}
      onJump={onJump}
      renderValue={renderValue}
    />
  );
}

function renderTraceEventPart(
  part: TracePart,
  onJump?: TraceJumpHandler
): ReactNode {
  if (part.kind === "command") {
    return renderCommandPart(part, onJump, renderTraceLinks);
  }
  if (part.kind === "tag") {
    return (
      <TraceTagChip
        inner={part.inner}
        key={`tag-${part.id}-${part.name}`}
        name={part.name}
        onJump={onJump}
        renderInner={renderTraceLinks}
      />
    );
  }
  return (
    <span key={`md-${part.id}`}>{renderTraceLinks(part.text, onJump)}</span>
  );
}

/**
 * True when an event/system line folds into at least one chip — a harness
 * wrapper tag OR (ISS-4767) a slash-command invocation. The event row uses this
 * to render such a line as a left-aligned block instead of the centered
 * `st-sysline` separator row: a separator row is a `<button>` when `onJump` is
 * set, so nesting the chip's `<button>` there would be a button in a button
 * (invalid DOM, hydration recovery) and expanding the chip would bubble a
 * timeline jump; and the tall expanded body would sit awkwardly between the
 * separator's two floating hairline dashes. Shares `parseTraceParts` so the
 * decision cannot drift from what `renderTraceEventContent` actually produces.
 *
 * Tested as "not plain markdown" rather than an allow-list of chip kinds, so a
 * future `TracePart` variant that renders a chip cannot silently regress the
 * guard by being forgotten here.
 */
export function containsHarnessTag(text: string): boolean {
  return parseTraceParts(text).some((part) => part.kind !== "md");
}
