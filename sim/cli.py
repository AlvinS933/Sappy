"""Command-line entry point for the vitals simulator.

    python3 sim/cli.py demo                      # scripted demo, fast-forwarded, printed every 15 sim-min
    python3 sim/cli.py serve --demo              # scripted demo live: 1 tick / 2 s = 15 hospital min
    python3 sim/cli.py serve --demo --reset      # ...and clear Supabase vitals/alerts first
    python3 sim/cli.py serve --speed 30          # free-running (random events) on http://127.0.0.1:8765
    python3 sim/cli.py stream --speed 30         # JSON lines on stdout (one batch per line)

Patients come from data/clean/ (scrubbed by Synthea_Gen/transform.py). Each is admitted to a bed;
the bed label is display-only - key everything on patientId / encounterId.

`serve` also writes every tick to Supabase (sim/supabase_sink.py) when SUPABASE_URL and
SUPABASE_SECRET_KEY are set (needs the venv: pip install -r requirements.txt).
If SIM_CONTROL_TOKEN is set, POST endpoints need `Authorization: Bearer <token>`.

Server endpoints (CORS open, for local dev only):
    GET  /health                       {"ok": true, "supabase": bool} (Render health check)
    GET  /patients                     patients (+ encounter/bed, baseline, active events)
    GET  /scenarios                    available scenario names
    GET  /vitals                       latest batch of readings
    GET  /stream                       Server-Sent Events: one `data: [readings...]` per tick
    POST /patients/<id>/trigger        body: {"scenario": "sepsis", "severity"?: 1, "holdMin"?: 30, "untilResolved"?: true}
    POST /patients/<id>/resolve        body (optional): {"scenario": "sepsis"}
    POST /patients/<id>/oxygen         body: {"on": true}
    POST /patients/<id>/consciousness  body: {"level": "C"}   ("A"|"C"|"V"|"P"|"U", or null = automatic)
    POST /patients/<id>/artifact       body (optional): {"vital": "spo2Percent", "value": 75}  one-off bad reading

From the browser:
    const es = new EventSource('http://127.0.0.1:8765/stream')
    es.onmessage = (e) => setVitals(JSON.parse(e.data))   // VitalsReading[]`
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vitals_sim import (  # noqa: E402
    REPO_ROOT,
    DEFAULT_CLEAN_DIR,
    DEMO_TICK_MIN,
    SCENARIOS,
    VitalsSimulator,
    load_clean_patients,
    schedule_demo,
)
from supabase_sink import SupabaseSink  # noqa: E402


# ------------------------------------------------------------------------------------------------
# demo / stream
# ------------------------------------------------------------------------------------------------

def cmd_demo(args: argparse.Namespace) -> None:
    patients = load_clean_patients(args.clean_dir)[: args.patients]
    start = datetime(2026, 1, 1, 8, tzinfo=timezone.utc).timestamp()
    sim = VitalsSimulator(patients, seed=args.seed, start_time=start, event_rate_per_hour=0)
    truth = schedule_demo(sim)
    role = {pid: name for name, pid in truth.items()}

    print(f"{'time':<6}{'bed':<6}{'patient':<20}{'HR':<5}{'BP':<9}{'RR':<4}{'SpO2':<9}{'Temp':<6}{'AVPU':<6}ground truth")
    for _ in range(args.hours * 60 // DEMO_TICK_MIN):
        readings = sim.step(DEMO_TICK_MIN * 60)
        artifacts = {(a["patientId"], a["recordedAt"]) for a in sim.artifact_log}
        clock = datetime.fromtimestamp(sim.now, timezone.utc).strftime("%H:%M")
        for i, (p, r) in enumerate(zip(patients, readings)):
            truth_note = role.get(p.id, "")
            if (p.id, r["recordedAt"]) in artifacts:
                truth_note += "  <- loose probe (artifact)"
            spo2 = f"{r['spo2Percent']}%" + (" O2" if r["onOxygen"] else "")
            label = f"{p.id[:8]} {p.age_band} {p.gender[0].upper()}"
            print(
                f"{clock if i == 0 else '':<6}{sim.admission(p.id).bed_label:<6}{label:<20}{r['heartRateBpm']:<5}"
                f"{str(r['systolicMmHg']) + '/' + str(r['diastolicMmHg']):<9}{r['respiratoryRate']:<4}{spo2:<9}"
                f"{r['temperatureC']:<6}{r['consciousness']:<6}{truth_note}"
            )
        print()


def cmd_stream(args: argparse.Namespace) -> None:
    sim = VitalsSimulator(load_clean_patients(args.clean_dir), seed=args.seed, event_rate_per_hour=args.event_rate)
    try:
        for readings in sim.stream(interval_sec=args.interval, speed=args.speed):
            print(json.dumps(readings), flush=True)
    except (KeyboardInterrupt, BrokenPipeError):
        pass


# ------------------------------------------------------------------------------------------------
# serve
# ------------------------------------------------------------------------------------------------

class SimServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, sim: VitalsSimulator, interval_sec: float, speed: float,
                 sink=None, control_token: str = ""):
        super().__init__(address, Handler)
        self.sim = sim
        self.sink = sink  # SupabaseSink or None
        self.control_token = control_token
        self.sink_failures = 0
        self.lock = threading.Lock()
        self.tick = threading.Condition()
        self.latest: list = []
        self.seq = 0
        self.stopped = threading.Event()
        self._ticker = threading.Thread(target=self._run, args=(interval_sec, speed), daemon=True)

    def start_ticking(self) -> None:
        self._ticker.start()

    def _run(self, interval_sec: float, speed: float) -> None:
        next_tick = time.monotonic()
        while not self.stopped.is_set():
            with self.lock:
                readings = self.sim.step(interval_sec * speed)
            with self.tick:
                self.latest, self.seq = readings, self.seq + 1
                self.tick.notify_all()
            self._write_sink(readings)
            next_tick += interval_sec
            self.stopped.wait(max(0.0, next_tick - time.monotonic()))

    def _write_sink(self, readings: list) -> None:
        if self.sink is None:
            return
        try:
            self.sink.write(readings)
            if self.sink_failures:
                print(f"supabase: writes recovered after {self.sink_failures} failures", flush=True)
            self.sink_failures = 0
        except Exception as e:  # keep ticking; the SSE stream still works without Supabase
            self.sink_failures += 1
            if self.sink_failures == 1 or self.sink_failures % 30 == 0:
                print(f"supabase: write failed ({self.sink_failures}x): {e}", file=sys.stderr, flush=True)

    def server_close(self) -> None:
        self.stopped.set()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    server: SimServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # silence the default per-request stderr line
        pass

    # -- helpers --------------------------------------------------------------------------------

    def _cors(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def _json(self, status: int, body) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        return json.loads(self.rfile.read(length))

    # -- routes ---------------------------------------------------------------------------------

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        sim, path = self.server.sim, self.path.split("?")[0]
        if path == "/health":
            self._json(200, {"ok": True, "supabase": self.server.sink is not None})
        elif path == "/patients":
            with self.server.lock:
                body = [
                    {
                        **p.to_json(),
                        "encounter": sim.admission(p.id).to_json(),
                        "baseline": sim.baseline(p.id),
                        "events": [e.to_json() for e in sim.active_events(p.id)],
                        "onOxygen": sim.on_oxygen(p.id),
                        "consciousnessOverride": sim.consciousness_override(p.id),
                    }
                    for p in sim.patients
                ]
            self._json(200, body)
        elif path == "/scenarios":
            self._json(200, {k: v.label for k, v in SCENARIOS.items()})
        elif path == "/vitals":
            with self.server.tick:
                self._json(200, self.server.latest)
        elif path == "/stream":
            self._sse()
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        m = re.fullmatch(r"/patients/([^/]+)/(trigger|resolve|oxygen|consciousness|artifact)", self.path.split("?")[0])
        if not m:
            return self._json(404, {"error": "not found"})
        patient_id, action = m.groups()
        token = self.server.control_token
        if token and self.headers.get("Authorization") != f"Bearer {token}":
            return self._json(401, {"error": "missing or wrong Authorization: Bearer <SIM_CONTROL_TOKEN>"})
        try:
            body = self._body()
            if action == "trigger" and "scenario" not in body:
                return self._json(400, {"error": f"body needs 'scenario', one of {sorted(SCENARIOS)}"})
            if action == "oxygen" and not isinstance(body.get("on"), bool):
                return self._json(400, {"error": "body needs 'on': true or false"})
            if action == "consciousness" and "level" not in body:
                return self._json(400, {"error": "body needs 'level': one of A, C, V, P, U, or null for automatic"})
            sim = self.server.sim
            with self.server.lock:
                if action == "trigger":
                    event = sim.trigger(
                        patient_id,
                        body["scenario"],
                        severity=float(body.get("severity", 1)),
                        hold_min=math.inf if body.get("untilResolved") else body.get("holdMin"),
                    )
                    return self._json(200, event.to_json())
                if action == "resolve":
                    sim.resolve(patient_id, body.get("scenario"))
                elif action == "oxygen":
                    sim.set_oxygen(patient_id, body["on"])
                elif action == "artifact":
                    value = body.get("value")
                    sim.inject_artifact(
                        patient_id, body.get("vital", "spo2Percent"), None if value is None else float(value)
                    )
                else:
                    sim.set_consciousness(patient_id, body["level"])
            self._json(200, {"ok": True})
        except KeyError as e:  # unknown patient id
            self._json(404, {"error": str(e).strip("'\"")})
        except (ValueError, json.JSONDecodeError) as e:
            self._json(400, {"error": str(e)})

    def _sse(self) -> None:
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.close_connection = True
        seen = -1
        try:
            while not self.server.stopped.is_set():
                with self.server.tick:
                    self.server.tick.wait_for(lambda: self.server.seq != seen or self.server.stopped.is_set(), timeout=15)
                    seq, readings = self.server.seq, self.server.latest
                if seq == seen:
                    self.wfile.write(b": keep-alive\n\n")
                else:
                    seen = seq
                    self.wfile.write(f"data: {json.dumps(readings)}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


def cmd_serve(args: argparse.Namespace) -> None:
    if args.demo:  # CLAUDE.md: 1 tick every 2 s real time = 15 min hospital time, no random events
        args.interval, args.speed, args.event_rate = 2.0, DEMO_TICK_MIN * 60 / 2.0, 0.0
    sim = VitalsSimulator(load_clean_patients(args.clean_dir), seed=args.seed, event_rate_per_hour=args.event_rate)
    truth = schedule_demo(sim) if args.demo else None

    sink = None if args.no_supabase else SupabaseSink.from_env()
    if sink:
        try:
            if args.reset:
                sink.reset()
            sink.admit(sim)
        except Exception as e:
            sys.exit(f"Supabase: setup failed: {getattr(e, 'message', None) or e}\n"
                     "Have the tables been created? Apply supabase/migrations/ (see CLAUDE.md -> Deployment), "
                     "or run with --no-supabase.")
        print(f"Supabase: admitted {len(sim.patients)} patients, writing vitals every tick", flush=True)
    else:
        print("Supabase: off (set SUPABASE_URL + SUPABASE_SECRET_KEY to enable)", flush=True)

    server = SimServer((args.host, args.port), sim, args.interval, args.speed,
                       sink=sink, control_token=os.environ.get("SIM_CONTROL_TOKEN", ""))
    server.start_ticking()
    print(f"Vitals simulator on http://{args.host}:{server.server_address[1]}  "
          f"({len(sim.patients)} patients, every {args.interval}s, speed x{args.speed:g})  Ctrl-C to stop", flush=True)
    if truth:
        beds = {name: sim.admission(pid).bed_label for name, pid in truth.items()}
        print(f"Demo script: sepsis from +1 h in bed {beds['sepsis']}, loose SpO2 probe at +2.5 h in bed "
              f"{beds['falseAlarm']} (ground truth - keep off the nurse UI)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


# ------------------------------------------------------------------------------------------------

def load_dotenv(path: Path) -> None:
    """Minimal .env reader (stdlib only): KEY=VALUE lines, # comments, optional quotes/`export`.
    Variables already set in the real environment win over the file."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key.startswith("export "):
            key = key[len("export "):].strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:  # inline comment on an unquoted value
            value = value.split(" #", 1)[0].rstrip()
        os.environ.setdefault(key, value)


