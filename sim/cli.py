"""Command-line entry point for the vitals simulator.

    python3 sim/cli.py demo                      # fast-forward 3 h, print the ward every 15 min
    python3 sim/cli.py stream --speed 30         # JSON lines on stdout (one batch per line)
    python3 sim/cli.py serve --speed 30          # HTTP + Server-Sent Events on http://127.0.0.1:8765

Server endpoints (CORS open, for local dev only):
    GET  /patients                     patient list (+ baseline, active events)
    GET  /scenarios                    available scenario names
    GET  /vitals                       latest batch of readings
    GET  /stream                       Server-Sent Events: one `data: [readings...]` per tick
    POST /patients/<id>/trigger        body: {"scenario": "sepsis", "severity"?: 1, "holdMin"?: 30, "untilResolved"?: true}
    POST /patients/<id>/resolve        body (optional): {"scenario": "sepsis"}
    POST /patients/<id>/oxygen         body: {"on": true}
    POST /patients/<id>/consciousness  body: {"level": "C"}   ("A"|"C"|"V"|"P"|"U", or null = automatic)

From the browser:
    const es = new EventSource('http://127.0.0.1:8765/stream')
    es.onmessage = (e) => setVitals(JSON.parse(e.data))   // VitalsReading[]
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vitals_sim import (  # noqa: E402
    DEFAULT_CSV_DIR,
    SCENARIOS,
    VitalsSimulator,
    load_synthea_patients,
)


# ------------------------------------------------------------------------------------------------
# demo / stream
# ------------------------------------------------------------------------------------------------

def cmd_demo(args: argparse.Namespace) -> None:
    patients = load_synthea_patients(args.csv_dir)[: args.patients]
    start = datetime(2026, 1, 1, 8, tzinfo=timezone.utc).timestamp()
    sim = VitalsSimulator(patients, seed=args.seed, start_time=start, event_rate_per_hour=0)
    sim.trigger(patients[0].id, "sepsis")
    if len(patients) > 1:
        sim.trigger(patients[1].id, "hypoxia", hold_min=40)

    print(f"{'time':<6}{'room':<5}{'patient':<22}{'HR':<5}{'BP':<9}{'RR':<4}{'SpO2':<9}{'Temp':<6}{'AVPU':<6}scenarios")
    for block in range(args.hours * 4 + 1):
        if block == 1 and len(patients) > 1:
            sim.set_oxygen(patients[1].id, True)  # nurse puts the hypoxic patient on oxygen at 08:15
        for _ in range(15 * 60 // 5):
            readings = sim.step(5)
        clock = datetime.fromtimestamp(sim.now, timezone.utc).strftime("%H:%M")
        for i, (p, r) in enumerate(zip(patients, readings)):
            events = ",".join(e.scenario for e in sim.active_events(p.id))
            spo2 = f"{r['spo2Percent']}%" + (" O2" if r["onOxygen"] else "")
            print(
                f"{clock if i == 0 else '':<6}{p.room:<5}{p.display_name:<22}{r['heartRateBpm']:<5}"
                f"{str(r['systolicMmHg']) + '/' + str(r['diastolicMmHg']):<9}{r['respiratoryRate']:<4}{spo2:<9}"
                f"{r['temperatureC']:<6}{r['consciousness']:<6}{events}"
            )
        print()


def cmd_stream(args: argparse.Namespace) -> None:
    sim = VitalsSimulator(load_synthea_patients(args.csv_dir), seed=args.seed, event_rate_per_hour=args.event_rate)
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

    def __init__(self, address, sim: VitalsSimulator, interval_sec: float, speed: float):
        super().__init__(address, Handler)
        self.sim = sim
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
            next_tick += interval_sec
            self.stopped.wait(max(0.0, next_tick - time.monotonic()))

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
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

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
        if path == "/patients":
            with self.server.lock:
                body = [
                    {
                        **p.to_json(),
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
        m = re.fullmatch(r"/patients/([^/]+)/(trigger|resolve|oxygen|consciousness)", self.path.split("?")[0])
        if not m:
            return self._json(404, {"error": "not found"})
        patient_id, action = m.groups()
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
    sim = VitalsSimulator(load_synthea_patients(args.csv_dir), seed=args.seed, event_rate_per_hour=args.event_rate)
    server = SimServer((args.host, args.port), sim, args.interval, args.speed)
    server.start_ticking()
    print(f"Vitals simulator on http://{args.host}:{server.server_address[1]}  "
          f"({len(sim.patients)} patients, every {args.interval}s, speed x{args.speed})  Ctrl-C to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


# ------------------------------------------------------------------------------------------------

def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description="Synthea-based bedside vitals simulator")
    parser.add_argument("--csv-dir", default=str(DEFAULT_CSV_DIR), help="Synthea CSV output directory")
    parser.add_argument("--seed", type=int, default=1984)
    sub = parser.add_subparsers(dest="command", required=True)

    demo = sub.add_parser("demo", help="fast-forward and print a ward table")
    demo.add_argument("--patients", type=int, default=5)
    demo.add_argument("--hours", type=int, default=3)
    demo.set_defaults(func=cmd_demo)

    for name, func, help_ in (("stream", cmd_stream, "JSON lines to stdout"), ("serve", cmd_serve, "HTTP/SSE server")):
        p = sub.add_parser(name, help=help_)
        p.add_argument("--interval", type=float, default=2, help="real seconds between readings")
        p.add_argument("--speed", type=float, default=1, help="sim seconds per real second")
        p.add_argument("--event-rate", type=float, default=0.15, help="random events per patient per sim-hour")
        p.set_defaults(func=func)
        if name == "serve":
            p.add_argument("--host", default="127.0.0.1")
            p.add_argument("--port", type=int, default=8765)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
