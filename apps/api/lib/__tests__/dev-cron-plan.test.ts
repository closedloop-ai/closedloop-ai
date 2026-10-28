import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  env,
  LOCAL_DATABASE_URL,
} from "@/__tests__/support/lib/dev-cron-scheduler.test-fixtures";
import {
  DEV_CRON_ENABLE_ENV_VAR,
  DEV_CRON_JOBS,
  DevCronDisabledReason,
  resolveDevCronPlan,
  resolveLoopbackOrigin,
} from "../dev-cron-scheduler";

/** `vercel.json` schedules the two shapes these crons actually use. */
const EVERY_N_MINUTES_SCHEDULE = /^\*\/(\d+) \* \* \* \*$/;
const HOURLY_SCHEDULE = /^\d+ \* \* \* \*$/;

describe("resolveDevCronPlan — the three-condition guard (ISS-8152)", () => {
  it("refuses to run under NODE_ENV=production even when opted in on a local database", () => {
    // `server.ts` is the production entrypoint too (`server:start`, and the
    // Dockerfile CMD). This is the condition that stops a production container
    // sweeping repos at development cadence.
    const plan = resolveDevCronPlan(env({ NODE_ENV: "production" }));

    expect(plan.enabled).toBe(false);
    expect(plan).toMatchObject({
      reason: DevCronDisabledReason.ProductionRuntime,
    });
  });

  it("stays off without the explicit opt-in", () => {
    const withoutOptIn = env();
    Reflect.deleteProperty(withoutOptIn, DEV_CRON_ENABLE_ENV_VAR);

    expect(resolveDevCronPlan(withoutOptIn)).toMatchObject({
      enabled: false,
      reason: DevCronDisabledReason.NotOptedIn,
    });
  });

  it("stays off when the opt-in is present but not the sanctioned value", () => {
    expect(
      resolveDevCronPlan(env({ [DEV_CRON_ENABLE_ENV_VAR]: "true" }))
    ).toMatchObject({
      enabled: false,
      reason: DevCronDisabledReason.NotOptedIn,
    });
  });

  it("refuses a non-local database, so a stack repointed at stage cannot write to it", () => {
    const plan = resolveDevCronPlan(
      env({
        DATABASE_URL:
          "postgresql://app:secret@db.stage.example.com:5432/closedloop",
      })
    );

    expect(plan).toMatchObject({
      enabled: false,
      reason: DevCronDisabledReason.NonLocalDatabase,
    });
  });

  it("fails closed on an absent or unparseable DATABASE_URL", () => {
    const absent = env();
    Reflect.deleteProperty(absent, "DATABASE_URL");

    expect(resolveDevCronPlan(absent)).toMatchObject({
      enabled: false,
      reason: DevCronDisabledReason.NonLocalDatabase,
    });
    expect(
      resolveDevCronPlan(env({ DATABASE_URL: "not a url" }))
    ).toMatchObject({
      enabled: false,
      reason: DevCronDisabledReason.NonLocalDatabase,
    });
  });

  it("does not accept a remote host that merely begins with a loopback name", () => {
    // Exact hostname membership, not a prefix or substring test.
    expect(
      resolveDevCronPlan(
        env({ DATABASE_URL: "postgresql://a:b@localhost.stage.example.com/cl" })
      )
    ).toMatchObject({
      enabled: false,
      reason: DevCronDisabledReason.NonLocalDatabase,
    });
  });

  it("reads the host by parsing, so an '@' in the password cannot fake a remote host", () => {
    // The reason the guard parses instead of pattern-matching: the WHATWG
    // parser splits userinfo at the LAST '@', so this is localhost.
    expect(
      resolveDevCronPlan(
        env({ DATABASE_URL: "postgresql://user:p@ss@localhost:5432/cl" })
      )
    ).toMatchObject({ enabled: true, databaseHost: "localhost" });
  });

  it("reads the host by parsing, so a loopback name in the password cannot fake a local host", () => {
    expect(
      resolveDevCronPlan(
        env({
          DATABASE_URL: "postgresql://user:localhost@stage.example.com/cl",
        })
      )
    ).toMatchObject({
      enabled: false,
      reason: DevCronDisabledReason.NonLocalDatabase,
    });
  });

  it("accepts every spelling of this machine", () => {
    for (const [url, host] of [
      [LOCAL_DATABASE_URL, "localhost"],
      ["postgresql://a:b@127.0.0.1:5432/cl", "127.0.0.1"],
      // Reported bracketed by `URL.hostname`, normalized to the bare form so
      // one entry in the allow-set serves this and the `?host=` spelling.
      ["postgresql://a:b@[::1]:5432/cl", "::1"],
    ] as const) {
      expect(resolveDevCronPlan(env({ DATABASE_URL: url }))).toMatchObject({
        enabled: true,
        databaseHost: host,
      });
    }
  });

  it("refuses a `host` connection parameter that overrides a local authority", () => {
    // whitlockk, #6048: `pg-connection-string` resolves this URL's host to
    // `stage.example.com` despite the `localhost` authority, so judging the
    // authority alone turned the scheduler on against stage.
    expect(
      resolveDevCronPlan(
        env({
          DATABASE_URL:
            "postgresql://a:b@localhost:5432/cl?host=db.stage.example.com",
        })
      )
    ).toMatchObject({
      enabled: false,
      reason: DevCronDisabledReason.NonLocalDatabase,
    });
  });

  it("judges the `host` parameter itself when it is present", () => {
    expect(
      resolveDevCronPlan(
        env({
          DATABASE_URL:
            "postgresql://a:b@db.stage.example.com:5432/cl?host=127.0.0.1",
        })
      )
    ).toMatchObject({ enabled: true, databaseHost: "127.0.0.1" });
  });

  it("requires every entry of a comma-separated `host` list to be local", () => {
    // libpq accepts a failover list; one remote entry is enough to write to it.
    expect(
      resolveDevCronPlan(
        env({
          DATABASE_URL:
            "postgresql://a:b@localhost:5432/cl?host=localhost,db.stage.example.com",
        })
      )
    ).toMatchObject({
      enabled: false,
      reason: DevCronDisabledReason.NonLocalDatabase,
    });
    expect(
      resolveDevCronPlan(
        env({
          DATABASE_URL:
            "postgresql://a:b@localhost:5432/cl?host=localhost,127.0.0.1",
        })
      )
    ).toMatchObject({ enabled: true });
  });

  it("judges EVERY `host` parameter, because the driver takes the last one", () => {
    // Verified against the installed pg-connection-string@2.12.0: it assigns in
    // iteration order, so this URL connects to stage while `searchParams.get`
    // reported `localhost`. The guard failed OPEN — the one direction it must
    // never fail (#6048 review, found by two reviewers independently).
    expect(
      resolveDevCronPlan(
        env({
          DATABASE_URL:
            "postgresql://a:b@localhost:5432/cl?host=localhost&host=db.stage.example.com",
        })
      )
    ).toMatchObject({
      enabled: false,
      reason: DevCronDisabledReason.NonLocalDatabase,
    });
    // And the mirror image, which the old code refused for the wrong reason.
    expect(
      resolveDevCronPlan(
        env({
          DATABASE_URL:
            "postgresql://a:b@localhost:5432/cl?host=db.stage.example.com&host=localhost",
        })
      )
    ).toMatchObject({
      enabled: false,
      reason: DevCronDisabledReason.NonLocalDatabase,
    });
  });

  it("accepts a local host whatever case it is written in", () => {
    // `postgres:` is not a WHATWG "special" scheme, so `URL.hostname` does not
    // lowercase it. This refused a genuinely local database before.
    // Reported back as written, so the banner echoes the configured value
    // rather than a normalized one the developer would have to recognize.
    expect(
      resolveDevCronPlan(
        env({ DATABASE_URL: "postgresql://a:b@LOCALHOST:5432/cl" })
      )
    ).toMatchObject({ enabled: true, databaseHost: "LOCALHOST" });
  });

  it("accepts a Unix-socket host, which has no network peer to reach", () => {
    expect(
      resolveDevCronPlan(
        env({
          DATABASE_URL:
            "postgresql://a:b@localhost:5432/cl?host=/var/run/postgresql",
        })
      )
    ).toMatchObject({ enabled: true });
  });
});

