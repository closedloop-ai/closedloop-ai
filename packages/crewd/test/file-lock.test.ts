/**
 * @file file-lock.test.ts
 * @description The daemon's single-instance guard (ISS-5296). `crewd start` is a
 * long-running foreground process, so the only thing between an operator and two
 * daemons firing every task twice is this lock — and the only thing between a
 * crashed daemon and a permanently unstartable scheduler is its stale-lock
 * reclaim. Both directions are asserted here.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultLockPath, FileLock } from "../src/scheduler/file-lock.js";

const ALREADY_RUNNING = /already running/;

/** A pid essentially certain not to be alive (above the usual `pid_max`). */
const DEAD_PID = 4_194_303;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crewd-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FileLock", () => {
  it("writes the owner pid and creates the lock's parent directory", () => {
    // The lock path may point somewhere that does not exist yet, so acquire must
    // create it rather than throw ENOENT and take the daemon down at startup.
    const path = join(dir, "nested", "crewd.lock");

    new FileLock(path).acquire();

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
  });

  it("refuses a second acquire while the recorded pid is ALIVE", () => {
    // The whole point of the guard: two daemons over one store would double-fire
    // every due task.
    const path = join(dir, "crewd.lock");
    new FileLock(path).acquire(); // records this (live) test process

    expect(() => new FileLock(path).acquire()).toThrow(ALREADY_RUNNING);
  });

  it("names the holding pid in the refusal so the operator can find it", () => {
    const path = join(dir, "crewd.lock");
    new FileLock(path).acquire();

    expect(() => new FileLock(path).acquire()).toThrow(
      new RegExp(`pid ${process.pid}`)
    );
  });

  it("reclaims a lock left behind by a DEAD pid", () => {
    // A daemon killed without releasing leaves its pid on disk. Treating that as
    // "already running" forever would make the scheduler permanently unstartable.
    const path = join(dir, "crewd.lock");
    seedLock(path, String(DEAD_PID));

    new FileLock(path).acquire();

    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
  });

  it("reclaims a lock file that is empty", () => {
    // `Number("")` is 0 — falsy, so the liveness probe is skipped and the lock is
    // reclaimed rather than the daemon refusing to start over a truncated file.
    const path = join(dir, "crewd.lock");
    seedLock(path, "");

    new FileLock(path).acquire();

    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
  });

  it("reclaims a lock file whose contents are not a pid", () => {
    // `Number("not-a-pid")` is NaN — also falsy, same reclaim.
    const path = join(dir, "crewd.lock");
    seedLock(path, "not-a-pid");

    new FileLock(path).acquire();

    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
  });

  it("release() removes the lock file it holds", () => {
    const path = join(dir, "crewd.lock");
    const lock = new FileLock(path);
    lock.acquire();

    lock.release();

    expect(existsSync(path)).toBe(false);
  });

  it("release() without a prior acquire does NOT delete a lock it never owned", () => {
    // A daemon that FAILED to acquire (because another is running) still runs its
    // shutdown path. Releasing there must not delete the live owner's lock and
    // hand the store to a second daemon.
    const path = join(dir, "crewd.lock");
    new FileLock(path).acquire();

    new FileLock(path).release();

    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(String(process.pid));
  });

  it("release() is idempotent", () => {
    const path = join(dir, "crewd.lock");
    const lock = new FileLock(path);
    lock.acquire();
    lock.release();

    expect(() => lock.release()).not.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it("adopts defaultLockPath() when constructed with no argument", () => {
    // Constructed ONLY — never acquired. Acquiring the default path would stamp
    // this runner's pid into the operator's real shared `$TMPDIR/crewd.lock` and
    // could collide with a parallel vitest worker.
    expect(new FileLock().path).toBe(defaultLockPath());
  });
});

describe("defaultLockPath", () => {
  let priorTmpdir: string | undefined;

  beforeEach(() => {
    priorTmpdir = process.env.TMPDIR;
  });

  afterEach(() => {
    if (priorTmpdir === undefined) {
      Reflect.deleteProperty(process.env, "TMPDIR");
    } else {
      process.env.TMPDIR = priorTmpdir;
    }
  });

  it("honors TMPDIR", () => {
    process.env.TMPDIR = "/custom/tmp";
    expect(defaultLockPath()).toBe("/custom/tmp/crewd.lock");
  });

  it("falls back to /tmp when TMPDIR is unset", () => {
    // Deleting the property is required: assigning `undefined` stores the literal
    // string "undefined", and the fallback would never be taken.
    Reflect.deleteProperty(process.env, "TMPDIR");
    expect(defaultLockPath()).toBe("/tmp/crewd.lock");
  });
});

/** Write a lock file directly, standing in for a previous daemon's leftovers. */
function seedLock(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, "utf8");
}
