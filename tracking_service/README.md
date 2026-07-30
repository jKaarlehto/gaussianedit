# Local SAM 3.1 tracking service

GaussianEdit uses the official stateful SAM video predictor when this service is
available. The browser stages each short synthetic-orbit branch as a complete
ordered frame sequence, seeds frame zero from the accepted mask, and then asks
the service for tracked masks one angle at a time.

The runtime and checkpoint live under `.runtime/` and are intentionally not
committed. Without them, the editor remains usable through its per-view guided
mask fallback.

The development launcher starts this service automatically when
`.runtime/sam3-service-venv` exists:

```powershell
.runtime\sam3-service-venv\Scripts\python.exe scripts\download_sam31.py
npm run dev
```

Health information is exposed through:

```text
GET http://127.0.0.1:8091/api/sam-tracking/capabilities
```

The service targets `facebook/sam3.1` and disables Flash Attention 3 and
`torch.compile` for Windows compatibility.
