/**
 * @file traced-session-rows.ts
 * @description The invocation rows of the one session this sandbox describes,
 * assembled in emission order.
 *
 * THIS FILE IS THE ORDER, NOT THE CONTENT. Each lane is a module of its own —
 * `./traced-session-lane-explore.ts`, `-implement`, `-validate`, `-review` —
 * and `./traced-session-row-builder.ts` owns how a row is made. What lives here
 * is the one thing none of them can own alone: the sequence they ran in. That
 * matters because `sequence` and every `externalInvocationId` are the emission
 * ordinal, so the lanes are called in the order the session ran and a reordering
 * here is a reordering of the fixture.
 *
 * Generated rather than typed out, because 200 literals drift against each
 * other and a generator cannot: the id is the sequence, `definitionHash` is a
 * function of the component key, and every cost is priced from that row's own
 * token vector. What is hand-authored is the part that has to be deliberate —
 * the SHAPE. Each lane is written out node by node, so the fan-out overlaps
 * because it was placed to overlap, the idle gaps are where somebody decided
 * the session went quiet, and the failures sit at the depths a debugger
 * actually has to reach.
 *
 * THE SHAPE THIS FIXTURE EXISTS TO EXERCISE, and which lane owns each:
 *
 *  - FAN-OUT WITH REAL OVERLAP (implement). Four shards whose measured extents
 *    run concurrently for most of fifteen minutes. Their durations sum to far
 *    more than the parent's own span, which is the whole reason `selfMs` comes
 *    off the UNION of the children rather than their sum.
 *  - VARIED DEPTH (validate, explore, review). The validation lane bottoms out
 *    eleven levels down; the planning lane stops at six; the wrap-up rows are
 *    leaves at the root, beside the command that owns everything else.
 *  - FAILURE TEXTURE: five failures over two depths and three kinds. A hook that
 *    BLOCKS (validate); a tool that fails and is retried to success in the same
 *    lane (validate); a failure inside ONE fan-out shard while its three
 *    siblings pass (implement); an MCP call that fails during review (review).
 *  - TIME TEXTURE. Two idle gaps with nothing in them (560s->680s before
 *    implement, 3,000s->3,100s before review), one `dagger call check` that
 *    owns eleven minutes on its own, and several rapid-fire runs where a dozen
 *    calls land inside twenty seconds.
 *  - EXTENT PROVENANCE. Tool, orchestration and hook rows carry a measured
 *    `durationMs`; command and skill activations never do, because nothing
 *    brackets them. Two rows (review) carry no `invokedAt` at all.
 *
 * WHY THE SUBJECT IS THE DESIGN PACK. The narrative is the session the reader
 * clicked in the Sessions table — `SES-7B91`, prototyping the generic artifact
 * shells. Component names are this repo's real public ones; nothing here is
 * copied from a private transcript. Where the proportions came from, and what
 * is measured against what is composed, is documented on `./traced-session.ts`.
 */

import { emitExploreLane } from "./traced-session-lane-explore";
import { emitImplementLane } from "./traced-session-lane-implement";
import { emitReviewLane } from "./traced-session-lane-review";
import { emitValidateLane } from "./traced-session-lane-validate";
import type { TracedSessionInvocation } from "./traced-session-model";
import { createRowBuilder } from "./traced-session-row-builder";

function buildTracedSessionRows(): readonly TracedSessionInvocation[] {
  const builder = createRowBuilder();
  const designSkill = emitExploreLane(builder);
  emitImplementLane(builder, designSkill);
  emitValidateLane(builder, designSkill);
  emitReviewLane(builder, designSkill);
  return builder.rows;
}

export const tracedSessionInvocations: readonly TracedSessionInvocation[] =
  buildTracedSessionRows();
