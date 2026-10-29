import { type ShellToken, shellTokens } from "./shell-command-tokens.js";

const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const CONTROL_FLOW_WORDS = new Set([
  "!",
  "{",
  "do",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "if",
  "in",
  "select",
  "then",
  "time",
  "until",
  "while",
]);
const PREFIX_COMMANDS = new Set([
  "command",
  "doas",
  "env",
  "exec",
  "nice",
  "nohup",
  "setsid",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "xargs",
]);
const OPTIONS_WITH_ARGUMENT = new Map<string, ReadonlySet<string>>([
  ["doas", new Set(["-a", "-C", "-u"])],
  [
    "env",
    new Set(["--chdir", "--split-string", "--unset", "-C", "-P", "-S", "-u"]),
  ],
  ["exec", new Set(["-a"])],
  ["nice", new Set(["--adjustment", "-n"])],
  ["stdbuf", new Set(["--error", "--input", "--output", "-e", "-i", "-o"])],
  [
    "sudo",
    new Set([
      "--chdir",
      "--close-from",
      "--group",
      "--host",
      "--prompt",
      "--role",
      "--type",
      "--user",
      "-C",
      "-D",
      "-g",
      "-h",
      "-p",
      "-R",
      "-r",
      "-T",
      "-t",
      "-u",
    ]),
  ],
  ["time", new Set(["--format", "--output", "-f", "-o"])],
  ["timeout", new Set(["--kill-after", "--signal", "-k", "-s"])],
  [
    "xargs",
    new Set([
      "--arg-file",
      "--delimiter",
      "--eof",
      "--max-args",
      "--max-chars",
      "--max-lines",
      "--max-procs",
      "--replace",
      "-a",
      "-d",
      "-E",
      "-I",
      "-L",
      "-n",
      "-P",
      "-s",
    ]),
  ],
]);

type PrefixState =
  | { kind: "case-expression" }
  | { kind: "case-pattern" }
  | { kind: "ordinary" }
  | {
      command: string;
      durationPending: boolean;
      kind: "prefix";
      optionsEnded: boolean;
      waitingForOptionValue: boolean;
    };

type PrefixDisposition = "command" | "skip" | "stop";

type LaunchState = {
  expectingCommand: boolean;
  inCase: boolean;
  prefixState: PrefixState;
  skipRedirectionTarget: boolean;
};

/**
 * Reports whether a static shell command launches an executable accepted by
 * `isExecutable`. Heredoc bodies, comments, quoting, substitutions,
 * redirections, compound-command boundaries, and common prefix utilities are
 * interpreted before the executable predicate runs.
 */
export function shellCommandLaunches(
  command: string | undefined,
  isExecutable: (word: string) => boolean
): boolean {
  if (command === undefined) {
    return false;
  }
  const state: LaunchState = {
    expectingCommand: true,
    inCase: false,
    prefixState: { kind: "ordinary" },
    skipRedirectionTarget: false,
  };
  return shellTokens(command).some((token) =>
    tokenLaunchesExecutable(token, state, isExecutable)
  );
}

function tokenLaunchesExecutable(
  token: ShellToken,
  state: LaunchState,
  isExecutable: (word: string) => boolean
): boolean {
  if (token.kind === "redirection-target") {
    state.skipRedirectionTarget = false;
    return false;
  }
  if (token.kind === "redirection") {
    if (state.expectingCommand) {
      state.skipRedirectionTarget = token.needsTarget;
    }
    return false;
  }
  if (token.kind === "operator") {
    consumeOperator(token.text, state);
    return false;
  }
  return wordLaunchesExecutable(
    unquoteShellWord(token.text),
    state,
    isExecutable
  );
}

function consumeOperator(operator: string, state: LaunchState): void {
  if (state.prefixState.kind === "case-pattern") {
    if (operator === ")") {
      state.expectingCommand = true;
      state.prefixState = { kind: "ordinary" };
    }
    return;
  }
  if (state.inCase && isCaseArmTerminator(operator)) {
    state.expectingCommand = false;
    state.prefixState = { kind: "case-pattern" };
    return;
  }
  state.expectingCommand = true;
  state.prefixState = { kind: "ordinary" };
  state.skipRedirectionTarget = false;
}

