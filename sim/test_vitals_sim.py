"""Run: python3 -m unittest discover sim -v"""

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
    DEFAULT_CLEAN_DIR,
    DEMO_TICK_MIN,
    DEMO_WARD,
    VITAL_SIGNS,
    SimPatient,
    VitalsSimulator,
    load_clean_patients,
    schedule_demo,
    select_ward,
)

START = 1767254400.0  # 2026-01-01T08:00:00Z

HEALTHY = SimPatient(
    id="healthy", age_band="40-49", gender="female",
    conditions=[], last_vitals={"heartRateBpm": 70, "systolicMmHg": 120, "diastolicMmHg": 78},
)
HAS_CLEAN_DATA = any(DEFAULT_CLEAN_DIR.glob("*.json"))


def ward(n: int) -> list:
    return [SimPatient(**{**HEALTHY.__dict__, "id": f"p{i}"}) for i in range(n)]


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


class SepsisTimingTests(unittest.TestCase):
    def test_sbp_falls_after_hr_and_temp(self):
        sim = VitalsSimulator([HEALTHY], start_time=START, event_rate_per_hour=0)
        base = sim.baseline("healthy")
        sim.trigger("healthy", "sepsis", onset_min=240, hold_min=math.inf)
        early = run(sim, 150)[-60:]  # ~60% through onset: HR/temp up, SBP lag (75% of onset) not reached
        self.assertGreater(mean(early, "heartRateBpm"), base["heartRateBpm"] + 15)
        self.assertGreater(mean(early, "temperatureC"), base["temperatureC"] + 0.8)
        self.assertLess(abs(mean(early, "systolicMmHg") - base["systolicMmHg"]), 4)
        late = run(sim, 300)[-60:]
        self.assertLess(mean(late, "systolicMmHg"), base["systolicMmHg"] - 20)


class ArtifactTests(unittest.TestCase):
    def test_single_implausible_spo2_reading_then_normal(self):
        sim = VitalsSimulator([HEALTHY], start_time=START, event_rate_per_hour=0)
        run(sim, 10)
        sim.inject_artifact("healthy")
        hr_before = sim.step(5)  # artifact lands on this reading
        (r,) = hr_before
        self.assertTrue(72 <= r["spo2Percent"] <= 80, r)
        self.assertTrue(55 < r["heartRateBpm"] < 90, r)  # heart rate stays normal: it's the probe
        self.assertGreaterEqual(sim.step(5)[0]["spo2Percent"], 94)
        self.assertEqual(len(sim.artifact_log), 1)
        self.assertEqual(sim.artifact_log[0]["recordedAt"], r["recordedAt"])
        self.assertEqual(sim.active_events("healthy"), [])  # physiology untouched

    def test_artifact_on_other_vital_needs_value(self):
        sim = VitalsSimulator([HEALTHY], start_time=START)
        with self.assertRaises(ValueError):
            sim.inject_artifact("healthy", "heartRateBpm")
        with self.assertRaises(ValueError):
            sim.inject_artifact("healthy", "bogus", 1)
        sim.inject_artifact("healthy", "heartRateBpm", 190)
        self.assertEqual(sim.step(5)[0]["heartRateBpm"], 190)


class AdmissionTests(unittest.TestCase):
    def test_encounter_and_bed_per_patient(self):
        sim = VitalsSimulator(ward(3), start_time=START)
        admissions = [sim.admission(f"p{i}") for i in range(3)]
        self.assertEqual([a.bed_label for a in admissions], ["4W-01", "4W-02", "4W-03"])
        self.assertEqual(len({a.encounter_id for a in admissions} | {a.location_id for a in admissions}), 6)
        j = admissions[0].to_json()
        self.assertEqual((j["status"], j["class"], j["location"]["display"]), ("in-progress", "IMP", "4W-01"))
        r = sim.step(5)[0]
        self.assertEqual(r["encounterId"], admissions[0].encounter_id)

    def test_ids_deterministic_given_seed(self):
        a = VitalsSimulator(ward(2), seed=5, start_time=START).admission("p1")
        b = VitalsSimulator(ward(2), seed=5, start_time=START).admission("p1")
        self.assertEqual(a, b)


