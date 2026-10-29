import { DocumentType } from "@repo/api/src/types/document";
import { CommentBodyFormat } from "@repo/database";
import { textBody } from "@/app/comments/mention-body";
import type { VibeSeedContext } from "../stage";
import {
  ATTACHMENT_NAMES,
  COMMENT_TEXTS_BY_SUBTYPE,
  MENTION_TEXTS,
  REPLY_TEXTS,
  REPLY_TO_ADMIN_TEXTS,
} from "./base-seed-labels";
import type { PlannedDocument, SeedRoster } from "./base-seed-plan";

/**
 * ISS-12056 (Seed quality), ISS-12135 (bug 22): the base seed's comments, all
 * written by one person at seed time ("Scaled seed comment N."), rewritten as
 * the team's review of each document: reviewers by role, dated inside the
 * document's own life, owners replying, and a few comments that @mention the
 * signed-in person or answer theirs.
 *
 * Direct writes, not `commentsService`: document comments are Liveblocks
 * threads the product projects into these rows, and the only writer for them
 * goes through Liveblocks first, which a local seed has no project for. An
 * edit through the service would also stamp every comment "edited".
 */

const SCALED_COMMENT_PREFIX = "Scaled seed comment ";
/** The openings of the base seed's five fixed comments on its first documents. */
const FIXED_BASE_COMMENT_PREFIXES = [
  "Initial feedback on this document.",
  "Follow-up: looks good after review.",
  "Liveblocks collaborative comment.",
  "Resolved the concern mentioned above.",
  "GitHub PR review comment",
] as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Every third thread gets an answer from the document's owner. */
const REPLY_EVERY_NTH_THREAD = 3;
/** Threads that ask the signed-in person for something. */
const MENTION_THREAD_COUNT = MENTION_TEXTS.length;
/** Threads where the signed-in person asked and a teammate answered. */
const ADMIN_THREAD_COUNT = REPLY_TO_ADMIN_TEXTS.length;
/** Comments on rows with no planned document land in the last few weeks. */
const LOOSE_COMMENT_WINDOW_DAYS = 21;

type ThreadRow = {
  readonly threadId: string;
  readonly artifactId: string;
  readonly resolved: boolean;
  readonly commentIds: readonly string[];
};

/** What one existing thread becomes, plus the reply to add, if any. */
export type ThreadRewrite = {
  readonly threadId: string;
  readonly authorId: string;
  readonly text: string;
  readonly mentions: readonly string[];
  readonly createdAt: Date;
  /** The document's owner, who answers in its threads. */
  readonly ownerId: string;
  readonly resolvedById: string | null;
  /** Comments already in the thread after its first; rewritten as replies. */
  readonly existingReplyIds: readonly string[];
  readonly reply: { authorId: string; text: string; createdAt: Date } | null;
};

export async function relabelBaseSeedComments(
  context: VibeSeedContext,
  roster: SeedRoster,
  documents: ReadonlyMap<string, PlannedDocument>
): Promise<number> {
  const threads = await findBaseThreads(context);
  await relabelAttachments(context);
  if (threads.length === 0) {
    return 0;
  }
  const admin = await context.prisma.user.findUnique({
    where: { id: roster.admin },
    select: { firstName: true, lastName: true },
  });
  const adminName = [admin?.firstName, admin?.lastName]
    .filter(Boolean)
    .join(" ");
  const rewrites = planThreadRewrites({
    threads,
    roster,
    documents,
    adminName,
    now: context.now,
  });
  let written = 0;
  for (const rewrite of rewrites) {
    written += await applyRewrite(context, rewrite);
  }
  return written;
}