function wordLaunchesExecutable(
  word: string,
  state: LaunchState,
  isExecutable: (word: string) => boolean
): boolean {
  if (state.prefixState.kind === "case-pattern") {
    consumeCasePatternWord(word, state);
    return false;
  }
  if (state.skipRedirectionTarget) {
    state.skipRedirectionTarget = false;
    return false;
  }
  if (!state.expectingCommand) {
    return false;
  }
  if (state.prefixState.kind === "case-expression") {
    state.prefixState = { kind: "case-pattern" };
    state.expectingCommand = false;
    return false;
  }
  const prefix = consumePrefix(word, state.prefixState);
  state.prefixState = prefix.nextState;
  if (prefix.disposition !== "command") {
    state.expectingCommand = prefix.disposition !== "stop";
    return false;
  }
  return evaluateCommandWord(word, state, isExecutable);
}

function consumeCasePatternWord(word: string, state: LaunchState): void {
  if (word === "esac") {
    state.inCase = false;
    state.prefixState = { kind: "ordinary" };
  }
}

function evaluateCommandWord(
  word: string,
  state: LaunchState,
  isExecutable: (word: string) => boolean
): boolean {
  if (word === "case") {
    state.inCase = true;
    state.prefixState = { kind: "case-expression" };
    return false;
  }
  const nestedPrefix = startPrefix(word);
  if (nestedPrefix !== undefined) {
    state.prefixState = nestedPrefix;
    return false;
  }
  if (ENV_ASSIGNMENT.test(word) || CONTROL_FLOW_WORDS.has(word)) {
    return false;
  }
  state.expectingCommand = false;
  state.prefixState = { kind: "ordinary" };
  return isExecutable(word);
}

function consumePrefix(
  word: string,
  state: PrefixState
): { disposition: PrefixDisposition; nextState: PrefixState } {
  if (state.kind !== "prefix") {
    return { disposition: "command", nextState: state };
  }
  if (state.waitingForOptionValue) {
    return {
      disposition: "skip",
      nextState: { ...state, waitingForOptionValue: false },
    };
  }
  if (state.command === "env" && ENV_ASSIGNMENT.test(word)) {
    return { disposition: "skip", nextState: state };
  }
  if (!state.optionsEnded && word === "--") {
    return {
      disposition: "skip",
      nextState: { ...state, optionsEnded: true },
    };
  }
  if (
    state.command === "command" &&
    !state.optionsEnded &&
    (word === "-v" || word === "-V")
  ) {
    return { disposition: "stop", nextState: { kind: "ordinary" } };
  }
  if (!state.optionsEnded && word.startsWith("-")) {
    return {
      disposition: "skip",
      nextState: {
        ...state,
        waitingForOptionValue: optionNeedsSeparateValue(state.command, word),
      },
    };
  }
  if (state.command === "timeout" && state.durationPending) {
    return {
      disposition: "skip",
      nextState: { ...state, durationPending: false, optionsEnded: true },
    };
  }
  return { disposition: "command", nextState: { kind: "ordinary" } };
}

function startPrefix(word: string): PrefixState | undefined {
  if (!PREFIX_COMMANDS.has(word)) {
    return undefined;
  }
  return {
    command: word,
    durationPending: word === "timeout",
    kind: "prefix",
    optionsEnded: false,
    waitingForOptionValue: false,
  };
}

function optionNeedsSeparateValue(command: string, option: string): boolean {
  if (option.includes("=")) {
    return false;
  }
  const options = OPTIONS_WITH_ARGUMENT.get(command);
  return options?.has(option) === true;
}

function isCaseArmTerminator(operator: string): boolean {
  return operator === ";;" || operator === ";&" || operator === ";;&";
}

function unquoteShellWord(word: string): string {
  const trimmed = word.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
