from __future__ import annotations

import threading
import unittest
import urllib.error
import urllib.request

from app import create_server


class AppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.server = create_server(host="127.0.0.1", port=0)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.origin = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_health(self) -> None:
        with urllib.request.urlopen(f"{self.origin}/health", timeout=2) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"ok\n")

    def test_home(self) -> None:
        with urllib.request.urlopen(f"{self.origin}/", timeout=2) as response:
            body = response.read().decode("utf-8")
        self.assertIn("部署底座已就绪", body)

    def test_not_found(self) -> None:
        try:
            urllib.request.urlopen(f"{self.origin}/missing", timeout=2)
        except urllib.error.HTTPError as error:
            self.assertEqual(error.code, 404)
            error.close()
        else:
            self.fail("missing path unexpectedly returned success")
