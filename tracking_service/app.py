from __future__ import annotations

import asyncio
import gc
import json
import logging
import os
import shutil
import threading
import time
import uuid
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path
from typing import Any, Iterator

import numpy as np
import torch
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from PIL import Image
from scipy import ndimage

LOGGER = logging.getLogger("gaussianedit.tracking")
LOGGER.setLevel(logging.INFO)
PROJECT_ROOT = Path(__file__).resolve().parents[1]
RUNTIME_ROOT = PROJECT_ROOT / ".runtime"
CHECKPOINT_PATH = Path(
    os.environ.get(
        "GAUSSIANEDIT_SAM_CHECKPOINT",
        RUNTIME_ROOT / "sam31-checkpoint" / "sam3.1_multiplex.pt",
    )
)
SESSION_ROOT = RUNTIME_ROOT / "sam3-sessions"
DETECTOR_ROOT = RUNTIME_ROOT / "yolo-models"
DETECTOR_PATH = Path(
    os.environ.get(
        "GAUSSIANEDIT_DETECTOR_CHECKPOINT",
        DETECTOR_ROOT / "yolo12s.pt",
    )
)

app = FastAPI(title="GaussianEdit temporal tracking", docs_url=None, redoc_url=None)
predictor: Any | None = None
model_status = "waiting-checkpoint"
model_error = ""
model_detail = ""
model_load_started_at = 0.0
model_lock = threading.RLock()
model_loader: threading.Thread | None = None
detector: Any | None = None
detector_status = "idle"
detector_error = ""
detector_load_started_at = 0.0
detector_loader: threading.Thread | None = None


@dataclass
class TrackingSession:
    id: str
    branch: str
    object_id: str
    directory: Path
    seed_mask: np.ndarray
    views: list[dict[str, Any]]
    predictor_session_id: str | None = None
    iterator: Iterator[dict[str, Any]] | None = None
    cache: dict[int, dict[str, Any]] = field(default_factory=dict)
    tracker_object_id: int = 1
    processed_frame: int = 0
    target_frame: int = 0
    phase: str = "staged"
    error: str = ""


sessions: dict[str, TrackingSession] = {}


def _load_model() -> None:
    global predictor, model_status, model_error, model_detail, model_load_started_at
    if not CHECKPOINT_PATH.exists():
        model_status = "waiting-checkpoint"
        return
    model_status = "loading"
    model_error = ""
    model_detail = "Importing the SAM 3.1 runtime"
    model_load_started_at = time.monotonic()
    try:
        import sam3.model_builder as sam3_builder
        import sam3.model.decoder as sam3_decoder

        # SAM 3.1's RoPE attention currently hard-restricts PyTorch SDPA to the
        # Flash kernel. On the RTX 5090 / CUDA 13 build that kernel is not
        # available for every tensor shape used by the multiplex decoder,
        # causing every tracked frame to fail with "No available kernel".
        # Keep Flash first, but allow efficient or math attention to take over
        # for unsupported shapes.
        original_sdpa_kernel = sam3_decoder.sdpa_kernel

        def compatible_sdpa_kernel(_requested_backend: Any) -> Any:
            return original_sdpa_kernel([
                torch.nn.attention.SDPBackend.FLASH_ATTENTION,
                torch.nn.attention.SDPBackend.EFFICIENT_ATTENTION,
                torch.nn.attention.SDPBackend.MATH,
            ])

        sam3_decoder.sdpa_kernel = compatible_sdpa_kernel

        LOGGER.info("loading SAM 3.1 tracker from %s", CHECKPOINT_PATH)
        model_detail = "Building the tracker and loading the 3.5 GB checkpoint once"
        torch.set_grad_enabled(False)
        # Meta's multiplex builder normally reads and applies the same 3.5 GB
        # checkpoint once to its tracker submodel and then again to the fully
        # assembled predictor. The final load covers that same tracker state,
        # so skipping only the redundant first load cuts startup I/O and its
        # peak host-memory pressure without changing any checkpoint weights.
        original_tracker_builder = sam3_builder.build_sam3_multiplex_video_model

        def build_uninitialized_tracker(*args: Any, **kwargs: Any) -> Any:
            kwargs["checkpoint_path"] = None
            kwargs["load_from_HF"] = False
            return original_tracker_builder(*args, **kwargs)

        sam3_builder.build_sam3_multiplex_video_model = build_uninitialized_tracker
        try:
            built = sam3_builder.build_sam3_predictor(
                checkpoint_path=str(CHECKPOINT_PATH),
                version="sam3.1",
                # The checkpoint tensors require a physical multiplex width of
                # 16, but the product exposes only one active tracked object.
                max_num_objects=1,
                multiplex_count=16,
                compile=False,
                warm_up=False,
                use_fa3=False,
                use_rope_real=False,
                async_loading_frames=False,
            )
        finally:
            sam3_builder.build_sam3_multiplex_video_model = original_tracker_builder
        # The shared Sam3BasePredictor currently forwards the SAM 3-era
        # `offload_state_to_cpu` keyword, while the SAM 3.1 multiplex model
        # removed that parameter from init_state(). Adapt that one API seam
        # locally instead of forking Meta's installed package.
        original_init_state = built.model.init_state

        def compatible_init_state(*args: Any, **kwargs: Any) -> Any:
            kwargs.pop("offload_state_to_cpu", None)
            return original_init_state(*args, **kwargs)

        built.model.init_state = compatible_init_state
        with model_lock:
            predictor = built
            model_status = "ready"
            model_detail = "SAM 3.1 tracking is ready for the active object"
        LOGGER.info("SAM 3.1 tracker ready")
    except Exception as error:  # pragma: no cover - depends on CUDA runtime
        model_error = f"{type(error).__name__}: {error}"
        model_detail = model_error
        model_status = "error"
        LOGGER.exception("SAM 3.1 tracker failed to load")


