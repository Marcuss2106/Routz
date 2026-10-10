# Routz

The current first-stage deliverable is a working 3D railroad simulation around downtown Columbia, South Carolina, with aligned SCDOT rail, OpenStreetMap road, and verified ground-level crossing layers.

Run the authoritative rail-motion service in [`backend`](backend/README.md), the merged audio-localization service in [`simulation_backend`](simulation_backend/README.md), then the Next.js renderer in [`simulation_frontend`](simulation_frontend/README.md). The `frontend` directory remains the separate user-facing routing application from GitHub.