def main(argv=None) -> None:
    load_dotenv(REPO_ROOT / ".env")
    env = os.environ.get
    parser = argparse.ArgumentParser(description="Synthea-based bedside vitals simulator")
    parser.add_argument("--clean-dir", default=str(DEFAULT_CLEAN_DIR), help="scrubbed patients (Synthea_Gen/transform.py)")
    parser.add_argument("--seed", type=int, default=int(env("SIM_SEED", 1984)))
    sub = parser.add_subparsers(dest="command", required=True)

    demo = sub.add_parser("demo", help="fast-forward the scripted demo and print a ward table")
    demo.add_argument("--patients", type=int, default=5)
    demo.add_argument("--hours", type=int, default=8)
    demo.set_defaults(func=cmd_demo)

    for name, func, help_ in (("stream", cmd_stream, "JSON lines to stdout"), ("serve", cmd_serve, "HTTP/SSE server")):
        p = sub.add_parser(name, help=help_)
        p.add_argument("--interval", type=float, default=2, help="real seconds between readings")
        p.add_argument("--speed", type=float, default=1, help="sim seconds per real second")
        p.add_argument("--event-rate", type=float, default=0.15, help="random events per patient per sim-hour")
        p.set_defaults(func=func)
        if name == "serve":
            p.add_argument("--demo", action="store_true",
                           help="scripted demo: 2 s ticks = 15 sim-min, random events off (overrides the above)")
            p.add_argument("--reset", action="store_true", help="delete Supabase vitals + alerts before starting")
            p.add_argument("--no-supabase", action="store_true", help="don't write to Supabase even if configured")
            p.add_argument("--host", default=env("SIM_HOST", "127.0.0.1"))
            p.add_argument("--port", type=int, default=int(env("SIM_PORT", 8765)))

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
