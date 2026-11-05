"""Check the documented proxy route with synthetic credentials in Docker."""

import argparse
import json
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples/session-login"
CADDY_IMAGE = "caddy:2.11.2-alpine"
TRAEFIK_IMAGE = "traefik:v3.6.7"

BACKEND = '''from aiohttp import web
async def handler(r):
    if r.path == '/ws':
        ws=web.WebSocketResponse(); await ws.prepare(r)
        async for msg in ws:
            if msg.type==web.WSMsgType.TEXT: await ws.send_str(msg.data)
        return ws
    if r.path not in ('/','/healthz','/upload'): return web.Response(status=404)
    body=await r.read()
    return web.json_response({'ok':True,'authorization_reached_backend':bool(r.headers.get('Authorization')),'body_bytes':len(body)})
app=web.Application(client_max_size=2*1024*1024); app.router.add_route('*','/{path:.*}',handler)
web.run_app(app,port=8000,access_log=None)
'''


def run(*args, **kwargs):
    return subprocess.run(
        ["docker", *args], text=True, capture_output=True, check=True,
        **kwargs,
    ).stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", help="Use an already built image instead of building")
    args = parser.parse_args()
    image = args.image or "codex-web:session-login-check"
    network = "session-login-check-" + uuid.uuid4().hex[:10]
    names = []

    def create(role, *options):
        name = network + "-" + role
        names.append(name)
        run("create", "--name", name, "--network", network, *options)
        return name

    try:
        if not args.image:
            run("build", "-t", image, str(ROOT), timeout=300)
        run("network", "create", network)
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            password_hash = run(
                "run", "--rm", CADDY_IMAGE,
                "caddy", "hash-password", "--plaintext", "fixture-password",
            )
            backend = create(
                "backend", "--network-alias", "codex-web", "--entrypoint",
                "python", image, "-c", BACKEND,
            )
            run("start", backend)
            gateway = create(
                "gateway", "--network-alias", "codex-gateway",
                "-e", "CODEX_WEB_LOGIN_USERNAME=team",
                "-e", "CODEX_WEB_LOGIN_PASSWORD_HASH=" + password_hash,
                CADDY_IMAGE, "caddy", "run", "--config", "/etc/caddy/Caddyfile",
            )
            run("cp", str(EXAMPLES / "gateway.Caddyfile"), gateway + ":/etc/caddy/Caddyfile")
            run("start", gateway)
            auth = create(
                "auth", "--network-alias", "codex-session-login", "--read-only",
                "--tmpfs", "/state:uid=1000,gid=1000,mode=700", "--tmpfs", "/tmp",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
                "-e", "CODEX_WEB_LOGIN_USERNAME=team",
                "-e", "CODEX_WEB_LOGIN_PASSWORD=fixture-password",
                "-e", "CODEX_WEB_LOGIN_ORIGIN=https://codex.example.com",
                image, "python", "session_bridge.py",
            )
            run("start", auth)
            original = {"http": {
                "routers": {"original": {
                    "rule": "Host(`codex.example.com`)",
                    "entryPoints": ["websecure"], "tls": {}, "service": "original",
                }},
                "services": {"original": {"loadBalancer": {"servers": [
                    {"url": "http://codex-gateway:8080"},
                ]}}},
            }}
            (temporary / "old.yaml").write_text(json.dumps(original))
            edge = create(
                "edge", "--network-alias", "session-login-edge", TRAEFIK_IMAGE,
                "--providers.file.directory=/etc/traefik", "--providers.file.watch=true",
                "--entrypoints.websecure.address=:8443", "--log.level=ERROR",
            )
            run("cp", str(temporary), edge + ":/etc/traefik")
            run("start", edge)
            probe = create("probe", "--entrypoint", "python", image, "/probe.py")
            run("cp", str(ROOT / "tests/session_login_probe.py"), probe + ":/probe.py")
            run("start", probe)
            for _ in range(100):
                ready = subprocess.run(
                    ["docker", "exec", probe, "test", "-f", "/tmp/connection-ready"],
                    capture_output=True,
                )
                if ready.returncode == 0:
                    break
                time.sleep(.15)
            else:
                raise RuntimeError("Original WebSocket was not ready")
            replacement = (EXAMPLES / "traefik.yaml").read_text().replace(
                "tls:\n        certResolver: letsencrypt", "tls: {}",
            )
            replacement_path = temporary / "new.tmp"
            replacement_path.write_text(replacement)
            run("cp", str(replacement_path), edge + ":/etc/traefik/new.tmp")
            run("exec", edge, "mv", "/etc/traefik/new.tmp", "/etc/traefik/overlay.yaml")
            run("exec", probe, "touch", "/tmp/config-switched")
            code = run("wait", probe, timeout=55)
            logs = run("logs", probe)
            if code != "0":
                raise RuntimeError("Proxy checks failed: " + logs)
            print(logs)
    except Exception:
        for name in names:
            result = subprocess.run(
                ["docker", "logs", "--tail", "15", name], capture_output=True, text=True,
            )
            print(name, (result.stdout + result.stderr)[-2200:])
        raise
    finally:
        for name in reversed(names):
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
        subprocess.run(["docker", "network", "rm", network], capture_output=True)


if __name__ == "__main__":
    main()
