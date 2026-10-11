# Vultr deployment scaffold

The compose file runs the three Python services on the same private Docker
network:

- `rail-service`: authoritative SCDOT/OSM scene on `8000`;
- `acoustic-service`: microphone-only GCC-PHAT/Kalman inference on `8001`;
- `user-service`: canonical estimate stream, crossing alerts, voice, and
  optional Tiger Data persistence on `8002`.

On a Vultr VM with Docker installed:

```bash
cp deploy/.env.example deploy/.env
# edit deploy/.env, especially INTERNAL_API_TOKEN
docker compose --env-file deploy/.env up --build -d
docker compose ps
curl http://127.0.0.1:8002/health
```

The frontend processes can run on the VM or locally with their API URLs set to
the VM address. Put a TLS reverse proxy in front of the exposed services before
opening them to the public internet; keep the internal token private.

For local development, use `../scripts/dev.sh` instead of Compose. It starts
both Next.js frontends as well as these three Python services. Once it is
running, `../scripts/e2e_smoke.py` validates the live acoustic estimate and
reset path.
