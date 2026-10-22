"""Check real HTTP delivery, cache boundaries and production asset references."""

import gzip
import hashlib
import re
import sys
import unittest
from pathlib import Path

from aiohttp import ClientSession
from aiohttp.test_utils import TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app


class StaticAssetTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.server = TestServer(app.create_app())
        await self.server.start_server()
        self.addAsyncCleanup(self.server.close)
        self.client = ClientSession(auto_decompress=False)
        self.addAsyncCleanup(self.client.close)

    async def test_page_and_assets_negotiate_compression_and_versioned_cache(self):
        async with self.client.get(self.server.make_url("/"), headers={"Accept-Encoding": "gzip"}) as response:
            html = gzip.decompress(await response.read()).decode()
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            self.assertEqual(response.headers["Vary"], "Accept-Encoding")
        urls = set(re.findall(r'/static/vendor/[\w-]+\.(?:js|css)', html))
        self.assertEqual(len(urls), 6)
        compressed_total = 0
        for url in sorted(urls):
            digest = re.search(r'-([0-9a-f]{16})\.', url).group(1)
            raw = (app.STATIC / url.removeprefix("/static/")).read_bytes()
            self.assertEqual(hashlib.sha256(raw).hexdigest()[:16], digest)
            for encoding in ("identity", "gzip", "br"):
                async with self.client.get(self.server.make_url(url), headers={"Accept-Encoding": encoding}) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers["Cache-Control"], "public, max-age=31536000, immutable")
                    self.assertEqual(response.headers["Vary"], "Accept-Encoding")
                    self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
                    body, etag = await response.read(), response.headers["ETag"]
                    if encoding == "identity":
                        self.assertEqual(body, raw)
                        self.assertNotIn("Content-Encoding", response.headers)
                    else:
                        self.assertEqual(response.headers["Content-Encoding"], encoding)
                        suffix = ".gz" if encoding == "gzip" else ".br"
                        self.assertEqual(body, (app.STATIC / (url.removeprefix("/static/") + suffix)).read_bytes())
                    if encoding == "gzip":
                        self.assertEqual(gzip.decompress(body), raw)
                        if "/math-" not in url:
                            compressed_total += len(body)
                async with self.client.get(self.server.make_url(url), headers={
                    "Accept-Encoding": encoding, "If-None-Match": etag,
                }) as response:
                    self.assertEqual(response.status, 304)
                    self.assertEqual(await response.read(), b"")
                    self.assertIn("immutable", response.headers["Cache-Control"])
                    self.assertEqual(response.headers["Vary"], "Accept-Encoding")
        self.assertLess(compressed_total, 80000, "Initial gzip asset budget exceeded")

    async def test_unversioned_and_private_responses_cannot_be_cached_immutably(self):
        for url, policy in (("/", "no-store"), ("/api/config", "no-store"),
                            ("/service-worker.js", "no-store"),
                            ("/static/app.js", "no-cache"), ("/static/index.html", "no-cache"),
                            ("/static/vendor/missing-0000000000000000.js", "no-store"),
                            ("/api/files", "no-store")):
            async with self.client.get(self.server.make_url(url)) as response:
                self.assertEqual(response.headers["Cache-Control"], policy, url)


if __name__ == "__main__":
    unittest.main()
