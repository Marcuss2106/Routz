# Vultr deployment scaffold

The compose file runs the three Python services on the same private Docker
network plus a Caddy TLS front door:

- `rail-service`: authoritative SCDOT/OSM scene on `8000`;
- `acoustic-service`: microphone-only GCC-PHAT/Kalman inference on `8001`;
- `user-service`: canonical estimate stream, crossing alerts, voice, and
  optional Tiger Data persistence on `8002`.
- `caddy`: terminates `https://`/`wss://` on ports `80`/`443` using
  `deploy/Caddyfile` and reverse-proxies to the three services above.

## Public HTTPS setup (required for Vercel-hosted frontends)

Browsers block `http://`/`ws://` from an `https://` page, so the VM must
serve TLS. Do this once:

```bash
# 1. DuckDNS: point all three names at the VM IP (three names are required
#    because rail :8000 and acoustic :8001 both serve /ws/simulation).
#    routz-rail.duckdns.org     -> <VM IP>
#    routz-user.duckdns.org     -> <VM IP>
#    routz-acoustic.duckdns.org -> <VM IP>

# 2. Firewall: allow 80 + 443 (plus 22 for SSH).
sudo ufw allow 80,443/tcp

# 3. Configure secrets + the user-map frontend origin.
cp deploy/.env.example deploy/.env
# edit deploy/.env: set INTERNAL_API_TOKEN and the user map's Vercel origin:
# USER_ALLOWED_ORIGINS=http://localhost:3000,https://<your-app>.vercel.app
# Keep DEPLOYED_SIMULATION_ALLOWED_ORIGINS=* for the public rail/acoustic demo.
# RAIL_DOMAIN / USER_DOMAIN / ACOUSTIC_DOMAIN default to the DuckDNS names above.

# 4. Start everything (Caddy issues Let's Encrypt certs automatically).
docker compose --env-file deploy/.env up --build --force-recreate -d
docker compose ps
curl https://routz-rail.duckdns.org/health
curl https://routz-user.duckdns.org/health
curl https://routz-acoustic.duckdns.org/health
```

`--force-recreate` is required after proxy changes. It prevents Caddy from
continuing to serve dynamically-loaded stale CORS headers from its old process.
Rail/acoustic responses intentionally do not use browser credentials.

The 3D simulation frontend no longer hard-requires the rail WebSocket: it polls
`GET /api/train` (1 Hz) and drives play/pause/restart/speed through
`POST /api/command` whenever `wss://` is blocked (content blocker, proxy, or
stalled TLS). The socket remains the low-latency path when it connects. After
pulling backend changes, rebuild the VM image (`up --build -d rail-service`).

Then set the Vercel env vars (`NEXT_PUBLIC_*` is compiled in at build time,
so you must Redeploy after changing them):

```text
NEXT_PUBLIC_SIMULATION_API_URL=https://routz-rail.duckdns.org
NEXT_PUBLIC_SIMULATION_WS_URL=wss://routz-rail.duckdns.org/ws/simulation
NEXT_PUBLIC_AUDIO_WS_URL=wss://routz-acoustic.duckdns.org/ws/simulation
NEXT_PUBLIC_USER_API_URL=https://routz-user.duckdns.org (or NEXT_PUBLIC_ROUTZ_API_URL)
NEXT_PUBLIC_USER_WS_URL=wss://routz-user.duckdns.org/ws/updates (or NEXT_PUBLIC_ROUTZ_WS_URL)
```

If `wss://routz-rail.duckdns.org/ws/simulation` still fails in Firefox:

- `curl` the three `/health` URLs above. Failure = DNS / firewall / Caddy cert issue.
- `curl` works but socket fails = ad-blocker or stale Vercel build (check the
  compiled `NEXT_PUBLIC_*` values).
- If REST fails only inside a browser, check that the response has exactly one
  `Access-Control-Allow-Origin: *` header and no
  `Access-Control-Allow-Credentials` header. Recreate Caddy if stale headers
  remain.

Keep the internal token private; the raw `8000`/`8001`/`8002` host ports are
HTTP-only fallbacks for local debugging, never for `https://` pages.

For local development, use `../scripts/dev.sh` instead of Compose. It starts
both Next.js frontends as well as these three Python services. Once it is
running, `../scripts/e2e_smoke.py` validates the live acoustic estimate and
reset path.