def _start_model_loader() -> None:
    global model_loader
    if predictor is not None or model_status == "loading":
        return
    if not CHECKPOINT_PATH.exists():
        return
    model_loader = threading.Thread(target=_load_model, daemon=True, name="sam31-loader")
    model_loader.start()


def _load_detector() -> None:
    global detector, detector_status, detector_error, detector_load_started_at
    detector_status = "loading"
    detector_error = ""
    detector_load_started_at = time.monotonic()
    try:
        from ultralytics import YOLO

        DETECTOR_ROOT.mkdir(parents=True, exist_ok=True)
        LOGGER.info("loading refined detector from %s", DETECTOR_PATH)
        # Passing the target runtime path keeps the downloaded checkpoint out
        # of the repository. Ultralytics downloads the published YOLO12 asset
        # here on first use and reuses it on later sessions.
        with model_lock:
            built = YOLO(str(DETECTOR_PATH), task="detect")
        detector = built
        detector_status = "ready"
        LOGGER.info("YOLO12 refined detector ready")
    except Exception as error:  # pragma: no cover - network/CUDA dependent
        detector_error = f"{type(error).__name__}: {error}"
        detector_status = "error"
        LOGGER.exception("YOLO12 refined detector failed to load")


def _start_detector_loader() -> None:
    global detector_loader
    if detector is not None or detector_status == "loading":
        return
    detector_loader = threading.Thread(
        target=_load_detector,
        daemon=True,
        name="yolo12-loader",
    )
    detector_loader.start()


@app.on_event("startup")
async def startup() -> None:
    SESSION_ROOT.mkdir(parents=True, exist_ok=True)
    _start_model_loader()


@app.get("/api/sam-tracking/capabilities")
async def capabilities() -> dict[str, Any]:
    _start_model_loader()
    return {
        "temporalTracking": predictor is not None and model_status == "ready",
        "status": model_status,
        "detail": model_error or model_detail,
        "loadingForSeconds": (
            round(time.monotonic() - model_load_started_at, 1)
            if model_status == "loading" and model_load_started_at
            else 0
        ),
        "maxTrackedObjects": 1,
        "provider": "official-meta-sam3",
        "modelId": "facebook/sam3.1",
        "family": "sam3.1",
        "device": (
            torch.cuda.get_device_name(0)
            if torch.cuda.is_available()
            else "cpu"
        ),
        "completeSequenceRequired": True,
    }


