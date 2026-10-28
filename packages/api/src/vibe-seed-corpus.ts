/**
 * ISS-12135: how the golden corpus presents itself in a vibe environment, shared
 * by the vibe Desktop profile (which prepares the local store and launches the
 * Desktop) and the web seed (which replays that store into the API), so the
 * Desktop's own sync of the store lands on the rows the seed wrote instead of
 * duplicating or relabelling them.
 *
 * The corpus is the ClosedLoop team's own agent work. A vibe org is Acme Co, so
 * every name, path, link and ticket reference in it is rewritten to Acme work
 * once, where the store is built, and the transcripts the seed uploads go
 * through the same rewrite.
 */

import {
  VIBE_SEED_SESSION_TOPICS,
  type VibeSeedPullRequestTopic,
} from "./vibe-seed-corpus-topics.ts";

/**
 * The one machine the seeded person works on. The web seed attributes every
 * golden Desktop session to a compute target of this name, and the vibe
 * Desktop names itself the same (`CL_MACHINE_NAME`), so it reads as that
 * target. It never registers or syncs: a vibe Desktop has no relay and starts
 * at data sync level Off (ISS-12135). Named for no one, like
 * {@link VIBE_SEED_SIGNED_IN_LOGIN}.
 */
export const VIBE_SEED_MACHINE_NAME = "acme-macbook-pro";

/**
 * The GitHub handle of the person the vibe environment signs in as: the seed
 * attributes this person's corpus sessions to their own user on
 * {@link VIBE_SEED_MACHINE_NAME}, and the Desktop profile keeps only this
 * person's sessions, so its local store matches that attribution. It is also
 * their pull requests' and review replies' author and their home directory.
 *
 * Named for no one (ISS-12135): a seeded Vercel environment hands this
 * person's row to whoever signs in (`adopt-person.ts`), so a handle built from
 * the seeded name would show on that person's own pull requests and paths.
 */
export const VIBE_SEED_SIGNED_IN_LOGIN = "acme-dev";

/**
 * Each corpus identity (home directory, branch prefix, GitHub login) and the
 * GitHub handle of the seeded Acme person whose work it becomes. The handles
 * are the seed people's (`apps/api/scripts/vibe-seed/core/seed-people.ts`,
 * pinned by `vibe-seed-corpus-people.test.ts`).
 */
export const VIBE_SEED_CORPUS_LOGINS: Readonly<Record<string, string>> = {
  "kerensa.whitlock": VIBE_SEED_SIGNED_IN_LOGIN,
  "kerensa-whitlock": VIBE_SEED_SIGNED_IN_LOGIN,
  whitlockk: VIBE_SEED_SIGNED_IN_LOGIN,
  testuser2: VIBE_SEED_SIGNED_IN_LOGIN,
  kaitoc: VIBE_SEED_SIGNED_IN_LOGIN,
  testuser1: "dreyes",
  "closedloop-agent": "tlindqvist",
  testuser6: "tlindqvist",
  testuser5: "sadeyemi",
  testuser4: "dreyes",
  "<user>": "gracechen",
  testuser: "priyaraman",
  testuser3: "priyaraman",
  "daveth.oakhurst": "priyaraman",
};

/**
 * Home directories whose work belongs to someone other than their login's
 * person: testuser2's Linux checkout holds the corpus's newest OpenCode
 * sessions, which go to a teammate so the last 7 days are not all the
 * signed-in person's (Dashboard "Me" and "Organization" would read the same).
 */
export const VIBE_SEED_CORPUS_HOMES: Readonly<Record<string, string>> = {
  "/home/testuser2": "dreyes",
};

/** Whose work a session run outside any home directory (`/tmp`) is. */
export const VIBE_SEED_UNHOMED_LOGIN = "tlindqvist";

/**
 * ISS-12135 (Daveth's ruling, option b): the seeded teammate the corpus's
 * named person becomes in transcript prose, where that person reviews and
 * owns work. Not the signed-in person, whose row a seeded environment hands
 * to whoever signs in, so their own transcripts never name a stand-in for
 * them. The seed's teammate row reads its name and handle from here
 * (`seed-people.ts`).
 */
export const VIBE_SEED_CORPUS_NAMED_TEAMMATE = {
  firstName: "Tomas",
  lastName: "Lindqvist",
  githubUsername: VIBE_SEED_UNHOMED_LOGIN,
} as const;

