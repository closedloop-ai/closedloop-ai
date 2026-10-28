import { fileURLToPath } from "node:url";
import { parseVibeProfileArgs, VibeProfileCommand } from "./args";
import { vibeProfileAuthClaim } from "./auth-claim";
import { defaultVibeLaunchDeps, launchVibeProfile } from "./launch";
import { vibeProfileLaunchEnv } from "./launch-env";
import { buildVibeCorpusStore, prepareVibeProfile } from "./prepare";
import { VIBE_PROFILE_FILE, vibeProfilePath } from "./profile-layout";
import { readDesktopRowCounts } from "./row-counts";
import { signInVibeProfile } from "./sign-in";

/**
 * `pnpm -C apps/desktop run vibe:profile <command>` (ISS-12017, ISS-12056).
 * Every command prints exactly one JSON object on stdout and its progress on
 * stderr, and exits non-zero on failure. `auth-claim` prints the bare claim a
 * branch preview registers, with no `ok` key, so it can be passed on as is.
 */
export async function runVibeProfileCli(
  argv: readonly string[]
): Promise<Record<string, unknown>> {
  const args = parseVibeProfileArgs(argv);
  const log = (message: string) =>
    process.stderr.write(`[vibe-profile] ${message}\n`);
  switch (args.command) {
    case VibeProfileCommand.Prepare:
      return prepareVibeProfile(args.out, args.now, log);
    case VibeProfileCommand.BuildStore:
      return buildVibeCorpusStore(args.out, args.now, log);
    case VibeProfileCommand.AuthClaim:
      return vibeProfileAuthClaim(args.profile);
    case VibeProfileCommand.SignIn:
      await signInVibeProfile(args.profile, args, log);
      return { ok: true };
    case VibeProfileCommand.LaunchEnv:
      return { ok: true, ...vibeProfileLaunchEnv(args.profile, args) };
    case VibeProfileCommand.Launch:
      return {
        ok: true,
        ...(await launchVibeProfile(
          args.profile,
          args,
          defaultVibeLaunchDeps,
          log
        )),
      };
    case VibeProfileCommand.Counts:
      return {
        ok: true,
        rowCounts: await readDesktopRowCounts(
          vibeProfilePath(args.profile, VIBE_PROFILE_FILE.Store)
        ),
      };
    default: {
      const exhaustive: never = args;
      throw new Error(`unhandled command ${JSON.stringify(exhaustive)}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The importer and stores log through console; stdout carries only the
  // result object, so everything else is routed to stderr until it is written.
  const writeResult = process.stdout.write.bind(process.stdout);
  process.stdout.write = process.stderr.write.bind(process.stderr);
  runVibeProfileCli(process.argv.slice(2))
    .then((result) => {
      writeResult(`${JSON.stringify(result)}\n`, () => process.exit(0));
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[vibe-profile] FAILED: ${message}\n`);
      writeResult(`${JSON.stringify({ ok: false, error: message })}\n`, () =>
        process.exit(1)
      );
    });
}
