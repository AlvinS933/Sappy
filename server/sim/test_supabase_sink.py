"""Run: python3 -m unittest discover sim -v

The real-client test needs the venv (pip install -r requirements.txt); it points the actual
supabase-py client at a local fake PostgREST server, so it never touches a real project.
"""

from __future__ import annotations

import json
import os
import sys
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, str(Path(__file__).resolve().parent))
from supabase_sink import VITALS_COLUMNS, SupabaseSink, encounter_rows, patient_rows, vitals_row  # noqa: E402
from vitals_sim import SimPatient, VitalsSimulator  # noqa: E402

START = 1767254400.0


def ward(n: int = 2) -> list:
    return [SimPatient(id=f"p{i}", age_band="60-69", gender="female", conditions=["Asthma"]) for i in range(n)]


def quiet_sim(n: int = 2) -> VitalsSimulator:
    return VitalsSimulator(ward(n), start_time=START, event_rate_per_hour=0)


class FakeQuery:
    """Records a supabase-py style call chain: table(..).op(..).filters(..).execute()."""

    def __init__(self, log: list, table: str):
        self.call = {"table": table, "op": None, "data": None, "filters": [], "kwargs": {}}
        self._negate = False
        log.append(self.call)

    def _op(self, op, data=None, **kwargs):
        self.call.update(op=op, data=data, kwargs=kwargs)
        return self

    def insert(self, data, **kw):
        return self._op("insert", data, **kw)

    def upsert(self, data, **kw):
        return self._op("upsert", data, **kw)

    def update(self, data, **kw):
        return self._op("update", data, **kw)

    def delete(self, **kw):
        return self._op("delete", **kw)

    @property
    def not_(self):
        self._negate = True
        return self

    def _filter(self, name, column, value):
        self.call["filters"].append((("not." if self._negate else "") + name, column, value))
        self._negate = False
        return self

    def eq(self, column, value):
        return self._filter("eq", column, value)

    def in_(self, column, values):
        return self._filter("in", column, list(values))

    def is_(self, column, value):
        return self._filter("is", column, value)

    def execute(self):
        return None


class FakeClient:
    def __init__(self):
        self.log: list = []

    def table(self, name):
        return FakeQuery(self.log, name)


class RowMappingTests(unittest.TestCase):
    def test_vitals_row_matches_reading(self):
        sim = quiet_sim()
        (r, _) = sim.step(5)
        row = vitals_row(r)
        self.assertEqual(set(row), set(VITALS_COLUMNS.values()))
        self.assertEqual(row["patient_id"], "p0")
        self.assertEqual(row["encounter_id"], sim.admission("p0").encounter_id)
        self.assertEqual(row["spo2_percent"], r["spo2Percent"])
        self.assertEqual(row["on_oxygen"], False)
        self.assertEqual(row["consciousness"], "A")

    def test_every_reading_key_is_mapped(self):
        (r, _) = quiet_sim().step(5)
        self.assertEqual(set(r), set(VITALS_COLUMNS))

    def test_patient_and_encounter_rows_have_no_identifying_fields(self):
        sim = quiet_sim()
        self.assertEqual(set(patient_rows(sim)[0]), {"id", "age_band", "gender", "conditions", "medications"})
        enc = encounter_rows(sim)[1]
        self.assertEqual(
            (enc["patient_id"], enc["status"], enc["class"], enc["bed_label"]), ("p1", "in-progress", "IMP", "4W-02")
        )


class SinkTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeClient()
        self.sink = SupabaseSink(self.client)
        self.sim = quiet_sim()

    def test_admit_upserts_then_finishes_old_encounters(self):
        self.sink.admit(self.sim)
        ops = [(c["table"], c["op"]) for c in self.client.log]
        self.assertEqual(ops, [("patients", "upsert"), ("encounters", "upsert"), ("encounters", "update")])
        self.assertEqual(self.client.log[0]["kwargs"], {"on_conflict": "id"})
        finish = self.client.log[2]
        ids = [self.sim.admission(f"p{i}").encounter_id for i in range(2)]
        self.assertEqual(finish["data"], {"status": "finished"})
        self.assertEqual(finish["filters"], [("not.in", "id", ids), ("eq", "status", "in-progress")])

    def test_write_inserts_one_row_per_patient(self):
        self.sink.write(self.sim.step(5))
        (call,) = self.client.log
        self.assertEqual((call["table"], call["op"], len(call["data"])), ("vitals", "insert", 2))
        self.sink.write([])
        self.assertEqual(len(self.client.log), 1)  # empty batch: no request

    def test_reset_clears_alerts_then_vitals(self):
        self.sink.reset()
        self.assertEqual([(c["table"], c["op"], c["filters"]) for c in self.client.log], [
            ("alerts", "delete", [("not.is", "id", "null")]),
            ("vitals", "delete", [("not.is", "id", "null")]),
        ])

    def test_from_env_none_when_unconfigured(self):
        with mock.patch.dict(os.environ, {"SUPABASE_URL": "", "SUPABASE_SECRET_KEY": "", "SUPABASE_SERVICE_ROLE_KEY": ""}):
            self.assertIsNone(SupabaseSink.from_env())

    def test_simulator_ground_truth_never_written(self):
        self.sim.trigger("p0", "sepsis")
        self.sink.admit(self.sim)
        self.sink.write(self.sim.step(5))
        self.assertNotIn("sepsis", json.dumps([c["data"] for c in self.client.log]))