@app.get("/api/object-detection/capabilities")
async def detection_capabilities() -> dict[str, Any]:
    _start_detector_loader()
    return {
        "available": detector is not None and detector_status == "ready",
        "status": detector_status,
        "detail": detector_error or (
            "Refined target detection is ready"
            if detector_status == "ready"
            else "Preparing refined target detection"
        ),
        "loadingForSeconds": (
            round(time.monotonic() - detector_load_started_at, 1)
            if detector_status == "loading" and detector_load_started_at
            else 0
        ),
        "provider": "yolo12s-refined",
        "modelId": "yolo12s.pt",
        "family": "yolo12",
        "vocabulary": "coco-fixed-category",
        "device": (
            torch.cuda.get_device_name(0)
            if torch.cuda.is_available()
            else "cpu"
        ),
    }


@app.post("/api/object-detection/detect")
async def detect_objects(
    image: UploadFile = File(...),
    metadata: str = Form("{}"),
) -> dict[str, Any]:
    if detector is None or detector_status != "ready":
        _start_detector_loader()
        raise HTTPException(
            status_code=503,
            detail=f"refined detector is {detector_status}",
        )
    payload = await image.read()
    if not payload or len(payload) > 24 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="invalid detector image")
    try:
        parsed = json.loads(metadata)
        threshold = min(0.95, max(0.03, float(parsed.get("threshold", 0.12))))
        maximum = min(160, max(1, int(parsed.get("maxDetections", 96))))
        image_size = min(1536, max(640, int(parsed.get("imageSize", 1280))))
    except (TypeError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=400, detail=f"invalid detector settings: {error}") from error
    try:
        return await asyncio.to_thread(
            _detect_objects,
            payload,
            threshold,
            maximum,
            image_size,
        )
    except Exception as error:  # pragma: no cover - model/runtime specific
        LOGGER.exception("refined object detection failed")
        raise HTTPException(status_code=500, detail=f"detection failed: {error}") from error


def _detect_objects(
    payload: bytes,
    threshold: float,
    maximum: int,
    image_size: int,
) -> dict[str, Any]:
    source = Image.open(BytesIO(payload)).convert("RGB")
    with model_lock, torch.inference_mode():
        results = detector.predict(
            source=source,
            conf=threshold,
            iou=0.55,
            max_det=maximum,
            imgsz=image_size,
            device=0 if torch.cuda.is_available() else "cpu",
            half=torch.cuda.is_available(),
            verbose=False,
        )
    result = results[0]
    names = result.names
    detections = []
    if result.boxes is not None:
        boxes = result.boxes.xyxy.detach().cpu().numpy()
        scores = result.boxes.conf.detach().cpu().numpy()
        classes = result.boxes.cls.detach().cpu().numpy()
        for box, score, class_id in zip(boxes, scores, classes):
            numeric_id = int(class_id)
            label = (
                names.get(numeric_id, f"object {numeric_id}")
                if isinstance(names, dict)
                else names[numeric_id]
            )
            detections.append({
                "label": str(label),
                "score": float(score),
                "classId": numeric_id,
                "box": {
                    "x1": float(box[0]),
                    "y1": float(box[1]),
                    "x2": float(box[2]),
                    "y2": float(box[3]),
                },
            })
    return {
        "width": source.width,
        "height": source.height,
        "detections": detections,
        "provider": "yolo12s-refined",
        "modelId": "yolo12s.pt",
    }


