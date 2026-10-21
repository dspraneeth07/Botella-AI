# syntax=docker/dockerfile:1
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not backend/.
#
#   docker build -f backend/Dockerfile .
#
# Three nightly jobs - the gate, the calibration refit and the weekly
# signal-effect fit - shell out to Python scripts that live in the sibling
# Botella_External_APIs checkout. This image had neither a Python interpreter
# nor those scripts, and the backend's build context could not reach them, so
# all three failed on every deployed box: the cron caught the ENOENT, logged one
# line, and the estate simply never gated. See backend/lib/pythonRunner.js.
#
# The pipeline half is CHEAP to carry: app/pipeline is pure stdlib by design, so
# the scripts need python3 and the source and nothing else - no pip, no venv, no
# wheels. The root .dockerignore keeps the wider context from costing anything.

# ---- deps: compile native modules (better-sqlite3) against this exact base ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY backend/package*.json ./
RUN npm ci --omit=dev

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
# python3 is a RUNTIME dependency here, not just a build one: the deps stage
# installs it to compile better-sqlite3 and that stage is discarded.
# Debian bookworm ships 3.11 and pyproject declares requires-python >= 3.11.
RUN apt-get update && apt-get install -y --no-install-recommends curl python3 \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
# node_modules (with the compiled better-sqlite3 .node binary) from the deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY backend/ ./

# The Python half, laid out so each script's sys.path.insert(parents[1]) finds
# `app`. Only app/pipeline is copied: that is all the four scripts import, and
# the rest of the package (FastAPI, the clients, storeagent) would drag in
# dependencies this image deliberately does not install.
COPY Botella_External_APIs/app/__init__.py /opt/pipeline/app/__init__.py
COPY Botella_External_APIs/app/pipeline    /opt/pipeline/app/pipeline
COPY Botella_External_APIs/scripts         /opt/pipeline/scripts
ENV PYTHON_BIN=/usr/bin/python3 \
    PYTHON_SCRIPTS_DIR=/opt/pipeline/scripts

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:3000/api/health || exit 1
CMD ["node", "server.js"]
