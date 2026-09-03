# Build context is the repository root so that /ml can be copied in.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 curl \
    && rm -rf /var/lib/apt/lists/*

# The lock file rather than requirements.txt, on purpose. This image controls
# its own interpreter (3.12 above), which is the one case where exact pins are
# the right choice: the training step below reproduces the model and the figures
# in docs/ML.md, and it can only do that against the versions those figures were
# measured with. The psycopg driver is added separately so it cannot pull the
# pinned packages forward.
COPY backend/requirements-lock.txt ./backend/
RUN pip install --upgrade pip \
    && pip install -r backend/requirements-lock.txt \
    && pip install "psycopg[binary]>=3.2,<4"

COPY ml ./ml
COPY backend ./backend
COPY database ./database

# Train the model at image build time so the container starts warm.
RUN python ml/train_model.py --rows 24000 --quiet

RUN mkdir -p backend/uploads
EXPOSE 8000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8000/api/health || exit 1

WORKDIR /app/backend
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
