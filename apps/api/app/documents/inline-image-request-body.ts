export type InlineImageAwareRequestTextResult =
  | { ok: true; requestBodyBytes: number; value: string }
  | { ok: false; requestBodyBytes: number };

/**
 * Read JSON text while enforcing a byte cap only after a top-level non-empty
 * `inlineImages` array is observed. Legacy content-only document requests can
 * be large, but image-bearing requests need an early cap before base64
 * payloads consume unbounded memory.
 */
export async function readInlineImageAwareRequestText(
  request: Request,
  maxBytes: number
): Promise<InlineImageAwareRequestTextResult> {
  const reader = request.body?.getReader();
  if (!reader) {
    return { ok: true, requestBodyBytes: 0, value: "" };
  }

  const decoder = new TextDecoder();
  const scanner = createTopLevelJsonKeyScanner("inlineImages");
  const chunks: string[] = [];
  let requestBodyBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const finalChunk = decoder.decode();
        if (finalChunk.length > 0) {
          scanTopLevelJsonKey(scanner, finalChunk);
          chunks.push(finalChunk);
        }
        return {
          ok: true,
          requestBodyBytes,
          value: chunks.join(""),
        };
      }

      requestBodyBytes += value.byteLength;
      const chunk = decoder.decode(value, { stream: true });
      scanTopLevelJsonKey(scanner, chunk);
      if (requestBodyBytes > maxBytes && scanner.matched) {
        await reader.cancel();
        return { ok: false, requestBodyBytes };
      }
      chunks.push(chunk);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return {
      ok: true,
      requestBodyBytes,
      value: chunks.join(""),
    };
  }
}

/** Return true when a parsed top-level body contains one or more inline images. */
export function hasInlineImageInputs(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const inlineImages = (value as { inlineImages?: unknown }).inlineImages;
  return Array.isArray(inlineImages) && inlineImages.length > 0;
}

function createTopLevelJsonKeyScanner(
  targetKey: string
): TopLevelJsonKeyScanner {
  return {
    collectingKey: false,
    currentKey: "",
    depth: 0,
    escaped: false,
    expectingTopLevelKey: false,
    inString: false,
    matched: false,
    pendingKey: null,
    targetKey,
    targetArrayStarted: false,
    targetValueStarted: false,
    trackingTargetValue: false,
    unicodeEscape: null,
  };
}

function scanTopLevelJsonKey(
  scanner: TopLevelJsonKeyScanner,
  text: string
): void {
  for (const char of text) {
    scanTopLevelJsonKeyChar(scanner, char);
    if (scanner.matched) {
      return;
    }
  }
}

function scanTopLevelJsonKeyChar(
  scanner: TopLevelJsonKeyScanner,
  char: string
): void {
  if (scanner.inString) {
    scanStringChar(scanner, char);
    return;
  }

  if (scanner.pendingKey !== null) {
    if (isJsonWhitespace(char)) {
      return;
    }
    if (char === ":") {
      scanner.trackingTargetValue = scanner.pendingKey === scanner.targetKey;
    }
    scanner.pendingKey = null;
    scanner.expectingTopLevelKey = false;
    return;
  }

  if (scanner.trackingTargetValue) {
    scanTargetValueChar(scanner, char);
    return;
  }

  switch (char) {
    case "{":
    case "[":
      scanner.depth += 1;
      scanner.expectingTopLevelKey = scanner.depth === 1 && char === "{";
      return;
    case "}":
    case "]":
      scanner.depth = Math.max(0, scanner.depth - 1);
      scanner.expectingTopLevelKey = false;
      return;
    case ",":
      scanner.expectingTopLevelKey = scanner.depth === 1;
      return;
    case '"':
      scanner.inString = true;
      scanner.escaped = false;
      scanner.collectingKey =
        scanner.depth === 1 && scanner.expectingTopLevelKey;
      scanner.currentKey = "";
      scanner.unicodeEscape = null;
      return;
    default:
      return;
  }
}

function scanTargetValueChar(
  scanner: TopLevelJsonKeyScanner,
  char: string
): void {
  if (!scanner.targetValueStarted) {
    if (isJsonWhitespace(char)) {
      return;
    }
    scanner.targetValueStarted = true;
    if (char === "[") {
      scanner.targetArrayStarted = true;
      return;
    }
    scanner.matched = true;
    return;
  }

  if (!scanner.targetArrayStarted) {
    scanner.matched = true;
    return;
  }

  if (isJsonWhitespace(char)) {
    return;
  }
  if (char === "]") {
    scanner.trackingTargetValue = false;
    return;
  }
  scanner.matched = true;
}

function scanStringChar(scanner: TopLevelJsonKeyScanner, char: string): void {
  if (scanner.unicodeEscape !== null) {
    scanUnicodeEscapeChar(scanner, char);
    return;
  }

  if (scanner.escaped) {
    if (scanner.collectingKey) {
      if (char === "u") {
        scanner.unicodeEscape = "";
      } else {
        scanner.currentKey += decodeJsonSimpleEscape(char);
      }
    }
    scanner.escaped = false;
    return;
  }

  if (char === "\\") {
    scanner.escaped = true;
    return;
  }

  if (char === '"') {
    scanner.inString = false;
    if (scanner.collectingKey) {
      scanner.pendingKey = scanner.currentKey;
    }
    scanner.collectingKey = false;
    return;
  }

  if (scanner.collectingKey) {
    scanner.currentKey += char;
  }
}

function isJsonWhitespace(char: string): boolean {
  return char === " " || char === "\n" || char === "\r" || char === "\t";
}

function scanUnicodeEscapeChar(
  scanner: TopLevelJsonKeyScanner,
  char: string
): void {
  if (!isJsonHexDigit(char)) {
    scanner.unicodeEscape = null;
    return;
  }

  const unicodeEscape = `${scanner.unicodeEscape}${char}`;
  scanner.unicodeEscape = unicodeEscape;
  if (unicodeEscape.length < 4) {
    return;
  }

  scanner.currentKey += String.fromCharCode(Number.parseInt(unicodeEscape, 16));
  scanner.unicodeEscape = null;
}

function decodeJsonSimpleEscape(char: string): string {
  switch (char) {
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "/":
      return "/";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return char;
  }
}

function isJsonHexDigit(char: string): boolean {
  return (
    (char >= "0" && char <= "9") ||
    (char >= "a" && char <= "f") ||
    (char >= "A" && char <= "F")
  );
}

type TopLevelJsonKeyScanner = {
  collectingKey: boolean;
  currentKey: string;
  depth: number;
  escaped: boolean;
  expectingTopLevelKey: boolean;
  inString: boolean;
  matched: boolean;
  pendingKey: string | null;
  targetKey: string;
  targetArrayStarted: boolean;
  targetValueStarted: boolean;
  trackingTargetValue: boolean;
  unicodeEscape: string | null;
};
