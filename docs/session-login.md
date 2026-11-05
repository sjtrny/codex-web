# Website session login

Use a normal sign-in form and a persistent cookie instead of browser password
challenges. This optional service sits in front of an existing Basic Auth
gateway. The browser uses the same cookie for page requests and WebSocket
reconnects, including in Safari.

This is a shared website login. It does not sign in to OpenAI, create a separate
workspace for each person, or change the app-server account.

## How requests flow

```text
Browser → HTTPS reverse proxy → existing Basic Auth gateway → Codex Web
                   ↓
             session login
```

The proxy sends login, logout, session-info and login-stylesheet requests to the
session service. For application requests, it asks the private `/internal/verify`
endpoint to validate the cookie. A successful check supplies the existing Basic
credential to the gateway. The gateway still checks that credential and removes
it before forwarding the request to Codex Web.

The session cookie is Secure, HttpOnly, SameSite=Lax and host-only, with a 30-day
lifetime. The database stores hashes of random session tokens. A stable local
secret keeps sessions valid after a service restart. A changed website password
invalidates existing sessions. Valid cached Basic credentials migrate to a cookie
automatically, so existing desktop tabs and API clients can continue to connect.
Invalid credentials never produce a native browser password challenge.

## Add the service

The [Compose example](../examples/session-login/compose.yaml) runs the service as
a separate project on an existing private proxy network. It does not publish a
port. The instructions below assume an existing Traefik HTTPS entry point and a
Basic Auth gateway. The [Caddy example](../examples/session-login/gateway.Caddyfile)
shows the expected gateway behavior; keep the existing equivalent configuration.

1. Copy [`.env.example`](../examples/session-login/.env.example) to
   `examples/session-login/.env`. Set the same username/password as the existing
   gateway, the exact HTTPS origin, the private Docker network, and an absolute
   state directory. Quote passwords in the environment file when required by
   Docker Compose. Keep the file private.
2. Create the state directory on the Docker host for UID/GID 1000:

   ```sh
   sudo install -d -m 0700 -o 1000 -g 1000 /srv/codex-session-login/state
   chmod 600 examples/session-login/.env
   ```

3. From the repository root, build and start only the session service:

   ```sh
   docker compose --project-name codex-session-login \
     --env-file examples/session-login/.env \
     -f examples/session-login/compose.yaml build auth
   docker compose --project-name codex-session-login \
     --env-file examples/session-login/.env \
     -f examples/session-login/compose.yaml up -d --no-build auth
   ```

4. Copy [the Traefik example](../examples/session-login/traefik.yaml) to a temporary
   file outside Traefik's watched configuration directory. Replace
   `codex.example.com`, the TLS certificate resolver, the HTTPS entry-point name,
   and the gateway address with your existing values. Keep both route priorities
   above the old application route. The auth service's network alias is
   `codex-session-login`.
5. Check the auth service's health and the prepared proxy configuration. Then move
   the complete routing file atomically into the watched directory. Traefik's
   file provider updates the routes without restarting the application stack.
   Refresh the browser once. Cancel an already-open native password prompt first.

The explicit Compose project name keeps this service separate from the original
application's deployment. Deploying the original project with `--remove-orphans`
must not remove the session service.

## Proxy requirements

Only the HTTPS proxy may access the private verification endpoint. Do not expose
`/internal/verify` or `/auth/check` through a public route, or publish the auth
container's port. The verification response contains an upstream credential.

The example exposes only `/login`, `/logout`, `/auth/session` and `/auth/login.css`
from the auth service. It removes `Authorization` and `WWW-Authenticate` from
public responses, copies the session cookie from successful auth checks, and
overwrites forwarded request metadata. WebSocket requests and writes require
the exact configured Origin. The existing gateway also checks Origin and removes
Authorization before forwarding to Codex Web.

Keep the auth service, gateway and Codex Web on a trusted private network. Do not
allow a second public route to bypass the authentication checks. Keep the proxy's
default rejection of untrusted forwarded headers. Do not enable request-body or
credential-header logging. Login passwords, session cookies and upstream
Authorization headers must remain private.

The configuration uses Traefik's
[ForwardAuth options](https://doc.traefik.io/traefik/v3.6/reference/routing-configuration/http/middlewares/forwardauth/)
and Caddy's
[request-header controls](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#headers).

## State and account changes

Keep both `session-secret` and `sessions.sqlite3` in the state directory when
updating the service, and include them in private backups. Do not generate a new
secret during a normal update. The files are created with mode 0600.

After changing the gateway password, change `CODEX_WEB_LOGIN_PASSWORD` to match
and recreate only the auth service with the same Compose command. Existing
cookies will require sign-in again. To sign out a browser, use the `csrfToken`
returned by `/auth/session` in a same-origin form POST to `/logout`; the session
is revoked and the cookie is cleared.

To remove this integration, move only its routing file outside Traefik's watched
directory. Keep the original Basic Auth route available as the fallback.
This returns new requests to the old website login without changing the
app-server or deleting conversations.

## Development checks

The ordinary Python suite includes the session and bridge checks. The isolated
proxy check builds the current checkout and starts a synthetic backend, Caddy
2.11.2 and Traefik 3.6.7 in a disposable Docker network:

```sh
python3 -m unittest discover --start-directory tests --pattern 'test_session*.py'
python3 tests/session_login_integration.py
```

It checks form login, cookie-only WebSocket reconnects, cached Basic credential
migration, forbidden origins, CSRF, private endpoint protection, credential
removal, uploads, logout and an open WebSocket across route replacement. It uses
synthetic credentials and does not connect to a real Codex backend.
