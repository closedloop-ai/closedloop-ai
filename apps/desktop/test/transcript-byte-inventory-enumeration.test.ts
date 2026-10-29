/**
 * @file transcript-byte-inventory-enumeration.test.ts
 * @description ISS-8506 — what the sweep actually WALKS, and what it admits it
 * could not. Covers the harness probes, `collectTranscriptByteInventory`'s
 * lister wiring (including the harnesses it must NOT open), and the walk-skip
 * plumbing that turns an unreadable subtree into an impairment.
 *
 * The pure fold over an already-enumerated ref list is the sibling
 * `transcript-byte-inventory.test.ts`. Shared fixtures live in
 * `transcript-byte-inventory-fixtures.ts`.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Harness } from "@repo/lib/harness/types";
import { afterAll, test } from "vitest";
import {
  DirectoryWalkSkipReason,
  reportReaddirSkip,
} from "../src/main/collectors/engine/directory-walk-skip.js";
import { PathReadability } from "../src/main/collectors/engine/file-access-probe.js";
import { listOpenCodeStoreFiles } from "../src/main/collectors/opencode/opencode-home.js";
import { collectJsonlFiles } from "../src/main/collectors/parsing/parser-utils.js";
import { opencodeMaterializedRoot } from "../src/main/transcript-sync/opencode-materializer.js";
import {
  collectTranscriptByteInventory,
  MAX_INVENTORY_FILES,
} from "../src/main/transcript-sync/transcript-byte-inventory.js";
import {
  TranscriptByteLane,
  TranscriptHarnessOutcome,
  TranscriptImpairmentReason,
  TranscriptInventoryCompleteness,
} from "../src/main/transcript-sync/transcript-byte-inventory-types.js";
import { probeTranscriptHarnesses } from "../src/main/transcript-sync/transcript-harness-probe.js";
import {
  TRANSCRIPT_MAIN_FILE_KEY,
  TranscriptSourceHarness,
} from "../src/main/transcript-sync/transcript-sync-types.js";
import { createTranscriptWalkSkipLedger } from "../src/main/transcript-sync/transcript-walk-skip-ledger.js";
import {
  cleanupTempDirs,
  makeTempDir,
} from "./normalized-session-test-utils.js";
import {
  measuredProbes,
  SCAN_START,
  stat,
} from "./transcript-byte-inventory-fixtures.js";

test("the harness probe never runs the OpenCode materializer", () => {
  // Only the sync sweeper writes the projection, behind its tier gate.
  // Onboarding runs before that, and a measurement must not do the sweeper's
  // job to make its own number look complete — it reports the gap instead.
  let materializeCalls = 0;
  const probes = probeTranscriptHarnesses("/state", {
    scanRoots: () => [
      { harness: TranscriptSourceHarness.OpenCode, roots: ["/oc"] },
    ],
    checkReadable: (root) => {
      if (root === "/oc") {
        return PathReadability.Readable;
      }
      materializeCalls += 1;
      return PathReadability.Absent;
    },
    checkFile: () => PathReadability.Readable,
    openCodeHome: () => "/oc",
    openCodeDbPath: () => "/oc/opencode.db",
    materializedRoot: () => "/state/transcript-materialized/opencode",
  });

  const opencode = probes.find(
    (probe) => probe.harness === TranscriptSourceHarness.OpenCode
  );
  assert.equal(opencode?.outcome, TranscriptHarnessOutcome.Impaired);
  assert.equal(
    opencode?.impairments[0]?.reason,
    TranscriptImpairmentReason.OpencodeUnmaterialized
  );
  // The projection is the UPLOAD lane's file. Scoping the gap to that lane is
  // what lets the parse number on this machine stay complete.
  assert.equal(opencode?.impairments[0]?.lane, TranscriptByteLane.Upload);
  // Only the readability probe touched the materialized root — nothing wrote it.
  assert.equal(materializeCalls, 1);
});

test("an absent opencode.db means not installed, not unmeasured", () => {
  // The home DIRECTORY can exist without the database. Probing the directory
  // for installed-ness would call OpenCode present when it is not, and turn a
  // real zero into a partial measurement.
  const probes = probeTranscriptHarnesses("/state", {
    scanRoots: () => [
      { harness: TranscriptSourceHarness.OpenCode, roots: ["/oc"] },
    ],
    checkReadable: () => PathReadability.Readable,
    checkFile: () => PathReadability.Absent,
    openCodeHome: () => "/oc",
    openCodeDbPath: () => "/oc/opencode.db",
    materializedRoot: () => "/state/transcript-materialized/opencode",
  });

  const opencode = probes.find(
    (probe) => probe.harness === TranscriptSourceHarness.OpenCode
  );
  assert.equal(opencode?.outcome, TranscriptHarnessOutcome.Absent);
  assert.deepEqual(opencode?.impairments, []);
});

test("a blocked Claude root is reported with a home-abbreviated path", () => {
  const probes = probeTranscriptHarnesses("/state", {
    scanRoots: () => [
      {
        harness: TranscriptSourceHarness.Claude,
        roots: ["/root/a", "/root/b"],
      },
    ],
    checkReadable: (root) =>
      root === "/root/a" ? PathReadability.Blocked : PathReadability.Readable,
    checkFile: () => PathReadability.Absent,
    openCodeHome: () => "/oc",
    openCodeDbPath: () => "/oc/opencode.db",
    materializedRoot: () => "/state/m",
  });

  const claude = probes.find(
    (probe) => probe.harness === TranscriptSourceHarness.Claude
  );
  // A readable sibling root does not rescue a denied one: the denied root's
  // files were never seen, so the harness is impaired, not measured.
  assert.equal(claude?.outcome, TranscriptHarnessOutcome.Impaired);
  assert.equal(
    claude?.impairments[0]?.reason,
    TranscriptImpairmentReason.RootBlocked
  );
});

test("the probe covers only the three archive-capable harnesses", () => {
  // Ruling 1: probing the readability of roots we already enumerate is not
  // widening discovery. Cursor and Copilot have no archive lane and must not be
  // probed, enumerated, stat'ed or counted.
  const probed: string[] = [];
  probeTranscriptHarnesses("/state", {
    scanRoots: () => [
      { harness: TranscriptSourceHarness.Claude, roots: ["/claude"] },
      { harness: TranscriptSourceHarness.Codex, roots: ["/codex"] },
      { harness: Harness.Cursor, roots: ["/cursor"] },
      { harness: Harness.Copilot, roots: ["/copilot"] },
      { harness: TranscriptSourceHarness.OpenCode, roots: ["/oc"] },
    ],
    checkReadable: (root) => {
      probed.push(root);
      return PathReadability.Absent;
    },
    checkFile: () => PathReadability.Absent,
    openCodeHome: () => "/oc",
    openCodeDbPath: () => "/oc/opencode.db",
    materializedRoot: () => "/state/m",
  });

  assert.equal(probed.includes("/cursor"), false);
  assert.equal(probed.includes("/copilot"), false);
  assert.deepEqual(probed.sort(), ["/claude", "/codex", "/oc"]);
});

test("OpenCode bytes reach both lanes from the file each lane actually reads", () => {
  // The regression this exists for: `discoverTranscriptFiles`'s own default for
  // the OpenCode seam is `() => []`, so a collector that forgets to supply the
  // real lister enumerates NO OpenCode files while the probe still reports the
  // harness measured — a `complete` inventory and a confident upload total
  // missing an entire harness. That is the exact defect this ticket exists to
  // close, and it is invisible unless a test counts the bytes.
  //
  // Since the 2026-09-02 ruling the two lanes read different OpenCode files:
  // the store is what the collector parses, the projection is what the archive
  // lane sends. Each must reach ITS lane and neither may reach both, or a
  // materialized machine counts every OpenCode byte twice.
  const sizes: Record<string, number> = {
    "/oc/opencode.db": 500,
    "/state/transcript-materialized/opencode/oc-1/main.jsonl": 750,
  };
  const inventory = collectTranscriptByteInventory("/state", {
    now: () => SCAN_START,
    nextRevision: () => 1,
    listClaudeMainFiles: () => [],
    listClaudeSubagentFiles: () => [],
    listCodexRolloutFiles: () => [],
    listOpencodeStoreFiles: () => ["/oc/opencode.db"],
    listOpencodeMaterializedFiles: () => [
      {
        externalSessionId: "oc-1",
        fileKey: TRANSCRIPT_MAIN_FILE_KEY,
        sourcePath: "/state/transcript-materialized/opencode/oc-1/main.jsonl",
      },
    ],
    lstatEntry: (sourcePath) =>
      stat({ size: sizes[sourcePath], ino: sizes[sourcePath] }),
    probeHarnesses: () => [
      {
        harness: TranscriptSourceHarness.OpenCode,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
    ],
  });

  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Complete
  );
  assert.equal(
    inventory.uploadCompleteness,
    TranscriptInventoryCompleteness.Complete
  );
  assert.equal(
    inventory.eligibleParseBytes,
    500,
    "the store is what is parsed"
  );
  assert.equal(
    inventory.discoveredBytes,
    500,
    "the projection is not a second copy of the corpus"
  );
  assert.equal(
    inventory.attributableRawBytes,
    750,
    "the projection is what is sent"
  );
  assert.deepEqual(
    inventory.eligibleFiles.map((file) => file.externalSessionId),
    ["oc-1"],
    "the store is never an archive row"
  );
});

test("the default store lister is the collector's own file set, ENOENT siblings omitted", () => {
  // `opencode.db` is always there on an install; the WAL/SHM siblings come and
  // go with SQLite's checkpointing. An absent sibling is the ordinary state and
  // must not read as unreadable, and a present one is real bytes the collector
  // will read through.
  const home = makeTempDir("opencode-home-");
  writeFileSync(join(home, "opencode.db"), "x".repeat(10));
  writeFileSync(join(home, "opencode.db-wal"), "y".repeat(4));

  assert.deepEqual(listOpenCodeStoreFiles(home), [
    join(home, "opencode.db"),
    join(home, "opencode.db-wal"),
  ]);
  assert.deepEqual(listOpenCodeStoreFiles(makeTempDir("opencode-empty-")), []);
});

test("a store lister that cannot stat keeps the path so lstat can call it unreadable", () => {
  // The non-ENOENT half of the contract: a home whose last segment is a FILE
  // makes every child stat throw ENOTDIR. Dropping the paths there would make a
  // broken install read as a real zero; keeping them lets the inventory's own
  // lstat classify each as unreadable and impair the parse lane.
  const notADir = join(makeTempDir("opencode-notdir-"), "opencode");
  writeFileSync(notADir, "not a directory");

  assert.deepEqual(listOpenCodeStoreFiles(notADir), [
    join(notADir, "opencode.db"),
    join(notADir, "opencode.db-wal"),
    join(notADir, "opencode.db-shm"),
  ]);
});

test("the default store lister is wired, so a real store reaches the parse lane", () => {
  // Injecting a store list proves the plumbing, not the DEFAULT — and the
  // default is what production runs. `getOpenCodeHome` honours
  // OPENCODE_DATA_DIR, which is the one seam that redirects it without a mock.
  const home = makeTempDir("opencode-wired-");
  const dbPath = join(home, "opencode.db");
  writeFileSync(dbPath, "x".repeat(123));
  const previous = process.env.OPENCODE_DATA_DIR;
  process.env.OPENCODE_DATA_DIR = home;
  const statted: string[] = [];
  try {
    const inventory = collectTranscriptByteInventory("/state", {
      now: () => SCAN_START,
      nextRevision: () => 1,
      listClaudeMainFiles: () => [],
      listClaudeSubagentFiles: () => [],
      listCodexRolloutFiles: () => [],
      listOpencodeMaterializedFiles: () => [],
      lstatEntry: (sourcePath) => {
        statted.push(sourcePath);
        return stat({ size: 123, ino: 5 });
      },
      probeHarnesses: () => [
        {
          harness: TranscriptSourceHarness.OpenCode,
          outcome: TranscriptHarnessOutcome.Measured,
          impairments: [],
        },
      ],
    });
    assert.deepEqual(statted, [dbPath]);
    assert.equal(inventory.eligibleParseBytes, 123);
  } finally {
    if (previous === undefined) {
      Reflect.deleteProperty(process.env, "OPENCODE_DATA_DIR");
    } else {
      process.env.OPENCODE_DATA_DIR = previous;
    }
  }
});

test("a redirected probe home is the home the store lister reads", () => {
  // The probe and the store lister must resolve the OpenCode home through ONE
  // seam. A caller that redirects only `probeOverrides.openCodeHome` — the
  // seam ISS-8376 will wire — would otherwise probe one install and size
  // another. Reverting the lister to a bare `getOpenCodeHome()` fails this.
  const home = makeTempDir("opencode-seam-");
  const dbPath = join(home, "opencode.db");
  writeFileSync(dbPath, "x".repeat(77));
  const statted: string[] = [];

  const inventory = collectTranscriptByteInventory("/state", {
    now: () => SCAN_START,
    nextRevision: () => 1,
    probeOverrides: { openCodeHome: () => home },
    listClaudeMainFiles: () => [],
    listClaudeSubagentFiles: () => [],
    listCodexRolloutFiles: () => [],
    listOpencodeMaterializedFiles: () => [],
    lstatEntry: (sourcePath) => {
      statted.push(sourcePath);
      return stat({ size: 77, ino: 9 });
    },
    probeHarnesses: () => [
      {
        harness: TranscriptSourceHarness.OpenCode,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
    ],
  });

  assert.deepEqual(statted, [dbPath]);
  assert.equal(inventory.eligibleParseBytes, 77);
});

test("the probe's db path follows a redirected home", () => {
  // The same seam from the probe's side: overriding the home alone must move
  // the install check with it, or the two halves of one measurement disagree
  // about which OpenCode they are looking at.
  const checked: string[] = [];
  probeTranscriptHarnesses("/state", {
    scanRoots: () => [],
    checkReadable: () => PathReadability.Readable,
    checkFile: (filePath) => {
      checked.push(filePath);
      return PathReadability.Absent;
    },
    openCodeHome: () => "/elsewhere/opencode",
    materializedRoot: () => "/state/m",
  });

  assert.deepEqual(checked, ["/elsewhere/opencode/opencode.db"]);
});

test("a disabled OpenCode never has its store listed", () => {
  // Same contract as the Codex case below: the probe's `disabled` is the one
  // decision, and the store lister obeys it like every other lister — no root
  // opened, no bytes counted.
  let storeListerCalls = 0;
  const inventory = collectTranscriptByteInventory("/state", {
    now: () => SCAN_START,
    nextRevision: () => 1,
    listClaudeMainFiles: () => [],
    listClaudeSubagentFiles: () => [],
    listCodexRolloutFiles: () => [],
    listOpencodeMaterializedFiles: () => [],
    listOpencodeStoreFiles: () => {
      storeListerCalls += 1;
      return ["/oc/opencode.db"];
    },
    lstatEntry: () => stat({ size: 900 }),
    probeHarnesses: () => [
      {
        harness: TranscriptSourceHarness.OpenCode,
        outcome: TranscriptHarnessOutcome.Disabled,
        impairments: [],
      },
    ],
  });

  assert.equal(storeListerCalls, 0);
  assert.equal(inventory.eligibleParseBytes, 0);
});

test("the default OpenCode lister is bound to the state dir, not left empty", () => {
  // Counting bytes is not enough on its own: an injected lister proves the
  // plumbing but not the DEFAULT, and the default is what production uses.
  const seen: string[] = [];
  collectTranscriptByteInventory("/my-state", {
    now: () => SCAN_START,
    nextRevision: () => 1,
    listClaudeMainFiles: () => [],
    listClaudeSubagentFiles: () => [],
    listCodexRolloutFiles: () => [],
    listOpencodeStoreFiles: () => [],
    lstatEntry: () => undefined,
    probeHarnesses: () => [],
    discover: (overrides = {}) => {
      // The real default reads the materialized root under the state dir and
      // returns [] when it is absent, which is what this asserts it reaches.
      overrides.listOpencodeMaterializedFiles?.();
      seen.push(
        typeof overrides.listOpencodeMaterializedFiles === "function"
          ? "supplied"
          : "missing"
      );
      return { refs: [], orphanCount: 0 };
    },
  });

  assert.deepEqual(seen, ["supplied"]);
});

test("a disabled harness is reported as disabled, not as absent", () => {
  // "Not installed" and "you turned it off" are different facts, and evidence
  // that says absent for a harness the user deliberately disabled tells the
  // reader the wrong story.
  const probes = probeTranscriptHarnesses("/state", {
    scanRoots: () => [],
    checkReadable: () => PathReadability.Readable,
    checkFile: () => PathReadability.Readable,
    openCodeHome: () => "/oc",
    openCodeDbPath: () => "/oc/opencode.db",
    materializedRoot: () => "/state/m",
    isEnabled: (harness) => harness !== TranscriptSourceHarness.Codex,
  });

  const codex = probes.find(
    (probe) => probe.harness === TranscriptSourceHarness.Codex
  );
  assert.equal(codex?.outcome, TranscriptHarnessOutcome.Disabled);
  assert.notEqual(codex?.outcome, TranscriptHarnessOutcome.Absent);
});

test("a disabled harness root is never opened", () => {
  // The FEA-3741 reason the toggle exists: no incidental TCC touch and no
  // file-access prompt for a harness nothing collects.
  const probed: string[] = [];
  probeTranscriptHarnesses("/state", {
    scanRoots: (isEnabled) =>
      [
        { harness: TranscriptSourceHarness.Claude, roots: ["/claude"] },
        { harness: TranscriptSourceHarness.Codex, roots: ["/codex"] },
      ].filter((entry) => isEnabled?.(entry.harness as never) ?? true),
    checkReadable: (root) => {
      probed.push(root);
      return PathReadability.Readable;
    },
    checkFile: () => PathReadability.Absent,
    openCodeHome: () => "/oc",
    openCodeDbPath: () => "/oc/opencode.db",
    materializedRoot: () => "/state/m",
    isEnabled: (harness) => harness !== TranscriptSourceHarness.Codex,
  });

  assert.equal(probed.includes("/codex"), false);
  assert.equal(probed.includes("/claude"), true);
});

test("a disabled harness's files are never enumerated, not merely relabelled", () => {
  // Evidence saying `disabled` while that harness's bytes sit inside the total
  // is the inflated twin of the OpenCode defect above: the parse and upload
  // lanes will never touch a switched-off collector, so counting its bytes
  // states a volume nothing will ever do work on — and opening its roots is the
  // incidental TCC touch FEA-3741's toggle exists to prevent.
  let codexListerCalls = 0;
  const inventory = collectTranscriptByteInventory("/state", {
    now: () => SCAN_START,
    nextRevision: () => 1,
    listClaudeMainFiles: () => ["/claude/a.jsonl"],
    listClaudeSubagentFiles: () => [],
    listOpencodeStoreFiles: () => [],
    listCodexRolloutFiles: () => {
      codexListerCalls += 1;
      return ["/codex/rollout-1.jsonl"];
    },
    listOpencodeMaterializedFiles: () => [],
    lstatEntry: () => stat({ size: 400, ino: 7 }),
    probeHarnesses: () => [
      {
        harness: TranscriptSourceHarness.Claude,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
      {
        harness: TranscriptSourceHarness.Codex,
        outcome: TranscriptHarnessOutcome.Disabled,
        impairments: [],
      },
    ],
  });

  assert.equal(codexListerCalls, 0, "a disabled harness must not be walked");
  assert.equal(inventory.eligibleParseBytes, 400);
  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Complete,
    "a switched-off collector is a real zero, not a gap in the measurement"
  );
});

test("an enabled harness is still enumerated when a sibling is disabled", () => {
  // The counterfactual for the case above: a bug that skipped every lister once
  // ANY harness was disabled would pass that assertion and lose real bytes.
  let codexListerCalls = 0;
  const inventory = collectTranscriptByteInventory("/state", {
    now: () => SCAN_START,
    nextRevision: () => 1,
    listClaudeMainFiles: () => [],
    listClaudeSubagentFiles: () => [],
    listOpencodeStoreFiles: () => [],
    listCodexRolloutFiles: () => {
      codexListerCalls += 1;
      return [];
    },
    listOpencodeMaterializedFiles: () => [],
    lstatEntry: () => undefined,
    probeHarnesses: () => [
      {
        harness: TranscriptSourceHarness.Codex,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
      {
        harness: TranscriptSourceHarness.OpenCode,
        outcome: TranscriptHarnessOutcome.Disabled,
        impairments: [],
      },
    ],
  });

  assert.equal(codexListerCalls, 1);
  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Complete
  );
});

test("a directory below a readable root that cannot be read forces partial", () => {
  // The root probe cannot see this: it opened the root fine. Without the skip
  // sink the shortened listing publishes as a confident, understated total.
  // `ENOTDIR` is used because it is a real, deterministic, permission-free
  // readdir rejection that is NOT `ENOENT` — the same branch a TCC denial takes.
  const stateDir = makeTempDir("inventory-subtree-");
  const root = opencodeMaterializedRoot(stateDir);
  mkdirSync(dirname(root), { recursive: true });
  writeFileSync(root, "not a directory");

  const inventory = collectTranscriptByteInventory(stateDir, {
    now: () => SCAN_START,
    nextRevision: () => 1,
    listClaudeMainFiles: () => [],
    listClaudeSubagentFiles: () => [],
    listCodexRolloutFiles: () => [],
    listOpencodeStoreFiles: () => [],
    lstatEntry: () => undefined,
    probeHarnesses: () => [
      {
        harness: TranscriptSourceHarness.OpenCode,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
    ],
  });

  const subtree = inventory.impairments.find(
    (impairment) =>
      impairment.reason === TranscriptImpairmentReason.SubtreeUnreadable
  );
  assert.equal(subtree?.harness, TranscriptSourceHarness.OpenCode);
  assert.equal(subtree?.count, 1);
  // The unreadable subtree is the PROJECTION root, which only the upload lane
  // reads: that lane must not publish a complete total, and the parse lane,
  // which never walks it, must not be shortened by it.
  assert.equal(subtree?.lane, TranscriptByteLane.Upload);
  assert.equal(
    inventory.uploadCompleteness,
    TranscriptInventoryCompleteness.Partial,
    "a subtree we never read must not be published as a complete total"
  );
  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Complete
  );
});

test("a blocked projection root shortens the upload lane, never the parse lane", () => {
  // The sibling of the unmaterialized case. `absent` was scoped to the upload
  // lane; `blocked`/`unknown` on the same directory went through the shared
  // root helper unscoped, and refused a parse number the store had measured.
  const probes = probeTranscriptHarnesses("/state", {
    scanRoots: () => [],
    checkReadable: (root) =>
      root === "/state/m" ? PathReadability.Blocked : PathReadability.Readable,
    checkFile: () => PathReadability.Readable,
    openCodeHome: () => "/oc",
    openCodeDbPath: () => "/oc/opencode.db",
    materializedRoot: () => "/state/m",
  });

  const opencode = probes.find(
    (probe) => probe.harness === TranscriptSourceHarness.OpenCode
  );
  assert.equal(
    opencode?.impairments[0]?.reason,
    TranscriptImpairmentReason.RootBlocked
  );
  assert.equal(opencode?.impairments[0]?.lane, TranscriptByteLane.Upload);
});

test("an over-cap projection listing is an upload-lane truncation", () => {
  const paths = Array.from({ length: MAX_INVENTORY_FILES + 2 }, (_, i) => ({
    externalSessionId: `oc-${i}`,
    fileKey: TRANSCRIPT_MAIN_FILE_KEY,
    sourcePath: `/state/m/oc-${i}/main.jsonl`,
  }));
  const inventory = collectTranscriptByteInventory("/state", {
    now: () => SCAN_START,
    nextRevision: () => 1,
    listClaudeMainFiles: () => [],
    listClaudeSubagentFiles: () => [],
    listCodexRolloutFiles: () => [],
    listOpencodeStoreFiles: () => ["/oc/opencode.db"],
    listOpencodeMaterializedFiles: () => paths,
    lstatEntry: () => stat({ size: 10, ino: Math.random() }),
    probeHarnesses: () => [
      {
        harness: TranscriptSourceHarness.OpenCode,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
    ],
  });

  const truncation = inventory.impairments.find(
    (impairment) =>
      impairment.reason === TranscriptImpairmentReason.InputCapTruncated
  );
  assert.equal(truncation?.count, 2);
  assert.equal(truncation?.lane, TranscriptByteLane.Upload);
  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Complete,
    "the store was listed whole; only the projection listing was cut"
  );
  assert.equal(
    inventory.uploadCompleteness,
    TranscriptInventoryCompleteness.Partial
  );
});

test("an absent materialized root is a real zero, not an unreadable subtree", () => {
  // The ENOENT carve-out, end to end. Without it every machine that has never
  // materialized OpenCode reads as impaired, and `partial` stops meaning
  // anything.
  const stateDir = makeTempDir("inventory-absent-");
  const inventory = collectTranscriptByteInventory(stateDir, {
    now: () => SCAN_START,
    nextRevision: () => 1,
    listClaudeMainFiles: () => [],
    listClaudeSubagentFiles: () => [],
    listCodexRolloutFiles: () => [],
    listOpencodeStoreFiles: () => [],
    lstatEntry: () => undefined,
    probeHarnesses: () => [
      {
        harness: TranscriptSourceHarness.OpenCode,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
    ],
  });

  assert.deepEqual(inventory.impairments, []);
  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Complete
  );
});

test("one directory reported by two walks of the same tree is one gap", () => {
  // The Claude listers walk `projects/` twice — sessions, then subagents — so a
  // single denied project directory reaches the ledger twice. Counting it twice
  // would overstate how much of the corpus went unseen.
  const ledger = createTranscriptWalkSkipLedger();
  const sink = ledger.sinkFor(TranscriptSourceHarness.Claude);
  sink("/projects/denied", DirectoryWalkSkipReason.ReadError);
  sink("/projects/denied", DirectoryWalkSkipReason.ReadError);
  sink("/projects/other", DirectoryWalkSkipReason.ReadError);
  sink("/projects/deep", DirectoryWalkSkipReason.MaxDepth);

  assert.deepEqual(ledger.impairments(), [
    {
      reason: TranscriptImpairmentReason.SubtreeUnreadable,
      harness: TranscriptSourceHarness.Claude,
      count: 2,
    },
    {
      reason: TranscriptImpairmentReason.SubtreeDepthTruncated,
      harness: TranscriptSourceHarness.Claude,
      count: 1,
    },
  ]);
});

test("a walk that stops at its depth bound says so instead of returning short", () => {
  // `collectJsonlFiles` truncates at maxDepth and used to report nothing, so a
  // corpus nested deeper than the bound read as a complete, smaller corpus.
  const root = makeTempDir("jsonl-depth-");
  const deep = join(root, "a", "b", "c");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(root, "a", "shallow.jsonl"), "{}\n");
  writeFileSync(join(deep, "buried.jsonl"), "{}\n");

  const skips: string[] = [];
  const found = collectJsonlFiles(root, {
    maxDepth: 1,
    onSkip: (_dir, reason) => skips.push(reason),
  });

  assert.deepEqual(found, [join(root, "a", "shallow.jsonl")]);
  assert.deepEqual(skips, [DirectoryWalkSkipReason.MaxDepth]);
});

test("an absent directory is never reported as a walk skip", () => {
  const reported: string[] = [];
  const onSkip = (_dir: string, reason: DirectoryWalkSkipReason) =>
    reported.push(reason);

  reportReaddirSkip(
    "/gone",
    Object.assign(new Error("nope"), { code: "ENOENT" }),
    onSkip
  );
  assert.deepEqual(reported, [], "an uninstalled harness is a real zero");

  reportReaddirSkip(
    "/denied",
    Object.assign(new Error("nope"), { code: "EACCES" }),
    onSkip
  );
  assert.deepEqual(reported, [DirectoryWalkSkipReason.ReadError]);
});

test("a disabled harness is not named among the harnesses the sweep walked", () => {
  // `enumeratedHarnesses` names the set a caller's copy is allowed to claim.
  // `cappedListers` never called the disabled harness's lister, so listing it
  // here would claim a switched-off source was inventoried — while its evidence
  // entry, which is a different question, must stay.
  const inventory = collectTranscriptByteInventory("/state", {
    now: () => SCAN_START,
    nextRevision: () => 1,
    listClaudeMainFiles: () => [],
    listClaudeSubagentFiles: () => [],
    listCodexRolloutFiles: () => [],
    listOpencodeStoreFiles: () => [],
    listOpencodeMaterializedFiles: () => [],
    lstatEntry: () => undefined,
    probeHarnesses: () => [
      {
        harness: TranscriptSourceHarness.Claude,
        outcome: TranscriptHarnessOutcome.Measured,
        impairments: [],
      },
      {
        harness: TranscriptSourceHarness.Codex,
        outcome: TranscriptHarnessOutcome.Disabled,
        impairments: [],
      },
    ],
  });

  assert.deepEqual(inventory.enumeratedHarnesses, [
    TranscriptSourceHarness.Claude,
  ]);
  assert.deepEqual(inventory.evidence, [
    {
      harness: TranscriptSourceHarness.Claude,
      outcome: TranscriptHarnessOutcome.Measured,
    },
    {
      harness: TranscriptSourceHarness.Codex,
      outcome: TranscriptHarnessOutcome.Disabled,
    },
  ]);
});

test("an over-cap listing keeps its measured prefix and reports partial", () => {
  const paths = Array.from(
    { length: MAX_INVENTORY_FILES + 5 },
    (_, i) => `/claude/${i}.jsonl`
  );

  const inventory = collectTranscriptByteInventory("/state", {
    now: () => SCAN_START,
    nextRevision: () => 1,
    listClaudeMainFiles: () => paths,
    listClaudeSubagentFiles: () => [],
    listCodexRolloutFiles: () => [],
    listOpencodeStoreFiles: () => [],
    lstatEntry: () => stat({ size: 10, ino: Math.random() }),
    probeHarnesses: measuredProbes,
  });

  assert.equal(
    inventory.parseCompleteness,
    TranscriptInventoryCompleteness.Partial
  );
  assert.equal(
    inventory.impairments.some(
      (entry) =>
        entry.reason === TranscriptImpairmentReason.InputCapTruncated &&
        entry.count === 5
    ),
    true
  );
  // The prefix IS measured — the cap bounds the work, it does not void it.
  assert.equal(inventory.eligibleParseBytes, MAX_INVENTORY_FILES * 10);
});

test("a root impairment carries its path but omits the count it has no value for", () => {
  const probes = probeTranscriptHarnesses("/state", {
    scanRoots: () => [
      { harness: TranscriptSourceHarness.Claude, roots: ["/root/a"] },
    ],
    checkReadable: () => PathReadability.Blocked,
    checkFile: () => PathReadability.Absent,
    openCodeHome: () => "/oc",
    openCodeDbPath: () => "/oc/opencode.db",
    materializedRoot: () => "/state/m",
  });

  const impairment = probes.find(
    (probe) => probe.harness === TranscriptSourceHarness.Claude
  )?.impairments[0];
  assert.equal("path" in (impairment ?? {}), true);
  assert.equal("count" in (impairment ?? {}), false);
});

afterAll(() => cleanupTempDirs());