@app.post("/api/sam-tracking/sessions")
async def create_session(
    frame: UploadFile = File(...),
    frames: list[UploadFile] = File(...),
    metadata: str = Form(...),
) -> dict[str, Any]:
    if predictor is None or model_status != "ready":
        raise HTTPException(status_code=503, detail=f"tracker is {model_status}")
    try:
        parsed = json.loads(metadata)
        encoded_mask = parsed["mask"]
        seed_mask = _decode_rle(encoded_mask)
        view_metadata = list(parsed.get("views") or [])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=400, detail=f"invalid tracker metadata: {error}") from error
    if not frames or len(frames) != len(view_metadata):
        raise HTTPException(status_code=400, detail="every staged view needs one frame")

    session_id = str(uuid.uuid4())
    directory = SESSION_ROOT / session_id
    directory.mkdir(parents=True, exist_ok=False)
    try:
        await _save_upload(frame, directory / "000000.png")
        for index, upload in enumerate(frames, start=1):
            # Synthetic frames arrive as browser-encoded JPEGs. Keeping that
            # format avoids a costly PNG encode on the interactive UI thread;
            # SAM's image-folder loader supports mixed PNG/JPEG sequences.
            await _save_upload(upload, directory / f"{index:06d}.jpg")
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise

    sessions[session_id] = TrackingSession(
        id=session_id,
        branch=str(parsed.get("branch") or "orbit"),
        object_id=str(parsed.get("objectId") or "selection"),
        directory=directory,
        seed_mask=seed_mask,
        views=view_metadata,
    )
    return {
        "sessionId": session_id,
        "frames": len(frames),
        "status": "staged",
    }


@app.get("/api/sam-tracking/sessions/{session_id}")
async def get_session_progress(session_id: str) -> dict[str, Any]:
    session = sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="tracker session not found")
    return {
        "sessionId": session.id,
        "branch": session.branch,
        "phase": session.phase,
        "processedFrame": session.processed_frame,
        "targetFrame": session.target_frame,
        "totalFrames": len(session.views),
        "error": session.error,
    }


@app.post("/api/sam-tracking/sessions/{session_id}/frames")
async def track_frame(
    session_id: str,
    frame: UploadFile | None = File(None),
    metadata: str = Form(...),
) -> dict[str, Any]:
    # The frame is already part of the staged sequence. Reading and discarding
    # this compatibility upload keeps the browser API backward-compatible.
    if frame is not None:
        await frame.read()
    session = sessions.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="tracker session not found")
    try:
        parsed = json.loads(metadata)
        view_id = str(parsed.get("view", {}).get("id") or "")
        guidance = parsed.get("guidance") or {}
        target = next(
            index + 1
            for index, view in enumerate(session.views)
            if str(view.get("id")) == view_id
        )
    except (json.JSONDecodeError, StopIteration) as error:
        raise HTTPException(status_code=400, detail="view is not in the staged branch") from error

    try:
        session.target_frame = target
        session.phase = (
            "initializing"
            if session.predictor_session_id is None
            else "tracking"
        )
        session.error = ""
        output, tracking_diagnostics = await asyncio.to_thread(
            _track_to_frame,
            session,
            target,
            guidance,
        )
        mask = _extract_mask(output)
        LOGGER.info(
            "tracked branch=%s frame=%d/%d view=%s area=%d ratio=%.4f",
            session.branch,
            target,
            len(session.views),
            view_id,
            int(mask.sum()),
            float(mask.mean()),
        )
        result = {
            "mask": _encode_rle(mask),
            "score": _extract_score(output),
            "frameIndex": target,
            "viewId": view_id,
            "maskArea": int(mask.sum()),
            "maskAreaRatio": float(mask.mean()),
            "reanchored": bool(tracking_diagnostics["reanchored"]),
            "guideCoverage": float(tracking_diagnostics["positive_coverage"]),
        }
        session.processed_frame = max(session.processed_frame, target)
        session.phase = "ready"
        if target >= len(session.views):
            await asyncio.to_thread(_close_predictor_state, session)
        return result
    except Exception as error:  # pragma: no cover - model/runtime specific
        session.phase = "error"
        session.error = str(error)
        LOGGER.exception("tracking failed for session %s", session_id)
        raise HTTPException(status_code=500, detail=f"tracking failed: {error}") from error