describe("the opt-in variable's name (ISS-8152)", () => {
  it("pins the name developers set to start the scheduler", () => {
    // The Community Edition ships neither upstream's `just dev-cron` recipe nor
    // its root local.env.example, so only the name itself is pinned here.
    expect(DEV_CRON_ENABLE_ENV_VAR).toBe("CL_DEV_CRON");
  });
});

describe("resolveLoopbackOrigin (ISS-8152)", () => {
  it("translates a wildcard bind to the loopback of its own family", () => {
    // Not an address anything can connect TO.
    expect(
      resolveLoopbackOrigin(
        { address: "0.0.0.0", port: 3002, family: "IPv4" },
        9999
      )
    ).toBe("http://127.0.0.1:3002");
    expect(
      resolveLoopbackOrigin({ address: "::", port: 3002, family: "IPv6" }, 9999)
    ).toBe("http://[::1]:3002");
  });

  it("uses the address the server actually bound", () => {
    // davetho, #6048: `server.ts` binds `HOST`, so a developer who pins it to
    // a non-wildcard loopback had every tick refused by a hardcoded 127.0.0.1.
    expect(
      resolveLoopbackOrigin(
        { address: "::1", port: 3002, family: "IPv6" },
        9999
      )
    ).toBe("http://[::1]:3002");
    expect(
      resolveLoopbackOrigin(
        { address: "127.0.0.1", port: 4123, family: "IPv4" },
        9999
      )
    ).toBe("http://127.0.0.1:4123");
  });

  it("falls back when the server reports no callable address", () => {
    // A string address is a Unix socket or named pipe; null is not listening.
    expect(resolveLoopbackOrigin(null, 9999)).toBe("http://127.0.0.1:9999");
    expect(resolveLoopbackOrigin("/tmp/api.sock", 9999)).toBe(
      "http://127.0.0.1:9999"
    );
  });

  it("leaves a non-loopback bind alone instead of rewriting it to loopback", () => {
    // Mutation testing (ISS-8152): the earlier IPv4 case bound 127.0.0.1, which
    // is ALSO what the wildcard branch produces — so both branches of the
    // translation returned the same string and the conditional was untested. A
    // LAN address is the fixture that can tell them apart.
    expect(
      resolveLoopbackOrigin(
        { address: "192.168.1.5", port: 3002, family: "IPv4" },
        9999
      )
    ).toBe("http://192.168.1.5:3002");
    // Same trap on the IPv6 side: the earlier case bound `::1`, which is what
    // the `::` wildcard branch also yields.
    expect(
      resolveLoopbackOrigin(
        { address: "fe80::1", port: 3002, family: "IPv6" },
        9999
      )
    ).toBe("http://[fe80::1]:3002");
  });

  it("brackets an IPv6 address even when the family string does not say IPv6", () => {
    // The `||` half of the family check. `Server.address()` reports "IPv6"
    // today, so this is the defensive arm — and with every fixture agreeing on
    // both signals, `&&` would have behaved identically.
    expect(
      resolveLoopbackOrigin({ address: "::1", port: 3002, family: "" }, 9999)
    ).toBe("http://[::1]:3002");
  });
});

