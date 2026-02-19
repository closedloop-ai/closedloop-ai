# Claude Code Runner Container
# Executes Symphony loop runs inside an isolated container environment.
# Designed to run on ECS with IAM role credentials for S3 access.

FROM node:20-slim

# Prevent interactive prompts during package installation
ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    jq \
    ca-certificates \
    unzip \
    tini \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN ARCH=$(dpkg --print-architecture) && \
    GH_VERSION=$(curl -sL https://api.github.com/repos/cli/cli/releases/latest | jq -r '.tag_name' | sed 's/^v//') && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${ARCH}.tar.gz" -o gh.tar.gz && \
    tar -xzf gh.tar.gz && \
    mv "gh_${GH_VERSION}_linux_${ARCH}/bin/gh" /usr/local/bin/gh && \
    rm -rf gh.tar.gz "gh_${GH_VERSION}_linux_${ARCH}" && \
    gh --version

# Install pnpm (needed for plugin installation)
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Copy the harness agent and install its dependencies locally
COPY harness-agent.mjs /opt/harness/harness-agent.mjs
RUN cd /opt/harness && npm init -y && npm install @aws-sdk/client-s3

# Create non-root user for runtime.
# The harness, git clone, and Claude Code all run as this user.
# System installs above require root; only the runtime switches to runner.
RUN useradd -m -s /bin/bash runner && \
    mkdir -p /workspace && chown runner:runner /workspace

USER runner

# Install ClosedLoop plugins as runner so the cache lands in /home/runner/.claude/
# (the harness looks for plugins in ~/.claude/plugins/cache/).
# Requires GITHUB_TOKEN build arg for private repo access.
# Local:  docker build --build-arg GITHUB_TOKEN=$(gh auth token) ...
# CI:     uses secrets.PLUGIN_REPO_TOKEN or a GitHub App token
ARG GITHUB_TOKEN
RUN git config --global url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/" && \
    git config --global --add url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf "git@github.com:" && \
    claude plugin marketplace add closedloop-ai/claude_code && \
    claude plugin install experimental@closedloop && \
    claude plugin install symphony-core@closedloop && \
    (git config --global --unset-all url."https://x-access-token:${GITHUB_TOKEN}@github.com/".insteadOf 2>/dev/null || true)

WORKDIR /workspace

ENTRYPOINT ["tini", "--"]
CMD ["node", "/opt/harness/harness-agent.mjs"]
