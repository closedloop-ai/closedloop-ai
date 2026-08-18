/**
 * A tiny evaluator for the subset of GitHub Actions `if:` expression syntax the
 * workflow guards in this directory need to EXECUTE rather than pattern-match.
 *
 * `scripts/deploy/AGENTS.md` ("Guards must execute the decision"): asserting
 * that a predicate *appears* in a condition is not asserting the decision. A
 * `true ||` prefix, or an extra disjunct, keeps every substring assertion green
 * while widening the gate — which for these jobs means off-`main` status writes
 * or a status posted for a build that never ran. So the guards evaluate the real
 * condition against synthetic contexts instead.
 *
 * Deliberately small: literals, `!`, `==`, `!=`, `&&`, `||`, parentheses, dotted
 * context lookups, and the status functions. Anything outside that grammar
 * THROWS rather than evaluating to a default — a condition this cannot read is a
 * condition the guard cannot vouch for, and silently returning `false` there
 * would make every fail-closed assertion pass for the wrong reason.
 */

export type GithubExpressionContext = {
  /** Dotted lookups, e.g. `needs.resolve-target.result`. */
  values: Record<string, string>;
  /** Whether the run is cancelled — drives `cancelled()` / `!cancelled()`. */
  cancelled?: boolean;
  /** Whether every prior dependency succeeded — drives `success()`. */
  success?: boolean;
};

type Token = { kind: string; text: string };

const TOKEN_PATTERN =
  /\s*(?:(&&|\|\||==|!=)|([()!])|'([^']*)'|([A-Za-z_][A-Za-z0-9_.-]*))/y;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    TOKEN_PATTERN.lastIndex = index;
    const match = TOKEN_PATTERN.exec(source);
    if (!match) {
      if (source.slice(index).trim() === "") {
        break;
      }
      throw new Error(
        `Unsupported token in GitHub if-expression at: ${source.slice(index, index + 40)}`
      );
    }
    index = TOKEN_PATTERN.lastIndex;
    if (match[1]) {
      tokens.push({ kind: "op", text: match[1] });
    } else if (match[2]) {
      tokens.push({ kind: match[2], text: match[2] });
    } else if (match[3] !== undefined) {
      tokens.push({ kind: "string", text: match[3] });
    } else if (match[4]) {
      tokens.push({ kind: "name", text: match[4] });
    }
  }
  return tokens;
}

/**
 * Recursive-descent over `||` → `&&` → equality → unary → primary, mirroring
 * GitHub's precedence. Values are compared as strings, which is what the
 * expressions under test do (`… == 'true'`, `… == 'success'`).
 */
class Parser {
  private position = 0;
  private readonly tokens: Token[];
  private readonly context: GithubExpressionContext;

  constructor(tokens: Token[], context: GithubExpressionContext) {
    this.tokens = tokens;
    this.context = context;
  }

  evaluate(): boolean {
    const value = this.parseOr();
    if (this.position !== this.tokens.length) {
      throw new Error("Trailing tokens in GitHub if-expression");
    }
    return toBoolean(value);
  }

  private peek(): Token | undefined {
    return this.tokens[this.position];
  }

  private parseOr(): string | boolean {
    let left = this.parseAnd();
    while (this.peek()?.text === "||") {
      this.position++;
      const right = this.parseAnd();
      left = toBoolean(left) || toBoolean(right);
    }
    return left;
  }

  private parseAnd(): string | boolean {
    let left = this.parseEquality();
    while (this.peek()?.text === "&&") {
      this.position++;
      const right = this.parseEquality();
      left = toBoolean(left) && toBoolean(right);
    }
    return left;
  }

  private parseEquality(): string | boolean {
    const left = this.parseUnary();
    const operator = this.peek();
    if (operator?.text === "==" || operator?.text === "!=") {
      this.position++;
      const right = this.parseUnary();
      const equal = String(left) === String(right);
      return operator.text === "==" ? equal : !equal;
    }
    return left;
  }

  private parseUnary(): string | boolean {
    if (this.peek()?.kind === "!") {
      this.position++;
      return !toBoolean(this.parseUnary());
    }
    return this.parsePrimary();
  }

  private parsePrimary(): string | boolean {
    const token = this.peek();
    if (!token) {
      throw new Error("Unexpected end of GitHub if-expression");
    }
    if (token.kind === "(") {
      this.position++;
      const value = this.parseOr();
      if (this.peek()?.kind !== ")") {
        throw new Error("Unbalanced parenthesis in GitHub if-expression");
      }
      this.position++;
      return value;
    }
    if (token.kind === "string") {
      this.position++;
      return token.text;
    }
    if (token.kind === "name") {
      this.position++;
      return this.resolveName(token.text);
    }
    throw new Error(`Unexpected token "${token.text}"`);
  }

  private resolveName(name: string): string | boolean {
    if (this.peek()?.kind === "(") {
      this.position++;
      if (this.peek()?.kind !== ")") {
        throw new Error(`Unsupported arguments to ${name}() — guards only`);
      }
      this.position++;
      return this.callStatusFunction(name);
    }
    if (name === "true" || name === "false") {
      return name === "true";
    }
    const value = this.context.values[name];
    if (value === undefined) {
      throw new Error(
        `GitHub if-expression reads "${name}", which the test context does not define. ` +
          "Add it to the synthetic context so the guard evaluates a real value instead of an accidental blank."
      );
    }
    return value;
  }

  private callStatusFunction(name: string): boolean {
    if (name === "always") {
      return true;
    }
    if (name === "cancelled") {
      return this.context.cancelled ?? false;
    }
    if (name === "success") {
      return this.context.success ?? true;
    }
    if (name === "failure") {
      return !(this.context.success ?? true);
    }
    throw new Error(`Unsupported status function ${name}()`);
  }
}

/** True when `\`${'{{'} … ${'}}'}\``-free condition `source` evaluates truthy in `context`. */
export function evaluateGithubIf(
  source: string,
  context: GithubExpressionContext
): boolean {
  return new Parser(tokenize(source), context).evaluate();
}

function toBoolean(value: string | boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  // GitHub treats the empty string as falsy and any other string as truthy.
  return value !== "" && value !== "false";
}
