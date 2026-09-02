# Clypso captioning service.
#
# Build from the repo root so the context stays small:
#   docker build -f server/captioning/Dockerfile -t clypso-captioning server/captioning
#
# CPU-only. faster-whisper runs int8 on CPU and float16 on CUDA, and picking the
# CUDA path up means a different base image (nvidia/cuda runtime) plus the
# torch wheel that matches it — deliberately not done here, because the service
# also has to run somewhere ordinary.
FROM python:3.11-slim

# ffmpeg AND ffprobe: the caption burn shells out to both, and a missing
# ffprobe fails late, mid-request, rather than at startup.
RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so a source-only change does not reinstall torch-sized
# wheels on every build.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY captions.py main.py ./

# Where faster-whisper caches the model it downloads on first use. Named as a
# volume so a container restart does not re-download it.
ENV HF_HOME=/models
VOLUME ["/models"]

ENV WHISPER_MODEL=base \
    WORK_DIR=/tmp \
    PORT=8787

# Runs as a non-root user; WORK_DIR and the model cache are the only paths
# written to, and both are given to it explicitly.
RUN useradd --create-home --uid 10001 clypso \
    && mkdir -p /models \
    && chown -R clypso:clypso /models
USER clypso

EXPOSE 8787

# The model loads lazily on the first request, so a cold container answers
# /styles immediately and that is what the healthcheck asks for.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,os; urllib.request.urlopen('http://127.0.0.1:' + os.environ['PORT'] + '/styles').read()"

CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT}"]
