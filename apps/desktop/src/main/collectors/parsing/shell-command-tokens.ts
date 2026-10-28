import {
  findHeredocSpans,
  stripQuotedContent,
} from "./artifact-ref-shell-quotes.js";

const FILE_DESCRIPTOR = /^\d+$/;
const SHELL_WHITESPACE = /\s/;

export type ShellToken =
  | { kind: "operator"; text: string }
  | { kind: "redirection"; needsTarget: boolean; text: string }
  | { kind: "redirection-target"; text: string }
  | { kind: "word"; text: string };

type Quote = "'" | '"';

type Substitution =
  | { depth: number; kind: "dollar"; restoreQuote: Quote | undefined }
  | { kind: "backtick"; restoreQuote: Quote | undefined };

type LexerState = {
  current: string;
  currentKind: "redirection-target" | "word";
  quote: Quote | undefined;
  substitutions: Substitution[];
  tokens: ShellToken[];
};

/** Tokenize statically known shell text into command boundaries and words. */
export function shellTokens(command: string): ShellToken[] {
  const text = stripQuotedContent(command, findHeredocSpans(command));
  const state: LexerState = {
    current: "",
    currentKind: "word",
    quote: undefined,
    substitutions: [],
    tokens: [],
  };

  for (let index = 0; index < text.length; index += 1) {
    index = consumeShellCharacter(text, index, state);
  }
  pushCurrent(state);
  return state.tokens;
}

function consumeShellCharacter(
  text: string,
  index: number,
  state: LexerState
): number {
  const char = text[index];
  if (state.quote !== "'" && isDollarSubstitutionStart(text, index)) {
    return openDollarSubstitution(state, index);
  }
  if (state.quote !== "'" && char === "`") {
    return consumeBacktick(state, index);
  }
  if (state.quote !== undefined) {
    return consumeQuotedChar(text, index, state);
  }
  if (hasEscapedNextChar(text, index)) {
    state.current += char + text[index + 1];
    return index + 1;
  }
  if (isQuote(char)) {
    state.quote = char;
    state.current += char;
    return index;
  }
  if (char === "#" && state.current === "") {
    return skipComment(text, index);
  }
  if (char === ")" && closeDollarSubstitution(state)) {
    return index;
  }
  const redirection = redirectionAt(text, index, state.current);
  if (redirection !== undefined) {
    return consumeRedirection(redirection, index, state);
  }
  const operator = shellOperatorAt(text, index);
  if (operator !== undefined) {
    return consumeShellOperator(operator, index, state);
  }
  if (SHELL_WHITESPACE.test(char)) {
    pushCurrent(state);
    return index;
  }
  state.current += char;
  return index;
}

function openDollarSubstitution(state: LexerState, index: number): number {
  pushCurrent(state);
  state.tokens.push({ kind: "operator", text: "$(" });
  state.substitutions.push({
    depth: 1,
    kind: "dollar",
    restoreQuote: state.quote,
  });
  state.quote = undefined;
  return index + 1;
}

function consumeBacktick(state: LexerState, index: number): number {
  if (closeBacktickSubstitution(state)) {
    return index;
  }
  pushCurrent(state);
  state.tokens.push({ kind: "operator", text: "`" });
  state.substitutions.push({ kind: "backtick", restoreQuote: state.quote });
  state.quote = undefined;
  return index;
}

function consumeRedirection(
  redirection: { hasAttachedTarget: boolean; length: number; text: string },
  index: number,
  state: LexerState
): number {
  pushCurrentWithoutFileDescriptor(state);
  state.tokens.push({
    kind: "redirection",
    needsTarget: !redirection.hasAttachedTarget,
    text: redirection.text,
  });
  if (redirection.hasAttachedTarget) {
    state.currentKind = "redirection-target";
  }
  return index + redirection.length - 1;
}

function consumeShellOperator(
  operator: string,
  index: number,
  state: LexerState
): number {
  if (operator === "(") {
    incrementDollarSubstitutionDepth(state);
  }
  pushCurrent(state);
  state.tokens.push({ kind: "operator", text: operator });
  return index + operator.length - 1;
}

