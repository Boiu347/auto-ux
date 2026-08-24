FROM python:3.12-slim

WORKDIR /app
COPY --chown=10001:10001 app.py /app/app.py

USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=6 \
  CMD ["python3", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=2).read()"]

CMD ["python3", "/app/app.py"]
