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

# Install AWS SDK v3 globally (used by harness agent for S3 operations)
RUN npm install -g @aws-sdk/client-s3

# Install ClosedLoop plugins (marketplace)
RUN claude plugin marketplace add closedloop-ai/claude_code && \
    claude plugin install experimental@closedloop && \
    claude plugin install symphony-core@closedloop

# Copy the harness agent (must happen as root for /opt write access)
COPY harness-agent.mjs /opt/harness/harness-agent.mjs

# Create non-root user for runtime.
# The harness, git clone, and Claude Code all run as this user.
# System installs above require root; only the runtime switches to runner.
RUN useradd -m -s /bin/bash runner && \
    mkdir -p /workspace && chown runner:runner /workspace

USER runner
WORKDIR /workspace

ENTRYPOINT ["tini", "--"]
CMD ["node", "/opt/harness/harness-agent.mjs"]