function consumeQuotedChar(
  command: string,
  index: number,
  state: LexerState
): number {
  const char = command[index];
  state.current += char;
  if (state.quote === '"' && hasEscapedNextChar(command, index)) {
    state.current += command[index + 1];
    return index + 1;
  }
  if (char === state.quote) {
    state.quote = undefined;
  }
  return index;
}

function closeBacktickSubstitution(state: LexerState): boolean {
  const substitution = state.substitutions.at(-1);
  if (substitution?.kind !== "backtick") {
    return false;
  }
  pushCurrent(state);
  state.substitutions.pop();
  state.quote = substitution.restoreQuote;
  return true;
}

function closeDollarSubstitution(state: LexerState): boolean {
  const substitution = state.substitutions.at(-1);
  if (substitution?.kind !== "dollar") {
    return false;
  }
  if (substitution.depth > 1) {
    substitution.depth -= 1;
    return false;
  }
  pushCurrent(state);
  state.substitutions.pop();
  state.quote = substitution.restoreQuote;
  return true;
}

function incrementDollarSubstitutionDepth(state: LexerState): boolean {
  const substitution = state.substitutions.at(-1);
  if (substitution?.kind !== "dollar") {
    return false;
  }
  substitution.depth += 1;
  return true;
}

function isDollarSubstitutionStart(command: string, index: number): boolean {
  return command.startsWith("$(", index) && command[index + 2] !== "(";
}

function redirectionAt(
  command: string,
  index: number,
  current: string
): { hasAttachedTarget: boolean; length: number; text: string } | undefined {
  const char = command[index];
  if (
    char !== "<" &&
    char !== ">" &&
    !(char === "&" && command[index + 1] === ">")
  ) {
    return undefined;
  }
  if (current !== "" && !FILE_DESCRIPTOR.test(current)) {
    return char === "<" || char === ">"
      ? redirectionShape(command, index, "")
      : undefined;
  }
  return redirectionShape(command, index, current);
}

function redirectionShape(
  command: string,
  index: number,
  descriptor: string
): { hasAttachedTarget: boolean; length: number; text: string } {
  const candidates = ["<<<", "<<-", "&>", ">>", "<<", "<>", ">&", "<&", ">|"];
  const operator =
    candidates.find((candidate) => command.startsWith(candidate, index)) ??
    command[index];
  const targetIndex = index + operator.length;
  const targetStart = command[targetIndex];
  return {
    hasAttachedTarget:
      targetStart !== undefined &&
      !SHELL_WHITESPACE.test(targetStart) &&
      !isCommandOperatorStart(targetStart),
    length: operator.length,
    text: descriptor + operator,
  };
}

function pushCurrentWithoutFileDescriptor(state: LexerState): void {
  if (FILE_DESCRIPTOR.test(state.current)) {
    state.current = "";
    state.currentKind = "word";
    return;
  }
  pushCurrent(state);
}

function pushCurrent(state: LexerState): void {
  if (state.current !== "") {
    state.tokens.push({ kind: state.currentKind, text: state.current });
  }
  state.current = "";
  state.currentKind = "word";
}

function shellOperatorAt(command: string, index: number): string | undefined {
  for (const operator of [";;&", "&&", "||", ";;", ";&"] as const) {
    if (command.startsWith(operator, index)) {
      return operator;
    }
  }
  const char = command[index];
  return isCommandOperatorStart(char) ? char : undefined;
}

function skipComment(command: string, index: number): number {
  const newline = command.indexOf("\n", index);
  return newline === -1 ? command.length : newline - 1;
}

function hasEscapedNextChar(command: string, index: number): boolean {
  return command[index] === "\\" && index + 1 < command.length;
}

function isQuote(char: string): char is Quote {
  return char === '"' || char === "'";
}

function isCommandOperatorStart(char: string): boolean {
  return (
    char === ";" ||
    char === "|" ||
    char === "&" ||
    char === "(" ||
    char === ")" ||
    char === "\n" ||
    char === "\r"
  );
}
