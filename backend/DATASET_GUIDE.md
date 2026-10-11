# Routz offline dataset guide

The offline generator creates varied synthetic journeys on the cached, real SCDOT railroad graph. It is data generation only: it does not contain a model, training loop, inference system, replay UI, renderer, HTTP server, or WebSocket broadcaster. The existing live simulation is unchanged.

## Install and generate

From `backend/`:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

PYTHONPATH=src .venv/bin/python -m backend.dataset_generator \
  --runs 100 \
  --duration 300 \
  --sampling-rate 10 \
  --seed 20261010 \
  --batch-size 50000 \
  --output-dir datasets/columbia-v1
```

Useful optional arguments:

```text
--prediction-horizons 5,15,30  Future-label horizons in seconds
--measurement-noise-m 3        Position-noise standard deviation; 0 disables it
--min-route-length 2000        Minimum requested route length in meters
--desktop-notification         Notify on completion on macOS/Linux when supported
```

The output directory must be new or empty so an old and new dataset cannot be mixed accidentally. Progress goes to stderr and includes completed runs, rows, elapsed time, and estimated time remaining. A successful command prints output paths, run count, row count, total byte size, and elapsed time. Errors are printed clearly and return a nonzero process exit code.

## File layout

```text
columbia-v1/
├── manifest.json                Machine-readable version, schemas, settings, seeds, provenance
├── rail_network_snapshot.json   Exact nodes, edges, geometry, metadata, and graph policy
├── routes.parquet               One ordered, directed geometry row per route ID
├── replay_metadata.parquet      One hidden/replay configuration row per complete run
├── observations/
│   └── part-*.parquet           Observable input rows, Zstandard-compressed
└── labels/
    └── part-*.parquet           Branch and future-position labels, Zstandard-compressed
