// Pure validation/apply core for the Style Lab token export. Kept separate from
// the `apply-style-lab-export.mjs` CLI so every guard at this boundary is
// reachable from a test without writing to the real design-system stylesheet.
// Failures throw StyleLabExportError; the CLI is what turns that into exit 1.

const regexpSpecialCharacterPattern = /[.*+?^${}()|[\]\\]/g;
const tokenNamePattern = /^[a-z0-9-]+$/;
const trailingWhitespacePattern = /\s+$/;
const unsafeCssDelimiterPattern = /[;{}]/;
// A `/*` in a value would comment out the remainder of globals.css from the
// injection point to the next `*/`, silently deleting every declaration after
// it; a stray `*/` closes a comment the file opened. Neither is caught by the
// delimiter check above, because a bare `/` is legitimate in a CSS value
// (`oklch(… / 0.5)`) and so cannot be rejected wholesale.
const cssCommentDelimiterPattern = /\/\*|\*\//;

export const TARGET_FILE = "packages/design-system/styles/globals.css";

export const StyleTokenScope = {
  Root: "root",
  Theme: "theme",
};

export const StyleTokenOperation = {
  Add: "add",
  Remove: "remove",
  Update: "update",
};

export const scopeSelectors = {
  [StyleTokenScope.Root]: ":root",
  [StyleTokenScope.Theme]: "@theme inline",
};

const styleTokenOperations = new Set(Object.values(StyleTokenOperation));

export class StyleLabExportError extends Error {}

export function validatePayload(payload) {
  if (!(payload && typeof payload === "object")) {
    fail("Style Lab export must be a JSON object.");
  }
  if (payload.version !== 1) {
    fail("Unsupported Style Lab export version.");
  }
  if (payload.targetFile !== TARGET_FILE) {
    fail("Style Lab export targets an unexpected file.");
  }
  if (!Array.isArray(payload.tokens) || payload.tokens.length === 0) {
    fail("Style Lab export has no token edits.");
  }

  return payload.tokens.map((token, index) => validateToken(token, index));
}

export function applyTokenEdits(source, tokens) {
  let nextSource = source;
  const tokensByScope = groupTokensByScope(tokens);

  for (const [scope, scopeTokens] of tokensByScope) {
    const selector = scopeSelectors[scope];
    const blockRange = findCssBlockRange(nextSource, selector);
    let block = nextSource.slice(blockRange.start, blockRange.end);
    for (const token of scopeTokens) {
      block = applyTokenEdit(block, token, selector);
    }
    nextSource = `${nextSource.slice(0, blockRange.start)}${block}${nextSource.slice(
      blockRange.end
    )}`;
  }

  return nextSource;
}

function validateToken(token, index) {
  if (!(token && typeof token === "object")) {
    fail(`Token edit ${index + 1} must be an object.`);
  }
  if (!(typeof token.name === "string" && tokenNamePattern.test(token.name))) {
    fail(`Token edit ${index + 1} has an invalid token name.`);
  }
  const operation = validateTokenOperation(token);
  validateTokenValue(token, operation);
  validatePreviousValue(token, operation);
  const scope = token.scope ?? StyleTokenScope.Root;
  if (!Object.hasOwn(scopeSelectors, scope)) {
    fail(`Token edit ${token.name} has an unsupported scope.`);
  }
  return {
    name: token.name,
    operation,
    previousValue:
      operation === StyleTokenOperation.Add
        ? null
        : normalizeCssValue(token.previousValue),
    value: operation === StyleTokenOperation.Remove ? null : token.value.trim(),
    scope,
  };
}

function validateTokenOperation(token) {
  const operation = token.operation ?? StyleTokenOperation.Update;
  if (styleTokenOperations.has(operation)) {
    return operation;
  }
  fail(`Token edit ${token.name} has an unsupported operation.`);
}

function validateTokenValue(token, operation) {
  if (operation === StyleTokenOperation.Remove) {
    return;
  }
  if (!(typeof token.value === "string" && token.value.trim().length > 0)) {
    fail(`Token edit ${token.name} has an empty value.`);
  }
  if (unsafeCssDelimiterPattern.test(token.value)) {
    fail(`Token edit ${token.name} contains unsafe CSS delimiters.`);
  }
  if (cssCommentDelimiterPattern.test(token.value)) {
    fail(`Token edit ${token.name} contains CSS comment delimiters.`);
  }
}