async function findBaseThreads(context: VibeSeedContext): Promise<ThreadRow[]> {
  const comments = await context.prisma.comment.findMany({
    where: {
      thread: { organizationId: context.organizationId },
      OR: [
        ...[SCALED_COMMENT_PREFIX, ...FIXED_BASE_COMMENT_PREFIXES].map(
          (prefix) => ({ plainText: { startsWith: prefix } })
        ),
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      threadId: true,
      thread: { select: { artifactId: true, resolvedAt: true } },
    },
  });
  const byThread = new Map<string, ThreadRow & { commentIds: string[] }>();
  for (const comment of comments) {
    const thread = byThread.get(comment.threadId) ?? {
      threadId: comment.threadId,
      artifactId: comment.thread.artifactId,
      resolved: comment.thread.resolvedAt !== null,
      commentIds: [],
    };
    thread.commentIds.push(comment.id);
    byThread.set(comment.threadId, thread);
  }
  return [...byThread.values()].sort((left, right) =>
    left.threadId.localeCompare(right.threadId)
  );
}

type RewriteInput = {
  readonly threads: readonly ThreadRow[];
  readonly roster: SeedRoster;
  readonly documents: ReadonlyMap<string, PlannedDocument>;
  readonly adminName: string;
  readonly now: Date;
};

/**
 * Pure: who says what on each thread, and when. Reviewers come from the roles
 * that review that kind of document and never include its owner; the first
 * threads on documents the signed-in person does not own @mention them, and
 * the first threads on documents they do own carry their question and a
 * teammate's answer.
 */
export function planThreadRewrites(input: RewriteInput): ThreadRewrite[] {
  const { threads, roster, documents, now } = input;
  const perArtifact = new Map<string, number>();
  const artifactTotals = new Map<string, number>();
  for (const thread of threads) {
    artifactTotals.set(
      thread.artifactId,
      (artifactTotals.get(thread.artifactId) ?? 0) + 1
    );
  }
  let mentions = 0;
  let adminThreads = 0;
  return threads.map((thread, index) => {
    const position = perArtifact.get(thread.artifactId) ?? 0;
    perArtifact.set(thread.artifactId, position + 1);
    const document = documents.get(thread.artifactId);
    const window = commentWindow(document, now, index);
    const total = artifactTotals.get(thread.artifactId) ?? 1;
    const createdAt = new Date(
      window.start +
        ((position + 1) / (total + 1)) * (window.end - window.start)
    );
    const owner = document?.assigneeId ?? roster.admin;
    const base = {
      threadId: thread.threadId,
      createdAt,
      ownerId: owner,
      existingReplyIds: thread.commentIds.slice(1),
    };
    if (
      document &&
      owner !== roster.admin &&
      position === 0 &&
      mentions < MENTION_THREAD_COUNT &&
      input.adminName
    ) {
      const text = MENTION_TEXTS[mentions]?.(input.adminName) ?? "";
      mentions += 1;
      return {
        ...base,
        authorId: owner,
        text,
        mentions: [roster.admin],
        resolvedById: null,
        reply: null,
      };
    }
    if (
      owner === roster.admin &&
      document &&
      adminThreads < ADMIN_THREAD_COUNT
    ) {
      const reviewer = pickReviewer(document, roster, index, owner);
      const text = REPLY_TO_ADMIN_TEXTS[adminThreads] ?? "";
      adminThreads += 1;
      return {
        ...base,
        authorId: roster.admin,
        text: pickText(document, index),
        mentions: [],
        resolvedById: null,
        reply: {
          authorId: reviewer,
          text,
          createdAt: new Date(createdAt.getTime() + 3 * HOUR_MS),
        },
      };
    }
    const authorId = pickReviewer(document, roster, index, owner);
    return {
      ...base,
      authorId,
      text: pickText(document, index),
      mentions: [],
      resolvedById: thread.resolved ? owner : null,
      reply:
        document && position % REPLY_EVERY_NTH_THREAD === 1
          ? {
              authorId: owner,
              text: REPLY_TEXTS[index % REPLY_TEXTS.length] ?? "",
              createdAt: new Date(createdAt.getTime() + 5 * HOUR_MS),
            }
          : null,
    };
  });
}

/**
 * A document is discussed between its first draft and a day after its last
 * change; anything without a planned document is spread over recent weeks.
 */
function commentWindow(
  document: PlannedDocument | undefined,
  now: Date,
  index: number
): { start: number; end: number } {
  const latest = now.getTime() - 2 * HOUR_MS;
  if (!document) {
    const start =
      now.getTime() - (LOOSE_COMMENT_WINDOW_DAYS - (index % 14)) * DAY_MS;
    return { start, end: Math.min(start + 6 * DAY_MS, latest) };
  }
  const start = document.createdAt.getTime() + 4 * HOUR_MS;
  const end = Math.min(document.updatedAt.getTime() + DAY_MS, latest);
  return { start, end: Math.max(end, Math.min(start + 6 * HOUR_MS, latest)) };
}

/**
 * PRDs are reviewed by engineers and design, plans by other engineers and the
 * signed-in person, docs by product and engineering, issues by whoever files
 * and builds them. The owner answers rather than reviews.
 */
function pickReviewer(
  document: PlannedDocument | undefined,
  roster: SeedRoster,
  index: number,
  owner: string
): string {
  const pool = reviewerPool(document, roster).filter((id) => id !== owner);
  return pool[index % pool.length] ?? roster.admin;
}

function reviewerPool(
  document: PlannedDocument | undefined,
  roster: SeedRoster
): string[] {
  const team = [...roster.pms, ...roster.engineers, ...roster.designers];
  if (!document) {
    return team;
  }
  switch (document.subtype) {
    case DocumentType.Prd:
      return [...roster.engineers, ...roster.designers];
    case DocumentType.ImplementationPlan:
      return [...roster.engineers, roster.admin];
    case DocumentType.Doc:
      return [...roster.pms, ...roster.engineers];
    default:
      return [document.createdById, ...roster.pms, ...roster.engineers];
  }
}

function pickText(document: PlannedDocument | undefined, index: number) {
  const pool =
    COMMENT_TEXTS_BY_SUBTYPE[document?.subtype ?? DocumentType.Feature] ?? [];
  return pool[index % pool.length] ?? "";
}

async function applyRewrite(
  context: VibeSeedContext,
  rewrite: ThreadRewrite
): Promise<number> {
  const { prisma } = context;
  const [rootId] = await prisma.comment
    .findMany({
      where: { threadId: rewrite.threadId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true },
      take: 1,
    })
    .then((rows) => rows.map((row) => row.id));
  if (!rootId) {
    return 0;
  }
  await prisma.comment.update({
    where: { id: rootId },
    data: {
      authorId: rewrite.authorId,
      plainText: rewrite.text,
      body: textBody(rewrite.text, rewrite.mentions),
      createdAt: rewrite.createdAt,
      updatedAt: rewrite.createdAt,
    },
    select: { id: true },
  });
  let written = 1;
  for (const [offset, replyId] of rewrite.existingReplyIds.entries()) {
    if (replyId === rootId) {
      continue;
    }
    const text = REPLY_TEXTS[offset % REPLY_TEXTS.length] ?? "";
    const at = new Date(rewrite.createdAt.getTime() + (offset + 1) * HOUR_MS);
    await prisma.comment.update({
      where: { id: replyId },
      data: {
        authorId: rewrite.ownerId,
        plainText: text,
        body: textBody(text),
        parentCommentId: rootId,
        createdAt: at,
        updatedAt: at,
      },
      select: { id: true },
    });
    written += 1;
  }
  if (rewrite.reply) {
    await prisma.comment.create({
      data: {
        threadId: rewrite.threadId,
        authorId: rewrite.reply.authorId,
        bodyFormat: CommentBodyFormat.RICH_V1,
        body: textBody(rewrite.reply.text),
        plainText: rewrite.reply.text,
        parentCommentId: rootId,
        createdAt: rewrite.reply.createdAt,
        updatedAt: rewrite.reply.createdAt,
      },
      select: { id: true },
    });
    written += 1;
  }
  const settledAt = rewrite.reply?.createdAt ?? rewrite.createdAt;
  await prisma.commentThread.update({
    where: { id: rewrite.threadId },
    data: {
      createdById: rewrite.authorId,
      createdAt: rewrite.createdAt,
      updatedAt: settledAt,
      ...(rewrite.resolvedById
        ? {
            resolvedById: rewrite.resolvedById,
            resolvedAt: new Date(settledAt.getTime() + HOUR_MS),
          }
        : {}),
    },
    select: { id: true },
  });
  return written;
}

async function relabelAttachments(context: VibeSeedContext): Promise<void> {
  const { prisma, organizationId } = context;
  for (const [from, to] of Object.entries(ATTACHMENT_NAMES)) {
    const attachments = await prisma.commentAttachment.findMany({
      where: { name: from, comment: { thread: { organizationId } } },
      select: { id: true, url: true },
    });
    for (const attachment of attachments) {
      await prisma.commentAttachment.update({
        where: { id: attachment.id },
        data: { name: to, url: attachment.url?.replace(from, to) ?? null },
        select: { id: true },
      });
    }
  }
}
