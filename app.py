from __future__ import annotations

import html
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


PAGE = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>auto-ux</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f7fb; color: #152033; }
    main { width: min(640px, calc(100% - 48px)); padding: 40px; border: 1px solid #dce4ee; border-radius: 20px; background: white; box-shadow: 0 16px 48px rgba(30, 55, 90, .08); }
    h1 { margin: 0 0 12px; font-size: 32px; }
    p { margin: 8px 0; line-height: 1.7; color: #506078; }
    strong { color: #13735b; }
  </style>
</head>
<body>
  <main>
    <h1>auto-ux</h1>
    <p><strong>部署底座已就绪。</strong></p>
    <p>自动化调研进度网站的业务页面可以从这个最小服务继续开发。</p>
  </main>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    server_version = "auto-ux"
    sys_version = ""

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._respond(200, b"ok\n", "text/plain; charset=utf-8")
            return
        if path == "/":
            self._respond(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")
            return
        self._respond(
            404,
            f"not found: {html.escape(path)}\n".encode("utf-8"),
            "text/plain; charset=utf-8",
        )

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")

    def _respond(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)


def create_server(host: str = "0.0.0.0", port: int = 8080) -> ThreadingHTTPServer:
    return ThreadingHTTPServer((host, port), Handler)


if __name__ == "__main__":
    listen_port = int(os.environ.get("PORT", "8080"))
    create_server(port=listen_port).serve_forever()