const CORPUS_NAMED_PERSON = "Kerensa Whitlock";
const NAMED_TEAMMATE = `${VIBE_SEED_CORPUS_NAMED_TEAMMATE.firstName} ${VIBE_SEED_CORPUS_NAMED_TEAMMATE.lastName}`;

/**
 * Each corpus session's Acme title, summarizing the session's own opening
 * prompts (`vibe-seed-corpus-topics.ts`).
 */
export const VIBE_SEED_SESSION_TITLES: ReadonlyMap<string, string> = new Map(
  VIBE_SEED_SESSION_TOPICS.map((session) => [session.sessionId, session.title])
);

/**
 * Corpus branches and the Acme branch each becomes, matched whole and before
 * every other rule (they carry ticket slugs and logins the later rules would
 * rewrite piecemeal). Each is named for the work its session did on it.
 */
export const VIBE_SEED_BRANCH_NAMES: ReadonlyMap<string, string> = new Map(
  VIBE_SEED_SESSION_TOPICS.flatMap((session) =>
    session.branches.map((topic) => [topic.corpusBranch, topic.branch])
  )
);

const PULL_REQUEST_TOPICS: ReadonlyMap<string, VibeSeedPullRequestTopic> =
  new Map(
    VIBE_SEED_SESSION_TOPICS.flatMap((session) =>
      session.branches.flatMap((topic) =>
        topic.pullRequest === null ? [] : [[topic.branch, topic.pullRequest]]
      )
    )
  );

/**
 * The title and body of the pull request a corpus session opened from this
 * (Acme) branch, or undefined for a branch the corpus opened none from.
 */
export function vibeSeedPullRequestTopic(
  branchName: string
): VibeSeedPullRequestTopic | undefined {
  return PULL_REQUEST_TOPICS.get(branchName);
}

/**
 * Literal rewrites, applied in order after the branch names: repositories
 * whole, then the repository's checkout directory in a home-directory path
 * (it shares the organization's name, so the organization prefix rule would
 * otherwise claim it), then hosts, then the bare repository directory names,
 * then people, then the nightly review bots' wording in commit subjects.
 */
