# syntax=docker/dockerfile:1

# ---- build the static bundle ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# CRA bakes env vars at BUILD time. Same-origin behind nginx => "/api".
# The app reads REACT_APP_API_URL both directly (`${API_BASE}/x`) and with the
# trailing /api stripped (`${base}/api/x`); "/api" satisfies both.
ARG REACT_APP_API_URL=/api
ENV REACT_APP_API_URL=$REACT_APP_API_URL

# Which environment this bundle is for: "qa", "staging", or "production".
# The two internal environments unlock the tester-facing tools - the per-figure
# "show the query" control, which prints raw warehouse SQL and must never reach
# a store owner, and the Generate Insights button. DEFAULTS TO PRODUCTION, so a
# build that forgets to pass this gets the safe bundle, not the leaky one.
ARG REACT_APP_ENV=production
ENV REACT_APP_ENV=$REACT_APP_ENV

# Card Statement Analysis rollout switch (src/utils/features.js): "true" shows
# the screen in this bundle, "false" hides it, and empty (the default) follows
# REACT_APP_ENV: shown in qa and staging, hidden in production. CI passes the
# SHOW_CARD_STATEMENTS CI/CD variable here, so the rollout is a variable, not
# a code change.
ARG REACT_APP_SHOW_CARD_STATEMENTS=
ENV REACT_APP_SHOW_CARD_STATEMENTS=$REACT_APP_SHOW_CARD_STATEMENTS
# REACT_APP_DEMO_STORE_NAME: when set, every surface that names the store
# (greeting, sidebar, titles - see utils/storeIdentity.displayStoreName) shows
# this instead of the real business name. Empty (the default, and what CI
# passes for production) keeps the real name. The QA compose sets it, so a
# prospect watching QA is never shown a pilot store's name.
ARG REACT_APP_DEMO_STORE_NAME=
ENV REACT_APP_DEMO_STORE_NAME=$REACT_APP_DEMO_STORE_NAME

COPY package*.json ./
RUN npm ci
COPY . .
# CRA treats lint warnings as errors when CI=true; keep the prod build resilient.
ENV CI=false
RUN npm run build

# ---- serve with nginx ----
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/build /usr/share/nginx/html
EXPOSE 80
