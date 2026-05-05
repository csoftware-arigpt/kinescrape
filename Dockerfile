FROM python:3.13-slim AS bento4

ARG BENTO4_VERSION=1-6-0-641
ARG BENTO4_PLATFORM=x86_64-unknown-linux

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl unzip; \
    curl -fsSL "https://www.bok.net/Bento4/binaries/Bento4-SDK-${BENTO4_VERSION}.${BENTO4_PLATFORM}.zip" -o /tmp/bento4.zip; \
    unzip -q /tmp/bento4.zip -d /opt; \
    install -m 0755 "/opt/Bento4-SDK-${BENTO4_VERSION}.${BENTO4_PLATFORM}/bin/mp4decrypt" /mp4decrypt

FROM python:3.13-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/nonexistent \
    TMPDIR=/tmp \
    VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:/usr/local/bin:/usr/bin:/bin \
    MP4DECRYPT_PATH=/usr/local/bin/mp4decrypt

WORKDIR /app

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates ffmpeg; \
    rm -rf /var/lib/apt/lists/*; \
    python -m venv "$VIRTUAL_ENV"; \
    sed -i 's#^\(root:[^:]*:[^:]*:[^:]*:[^:]*:[^:]*:\).*#\1/usr/sbin/nologin#' /etc/passwd; \
    printf 'app:x:10001:10001:Kinescrape app:/nonexistent:/usr/sbin/nologin\n' >> /etc/passwd; \
    printf 'app:x:10001:\n' >> /etc/group

COPY requirements.txt .
RUN set -eux; \
    pip install --no-cache-dir -r requirements.txt; \
    python -m pip uninstall -y pip setuptools wheel || true; \
    find "$VIRTUAL_ENV" -type d -name '__pycache__' -prune -exec rm -rf '{}' +; \
    rm -rf /root/.cache /tmp/* /var/tmp/*

COPY --from=bento4 /mp4decrypt /usr/local/bin/mp4decrypt
COPY --chown=10001:10001 kinescrape ./kinescrape
COPY --chown=10001:10001 web ./web
COPY --chown=10001:10001 web_server.py .

RUN set -eux; \
    rm -f /bin/sh /usr/bin/sh /bin/dash /usr/bin/dash /bin/bash /usr/bin/bash; \
    rm -f /bin/su /usr/bin/su /bin/login /usr/bin/login /usr/bin/passwd /usr/bin/chsh /usr/bin/chfn; \
    rm -f /usr/bin/apt /usr/bin/apt-get /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-query; \
    find /app -type d -exec chmod 0555 '{}' +; \
    find /app -type f -exec chmod 0444 '{}' +; \
    chmod 0555 /app /app/kinescrape /app/web; \
    chmod 0555 /usr/local/bin/mp4decrypt

USER 10001:10001
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).read()"]

CMD ["python", "web_server.py", "--host", "0.0.0.0", "--port", "8000"]
