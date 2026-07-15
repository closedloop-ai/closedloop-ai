export type ParsedPullRequestUrl = {
  owner: string;
  repo: string;
  number: number;
  fullName: string;
};

const GITHUB_OWNER_REPO_SEGMENT_REGEX = /^[A-Za-z0-9_.-]+$/;
const PR_NUMBER_REGEX = /^[1-9]\d*$/;

export function parseGitHubPullRequestUrl(
  value: string
): ParsedPullRequestUrl | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.username ||
    url.password
  ) {
    return null;
  }

  const parts = url.pathname.split("/");
  if (parts.at(-1) === "") {
    parts.pop();
  }
  if (parts.length !== 5 || parts[0] !== "" || parts[3] !== "pull") {
    return null;
  }

  const [owner, repo, numberText] = [parts[1], parts[2], parts[4]];
  if (
    !(
      isSafeRepositorySegment(owner) &&
      isSafeRepositorySegment(repo) &&
      PR_NUMBER_REGEX.test(numberText)
    )
  ) {
    return null;
  }

  return {
    owner,
    repo,
    number: Number.parseInt(numberText, 10),
    fullName: `${owner}/${repo}`,
  };
}

export function isSafeRepositorySegment(segment: string): boolean {
  try {
    const decoded = decodeURIComponent(segment);
    return (
      decoded === segment &&
      GITHUB_OWNER_REPO_SEGMENT_REGEX.test(decoded) &&
      !hasControlCharacter(decoded)
    );
  } catch {
    return false;
  }
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const charCode = value.charCodeAt(index);
    if (charCode <= 31 || charCode === 127) {
      return true;
    }
  }
  return false;
}