```

Part sizes are controlled by `--batch-size`. `run_id`, `train_id`, `route_id`, and `simulation_time_s` are the stable join keys. Routes are stored once and referenced by `route_id`; full geometry is not duplicated in every observation.

## Schema and units

The authoritative machine-readable field list and Arrow types are in `manifest.json`.

### `observations/`

| Field group | Meaning and units |
| --- | --- |
| IDs/time | `run_id`, `train_id`, `route_id`; `simulation_time_s` is seconds from run start; `timestamp_utc_ns` is Unix epoch nanoseconds UTC. |
| Geographic truth | `latitude_deg`, `longitude_deg` in WGS84 degrees. |
| Local truth | `local_x_m`, `local_y_m`, `local_z_m` in scene meters; `track_segment_id`; `distance_along_route_m`. |
| Motion truth | `speed_mps`, `acceleration_mps2`, heading in degrees clockwise from true north, and `stopped`. |
| Optional measurements | Nullable `measured_*` columns. They are populated only when measurement noise is enabled. |

### `labels/`

Each label row aligns one-to-one with an observation by run/train/time. `upcoming_switch_id`, `distance_to_upcoming_switch_m`, and `actual_branch_edge_id` describe the next switch on the planned route. `future_positions` is a list of structs for the configured horizons. A horizon beyond the recorded run has `available=false` and null position fields.

### `routes.parquet`

Contains ordered `directed_node_ids`, `directed_edge_ids`, route length, and geometry. Every geometry point has UTM easting/northing, local X/Z, a sequence number, and cumulative route distance. Direction matters: the first point is the journey start and the last point is its destination.

### `replay_metadata.parquet`

Contains hidden planning data and reconstruction settings: destination, planned edge sequence, departure time, run seed, initial route placement/speed, acceleration limits, train length, locomotive/wagon dimensions, coupling spacing, and each vehicle's offset behind the locomotive. Keep this table out of an ML input feature set.

## Coordinate conventions

- Cached source geometry: WGS84 / EPSG:4326 in `[longitude, latitude]` order.
- Movement and graph distances: UTM zone 17N / EPSG:32617, meters.
- Scene origin: downtown Columbia at 34.0007 N, -81.0348 W. Exact WGS84 and UTM origin values are stored in the manifest and network snapshot.
- Three.js-compatible local axes: positive X is east, positive Y is up, and positive Z is south.
- Heading: degrees clockwise from true north.
- Route distance: meters along the ordered polyline, not straight-line displacement.

## Reconstructing a sped-up 3D replay

No simulation rerun is needed:

1. Select all observation rows for one `run_id`, ordered by `simulation_time_s`.
2. Load that run's replay metadata and its referenced route geometry.
3. For a render time between two observations, linearly interpolate `distance_along_route_m` using their timestamps. Stops naturally remain stationary because consecutive distances are equal or nearly equal.
4. Locate that distance between two cumulative route-geometry distances and interpolate the local X/Z position. Use the segment tangent for heading; this follows curves instead of drawing a chord across the whole route.
5. For each wagon, sample the same route at `locomotive_distance - vehicle_offset`. Clamp negative distances to the first route point. The saved offsets, dimensions, train length, and coupling spacing fully describe placement.
6. Set playback speed by advancing replay time faster; do not alter route distance values.

`read_dataset.py` demonstrates selected-column scanning, loading one complete run, joining its route/train metadata, and reconstructing locomotive and wagon positions.

```bash
PYTHONPATH=src .venv/bin/python read_dataset.py datasets/columbia-v1
PYTHONPATH=src .venv/bin/python read_dataset.py datasets/columbia-v1 --run-id RUN_ID --batch-size 20
```

## Synthetic assumptions

- Start/destination nodes and shortest valid paths are sampled from the largest connected component of the cached graph.
- Routes are longer than the live 800-meter corridor; the default requested minimum is 2 km.
- Speed targets, bounded acceleration/braking, dwell stops, initial speed, departure time, and optional measurement errors are synthetic and seeded.
- The graph connects source-feature endpoints within 2.5 m. A visual crossing is not a junction unless the source topology splits/connects it.
- The generator does not model signals, dispatching, other trains, grades, speed-limit records, weather, wheel dynamics, or operational railway rules.
- Synthetic results are not evidence of real train behavior or prediction accuracy.

## Preventing label leakage

Treat only `observations/` (and explicitly chosen nullable `measured_*` columns) as model inputs. Future positions, the branch actually taken, destinations, complete planned edge sequences, and route-level replay metadata expose the answer and must not be input features for prediction tasks.

Split train/validation/test data by complete `run_id`, never by individual rows. Row-level random splitting puts adjacent timestamps from the same journey into multiple splits and creates severe temporal and route-plan leakage. Fit preprocessing statistics using training runs only. For stronger generalization tests, also hold out route IDs, destination regions, or departure-time ranges.

The generator records every per-run seed in the manifest. Reuse the same master seed and arguments for exact deterministic motion/route content; creation timestamps and elapsed-time reporting are intentionally not deterministic.

## Rail pathfinder baseline and evaluation

Routez includes a destination-blind graph baseline in
`backend.rail_pathfinder`. It accepts one observable fix (WGS84 position,
compass heading clockwise from north, and speed), snaps it to the saved rail
graph, and returns up to three likely paths with positions at the dataset's
prediction horizons. At a switch, the default ranking favors the smallest
heading change.

Evaluate a generated dataset with:

```bash
PYTHONPATH=src .venv/bin/python -m backend.pathfinder_evaluation \
  datasets/columbia-v1 \
  --output datasets/columbia-v1/pathfinder-report.json
```

or, when installed with `uv`:

```bash
uv run evaluate-train-pathfinder datasets/columbia-v1 \
  --output datasets/columbia-v1/pathfinder-report.json
```

The evaluator splits complete runs 70/15/15 using a stable hash of `run_id`.
It reports top-1 branch accuracy, top-2 branch coverage, Brier score, and
future-position MAE/RMSE at each horizon for truth and noisy measurements.
It also fits simple per-switch branch frequencies on the training runs. That
probabilistic model is selected only when validation top-1 accuracy beats the
heading baseline by more than one percentage point, or its Brier score improves
by at least five percent without reducing top-1 accuracy.

The current generator chooses a random hidden destination. Exact branch intent
is therefore not always identifiable from position, heading, and speed. Treat
candidate paths as probabilities, not certainty. The evaluator never exposes
destination, planned edge sequences, replay metadata, or future labels to the
predictor.
