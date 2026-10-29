/** A finished event is insufficient when Storybook swallowed a play exception. */
export function branchesListPlayResult(events, storyId) {
  const playError = events.find(
    (event) =>
      event.type === "playFunctionThrewException" ||
      event.type === "unhandledErrorsWhilePlaying" ||
      event.type === "storyThrewException"
  );
  if (playError) {
    return { passed: false, reason: `${playError.type}: ${playError.message}` };
  }
  const finished = events.find(
    (event) => event.type === "storyFinished" && event.storyId === storyId
  );
  if (!finished) {
    return { passed: false, reason: "storyFinished was not observed" };
  }
  if (finished.status !== "success") {
    return { passed: false, reason: `storyFinished: ${finished.status}` };
  }
  return { passed: true };
}

/**
 * Runs every story and returns the ids that failed. A story that throws, such
 * as one that never emits storyFinished, is a FAIL for that story only, so the
 * run still reports every other verdict.
 */
export async function verifyBranchesListStories(stories, verifyStory, report) {
  const failures = [];
  for (const story of stories) {
    let result;
    try {
      result = await verifyStory(story);
    } catch (error) {
      result = {
        passed: false,
        reason: String(error?.message ?? error).split("\n")[0],
      };
    }
    report(story, result);
    if (!result.passed) {
      failures.push(story.id);
    }
  }
  return failures;
}
