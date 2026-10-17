# Container release and vulnerability verification

On 2026-10-17 the container pins were checked against the upstream Docker Official Images manifest. Compatible maintained releases replaced the initial bootstrap versions:

| Component | Pinned image | Official source |
| --- | --- | --- |
| PostgreSQL | `postgres:17.11-alpine3.24` plus rebuilt gosu | [Manifest](https://github.com/docker-library/official-images/blob/master/library/postgres) |
| Redis | `redis:7.4.11-alpine` | [Manifest](https://github.com/docker-library/official-images/blob/master/library/redis) |
| Caddy | `caddy:2.11.7-alpine` | [Manifest](https://github.com/docker-library/official-images/blob/master/library/caddy) |
| nginx | `nginx:1.30.6-alpine` | [Manifest](https://github.com/docker-library/official-images/blob/master/library/nginx) |
| Python | `python:3.12.15-alpine3.24` | [Manifest](https://github.com/docker-library/official-images/blob/master/library/python) |
| Node (build only) | `node:24.22.0-bookworm-slim` | [Manifest](https://github.com/docker-library/official-images/blob/master/library/node) |

Run `python3 scripts/scan_images.py` on the Linux ARM64 deployment host after building the app images. It uses the pinned Trivy 0.76.0 scanner, records exact image IDs/digests, and includes unfixed findings. The scanner's complete reports are in `evidence/container-scans/` and its counts are in `evidence/container-security.json`. A successful process exit means the scan completed; it does not imply zero findings. Review both fixable and unfixed HIGH/CRITICAL entries before release. Package-level `npm audit` and `pip-audit` evidence is separate and does not substitute for this image scan.

The initial scan found inherited Debian Bookworm critical findings, two fixable Redis OpenSSL findings, four fixable Caddy Go/HTTP2 dependency findings, and old Go dependencies in PostgreSQL's bundled gosu binary. The runtime therefore uses Alpine3.24 for Python/PostgreSQL; the locked native Python dependencies have ARM64 musllinux wheels. The Redis build updates its Alpine packages. The Caddy build uses Go1.27.2 and x/net0.60.0 with Caddy2.11.7, and PostgreSQL's gosu1.19 is rebuilt with Go1.27.2. These changes are explicit Dockerfiles, not runtime container modifications.

The unmodified Python3.12.15 Alpine and nginx1.30.6 Alpine base scans had zero HIGH/CRITICAL findings. Final app and patched service image scans remain separate evidence. Runtime changes require actual container smoke and simulation verification; the final deployment evidence records their results.
