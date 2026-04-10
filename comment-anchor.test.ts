import assert from "node:assert/strict";
import test from "node:test";
import {
  hydrateComment,
  reanchorComment,
  reanchorComments,
} from "./comment-anchor";

function idx(text: string, needle: string, from = 0) {
  const i = text.indexOf(needle, from);
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called exclusively from test() blocks
  assert.notEqual(
    i,
    -1,
    `Could not find ${JSON.stringify(needle)} in ${JSON.stringify(text)}`
  );
  return i;
}

function commentFor(text: string, needle: string, id = "c1") {
  const start = idx(text, needle);
  return hydrateComment(text, { id, start, end: start + needle.length });
}

function assertResolved(
  result: ReturnType<typeof reanchorComment>,
  text: string,
  expectedQuote: string
) {
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called exclusively from test() blocks
  assert.equal(result.status, "resolved", JSON.stringify(result));
  // biome-ignore lint/suspicious/noMisplacedAssertion: helper called exclusively from test() blocks
  assert.equal(text.slice(result.start!, result.end!), expectedQuote);
}

test("unchanged document preserves positions", () => {
  const text = "The quick brown fox jumped over a lazy dog";
  const comment = commentFor(text, "brown fox");
  const result = reanchorComment(text, text, comment);
  assert.equal(result.status, "resolved");
  assert.equal(result.start, comment.start);
  assert.equal(result.end, comment.end);
});

test("insertion before anchor shifts it right", () => {
  const oldText = "The quick brown fox jumped over a lazy dog";
  const newText = "The quick young brown fox jumped over a lazy dog";
  const comment = commentFor(oldText, "brown fox");
  const result = reanchorComment(oldText, newText, comment);
  assertResolved(result, newText, "brown fox");
  assert.equal(result.start, idx(newText, "brown fox"));
});

test("insertion after anchor leaves anchor text intact", () => {
  const oldText = "The quick brown fox jumped over a lazy dog";
  const newText = "The quick brown fox gracefully jumped over a lazy dog";
  const comment = commentFor(oldText, "brown fox");
  const result = reanchorComment(oldText, newText, comment);
  assertResolved(result, newText, "brown fox");
});

test("insertion inside anchor expands the anchor", () => {
  const oldText = "The quick brown fox jumped over a lazy dog";
  const newText = "The quick brown clever fox jumped over a lazy dog";
  const comment = commentFor(oldText, "brown fox");
  const result = reanchorComment(oldText, newText, comment);
  assertResolved(result, newText, "brown clever fox");
});

test("deletion inside anchor shrinks the anchor", () => {
  const oldText = "The quick brown fox jumped over a lazy dog";
  const newText = "The quick fox jumped over a lazy dog";
  const comment = commentFor(oldText, "brown fox");
  const result = reanchorComment(oldText, newText, comment);
  assertResolved(result, newText, "fox");
});

test("replacement inside anchor follows replacement", () => {
  const oldText = "The quick brown fox jumped over a lazy dog";
  const newText = "The quick red fox jumped over a lazy dog";
  const comment = commentFor(oldText, "brown fox");
  const result = reanchorComment(oldText, newText, comment);
  assertResolved(result, newText, "red fox");
});

test("entire anchor deletion removes comment", () => {
  const oldText = "The quick brown fox jumped over a lazy dog";
  const newText = "The quick jumped over a lazy dog";
  const comment = commentFor(oldText, "brown fox");
  const result = reanchorComment(oldText, newText, comment);
  assert.equal(result.status, "removed", JSON.stringify(result));
});

test("duplicate exact quote is disambiguated by context", () => {
  const oldText = "alpha brown fox omega\nalpha brown fox sigma";
  const targetStart = oldText.lastIndexOf("brown fox");
  const comment = hydrateComment(oldText, {
    id: "c1",
    start: targetStart,
    end: targetStart + "brown fox".length,
  });
  const newText = "alpha brown fox omega\nalpha young brown fox sigma";
  const result = reanchorComment(oldText, newText, comment);
  assertResolved(result, newText, "brown fox");
  assert.equal(result.start, newText.lastIndexOf("brown fox"));
});

test("moved text is found at its new location when quote remains unique enough", () => {
  const oldText = "A\nThe quick brown fox jumped over a lazy dog\nB";
  const newText = "B\nA\nThe quick brown fox jumped over a lazy dog";
  const comment = commentFor(oldText, "brown fox");
  const result = reanchorComment(oldText, newText, comment);
  assertResolved(result, newText, "brown fox");
});

test("ambiguous identical duplicates are not guessed", () => {
  const oldText = "x brown fox y\na brown fox b";
  const comment = commentFor(oldText, "brown fox");
  const newText = "brown fox\nbrown fox";
  const result = reanchorComment(oldText, newText, comment, {
    minConfidence: 0.4,
    ambiguityMargin: 0.02,
  });
  assert.equal(result.status, "ambiguous", JSON.stringify(result));
});

test("multiple comments are reanchored independently", () => {
  const oldText = "alpha beta gamma delta";
  const comments = [
    commentFor(oldText, "alpha", "c1"),
    commentFor(oldText, "gamma", "c2"),
  ];
  const newText = "zero alpha beta wide gamma delta";
  const results = reanchorComments(oldText, newText, comments);
  assert.equal(results.length, 2);
  assertResolved(results[0], newText, "alpha");
  assertResolved(results[1], newText, "gamma");
});

test("overlapping comments can both survive", () => {
  const oldText = "The quick brown fox";
  const startA = idx(oldText, "quick brown");
  const startB = idx(oldText, "brown fox");
  const comments = [
    hydrateComment(oldText, {
      id: "a",
      start: startA,
      end: startA + "quick brown".length,
    }),
    hydrateComment(oldText, {
      id: "b",
      start: startB,
      end: startB + "brown fox".length,
    }),
  ];
  const newText = "The very quick brown clever fox";
  const results = reanchorComments(oldText, newText, comments);
  assertResolved(results[0], newText, "quick brown");
  assertResolved(results[1], newText, "brown clever fox");
});

test("whitespace-only changes around anchor do not break mapping", () => {
  const oldText = "The quick brown fox jumped";
  const newText = "The quick\n\tbrown fox jumped";
  const comment = commentFor(oldText, "brown fox");
  const result = reanchorComment(oldText, newText, comment);
  assertResolved(result, newText, "brown fox");
});
