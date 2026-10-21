# syntax=docker/dockerfile:1
FROM python:3.12-slim AS base

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install dependencies in their own layer (keyed only on pyproject.toml) so a
# code change doesn't re-resolve and re-install every dependency.
COPY pyproject.toml ./
RUN pip install --upgrade pip \
    && python -c "import tomllib; print('\n'.join(tomllib.load(open('pyproject.toml','rb'))['project']['dependencies']))" > /tmp/requirements.txt \
    && pip install -r /tmp/requirements.txt

# Now copy the source and install the package itself without re-touching deps.
COPY app ./app
# StoreAgent is a separate, self-contained module that ships alongside `app`.
COPY storeagent ./storeagent
# Diagnostic probe: exercise every external signal source from wherever the
# image runs (docker compose exec api python probe_external_apis.py) — the
# fastest way to tell an IP-level upstream block from a code problem.
COPY probe_external_apis.py ./probe_external_apis.py
# The pipeline's command-line jobs: the gate's statistics, the calibration refit
# and the weekly signal-effect fit. Left out of the image until now, so anyone
# running them inside this container got "No such file or directory" - and the
# container is the only place a deployed box has a Python interpreter with the
# package installed. They import only app.pipeline, which is pure stdlib.
COPY scripts ./scripts
RUN pip install --no-deps .

# Run as a non-root user.
RUN useradd --create-home --uid 10001 appuser
USER appuser

EXPOSE 8000

# Honor the platform's $PORT if provided (e.g. Cloud Run / Heroku), else 8000.
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers ${WEB_CONCURRENCY:-2}"]