const LITERAL_REWRITES: readonly (readonly [string | RegExp, string])[] = [
  ["closedloop-ai/closedloop-ai", "acme-co/acme-web"],
  ["closedloop-ai/claude-plugins", "acme-co/agent-toolkit"],
  ["closedloop-ai/closedloop-electron", "acme-co/acme-desktop"],
  ["example-org/infrastructure", "acme-co/infra-live"],
  ["closedloop-ai/claude-code-expert-training", "acme-co/onboarding-guides"],
  [
    /(\/(?:Users|home)\/[^\s"'\\]*?\/)closedloop-ai(?=[/"'\\\s]|$)/g,
    "$1acme-web",
  ],
  ["closedloop-ai/", "acme-co/"],
  ["stage.example", "acmeco-stage.example"],
  ["closedloop.ai", "acmeco.example"],
  ["closedloop-ai", "acme-web"],
  ["closedloop-electron", "acme-desktop"],
  ["claude-plugins", "agent-toolkit"],
  ["example-infrastructure", "infra-live"],
  ["Daveth Oakhurst", "Priya Raman"],
  ["lemoncrow", "toolkit"],
  ["Add test coverage for testing-tina findings", "Add missing unit tests"],
  [" per CLAUDE.md convention", " per the style guide"],
  [" (emergent)", ""],
];

// The corpus person's name with the handle written beside it ("Kerensa Whitlock
// (whitlockk)", "Kerensa Whitlock, kerensa.whitlock@..."), so the handle becomes the teammate's
// along with the name instead of the signed-in person's.
const NAMED_PERSON_HANDLE =
  /Kerensa Whitlock(\s*[(,]\s*)(?:kerensa[.-]whitlock|whitlockk)\b/g;
const HOME_DIRECTORY =
  /\/(Users|home)\/(testuser\d?|kerensa\.whitlock|daveth\.oakhurst|<user>)(?=[/"'\\<\s:]|$)/g;
// A word starts at a non-word character or right after a JSON escape: a commit
// message inside a tool call's JSON reads `\nISS-6147: ...`, where `\b` sees no
// boundary between the escape's `n` and the slug.
const CORPUS_LOGIN_WORD =
  /(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))(testuser\d?|kaitoc|kerensa[.-]whitlock|whitlockk|daveth\.oakhurst|closedloop-agent)\b/g;
const UPPER_TICKET_SLUG =
  /(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))(?:FEA|ISS|PLN|PRD|PRO)-(\d+)\b/g;
const LOWER_TICKET_SLUG =
  /(?:(?<![A-Za-z0-9_])|(?<=\\[nrt]))(?:fea|iss|pln|prd|pro)-(\d+)\b/g;
// A benchmark PR's "DO NOT MERGE" marker, with the separator that introduced
// it, so no dash or empty parentheses are left behind.
const DO_NOT_MERGE_MARKERS: readonly (readonly [RegExp, string])[] = [
  [/\s*[\u2014\u2013-]+\s*DO NOT MERGE\b/g, ""],
  [/\s*\(DO NOT MERGE\)/g, ""],
  [/\[DO NOT MERGE\]\s*/g, ""],
  [/DO NOT MERGE:?\s*/g, ""],
];
const PRODUCT_WORDS: readonly (readonly [RegExp, string])[] = [
  [/ClosedLoop|Closedloop/g, "Acme"],
  [/CLOSEDLOOP/g, "ACME"],
  [/SYMPHONY/g, "ACME"],
  [/closedloop/g, "acme"],
  [/Symphony/g, "Acme"],
  [/symphony/g, "acme"],
];

/** Rewrite one piece of corpus text (a name, a path, a JSON payload, a transcript line) to Acme work. */
export function rewriteVibeCorpusText(text: string): string {
  let rewritten = text;
  for (const [from, to] of VIBE_SEED_BRANCH_NAMES) {
    rewritten = rewritten.replaceAll(from, to);
  }
  rewritten = rewritten.replace(
    NAMED_PERSON_HANDLE,
    `${NAMED_TEAMMATE}$1${VIBE_SEED_CORPUS_NAMED_TEAMMATE.githubUsername}`
  );
  rewritten = rewritten.replaceAll(CORPUS_NAMED_PERSON, NAMED_TEAMMATE);
  for (const [from, to] of LITERAL_REWRITES) {
    rewritten = rewritten.replaceAll(from, to);
  }
  for (const [pattern, to] of DO_NOT_MERGE_MARKERS) {
    rewritten = rewritten.replace(pattern, to);
  }
  rewritten = rewritten
    .replace(
      HOME_DIRECTORY,
      (_match, root: string, login: string) =>
        `/${root}/${
          VIBE_SEED_CORPUS_HOMES[`/${root}/${login}`] ??
          VIBE_SEED_CORPUS_LOGINS[login] ??
          VIBE_SEED_UNHOMED_LOGIN
        }`
    )
    .replace(
      CORPUS_LOGIN_WORD,
      (login: string) =>
        VIBE_SEED_CORPUS_LOGINS[login] ?? VIBE_SEED_UNHOMED_LOGIN
    )
    .replace(UPPER_TICKET_SLUG, "ACME-$1")
    .replace(LOWER_TICKET_SLUG, "acme-$1");
  for (const [pattern, to] of PRODUCT_WORDS) {
    rewritten = rewritten.replace(pattern, to);
  }
  return rewritten;
}

const REWRITTEN_HOME = /^\/(?:Users|home)\/([^/]+)/;
const ACME_HANDLES: ReadonlySet<string> = new Set([
  ...Object.values(VIBE_SEED_CORPUS_LOGINS),
  ...Object.values(VIBE_SEED_CORPUS_HOMES),
]);

/** The Acme handle whose session ran in this (rewritten) working directory. */
export function vibeCorpusSessionOwner(cwd: string | null): string {
  const home = cwd === null ? undefined : REWRITTEN_HOME.exec(cwd)?.[1];
  return home !== undefined && ACME_HANDLES.has(home)
    ? home
    : VIBE_SEED_UNHOMED_LOGIN;
}

const ACME_REPOSITORY_DIR = /(?:^|\/)(acme-web|agent-toolkit)(?:\/|$)/;

/** The repositories the vibe org holds, where the seed replays branch work. */
export const VIBE_SEED_REPOSITORIES: ReadonlySet<string> = new Set([
  "acme-co/acme-web",
  "acme-co/agent-toolkit",
]);

/** The Acme repository a (rewritten) working directory is a checkout of, if any. */
export function vibeCorpusRepositoryForCwd(cwd: string | null): string | null {
  const dir = cwd === null ? undefined : ACME_REPOSITORY_DIR.exec(cwd)?.[1];
  return dir === undefined ? null : `acme-co/${dir}`;
}