@app.delete("/api/sam-tracking/sessions/{session_id}")
async def delete_session(session_id: str) -> dict[str, bool]:
    session = sessions.pop(session_id, None)
    if session is not None:
        await asyncio.to_thread(_close_predictor_state, session)
        shutil.rmtree(session.directory, ignore_errors=True)
    return {"isSuccess": True}


async def _save_upload(upload: UploadFile, target: Path) -> None:
    target.write_bytes(await upload.read())


def _decode_rle(encoded: dict[str, Any]) -> np.ndarray:
    width = int(encoded["w"])
    height = int(encoded["h"])
    flat = np.zeros(width * height, dtype=np.bool_)
    runs = encoded.get("runs") or []
    if len(runs) % 2:
        raise ValueError("mask runs must be start/length pairs")
    for index in range(0, len(runs), 2):
        start = int(runs[index])
        length = int(runs[index + 1])
        if start < 0 or length < 0 or start + length > flat.size:
            raise ValueError("mask run is outside the image")
        flat[start : start + length] = True
    return flat.reshape(height, width)


def _encode_rle(mask: np.ndarray) -> dict[str, Any]:
    binary = np.asarray(mask, dtype=np.bool_)
    height, width = binary.shape
    flat = binary.reshape(-1)
    padded = np.concatenate(([False], flat, [False]))
    edges = np.flatnonzero(padded[1:] != padded[:-1])
    runs: list[int] = []
    for start, end in edges.reshape(-1, 2):
        runs.extend((int(start), int(end - start)))
    return {"w": int(width), "h": int(height), "runs": runs}


def _dominant_mask_component(mask: np.ndarray) -> np.ndarray:
    labels_image, component_count = ndimage.label(mask)
    if not component_count:
        return mask
    component_sizes = np.bincount(labels_image.reshape(-1))
    component_sizes[0] = 0
    dominant_label = int(component_sizes.argmax())
    return labels_image == dominant_label


def _sample_mask_prompts(mask: np.ndarray) -> tuple[list[list[float]], list[int]]:
    height, width = mask.shape
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        raise ValueError("seed mask is empty")
    # The Fast mask supplies object intent, not a boundary SAM 3 must copy.
    # Prompt from the most interior pixel of its dominant component so SAM 3
    # generates its own frame-zero object mask. A box-centre-nearest pixel can
    # land on a thin edge or inside a hole for U-shaped objects.
    dominant = _dominant_mask_component(mask)
    interior_distance = ndimage.distance_transform_edt(dominant)
    centre_y, centre_x = np.unravel_index(
        int(interior_distance.argmax()),
        interior_distance.shape,
    )
    positive = [[
        float(centre_x / max(1, width - 1)),
        float(centre_y / max(1, height - 1)),
    ]]
    return positive, [1]


def _mask_box_prompt(mask: np.ndarray) -> list[list[float]]:
    """Convert a Fast mask into a loose SAM 3 visual-prompt box."""
    mask = _dominant_mask_component(mask)
    height, width = mask.shape
    ys, xs = np.nonzero(mask)
    if xs.size == 0:
        raise ValueError("seed mask is empty")
    x1, x2 = float(xs.min()), float(xs.max() + 1)
    y1, y2 = float(ys.min()), float(ys.max() + 1)
    # Keep the detector box close to the visible intent. A generous box around
    # an incomplete mask often includes an attached wall, vehicle, or ground
    # plane and gives the tracker a different object to follow.
    margin = max(2.0, max(x2 - x1, y2 - y1) * 0.025)
    x1 = max(0.0, x1 - margin)
    y1 = max(0.0, y1 - margin)
    x2 = min(float(width), x2 + margin)
    y2 = min(float(height), y2 + margin)
    return [[
        x1 / width,
        y1 / height,
        (x2 - x1) / width,
        (y2 - y1) / height,
    ]]


def _outputs_have_mask(outputs: dict[str, Any] | None) -> bool:
    if not outputs:
        return False
    raw = outputs.get("out_binary_masks")
    if raw is None:
        raw = outputs.get("binary_masks")
    if raw is None:
        return False
    if hasattr(raw, "detach"):
        raw = raw.detach().cpu().numpy()
    return bool(np.asarray(raw).size and np.asarray(raw).any())