describe("import-time inertness (ISS-8152)", () => {
  // Fake timers so `getTimerCount` can see whether evaluation armed anything.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing until it is called", async () => {
    // Production does NOT import this module any more — the server.ts /
    // server-dev.ts split saw to that, and dev-cron-production-exclusion.test.ts
    // holds it. This is the defense-in-depth half: if that exclusion ever
    // regressed, merely EVALUATING the module must still do nothing (#6048).
    const before = process.env.CRON_SECRET;
    vi.resetModules();
    const loaded = await import("../dev-cron-scheduler");

    expect(vi.getTimerCount()).toBe(0);
    expect(process.env.CRON_SECRET).toBe(before);
    expect(typeof loaded.startDevCronScheduler).toBe("function");
  });
});

describe("the shipped job table (ISS-8152)", () => {
  it("bootstraps repo sync states before it reconciles pull requests", () => {
    // Load-bearing order: the reconciler selects from `gitHubRepoSyncState`,
    // and bootstrap is what creates those rows.
    expect(DEV_CRON_JOBS.map((job) => job.path)).toEqual([
      "/cron/bootstrap-repo-sync-states",
      "/cron/reconcile-pull-requests",
      "/cron/refresh-branch-analytics-rollups",
    ]);
  });

  it("runs only the cheap bootstrap job at boot", () => {
    // `server:dev` is `tsx watch`, so every save re-fires the boot run; a
    // reconcile sweep per save would burn the developer's rate limit.
    expect(DEV_CRON_JOBS.filter((job) => job.runAtBoot)).toHaveLength(1);
    expect(DEV_CRON_JOBS.find((job) => job.runAtBoot)?.path).toBe(
      "/cron/bootstrap-repo-sync-states"
    );
  });

  it("keeps every development cadence faster than nothing and slower than a hammer", () => {
    for (const job of DEV_CRON_JOBS) {
      // Both bounds. The upper one was missing, so the title's "faster than
      // nothing" half was unasserted and a daily interval would have passed.
      expect(job.intervalMs).toBeGreaterThanOrEqual(60_000);
      expect(job.intervalMs).toBeLessThanOrEqual(15 * 60_000);
    }
  });

  it("schedules paths production actually registers, at the cadence it claims", () => {
    // The banner's whole job is to stop a developer signing off against a
    // cadence faster than production's. `vercel.json` is the canonical owner of
    // both the path and the schedule; nothing pinned the copies to it, so a
    // renamed route would 404 every tick under an affirmative "ENABLED" banner,
    // and a rescheduled cron would leave the banner confidently wrong (#6048
    // review, raised by three reviewers).
    const crons = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../vercel.json"), "utf8")
    ).crons as { path: string; schedule: string }[];

    for (const job of DEV_CRON_JOBS) {
      const registered = crons.find((cron) => cron.path === job.path);
      expect(
        registered,
        `${job.path} is not registered in vercel.json`
      ).toBeDefined();
      expect(
        describeCronSchedule(registered?.schedule ?? ""),
        `${job.path} label disagrees with vercel.json`
      ).toBe(job.productionCadenceLabel);
    }
  });
});

/** The label a `vercel.json` cron schedule should carry in the banner. */
function describeCronSchedule(schedule: string): string {
  const everyNMinutes = EVERY_N_MINUTES_SCHEDULE.exec(schedule);
  if (everyNMinutes) {
    return `*/${everyNMinutes[1]}m`;
  }
  return HOURLY_SCHEDULE.test(schedule) ? "hourly" : schedule;
}
