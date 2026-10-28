import { describe, expect, it } from "vitest";
import {
  rewriteVibeCorpusText,
  VIBE_SEED_BRANCH_NAMES,
  VIBE_SEED_CORPUS_HOMES,
  VIBE_SEED_CORPUS_LOGINS,
  VIBE_SEED_CORPUS_NAMED_TEAMMATE,
  VIBE_SEED_SIGNED_IN_LOGIN,
  VIBE_SEED_UNHOMED_LOGIN,
  vibeCorpusSessionOwner,
} from "./vibe-seed-corpus.ts";

const NAMED_TEAMMATE = `${VIBE_SEED_CORPUS_NAMED_TEAMMATE.firstName} ${VIBE_SEED_CORPUS_NAMED_TEAMMATE.lastName}`;

const CLOSEDLOOP_TRACE =
  /closedloop|symphony|testuser|kaitoc|kerensa[.-]whitlock|whitlockk|daveth\.oakhurst|(?:fea|iss|pln|prd|pro)-\d+/i;

describe("rewriteVibeCorpusText", () => {
  it("leaves no ClosedLoop repository, person, link or ticket in corpus text", () => {
    const corpus = [
      '{"cwd":"/Users/testuser2/conductor/workspaces/closedloop-ai/atlanta"}',
      "git push origin corpus/feat/total-tokens-label",
      "See https://app.closedloop.ai/closedloop-ai/features/FEA-2180 (ISS-5318)",
      "PR #2026 in closedloop-ai/closedloop-ai by kerensa-whitlock, reviewed by Kerensa Whitlock (whitlockk)",
      "/home/testuser6/Workspace/closedloop-ai and /Users/daveth.oakhurst/Source",
      "ClosedLoop Desktop, CLOSEDLOOP_API_URL, closedloop-agent",
      "worktree-pln-1772 merged; fea-1459-attribution-accuracy is stale",
      String.raw`{"command":"git commit -F - <<'EOF'\nISS-6147: share the order\nby testuser5"}`,
    ].join("\n");

    const rewritten = rewriteVibeCorpusText(corpus);

    expect(rewritten).not.toMatch(CLOSEDLOOP_TRACE);
    expect(rewritten).toContain(
      `/Users/${VIBE_SEED_SIGNED_IN_LOGIN}/conductor/workspaces/acme-web/atlanta`
    );
    expect(rewritten).toContain(
      VIBE_SEED_BRANCH_NAMES.get("corpus/feat/total-tokens-label")
    );
    expect(rewritten).toContain(
      `acme-co/acme-web by ${VIBE_SEED_SIGNED_IN_LOGIN}, reviewed by ${NAMED_TEAMMATE} (${VIBE_SEED_CORPUS_NAMED_TEAMMATE.githubUsername})`
    );
    expect(rewritten).toContain("https://app.acmeco.example/acme-co/");
  });

  it("renames every corpus branch whole, to a name with no ticket slug", () => {
    for (const [corpus, acme] of VIBE_SEED_BRANCH_NAMES) {
      expect(rewriteVibeCorpusText(`refs/heads/${corpus}`)).toBe(
        `refs/heads/${acme}`
      );
      expect(acme).not.toMatch(CLOSEDLOOP_TRACE);
    }
  });

  it("leaves text with nothing to rewrite unchanged", () => {
    const text = '{"tool":"Edit","file":"apps/web/projects/list.tsx"}';
    expect(rewriteVibeCorpusText(text)).toBe(text);
  });
});

describe("vibeCorpusSessionOwner", () => {
  it("names the Acme person whose home directory the session ran in", () => {
    expect(
      vibeCorpusSessionOwner(
        rewriteVibeCorpusText("/Users/kerensa.whitlock/Dev/closedloop-ai")
      )
    ).toBe(VIBE_SEED_CORPUS_LOGINS["kerensa.whitlock"]);
    expect(
      vibeCorpusSessionOwner(rewriteVibeCorpusText("/home/testuser6/x"))
    ).toBe(VIBE_SEED_CORPUS_LOGINS.testuser6);
  });

  it("hands a home directory with its own owner to that person, not its login's", () => {
    expect(
      vibeCorpusSessionOwner(
        rewriteVibeCorpusText("/home/testuser2/Workspace/closedloop-ai")
      )
    ).toBe(VIBE_SEED_CORPUS_HOMES["/home/testuser2"]);
    expect(
      vibeCorpusSessionOwner(rewriteVibeCorpusText("/Users/testuser2/x"))
    ).toBe(VIBE_SEED_CORPUS_LOGINS.testuser2);
  });

  it("keeps every home-directory owner as the session's owner", () => {
    for (const [home, owner] of Object.entries(VIBE_SEED_CORPUS_HOMES)) {
      expect(
        vibeCorpusSessionOwner(rewriteVibeCorpusText(`${home}/project`))
      ).toBe(owner);
    }
  });

  it("gives a session run outside any home directory to the unhomed owner", () => {
    expect(vibeCorpusSessionOwner("/private/tmp")).toBe(
      VIBE_SEED_UNHOMED_LOGIN
    );
    expect(vibeCorpusSessionOwner(null)).toBe(VIBE_SEED_UNHOMED_LOGIN);
  });
});
