"""Shared fixtures for the sim/ tests.

Not a test module itself: `unittest discover` only collects files matching test*.py.
"""

from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vitals_sim import SimPatient, VitalsSimulator  # noqa: E402

START = 1767254400.0  # 2026-01-01T08:00:00Z


def make_patient(**overrides: Any) -> SimPatient:
    """A healthy 40-49 year old with normal Synthea vitals; override any SimPatient field."""
    fields: Dict[str, Any] = dict(
        id="p1", age_band="40-49", gender="female",
        conditions=[], last_vitals={"heartRateBpm": 70, "systolicMmHg": 120, "diastolicMmHg": 78},
    )
    fields.update(overrides)
    return SimPatient(**fields)


def ward(n: int) -> List[SimPatient]:
    """n healthy patients with ids p0..p{n-1}."""
    return [make_patient(id=f"p{i}") for i in range(n)]


def quiet_sim(patients: List[SimPatient], seed: int = 1984) -> VitalsSimulator:
    """Simulator with random events off, so only explicitly triggered scenarios run."""
    return VitalsSimulator(patients, seed=seed, start_time=START, event_rate_per_hour=0)


def run(sim: VitalsSimulator, minutes: float, dt: float = 5) -> list:
    """Run `minutes` of sim time in `dt` second steps and return every reading."""
    out = []
    for _ in range(int(minutes * 60 / dt)):
        out.extend(sim.step(dt))
    return out


def start_server(sim: VitalsSimulator, **kwargs: Any) -> Tuple[Any, str]:
    """Start a SimServer on a free port, ticking every 50 ms. Returns (server, base_url);
    call stop_server(server) when done (e.g. via addCleanup)."""
    from cli import SimServer

    server = SimServer(("127.0.0.1", 0), sim, interval_sec=0.05, speed=1, **kwargs)
    server.start_ticking()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def stop_server(server: Any) -> None:
    server.shutdown()
    server.server_close()


def request(url: str, body: Optional[dict] = None, headers: Optional[dict] = None) -> Tuple[int, Any]:
    """GET (body None) or POST JSON; returns (status, decoded JSON body) for success and errors."""
    req = urllib.request.Request(
        url,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())