class WardTests(unittest.TestCase):
    def test_ward_is_five_patients_in_bed_order(self):
        patients = [SimPatient(**{**HEALTHY.__dict__, "id": i}) for i in reversed(DEMO_WARD)] + ward(3)
        chosen, found = select_ward(patients)
        self.assertTrue(found)
        self.assertEqual([p.id for p in chosen], list(DEMO_WARD))
        sim = VitalsSimulator(chosen, start_time=START)
        self.assertEqual(len(sim.step(5)), 5)
        self.assertEqual(schedule_demo(sim), {"sepsis": DEMO_WARD[1], "falseAlarm": DEMO_WARD[3]})

    def test_falls_back_to_first_five_by_id_when_ids_missing(self):
        chosen, found = select_ward(ward(7))
        self.assertFalse(found)
        self.assertEqual([p.id for p in chosen], ["p0", "p1", "p2", "p3", "p4"])

    def test_custom_ids(self):
        chosen, found = select_ward(ward(4), ("p3", "p1"))
        self.assertEqual(([p.id for p in chosen], found), (["p3", "p1"], True))


@unittest.skipUnless(HAS_CLEAN_DATA, "no clean data")
class RealWardTests(unittest.TestCase):
    def test_demo_ward_exists_in_clean_data(self):
        chosen, found = select_ward(load_clean_patients())
        self.assertTrue(found, "DEMO_WARD ids missing from data/clean - regenerated with another seed?")
        self.assertEqual(len(chosen), 5)


class DemoScriptTests(unittest.TestCase):
    def test_demo_one_sepsis_one_false_alarm_rest_stable(self):
        sim = VitalsSimulator(ward(6), start_time=START, event_rate_per_hour=0)
        truth = schedule_demo(sim)
        self.assertEqual(truth, {"sepsis": "p1", "falseAlarm": "p3"})
        readings = []
        for _ in range(8 * 60 // DEMO_TICK_MIN):
            readings.extend(sim.step(DEMO_TICK_MIN * 60))
        by_patient = {f"p{i}": [r for r in readings if r["patientId"] == f"p{i}"] for i in range(6)}

        self.assertEqual([e.scenario for e in sim.active_events("p1")], ["sepsis"])
        self.assertGreater(mean(by_patient["p1"][-4:], "heartRateBpm"), 95)
        self.assertEqual([(a["patientId"], a["vital"]) for a in sim.artifact_log], [("p3", "spo2Percent")])
        low = [r for r in by_patient["p3"] if r["spo2Percent"] < 90]
        self.assertEqual(len(low), 1)
        self.assertEqual(low[0]["recordedAt"], "2026-01-01T10:30:00.000Z")  # +2.5 h
        for pid in ("p0", "p2", "p4", "p5"):
            self.assertEqual(sim.active_events(pid), [])
            self.assertTrue(all(r["spo2Percent"] >= 93 and r["consciousness"] == "A" for r in by_patient[pid]))


@unittest.skipUnless(HAS_CLEAN_DATA, "no clean data - run Synthea_Gen/synthea.py and Synthea_Gen/transform.py")
class CleanLoaderTests(unittest.TestCase):
    def test_loads_scrubbed_patients(self):
        patients = load_clean_patients()
        self.assertGreater(len(patients), 0)
        self.assertEqual([p.id for p in patients], sorted(p.id for p in patients))
        for p in patients:
            j = p.to_json()
            self.assertEqual(set(j), {"id", "ageBand", "gender", "conditions", "medications", "lastVitals"})
            self.assertRegex(p.age_band, r"^\d0-\d9$|^90\+$")
            self.assertFalse(any("(" in c for c in p.conditions), p.conditions)

    def test_missing_dir_raises(self):
        with self.assertRaises(FileNotFoundError):
            load_clean_patients(DEFAULT_CLEAN_DIR / "nope")


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from cli import SimServer

        sim = VitalsSimulator(ward(3), start_time=START, event_rate_per_hour=0)
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
        self.assertEqual(patients[0]["encounter"]["location"]["display"], "4W-01")
        self.assertNotIn("firstName", patients[0])
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

    def test_artifact_endpoint(self):
        self.assertEqual(self.request("/patients/p2/artifact", {})[0], 200)
        self.assertEqual(self.request("/patients/p2/artifact", {"vital": "heartRateBpm", "value": 190})[0], 200)
        self.assertEqual(self.request("/patients/p2/artifact", {"vital": "heartRateBpm"})[0], 400)
        self.assertEqual(self.request("/patients/nope/artifact", {})[0], 404)

    def test_sse_stream(self):
        with urllib.request.urlopen(self.base + "/stream", timeout=5) as resp:
            self.assertEqual(resp.headers["Content-Type"], "text/event-stream")
            line = resp.readline().decode()
            self.assertTrue(line.startswith("data: "), line)
            self.assertIn("patientId", json.loads(line[6:])[0])


if __name__ == "__main__":
    unittest.main()
