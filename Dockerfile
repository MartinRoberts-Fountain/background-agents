# Stage 1: build Node + OpenCode (build-essential for native deps; not present in final image)
FROM node:22-slim AS node-builder
RUN apt-get update && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*
RUN npm install -g opencode-ai@1.2.21

# Stage 2: final image
FROM python:3.12-slim-bookworm

# Copy Node runtime and global node_modules from builder (no npm/npx in final image)
COPY --from=node-builder /usr/local/bin/node /usr/local/bin/node
COPY --from=node-builder /usr/lib/node_modules /usr/lib/node_modules
# OpenCode CLI on PATH
RUN ln -sf ../lib/node_modules/.bin/opencode /usr/local/bin/opencode

# Runtime system deps only (git, ca-certificates, openssh-client; no gh, curl, jq, unzip, gnupg, build-essential)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    gh \
    ca-certificates \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Python dependencies for the bridge and supervisor (pinned for reproducibility)
RUN pip install --no-cache-dir \
    "httpx>=0.27" \
    "websockets>=12" \
    "pydantic>=2.0,<3"

# Setup workspace
WORKDIR /workspace

# Copy sandbox code
#COPY background-agents/.claude/ftn-planner.md /root/.config/opencode/agents/ftn-planner.md
COPY background-agents/packages/modal-infra/src/sandbox /app/sandbox
ENV PYTHONPATH=/app

# Expose ports
# OpenCode
EXPOSE 4096
# Reverse Proxy
EXPOSE 3000

# Set entrypoint to the supervisor
ENTRYPOINT ["python", "-m", "sandbox.entrypoint"]
