# Build the policy engine

Build from the pinned upstream source and apply the supplied patch. These
instructions describe a Linux x86-64 GNU build. Use the upstream build guidance
for other targets. The web application image does not contain this engine.

## Prepare the source

Start in the root of this Codex Web checkout:

```bash
policy_dir="$PWD/patches/model-policy"
cd "$policy_dir"
sha256sum --check SHA256SUMS
cd ../..
git clone --depth 1 --branch rust-v0.159.1 \
  https://github.com/openai/codex.git ../codex-policy-source
cd ../codex-policy-source
test "$(git rev-parse HEAD)" = 8e68a98ef03cdde76d2e6800791ebdf1b3b95b24
git apply --check "$policy_dir/model-policy.patch"
git apply "$policy_dir/model-policy.patch"
```

Stop if the revision check or patch application fails. Use this source revision
instead of applying the patch to the latest Codex release.

The repository pins Rust 1.95.0. Install Rust through rustup and the upstream
Linux build prerequisites, including a C/C++ toolchain, Perl, pkg-config and
native development headers. Use a machine with enough memory and disk for the
Codex release build; adjust parallel jobs for the build host.

The tag's Cargo.lock records workspace packages at `0.0.0`, while its manifest
uses `0.159.1`. Cargo normalizes those local versions on the first build. Those
local-version changes are not part of this patch, and no third-party dependency
version was changed for the policy implementation.

## Build OpenSSL

The example build statically links OpenSSL so it does not depend on the target
environment's OpenSSL shared libraries. It uses the source already pinned in
upstream Cargo.lock:

- Cargo package: `openssl-src` `300.6.1+3.6.3`
- Crate archive SHA256:
  `46eb8fb9fb3b61ce1c0f8a026c4c1a0714d3a9e138e7fbde78753ce2babc3846`
- OpenSSL version: `3.6.3`

Fetch the locked sources from the Codex checkout:

```bash
cd codex-rs
cargo fetch
```

The OpenSSL source is in the fetched `openssl-src-300.6.1+3.6.3/openssl`
directory, normally under `~/.cargo/registry/src/<registry>/`. Build from a
separate directory. Replace the three absolute paths below with your paths:

```bash
mkdir -p /absolute/path/to/openssl-build
cd /absolute/path/to/openssl-build
perl /absolute/path/to/openssl-src-300.6.1+3.6.3/openssl/Configure \
  --prefix=/absolute/path/to/openssl-static \
  --openssldir=/etc/ssl --libdir=lib no-shared no-tests no-module
make -j 8
make install_sw
```

## Build Codex

Return to `codex-policy-source/codex-rs`, then run:

```bash
OPENSSL_DIR=/absolute/path/to/openssl-static OPENSSL_STATIC=1 \
  cargo build -p codex-cli --bin codex --release \
  --config profile.release.lto=false \
  --config profile.release.codegen-units=16 \
  --config profile.release.strip=true -j 8
```

The output is `target/release/codex`. It reports `codex-cli 0.159.1`; the
version string does not distinguish this custom build from the stock release.
Record the patch, upstream commit, build settings and binary checksum together.
Different build environments can produce different binary checksums.

```bash
target/release/codex --version
ldd target/release/codex
sha256sum target/release/codex
```

This build should have no dynamic dependency on `libssl` or `libcrypto`. It
still needs the Linux loader, glibc, libgcc and liblzma from a compatible
runtime. Check it in your target environment before replacing a running
backend. Use the intended runtime account and a temporary Codex home for an
isolated startup check.

Install the binary at a location of your choice, make it executable by the
runtime user, and [run the backend](README.md#run-the-backend) with the policy
environment. Apply the binary and environment through your normal deployment
or process-management workflow.

## Development checks

The patch includes API unit tests and a public app-server integration test.
Use the upstream `just` commands from `codex-rs` with the required nextest and
helper tools installed:

```bash
just test -p codex-api
just test -p codex-model-provider -p codex-app-server
just fix -p codex-api -p codex-model-provider -p codex-app-server
just fmt
```

The app-server suite also depends on sandbox namespaces and generated helper
binaries. Review failures individually when the build environment lacks those
prerequisites. Codex Web's normal Python and frontend CI does not run these
native tests or build the patched engine.
