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
# Both downloads are checked against pinned SHA-256 sums (rclone's from its
# release SHA256SUMS; the agent's from the pinned commit), so a version pin
# is an artifact pin. curl and unzip leave with the layer.
ARG RCLONE_VERSION=v1.68.2
ARG RCLONE_SHA256_AMD64=0e6fa18051e67fc600d803a2dcb10ddedb092247fc6eee61be97f64ec080a13c
ARG RCLONE_SHA256_ARM64=c6e9d4cf9c88b279f6ad80cd5675daebc068e404890fa7e191412c1bc7a4ac5f
ARG BACKUP_AGENT_REF=5f843cc3be6ec7c86a9ede9538fc569a284a650b
ARG BACKUP_AGENT_SHA256=e1acfd52b3906959b00937467c2ae4f296381e067fb12ca5561b910ab3aabb1d
RUN set -eu; \
    arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in amd64) sum="$RCLONE_SHA256_AMD64" ;; arm64) sum="$RCLONE_SHA256_ARM64" ;; *) echo "no rclone checksum for $arch" >&2; exit 1 ;; esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl unzip jq openssh-client util-linux; \
    curl -fsSL "https://downloads.rclone.org/${RCLONE_VERSION}/rclone-${RCLONE_VERSION}-linux-${arch}.zip" -o /tmp/rclone.zip; \
    echo "$sum  /tmp/rclone.zip" | sha256sum -c -; \
    unzip -j /tmp/rclone.zip '*/rclone' -d /usr/local/bin; \
    chmod 755 /usr/local/bin/rclone; \
    rm -f /tmp/rclone.zip; \
    curl -fsSL "https://raw.githubusercontent.com/paulscode/lightning-fork-startos/${BACKUP_AGENT_REF}/backup-agent.sh" -o /usr/local/bin/backup-agent.sh; \
    echo "$BACKUP_AGENT_SHA256  /usr/local/bin/backup-agent.sh" | sha256sum -c -; \
    chmod 755 /usr/local/bin/backup-agent.sh; \
    sh -n /usr/local/bin/backup-agent.sh; \
    apt-get purge -y --auto-remove curl unzip; \
    rm -rf /var/lib/apt/lists/*; \
    rclone version | head -1

# Change directory to '/app' 
WORKDIR /app

# Copy built code from build stages to '/app' directory
COPY --from=backend-builder /app /app
COPY --from=frontend-builder /app/apps/frontend/dist/ /app/apps/frontend/dist/

EXPOSE 3006
CMD [ "npm", "run", "dev:backend" ]