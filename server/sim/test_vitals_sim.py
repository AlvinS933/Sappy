"""Run: python3 -m unittest discover server/sim -v"""

from __future__ import annotations

import json
import math
import statistics
import sys
import threading
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vitals_sim import (  # noqa: E402
    DEFAULT_CSV_DIR,
    VITAL_SIGNS,
    SimPatient,
    VitalsSimulator,
    load_synthea_patients,
)

START = 1767254400.0  # 2026-01-01T08:00:00Z

HEALTHY = SimPatient(
    id="healthy", first_name="Test", last_name="Healthy", room="1", birth_date="1980-01-01", gender="F",
    conditions=[], last_vitals={"heartRateBpm": 70, "systolicMmHg": 120, "diastolicMmHg": 78},
)


def run(sim: VitalsSimulator, minutes: float) -> list:
    """Run `minutes` of sim time in 5 s steps and return every reading."""
    out = []
    for _ in range(int(minutes * 60 / 5)):
        out.extend(sim.step(5))
    return out


def mean(readings: list, key: str) -> float:
    return statistics.mean(r[key] for r in readings)


class SimulatorTests(unittest.TestCase):
    def test_same_seed_identical_readings(self):
        a = VitalsSimulator([HEALTHY], seed=7, start_time=START)
        b = VitalsSimulator([HEALTHY], seed=7, start_time=START)
        self.assertEqual(run(a, 30), run(b, 30))

    def test_reading_shape(self):
        sim = VitalsSimulator([HEALTHY], start_time=START)
        (r,) = sim.step(5)
        self.assertEqual(r["patientId"], "healthy")
        self.assertEqual(r["recordedAt"], "2026-01-01T08:00:05.000Z")
        for k in VITAL_SIGNS:
            self.assertIsInstance(r[k], (int, float), k)
        self.assertIsInstance(r["heartRateBpm"], int)
        self.assertIsInstance(r["respiratoryRate"], int)
        self.assertGreaterEqual(r["systolicMmHg"] - r["diastolicMmHg"], 25)
        self.assertIs(r["onOxygen"], False)
        self.assertEqual(r["consciousness"], "A")

    def test_healthy_patient_stays_in_normal_range_for_8h(self):
        sim = VitalsSimulator([HEALTHY], start_time=START, event_rate_per_hour=0)
        readings = run(sim, 8 * 60)
        for r in readings:
            self.assertTrue(50 < r["heartRateBpm"] < 110, r)
            self.assertTrue(100 < r["systolicMmHg"] < 180, r)
            self.assertTrue(93 < r["spo2Percent"] <= 100, r)
            self.assertTrue(35.5 < r["temperatureC"] < 38, r)
            self.assertTrue(8 < r["respiratoryRate"] < 21, r)
            self.assertEqual(r["consciousness"], "A", r)
        self.assertLess(abs(mean(readings, "spo2Percent") - sim.baseline("healthy")["spo2Percent"]), 1)

    def test_sepsis_deteriorates_then_recovers(self):
        sim = VitalsSimulator([HEALTHY], start_time=START, event_rate_per_hour=0)
        base = sim.baseline("healthy")
        run(sim, 10)
        sim.trigger("healthy", "sepsis")

        peak = run(sim, 90)[-60:]
        self.assertGreater(mean(peak, "heartRateBpm"), base["heartRateBpm"] + 25)
        self.assertLess(mean(peak, "systolicMmHg"), base["systolicMmHg"] - 20)
        self.assertGreater(mean(peak, "temperatureC"), 38.3)
        self.assertGreater(mean(peak, "respiratoryRate"), base["respiratoryRate"] + 7)
        self.assertTrue(all(r["consciousness"] == "C" for r in peak))

        after = run(sim, 4 * 60)[-60:]
        self.assertEqual(sim.active_events("healthy"), [])
        self.assertLess(abs(mean(after, "heartRateBpm") - base["heartRateBpm"]), 4)
        self.assertLess(abs(mean(after, "temperatureC") - base["temperatureC"]), 0.2)
        self.assertLess(abs(mean(after, "respiratoryRate") - base["respiratoryRate"]), 2)
        self.assertTrue(all(r["consciousness"] == "A" for r in after))

    def test_oxygen_raises_spo2(self):
        sim = VitalsSimulator([HEALTHY], start_time=START, event_rate_per_hour=0)
        sim.trigger("healthy", "hypoxia", hold_min=math.inf)
        on_air = run(sim, 30)[-60:]
        sim.set_oxygen("healthy", True)
        on_o2 = run(sim, 30)[-60:]
        self.assertGreater(mean(on_o2, "spo2Percent"), mean(on_air, "spo2Percent") + 4)
        self.assertTrue(all(r["onOxygen"] for r in on_o2))
        self.assertTrue(all(r["spo2Percent"] <= 100 for r in on_o2))
        sim.set_oxygen("healthy", False)
        self.assertIs(sim.step(5)[0]["onOxygen"], False)

    def test_consciousness_from_severe_hypoxia_and_override(self):
        sim = VitalsSimulator([HEALTHY], start_time=START, event_rate_per_hour=0)
        sim.trigger("healthy", "hypoxia", severity=1.8, hold_min=math.inf)  # SpO2 ~80%
        self.assertEqual(run(sim, 30)[-1]["consciousness"], "C")
        sim.set_consciousness("healthy", "P")
        self.assertEqual(sim.step(5)[0]["consciousness"], "P")
        sim.set_consciousness("healthy", None)
        self.assertEqual(sim.step(5)[0]["consciousness"], "C")
        with self.assertRaises(ValueError):
            sim.set_consciousness("healthy", "X")

    def test_hold_until_resolved(self):
        sim = VitalsSimulator([HEALTHY], start_time=START, event_rate_per_hour=0)
        sim.trigger("healthy", "hypoxia", hold_min=math.inf)
        self.assertLess(mean(run(sim, 6 * 60)[-60:], "spo2Percent"), 90)
        sim.resolve("healthy")
        run(sim, 30)
        self.assertEqual(sim.active_events("healthy"), [])

    def test_random_events_occur(self):
        patients = [SimPatient(**{**HEALTHY.__dict__, "id": f"p{i}"}) for i in range(20)]
        sim = VitalsSimulator(patients, start_time=START, event_rate_per_hour=0.5)
        seen = set()
        for _ in range(4 * 3600 // 5):
            sim.step(5)
            for p in patients:
                seen.update((p.id, e.started_at) for e in sim.active_events(p.id))
        self.assertGreater(len(seen), 5)

    def test_unknown_inputs(self):
        sim = VitalsSimulator([HEALTHY], start_time=START)
        with self.assertRaises(KeyError):
            sim.trigger("nope", "sepsis")
        with self.assertRaises(ValueError):
            sim.trigger("healthy", "zombie")


@unittest.skipUnless((DEFAULT_CSV_DIR / "patients.csv").exists(), "no Synthea data - run server/Synthea_Gen/synthea.py")
class SyntheaLoaderTests(unittest.TestCase):
    def test_loads_patients(self):
        patients = load_synthea_patients()
        self.assertGreater(len(patients), 0)
        self.assertEqual([p.room for p in patients], [str(401 + i) for i in range(len(patients))])
        for p in patients:
            self.assertNotRegex(p.first_name + p.last_name, r"\d")
            self.assertFalse(any("(finding)" in c for c in p.conditions))


@unittest.skipUnless((DEFAULT_CSV_DIR / "patients.csv").exists(), "no Synthea data - run server/Synthea_Gen/synthea.py")
class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from cli import SimServer

        sim = VitalsSimulator(load_synthea_patients(), start_time=START, event_rate_per_hour=0)
        cls.server = SimServer(("127.0.0.1", 0), sim, interval_sec=0.05, speed=1)
        cls.server.start_ticking()
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def request(self, path, body=None):
        req = urllib.request.Request(
            self.base + path,
            data=None if body is None else json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def test_patients_and_vitals(self):
        status, patients = self.request("/patients")
        self.assertEqual(status, 200)
        self.assertIn("baseline", patients[0])
        status, vitals = self.request("/vitals")
        self.assertEqual(status, 200)
        self.assertEqual(len(vitals), len(patients))

    def test_trigger_and_resolve(self):
        _, patients = self.request("/patients")
        pid = patients[0]["id"]
        status, event = self.request(f"/patients/{pid}/trigger", {"scenario": "fever", "untilResolved": True})
        self.assertEqual((status, event["scenario"], event["holdMin"]), (200, "fever", None))
        self.assertEqual(self.request(f"/patients/{pid}/resolve", {})[0], 200)
        self.assertEqual(self.request("/patients/nope/trigger", {"scenario": "fever"})[0], 404)
        self.assertEqual(self.request(f"/patients/{pid}/trigger", {"scenario": "zombie"})[0], 400)
        self.assertEqual(self.request(f"/patients/{pid}/trigger", {})[0], 400)

    def test_oxygen_and_consciousness(self):
        _, patients = self.request("/patients")
        pid = patients[1]["id"]
        self.assertEqual(self.request(f"/patients/{pid}/oxygen", {"on": True})[0], 200)
        self.assertEqual(self.request(f"/patients/{pid}/consciousness", {"level": "V"})[0], 200)
        _, patients = self.request("/patients")
        p = next(p for p in patients if p["id"] == pid)
        self.assertEqual((p["onOxygen"], p["consciousnessOverride"]), (True, "V"))
        self.assertEqual(self.request(f"/patients/{pid}/consciousness", {"level": None})[0], 200)
        self.assertEqual(self.request(f"/patients/{pid}/oxygen", {"on": "yes"})[0], 400)
        self.assertEqual(self.request(f"/patients/{pid}/consciousness", {"level": "X"})[0], 400)
        self.assertEqual(self.request(f"/patients/{pid}/consciousness", {})[0], 400)

    def test_sse_stream(self):
        with urllib.request.urlopen(self.base + "/stream", timeout=5) as resp:
            self.assertEqual(resp.headers["Content-Type"], "text/event-stream")
            line = resp.readline().decode()
            self.assertTrue(line.startswith("data: "), line)
            self.assertIn("patientId", json.loads(line[6:])[0])


if __name__ == "__main__":
    unittest.main()