class ServerSinkTests(unittest.TestCase):
    def start(self, sink=None, token=""):
        from cli import SimServer

        server = SimServer(("127.0.0.1", 0), quiet_sim(), interval_sec=0.05, speed=1, sink=sink, control_token=token)
        server.start_ticking()
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server, f"http://127.0.0.1:{server.server_address[1]}"

    def request(self, url, body=None, headers=None):
        req = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json", **(headers or {})})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_ticks_written_to_sink_and_health_reports_it(self):
        client = FakeClient()
        server, base = self.start(sink=SupabaseSink(client))
        self.assertEqual(self.request(base + "/health"), (200, {"ok": True, "supabase": True}))
        import time
        deadline = time.time() + 3
        while not client.log and time.time() < deadline:
            time.sleep(0.02)
        self.assertEqual(client.log[0]["table"], "vitals")

    def test_sink_failure_does_not_stop_ticking(self):
        class Broken:
            def write(self, readings):
                raise RuntimeError("network down")

        server, base = self.start(sink=Broken())
        import io, time
        with mock.patch("sys.stderr", new=io.StringIO()):
            first = server.seq
            time.sleep(0.3)
        self.assertGreater(server.seq, first + 2)
        self.assertGreater(server.sink_failures, 0)

    def test_control_token_required_for_post(self):
        _, base = self.start(token="s3cret")
        url = base + "/patients/p0/oxygen"
        self.assertEqual(self.request(url, {"on": True})[0], 401)
        self.assertEqual(self.request(url, {"on": True}, {"Authorization": "Bearer nope"})[0], 401)
        self.assertEqual(self.request(url, {"on": True}, {"Authorization": "Bearer s3cret"})[0], 200)
        self.assertEqual(self.request(base + "/health")[0], 200)  # GETs stay open


try:
    # Import a real name: the repo's supabase/ folder (migrations) can masquerade as an empty
    # namespace package called "supabase" when the library isn't installed.
    from supabase import create_client  # noqa: F401
    HAS_SUPABASE = True
except ImportError:
    HAS_SUPABASE = False


@unittest.skipUnless(HAS_SUPABASE, "supabase package not installed (use the venv)")
class RealClientTests(unittest.TestCase):
    """Real supabase-py client -> local fake PostgREST; checks the HTTP requests it sends."""

    def setUp(self):
        requests = self.requests = []

        class FakePostgrest(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                url = urlparse(self.path)
                requests.append({
                    "method": self.command,
                    "path": url.path,
                    "query": {k: v[0] for k, v in parse_qs(url.query).items()},
                    "body": json.loads(self.rfile.read(length)) if length else None,
                    "auth": self.headers.get("Authorization", ""),
                })
                payload = b"[]"
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = do_PATCH = do_DELETE = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FakePostgrest)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        env = {"SUPABASE_URL": f"http://127.0.0.1:{self.server.server_address[1]}",
               "SUPABASE_SECRET_KEY": "sb_secret_" + "x" * 32}
        with mock.patch.dict(os.environ, env):
            self.sink = SupabaseSink.from_env()

    def test_requests_sent_to_postgrest(self):
        sim = quiet_sim()
        self.sink.reset()
        self.sink.admit(sim)
        self.sink.write(sim.step(5))
        got = [(r["method"], r["path"]) for r in self.requests]
        self.assertEqual(got, [
            ("DELETE", "/rest/v1/alerts"), ("DELETE", "/rest/v1/vitals"),
            ("POST", "/rest/v1/patients"), ("POST", "/rest/v1/encounters"),
            ("PATCH", "/rest/v1/encounters"), ("POST", "/rest/v1/vitals"),
        ])
        self.assertEqual(self.requests[0]["query"], {"id": "not.is.null"})
        self.assertEqual(self.requests[2]["query"]["on_conflict"], "id")
        ids = ",".join(sim.admission(f"p{i}").encounter_id for i in range(2))
        self.assertEqual(self.requests[4]["query"], {"id": f"not.in.({ids})", "status": "eq.in-progress"})
        self.assertEqual(self.requests[4]["body"], {"status": "finished"})
        vitals = self.requests[5]["body"]
        self.assertEqual(len(vitals), 2)
        self.assertEqual(set(vitals[0]), set(VITALS_COLUMNS.values()))
        self.assertTrue(all(r["auth"].startswith("Bearer ") for r in self.requests))


if __name__ == "__main__":
    unittest.main()
