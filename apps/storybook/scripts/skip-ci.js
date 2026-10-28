const { execSync } = require("node:child_process");

const commitMessage = execSync("git log -1 --pretty=%B").toString().trim();

// ISS-9704: the SUBJECT line only, never the whole body. A bare `includes` over
// the full message meant a commit that merely DISCUSSED this marker — in prose,
// in backticks, in a changelog bullet — cancelled every Vercel deploy. A real
// directive is conventionally written on the subject line; a mention is not.
// GitHub Actions applies its own copy of this rule to the whole message and
// creates no run for the two events it covers — `push` and `pull_request`, and
// only those. Not configurable from this repo, so the mention still costs every
// required PR context — docs/runbooks/pr-authoring.md.
const commitSubject = commitMessage.split("\n", 1)[0];

if (commitSubject.includes("[skip ci]")) {
  console.log("Skipping build due to [skip ci] in commit message.");
  process.exit(0); // this causes Vercel to skip the build
}

// ISS-9705: every exit path names its decision. Exit 1 is also what a child that
// died before running anything returns, so a harness reading only the status
// cannot tell "continue the build" from "never executed".
console.log("Continuing with build.");
process.exit(1); // continue with build