function validatePreviousValue(token, operation) {
  if (operation === StyleTokenOperation.Add) {
    return;
  }
  if (
    !(
      typeof token.previousValue === "string" &&
      token.previousValue.trim().length > 0
    )
  ) {
    fail(`Token edit ${token.name} is missing previousValue.`);
  }
  if (unsafeCssDelimiterPattern.test(token.previousValue)) {
    fail(`Token edit ${token.name} contains unsafe previousValue delimiters.`);
  }
  if (cssCommentDelimiterPattern.test(token.previousValue)) {
    fail(
      `Token edit ${token.name} contains CSS comment delimiters in previousValue.`
    );
  }
}

function groupTokensByScope(tokens) {
  const groups = new Map();
  for (const token of tokens) {
    const scopeTokens = groups.get(token.scope) ?? [];
    scopeTokens.push(token);
    groups.set(token.scope, scopeTokens);
  }
  return groups;
}

function findCssBlockRange(source, selector) {
  const selectorStart = source.indexOf(selector);
  if (selectorStart === -1) {
    fail(`Could not find ${selector} block in design-system globals.`);
  }
  const blockStart = source.indexOf("{", selectorStart);
  if (blockStart === -1) {
    fail(`Could not find the start of the ${selector} block.`);
  }

  let depth = 0;
  for (let index = blockStart; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return { start: blockStart + 1, end: index };
      }
    }
  }

  return fail(`Could not find the end of the ${selector} block.`);
}

function applyTokenEdit(block, token, selector) {
  if (token.operation === StyleTokenOperation.Add) {
    return applyTokenAdd(block, token, selector);
  }
  if (token.operation === StyleTokenOperation.Remove) {
    return applyTokenRemove(block, token, selector);
  }
  return applyTokenUpdate(block, token, selector);
}

function applyTokenAdd(block, token, selector) {
  const pattern = tokenDeclarationPattern(token.name);
  if (block.match(pattern)) {
    fail(`Token --${token.name} already exists in the ${selector} block.`);
  }
  const trimmedBlock = block.replace(trailingWhitespacePattern, "");
  const trailingWhitespace = block.slice(trimmedBlock.length) || "\n";
  return `${trimmedBlock}\n  --${token.name}: ${token.value};${trailingWhitespace}`;
}

function applyTokenRemove(block, token, selector) {
  const pattern = tokenDeclarationPattern(token.name);
  const match = block.match(pattern);
  if (!match) {
    fail(`Token --${token.name} was not found in the ${selector} block.`);
  }
  const currentValue = normalizeCssValue(match[2]);
  if (currentValue !== token.previousValue) {
    fail(
      `Token --${token.name} in ${selector} changed since export. Expected "${token.previousValue}", found "${currentValue}".`
    );
  }
  const removePattern = new RegExp(
    `^\\s*--${escapeRegExp(token.name)}:\\s*[\\s\\S]*?;\\n?`,
    "m"
  );
  return block.replace(removePattern, "");
}

function applyTokenUpdate(block, token, selector) {
  const pattern = new RegExp(
    `(^\\s*--${escapeRegExp(token.name)}:\\s*)([\\s\\S]*?);`,
    "m"
  );
  const match = block.match(pattern);
  if (!match) {
    fail(`Token --${token.name} was not found in the ${selector} block.`);
  }
  const currentValue = normalizeCssValue(match[2]);
  if (currentValue !== token.previousValue) {
    fail(
      `Token --${token.name} in ${selector} changed since export. Expected "${token.previousValue}", found "${currentValue}".`
    );
  }
  return block.replace(pattern, `$1${token.value};`);
}

function tokenDeclarationPattern(name) {
  return new RegExp(`(^\\s*--${escapeRegExp(name)}:\\s*)([\\s\\S]*?);`, "m");
}

function normalizeCssValue(value) {
  return value.trim().replace(/\s+/g, " ");
}

function escapeRegExp(value) {
  return value.replace(regexpSpecialCharacterPattern, "\\$&");
}

function fail(message) {
  throw new StyleLabExportError(message);
}
