from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path


def runtime_report() -> dict[str, object]:
    root = Path(__file__).resolve().parents[1]
    runtime_root = Path(
        os.environ.get("GAUSSIANEDIT_RUNTIME_ROOT", root / ".runtime")
    ).resolve()
    checkpoint = Path(
        os.environ.get(
            "GAUSSIANEDIT_SAM_CHECKPOINT",
            runtime_root / "sam31-checkpoint" / "sam3.1_multiplex.pt",
        )
    ).resolve()
    expected_environment = runtime_root / "sam3-service-venv"
    executable = Path(sys.executable).resolve()
    problems: list[str] = []

    try:
        executable.relative_to(expected_environment.resolve())
    except ValueError:
        problems.append(
            f"Python is {executable}, not the project tracker runtime "
            f"{expected_environment}"
        )

    if importlib.util.find_spec("sam3") is None:
        problems.append("the official sam3 package is not installed")

    torch_version = ""
    cuda_version = ""
    device = "unavailable"
    try:
        import torch

        torch_version = str(torch.__version__)
        cuda_version = str(torch.version.cuda or "")
        if torch.cuda.is_available():
            device = str(torch.cuda.get_device_name(0))
        else:
            problems.append("CUDA is unavailable; temporal tracking is GPU-only")
    except Exception as error:  # pragma: no cover - runtime-specific
        problems.append(f"PyTorch failed to import: {type(error).__name__}: {error}")

    if not checkpoint.is_file():
        problems.append(f"SAM 3.1 checkpoint is missing: {checkpoint}")

    return {
        "ok": not problems,
        "python": str(executable),
        "runtimeRoot": str(runtime_root),
        "checkpoint": str(checkpoint),
        "sam3Installed": importlib.util.find_spec("sam3") is not None,
        "torchVersion": torch_version,
        "cudaVersion": cuda_version,
        "device": device,
        "problems": problems,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate GaussianEdit's dedicated SAM 3.1 runtime."
    )
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    report = runtime_report()
    if args.json:
        print(json.dumps(report))
    elif report["ok"]:
        print(f"SAM 3.1 runtime ready · {report['device']}")
        print(f"Python: {report['python']}")
        print(f"Checkpoint: {report['checkpoint']}")
    else:
        print("SAM 3.1 runtime is not ready:")
        for problem in report["problems"]:
            print(f"- {problem}")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