def _prompt_seed_alignment(
    outputs: dict[str, Any] | None,
    seed_mask: np.ndarray,
) -> dict[str, float]:
    if not outputs:
        return {"coverage": 0.0, "precision": 0.0, "area_ratio": 0.0, "expansion": 0.0}
    raw = outputs.get("out_binary_masks")
    if raw is None:
        raw = outputs.get("binary_masks")
    if raw is None:
        return {"coverage": 0.0, "precision": 0.0, "area_ratio": 0.0, "expansion": 0.0}
    if hasattr(raw, "detach"):
        raw = raw.detach().cpu().numpy()
    masks = np.asarray(raw, dtype=np.bool_)
    if masks.size == 0 or masks.ndim < 2:
        return {"coverage": 0.0, "precision": 0.0, "area_ratio": 0.0, "expansion": 0.0}
    height, width = masks.shape[-2:]
    candidates = masks.reshape(-1, height, width)
    if seed_mask.shape != (height, width):
        source_height, source_width = seed_mask.shape
        source_y = np.minimum(
            source_height - 1,
            np.floor(np.arange(height) * source_height / height).astype(np.int64),
        )
        source_x = np.minimum(
            source_width - 1,
            np.floor(np.arange(width) * source_width / width).astype(np.int64),
        )
        seed = seed_mask[np.ix_(source_y, source_x)]
    else:
        seed = seed_mask
    seed_area = max(1, int(seed.sum()))
    best = {"coverage": 0.0, "precision": 0.0, "area_ratio": 0.0, "expansion": 0.0}
    best_score = -1.0
    for candidate in candidates:
        area = int(candidate.sum())
        if not area:
            continue
        intersection = int(np.logical_and(candidate, seed).sum())
        coverage = intersection / seed_area
        precision = intersection / area
        area_ratio = area / candidate.size
        expansion = area / seed_area
        score = coverage * 0.72 + precision * 0.28
        if score > best_score:
            best_score = score
            best = {
                "coverage": float(coverage),
                "precision": float(precision),
                "area_ratio": float(area_ratio),
                "expansion": float(expansion),
            }
    return best


def _extract_object_id(outputs: dict[str, Any] | None, fallback: int = 1) -> int:
    if not outputs:
        return fallback
    raw = outputs.get("out_obj_ids")
    if raw is None:
        raw = outputs.get("obj_ids")
    if raw is None:
        return fallback
    if hasattr(raw, "detach"):
        raw = raw.detach().cpu().numpy()
    values = np.asarray(raw).reshape(-1)
    return int(values[0]) if values.size else fallback


def _guidance_alignment(
    mask: np.ndarray,
    guidance: dict[str, Any] | None,
) -> dict[str, float]:
    height, width = mask.shape
    positive = list((guidance or {}).get("positive") or [])
    negative = list((guidance or {}).get("negative") or [])

    def coverage(points: list[dict[str, Any]]) -> float:
        if not points:
            return 0.0
        hits = 0
        radius = max(3, int(round(min(width, height) * 0.006)))
        for point in points:
            try:
                x = int(round(float(point["x"])))
                y = int(round(float(point["y"])))
            except (KeyError, TypeError, ValueError):
                continue
            x1 = max(0, x - radius)
            x2 = min(width, x + radius + 1)
            y1 = max(0, y - radius)
            y2 = min(height, y + radius + 1)
            if x1 < x2 and y1 < y2 and mask[y1:y2, x1:x2].any():
                hits += 1
        return hits / max(1, len(points))

    return {
        "positive_coverage": float(coverage(positive)),
        "negative_leak": float(coverage(negative)),
        "area_ratio": float(mask.mean()),
    }


