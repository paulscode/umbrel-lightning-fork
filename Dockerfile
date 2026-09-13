# Build backend
FROM node:16-bookworm-slim AS backend-builder

# Create app directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package.json ./
COPY apps/backend/package.json ./apps/backend/package.json
RUN npm install
# Copy project files and folders
COPY apps/backend ./apps/backend



# Build frontend
FROM node:16-bookworm-slim AS frontend-builder

# Create app directory
WORKDIR /app

# Copy package.json and install dependencies
COPY package.json ./
COPY apps/frontend/package.json ./apps/frontend/package.json
RUN npm install

# Copy project files and folders
COPY apps/frontend ./apps/frontend

# Build assets
RUN yarn run build:frontend



# Final image
FROM node:16-bookworm-slim AS lightning
ARG TARGETARCH

# The channel backup agent the StartOS package runs, and what it needs: rclone
# for the targets, jq for its state, ssh-keyscan/ssh-keygen for SFTP host keys
# and key checks, flock (util-linux) to serialize copies. rclone comes from
# its own release rather than Debian's, which lags the Dropbox and Google
# token handling the agent relies on. The agent is pinned to a commit of the
# package repository: one script serves both platforms.
ARG RCLONE_VERSION=v1.68.2
ARG BACKUP_AGENT_REF=3e16a3112ebb0dc0a5faedda7f93a824ed14ec82
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip jq openssh-client util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL "https://downloads.rclone.org/${RCLONE_VERSION}/rclone-${RCLONE_VERSION}-linux-${TARGETARCH}.zip" -o /tmp/rclone.zip \
    && unzip -j /tmp/rclone.zip '*/rclone' -d /usr/local/bin \
    && chmod 755 /usr/local/bin/rclone \
    && rm -f /tmp/rclone.zip \
    && curl -fsSL "https://raw.githubusercontent.com/paulscode/lightning-fork-startos/${BACKUP_AGENT_REF}/backup-agent.sh" -o /usr/local/bin/backup-agent.sh \
    && chmod 755 /usr/local/bin/backup-agent.sh \
    && sh -n /usr/local/bin/backup-agent.sh \
    && rclone version | head -1

# Change directory to '/app' 
WORKDIR /app

# Copy built code from build stages to '/app' directory
COPY --from=backend-builder /app /app
COPY --from=frontend-builder /app/apps/frontend/dist/ /app/apps/frontend/dist/

EXPOSE 3006
CMD [ "npm", "run", "dev:backend" ]