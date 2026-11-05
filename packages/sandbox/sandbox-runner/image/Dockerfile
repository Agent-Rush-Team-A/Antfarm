FROM python:3.11-slim@sha256:0dd364ba7e10242f07755449e3a3d0e35f9efd987952737b90def6709ab0c5ce

COPY --chown=0:0 --chmod=0444 assets/supervisor.py /opt/agentrush/sandbox-runner/supervisor.py
RUN chmod 0555 /opt/agentrush /opt/agentrush/sandbox-runner \
    && test -x /usr/local/bin/python3 && test -x /bin/bash && test -x /usr/bin/sleep

USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/sleep"]
CMD ["infinity"]