def _guidance_point_prompt(
    guidance: dict[str, Any],
    width: int,
    height: int,
) -> tuple[list[list[float]], list[int]]:
    points: list[list[float]] = []
    labels: list[int] = []
    # The first projected positive is the closest visible Gaussian to the
    # centre of the known 3D object. Keep two more spatial anchors when
    # available, then use the surrounding negatives as spill guards.
    candidates = [
        *((point, 1) for point in list(guidance.get("positive") or [])[:3]),
        *((point, 0) for point in list(guidance.get("negative") or [])[:4]),
    ]
    for point, label in candidates:
        try:
            x = float(point["x"])
            y = float(point["y"])
        except (KeyError, TypeError, ValueError):
            continue
        if not np.isfinite(x) or not np.isfinite(y):
            continue
        points.append([
            float(np.clip(x / max(1, width - 1), 0.0, 1.0)),
            float(np.clip(y / max(1, height - 1), 0.0, 1.0)),
        ])
        labels.append(label)
    return points, labels


def _initialize_predictor_state(session: TrackingSession) -> None:
    if predictor is None:
        raise RuntimeError("tracker model is not ready")
    response = predictor.handle_request(
        {
            "type": "start_session",
            "resource_path": str(session.directory),
            "offload_video_to_cpu": True,
            "offload_state_to_cpu": False,
        }
    )
    session.predictor_session_id = response["session_id"]
    # A box enters SAM 3's visual-prompt detector, allowing it to generate its
    # own complete frame-zero mask instead of inheriting every omission in the
    # Fast mask. Point prompts in the official multiplex predictor intentionally
    # route to its SAM2-style interactive fallback.
    boxes = _mask_box_prompt(session.seed_mask)
    prompted = predictor.handle_request(
        {
            "type": "add_prompt",
            "session_id": session.predictor_session_id,
            "frame_index": 0,
            "bounding_boxes": boxes,
            "bounding_box_labels": [1],
        }
    )
    alignment = _prompt_seed_alignment(prompted.get("outputs"), session.seed_mask)
    box_prompt_is_credible = (
        _outputs_have_mask(prompted.get("outputs"))
        and alignment["coverage"] >= 0.18
        and alignment["area_ratio"] <= 0.72
        and alignment["expansion"] <= 14.0
    )
    LOGGER.info(
        "seed prompt alignment coverage=%.3f precision=%.3f area=%.3f expansion=%.2f accepted=%s",
        alignment["coverage"],
        alignment["precision"],
        alignment["area_ratio"],
        alignment["expansion"],
        box_prompt_is_credible,
    )
    if not box_prompt_is_credible:
        points, labels = _sample_mask_prompts(session.seed_mask)
        prompted = predictor.handle_request(
            {
                "type": "add_prompt",
                "session_id": session.predictor_session_id,
                "frame_index": 0,
                "points": points,
                "point_labels": labels,
                "obj_id": 1,
                "rel_coordinates": True,
            }
        )
    session.tracker_object_id = _extract_object_id(
        prompted.get("outputs"),
        session.tracker_object_id,
    )
    session.cache[0] = prompted["outputs"]
    session.iterator = iter(
        predictor.handle_stream_request(
            {
                "type": "propagate_in_video",
                "session_id": session.predictor_session_id,
                "propagation_direction": "forward",
                "start_frame_index": 0,
            }
        )
    )


