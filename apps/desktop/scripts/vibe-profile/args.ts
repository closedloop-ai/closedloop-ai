import { parseIsoInstant } from "./corpus-time-shift";
import {
  decideVibeProfileOrigins,
  type VibeOriginKind,
  VibeOriginVerdict,
} from "./origin-policy";

export const VibeProfileCommand = {
  Prepare: "prepare",
  BuildStore: "build-store",
  AuthClaim: "auth-claim",
  SignIn: "sign-in",
  LaunchEnv: "launch-env",
  Launch: "launch",
  Counts: "counts",
} as const;
export type VibeProfileCommand =
  (typeof VibeProfileCommand)[keyof typeof VibeProfileCommand];

export type VibeProfileArgs =
  | {
      command:
        | typeof VibeProfileCommand.Prepare
        | typeof VibeProfileCommand.BuildStore;
      out: string;
      now: string;
    }
  | {
      command:
        | typeof VibeProfileCommand.SignIn
        | typeof VibeProfileCommand.LaunchEnv
        | typeof VibeProfileCommand.Launch;
      profile: string;
      apiOrigin: string;
      webOrigin: string;
      originKind: VibeOriginKind;
    }
  | {
      command:
        | typeof VibeProfileCommand.AuthClaim
        | typeof VibeProfileCommand.Counts;
      profile: string;
    };

export const VIBE_PROFILE_USAGE = [
  "usage: vibe:profile <command> [flags]",
  "  prepare    --out <dir> --now <ISO-8601>",
  "  build-store --out <dir> --now <ISO-8601>",
  "  auth-claim --profile <dir>",
  "  sign-in    --profile <dir> --api-origin <url> --web-origin <url>",
  "  launch-env --profile <dir> --api-origin <url> --web-origin <url>",
  "  launch     --profile <dir> --api-origin <url> --web-origin <url>",
  "  counts     --profile <dir>",
  "origins: both loopback (http(s)://localhost:<port>), or both the same stage",
  "  branch preview: https://api-stage-git-<branch>.preview.stage.example",
  "  and https://app-stage-git-<branch>.preview.stage.example",
].join("\n");

/**
 * Parses the CLI's argv (after the script path). Every flag takes exactly one
 * value; unknown flags and missing values are errors, so a typo cannot silently
 * fall back to a default profile location.
 */
export function parseVibeProfileArgs(argv: readonly string[]): VibeProfileArgs {
  const [command, ...rest] = argv.filter((arg) => arg !== "--");
  const flags = parseFlags(rest);
  switch (command) {
    case VibeProfileCommand.Prepare:
    case VibeProfileCommand.BuildStore: {
      assertOnlyFlags(flags, ["out", "now"]);
      const now = requireFlag(flags, "now");
      parseIsoInstant(now, "--now");
      return { command, out: requireFlag(flags, "out"), now };
    }
    case VibeProfileCommand.SignIn:
    case VibeProfileCommand.LaunchEnv:
    case VibeProfileCommand.Launch:
      assertOnlyFlags(flags, ["profile", "api-origin", "web-origin"]);
      return {
        command,
        profile: requireFlag(flags, "profile"),
        ...allowedOrigins(
          requireFlag(flags, "api-origin"),
          requireFlag(flags, "web-origin")
        ),
      };
    case VibeProfileCommand.AuthClaim:
    case VibeProfileCommand.Counts:
      assertOnlyFlags(flags, ["profile"]);
      return { command, profile: requireFlag(flags, "profile") };
    default:
      throw new Error(
        `unknown command ${command === undefined ? "(none)" : command}\n${VIBE_PROFILE_USAGE}`
      );
  }
}

function parseFlags(args: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--")) {
      throw new Error(`expected a --flag, got ${String(flag)}`);
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${flag} needs a value`);
    }
    const name = flag.slice(2);
    if (flags.has(name)) {
      throw new Error(`${flag} given twice`);
    }
    flags.set(name, value);
  }
  return flags;
}

function assertOnlyFlags(
  flags: ReadonlyMap<string, string>,
  allowed: readonly string[]
): void {
  for (const name of flags.keys()) {
    if (!allowed.includes(name)) {
      throw new Error(`unknown flag --${name}\n${VIBE_PROFILE_USAGE}`);
    }
  }
}

function requireFlag(flags: ReadonlyMap<string, string>, name: string): string {
  const value = flags.get(name)?.trim();
  if (!value) {
    throw new Error(`--${name} is required\n${VIBE_PROFILE_USAGE}`);
  }
  return value;
}

/** `decideVibeProfileOrigins` as flag parsing: a refused pair is an error. */
function allowedOrigins(
  apiOrigin: string,
  webOrigin: string
): { apiOrigin: string; webOrigin: string; originKind: VibeOriginKind } {
  const decision = decideVibeProfileOrigins(apiOrigin, webOrigin);
  if (decision.verdict === VibeOriginVerdict.Refused) {
    throw new Error(decision.reason);
  }
  return {
    apiOrigin: decision.apiOrigin,
    webOrigin: decision.webOrigin,
    originKind: decision.verdict,
  };
}
