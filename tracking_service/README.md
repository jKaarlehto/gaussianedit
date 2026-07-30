# Local SAM 3.1 tracking service

GaussianEdit uses the official stateful SAM video predictor when this service is
available. The browser stages each short synthetic-orbit branch as a complete
ordered frame sequence, seeds frame zero from the accepted mask, and then asks
the service for tracked masks one angle at a time.

The runtime and checkpoint live under `.runtime/` and are intentionally not
committed. Without them, the editor remains usable through its per-view guided
mask fallback.

The development launcher always starts this service with the dedicated
`.runtime/sam3-service-venv` Python. It validates the official `sam3` package,
checkpoint, and CUDA first. If port 8091 is occupied, the launcher selects a
free private port and points Vite's API proxy at that exact process; an old
Conda service can no longer impersonate the tracker.

```powershell
.runtime\sam3-service-venv\Scripts\python.exe scripts\download_sam31.py
npm run dev
```

Health information is exposed through:

```text
GET http://127.0.0.1:8091/api/sam-tracking/capabilities
```

The port can differ during development when 8091 is occupied. Run
`npm run test:tracker-runtime` to validate the local Python environment without
starting the model service. Run `npm run test:tracker-service` for a lightweight
HTTP startup and identity smoke test that deliberately does not load the
checkpoint. `npm run tracker` starts only the validated tracker service and
prints its selected port.

The UI can show backend activity through a bounded, read-only in-memory feed:

```text
GET /api/sam-tracking/logs?after=0&limit=100
```

Each response contains ordered service events and a `latestSequence` cursor.
The endpoint cannot read arbitrary files or execute terminal commands.

The service targets `facebook/sam3.1` and disables Flash Attention 3 and
`torch.compile` for Windows compatibility.