def _track_to_frame(
    session: TrackingSession,
    target: int,
    guidance: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    # Autocast state is thread-local. Meta enters its bf16 context while the
    # predictor is constructed, but FastAPI executes this function in a worker
    # thread. Re-enter it here so CUDA activations and float32 parameters are
    # handled consistently by autocast kernels.
    with model_lock, torch.inference_mode(), torch.autocast(
        device_type="cuda",
        dtype=torch.bfloat16,
        enabled=torch.cuda.is_available(),
    ):
        if session.predictor_session_id is None:
            _initialize_predictor_state(session)
        if target in session.cache:
            output = session.cache[target]
        else:
            if session.iterator is None:
                raise RuntimeError("tracker propagation is not active")
            for item in session.iterator:
                frame_index = int(item["frame_index"])
                session.cache[frame_index] = item["outputs"]
                session.processed_frame = max(session.processed_frame, frame_index)
                session.phase = "tracking"
                if frame_index >= target:
                    break
        if target not in session.cache:
            raise RuntimeError(f"tracker produced no output for frame {target}")
        output = session.cache[target]
        mask = _extract_mask(output)
        alignment = _guidance_alignment(mask, guidance)
        positive = list((guidance or {}).get("positive") or [])
        should_reanchor = bool(
            positive
            and (
                alignment["positive_coverage"] < 0.43
                or alignment["area_ratio"] < 0.00002
                or alignment["area_ratio"] > 0.88
                or alignment["negative_leak"] > 0.6
            )
        )
        reanchored = False
        if should_reanchor:
            points, labels = _guidance_point_prompt(
                guidance or {},
                mask.shape[1],
                mask.shape[0],
            )
            if any(label == 1 for label in labels):
                LOGGER.info(
                    "reanchoring branch=%s frame=%d coverage=%.3f negative=%.3f area=%.4f",
                    session.branch,
                    target,
                    alignment["positive_coverage"],
                    alignment["negative_leak"],
                    alignment["area_ratio"],
                )
                prompted = predictor.handle_request(
                    {
                        "type": "add_prompt",
                        "session_id": session.predictor_session_id,
                        "frame_index": target,
                        "points": points,
                        "point_labels": labels,
                        "obj_id": session.tracker_object_id,
                        "clear_old_points": True,
                        "rel_coordinates": True,
                    }
                )
                output = prompted["outputs"]
                session.cache[target] = output
                for frame_index in [
                    frame_index for frame_index in session.cache if frame_index > target
                ]:
                    session.cache.pop(frame_index, None)
                # Continue temporal propagation from the corrected key frame;
                # memory before it remains available inside the predictor.
                session.iterator = iter(
                    predictor.handle_stream_request(
                        {
                            "type": "propagate_in_video",
                            "session_id": session.predictor_session_id,
                            "propagation_direction": "forward",
                            "start_frame_index": target,
                        }
                    )
                )
                alignment = _guidance_alignment(_extract_mask(output), guidance)
                reanchored = True
                LOGGER.info(
                    "reanchored branch=%s frame=%d coverage=%.3f negative=%.3f area=%.4f",
                    session.branch,
                    target,
                    alignment["positive_coverage"],
                    alignment["negative_leak"],
                    alignment["area_ratio"],
                )
        return output, {
            **alignment,
            "reanchored": reanchored,
        }


def _extract_mask(outputs: dict[str, Any]) -> np.ndarray:
    raw = outputs.get("out_binary_masks")
    if raw is None:
        raw = outputs.get("binary_masks")
    if raw is None:
        raise RuntimeError(f"tracker output has no binary mask ({list(outputs)})")
    if hasattr(raw, "detach"):
        raw = raw.detach().cpu().numpy()
    masks = np.asarray(raw)
    if masks.size == 0:
        if masks.ndim >= 2:
            return np.zeros(masks.shape[-2:], dtype=np.bool_)
        raise RuntimeError("tracker returned an empty mask without image dimensions")
    while masks.ndim > 2:
        masks = masks[0]
    if masks.ndim != 2:
        raise RuntimeError(f"unexpected tracker mask shape {masks.shape}")
    return masks.astype(np.bool_)


def _extract_score(outputs: dict[str, Any]) -> float:
    for key in ("out_iou_scores", "iou_scores", "scores", "object_scores"):
        raw = outputs.get(key)
        if raw is None:
            continue
        if hasattr(raw, "detach"):
            raw = raw.detach().float().cpu().numpy()
        values = np.asarray(raw, dtype=np.float32).reshape(-1)
        if values.size:
            return float(np.clip(values.max(), 0.0, 1.0))
    return 0.9


def _close_predictor_state(session: TrackingSession) -> None:
    with model_lock:
        if predictor is not None and session.predictor_session_id is not None:
            predictor.handle_request(
                {
                    "type": "close_session",
                    "session_id": session.predictor_session_id,
                    "run_gc_collect": True,
                }
            )
        session.predictor_session_id = None
        session.iterator = None
        session.cache.clear()
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
