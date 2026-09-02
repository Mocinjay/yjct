# Clypso climax scorer.
#
# This is a batch CLI, not a service — there is no server to deploy, and the
# image exists so a run is reproducible rather than so it can be hosted. The
# pins in requirements.txt are there to keep feature values bit-identical
# across machines, and a fixed base image is the rest of that promise.
#
#   docker build -t clypso-climax server/climax
#   docker run --rm -v "$PWD:/data" clypso-climax /data/clip.mp4 -o /data/out.mp4
FROM python:3.11-slim

# ffmpeg is a hard requirement (see requirements.txt), and opencv and librosa
# both need libgl/libsndfile at runtime — the slim base has neither, and the
# failure is an ImportError deep into a run that has already spent minutes
# decoding.
RUN apt-get update \
    && apt-get install --no-install-recommends -y \
        ffmpeg \
        libgl1 \
        libglib2.0-0 \
        libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py ./

ENV HF_HOME=/models
VOLUME ["/models"]

ENV WHISPER_MODEL=base

RUN useradd --create-home --uid 10001 clypso \
    && mkdir -p /models /data \
    && chown -R clypso:clypso /models /data
USER clypso

WORKDIR /data
ENTRYPOINT ["python", "/app/main.py"]
CMD ["--help"]
