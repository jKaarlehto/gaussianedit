"""Parallel, resumable downloader for the gated SAM 3.1 checkpoint.

Uses the user's existing Hugging Face login without printing or persisting its
token in this repository. Independent HTTP ranges are downloaded concurrently,
then assembled atomically under the git-ignored `.runtime/` directory.
"""

from __future__ import annotations

import os
import shutil
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests
from huggingface_hub import get_token, hf_hub_url

ROOT = Path(__file__).resolve().parents[1]
DESTINATION = ROOT / ".runtime" / "sam31-checkpoint" / "sam3.1_multiplex.pt"
PARTIAL = DESTINATION.with_suffix(".pt.part")
ASSEMBLY = DESTINATION.with_suffix(".pt.assembly")
RANGE_ROOT = DESTINATION.parent / ".sam31-ranges"
REPOSITORY = "facebook/sam3.1"
FILENAME = "sam3.1_multiplex.pt"
RANGE_BYTES = 32 * 1024 * 1024
STREAM_CHUNK_BYTES = 1024 * 1024
WORKERS = 10
MAX_ATTEMPTS = 6
MAX_BATCH_ROUNDS = 40
print_lock = threading.Lock()


def main() -> None:
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    token = get_token()
    if not token:
        raise SystemExit("Hugging Face login required: run `hf auth login` first")
    url = hf_hub_url(REPOSITORY, FILENAME)
    auth = {"Authorization": f"Bearer {token}"}
    total, resolved_url = discover_file(url, auth)
    if DESTINATION.exists() and DESTINATION.stat().st_size == total:
        PARTIAL.unlink(missing_ok=True)
        shutil.rmtree(RANGE_ROOT, ignore_errors=True)
        print(f"checkpoint ready: {DESTINATION}", flush=True)
        return

    prefix = PARTIAL.stat().st_size if PARTIAL.exists() else 0
    if prefix > total:
        raise RuntimeError(f"partial checkpoint is larger than the source ({prefix} > {total})")
    RANGE_ROOT.mkdir(parents=True, exist_ok=True)
    ranges = [
        (start, min(total - 1, start + RANGE_BYTES - 1))
        for start in range(prefix, total, RANGE_BYTES)
    ]
    print(
        f"SAM 3.1: {prefix / 1_000_000:.0f} / {total / 1_000_000:.0f} MB; "
        f"{len(ranges)} ranges on {min(WORKERS, len(ranges))} connections",
        flush=True,
    )

    pending = list(ranges)
    complete = len(ranges) - len(pending)
    batch_round = 0
    while pending:
        failed = []
        with ThreadPoolExecutor(max_workers=WORKERS) as executor:
            futures = {
                executor.submit(
                    download_range,
                    resolved_url,
                    auth,
                    start,
                    end,
                ): (start, end)
                for start, end in pending
            }
            for future in as_completed(futures):
                start, end = futures[future]
                try:
                    future.result()
                except Exception as error:
                    failed.append((start, end))
                    with print_lock:
                        print(
                            f"range deferred ({start / 1_000_000:.0f}–"
                            f"{(end + 1) / 1_000_000:.0f} MB): "
                            f"{type(error).__name__}",
                            flush=True,
                        )
                    continue
                complete += 1
                with print_lock:
                    print(
                        f"range {complete}/{len(ranges)} ready "
                        f"({start / 1_000_000:.0f}–{(end + 1) / 1_000_000:.0f} MB)",
                        flush=True,
                    )
        if not failed:
            break
        batch_round += 1
        if batch_round >= MAX_BATCH_ROUNDS:
            raise RuntimeError(
                f"{len(failed)} checkpoint ranges still unavailable after "
                f"{MAX_BATCH_ROUNDS} retry rounds"
            )
        print(
            f"retrying {len(failed)} deferred ranges after a network interruption",
            flush=True,
        )
        time.sleep(min(30, 4 + batch_round * 2))
        try:
            refreshed_total, refreshed_url = discover_file(url, auth)
            if refreshed_total != total:
                raise RuntimeError("checkpoint size changed during download")
            resolved_url = refreshed_url
        except (requests.RequestException, OSError):
            pass
        pending = failed

    with ASSEMBLY.open("wb") as output:
        if PARTIAL.exists():
            with PARTIAL.open("rb") as source:
                shutil.copyfileobj(source, output, length=8 * 1024 * 1024)
        for start, end in ranges:
            range_file = range_path(start, end)
            with range_file.open("rb") as source:
                shutil.copyfileobj(source, output, length=8 * 1024 * 1024)
        output.flush()
        os.fsync(output.fileno())
    if ASSEMBLY.stat().st_size != total:
        raise RuntimeError(
            f"assembled checkpoint has {ASSEMBLY.stat().st_size} bytes; expected {total}"
        )
    ASSEMBLY.replace(DESTINATION)
    PARTIAL.unlink(missing_ok=True)
    shutil.rmtree(RANGE_ROOT, ignore_errors=True)
    print(f"checkpoint ready: {DESTINATION} ({total / 1_000_000:.0f} MB)", flush=True)


def discover_file(url: str, headers: dict[str, str]) -> tuple[int, str]:
    response = requests.head(
        url,
        headers=headers,
        allow_redirects=True,
        timeout=(30, 60),
    )
    response.raise_for_status()
    total = int(response.headers.get("content-length") or 0)
    if not total or "bytes" not in response.headers.get("accept-ranges", "").lower():
        raise RuntimeError("checkpoint host does not expose resumable byte ranges")
    return total, response.url


def download_range(
    url: str,
    auth: dict[str, str],
    start: int,
    end: int,
) -> None:
    target = range_path(start, end)
    expected = end - start + 1
    for attempt in range(1, MAX_ATTEMPTS + 1):
        existing = target.stat().st_size if target.exists() else 0
        if existing == expected:
            return
        if existing > expected:
            raise RuntimeError(f"range file is too large: {target}")
        headers = {
            **auth,
            "Range": f"bytes={start + existing}-{end}",
        }
        try:
            with requests.get(
                url,
                headers=headers,
                stream=True,
                allow_redirects=True,
                timeout=(30, 90),
            ) as response:
                if response.status_code != 206:
                    raise RuntimeError(
                        f"range {start}-{end} returned HTTP {response.status_code}"
                    )
                expected_prefix = f"bytes {start + existing}-"
                content_range = response.headers.get("content-range", "").lower()
                if not content_range.startswith(expected_prefix):
                    raise RuntimeError(
                        f"range {start}-{end} returned {content_range or 'no content-range'}"
                    )
                with target.open("ab" if existing else "wb") as output:
                    for chunk in response.iter_content(chunk_size=STREAM_CHUNK_BYTES):
                        if chunk:
                            output.write(chunk)
                    output.flush()
                    os.fsync(output.fileno())
        except (requests.RequestException, OSError, RuntimeError):
            if attempt >= MAX_ATTEMPTS:
                raise
            time.sleep(min(12, attempt * 2))
            continue
        if target.stat().st_size == expected:
            return
    raise RuntimeError(
        f"range {start}-{end} has {target.stat().st_size} bytes; expected {expected}"
    )


def range_path(start: int, end: int) -> Path:
    return RANGE_ROOT / f"{start:012d}-{end:012d}.part"


if __name__ == "__main__":
    main()
