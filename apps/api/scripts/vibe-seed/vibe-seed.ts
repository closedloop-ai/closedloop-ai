/**
 * ISS-12017: CLI for the vibe seed. Prints ONE JSON summary on stdout
 * (`{ ok, organizationId, userId, stages, rowCounts, error? }`), progress on
 * stderr, and exits 1 on any refusal or failure.
 *
 * Usage (from `apps/api`; refuses anything but a local control_* database):
 *   pnpm vibe:seed --database-url postgresql://…@localhost:5432/control_x \
 *     [--desktop-store <agent-dashboard.sqlite>] [--desktop-auth <auth.json>] \
 *     [--now <ISO-8601>] [--api-key-out <path>] \
 *     [--only-stages <a,b>] [--skip-base]
 *
 * Runs under `--conditions=react-server` for the same reason as
 * `perf:import-desktop-snapshot`: it reaches deep into service graphs where one
 * new `import "server-only"` edge would otherwise throw at load.
 */
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { runVibeSeed, type VibeSeedOptions, type VibeSeedSummary } from "./run";

const ARG_OPTIONS = {
  "database-url": { type: "string" },
  "desktop-store": { type: "string" },
  "desktop-auth": { type: "string" },
  now: { type: "string" },
  "api-key-out": { type: "string" },
  "only-stages": { type: "string" },
  "skip-base": { type: "boolean", default: false },
} as const;

const desktopAuthSchema = z.object({
  refreshToken: z.string().min(1),
  publicKeySpki: z.string().min(1),
  gatewayId: z.string().min(1),
});

const argsSchema = z.object({
  "database-url": z.string().min(1),
  "desktop-store": z.string().min(1).optional(),
  "desktop-auth": z.string().min(1).optional(),
  now: z.iso.datetime({ offset: true }).optional(),
  "api-key-out": z.string().min(1).optional(),
  "only-stages": z.string().min(1).optional(),
  "skip-base": z.boolean(),
});

const STAGE_LIST_SEPARATOR = ",";

/** Parse argv into run options; throws with a message naming the bad flag. */
export function parseVibeSeedArgs(
  argv: readonly string[]
): Omit<VibeSeedOptions, "log"> {
  const { values } = parseArgs({
    args: [...argv],
    options: ARG_OPTIONS,
    allowPositionals: false,
  });
  const parsed = argsSchema.safeParse(values);
  if (!parsed.success) {
    throw new Error(`invalid arguments: ${z.prettifyError(parsed.error)}`);
  }
  const args = parsed.data;
  return {
    databaseUrl: args["database-url"],
    desktopStorePath: optionalPath(args["desktop-store"]),
    desktopAuth: readDesktopAuth(args["desktop-auth"]),
    ...(args.now === undefined ? {} : { now: new Date(args.now) }),
    apiKeyOutPath: optionalPath(args["api-key-out"]),
    ...(args["only-stages"] === undefined
      ? {}
      : { onlyStages: splitStageList(args["only-stages"]) }),
    skipBase: args["skip-base"],
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const writeResult = process.stdout.write.bind(process.stdout);
  // Producers deep in the service graph log through console; stdout carries
  // only the JSON summary, so everything else is sent to stderr.
  process.stdout.write = process.stderr.write.bind(process.stderr);
  const log = (message: string) =>
    process.stderr.write(`[vibe-seed] ${message}\n`);
  let summary: VibeSeedSummary;
  try {
    summary = await runVibeSeed({ ...parseVibeSeedArgs(argv), log });
  } catch (error) {
    summary = {
      ok: false,
      organizationId: null,
      userId: null,
      stages: [],
      rowCounts: {},
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await new Promise<void>((done) => {
    writeResult(`${JSON.stringify(summary)}\n`, () => done());
  });
  return summary.ok ? 0 : 1;
}

function optionalPath(value: string | undefined): string | null {
  return value === undefined ? null : resolve(value);
}

function readDesktopAuth(
  path: string | undefined
): VibeSeedOptions["desktopAuth"] {
  if (path === undefined) {
    return null;
  }
  const parsed = desktopAuthSchema.safeParse(
    JSON.parse(readFileSync(resolve(path), "utf8"))
  );
  if (!parsed.success) {
    throw new Error(
      `--desktop-auth ${path} is not { refreshToken, publicKeySpki, gatewayId }: ${z.prettifyError(parsed.error)}`
    );
  }
  return parsed.data;
}

function splitStageList(value: string): string[] {
  return value
    .split(STAGE_LIST_SEPARATOR)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url ===
    pathToFileURL(realpathSync(resolve(process.argv[1]))).href;

if (isDirectRun) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(`[vibe-seed] failed: ${String(error)}\n`);
      process.exit(1);
    }
  );
}
