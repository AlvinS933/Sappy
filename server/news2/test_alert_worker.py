"""Tests for the NEWS2 alert worker, using an in-memory fake of the supabase client.

    python3 -m unittest server/news2/test_alert_worker.py -v
"""

import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from alert_worker import RESET_AFTER, AlertWorker, reading_from_row  # noqa: E402


class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table, self.filters = db, table, []

    def select(self, _cols):
        return self

    def in_(self, col, values):
        self.filters.append(lambda r: r[col] in values)
        return self

    def insert(self, rows):
        self.db.setdefault(self.table, []).extend(rows)
        return self

    def execute(self):
        rows = [r for r in self.db.get(self.table, []) if all(f(r) for f in self.filters)]
        return type("Resp", (), {"data": rows})()


class FakeClient:
    def __init__(self, db):
        self.db = db

    def table(self, name):
        return FakeQuery(self.db, name)


NORMAL = dict(heart_rate_bpm=75, systolic_mmhg=125, diastolic_mmhg=80, spo2_percent=97,
              temperature_c="36.8", respiratory_rate=16, on_oxygen=False, consciousness="A")
SEPTIC = dict(NORMAL, heart_rate_bpm=125, systolic_mmhg=95, temperature_c="39.2",
              respiratory_rate=26, spo2_percent=93)  # NEWS2 >= 7
PULSE_91 = dict(NORMAL, heart_rate_bpm=91)  # NEWS2 1 -> watch

START = datetime(2026, 1, 1, 8, tzinfo=timezone.utc)


class AlertWorkerTest(unittest.TestCase):
    def setUp(self):
        self.db = {
            "patients": [{"id": "p1", "conditions": []},
                         {"id": "copd", "conditions": ["Chronic obstructive bronchitis (disorder)"]}],
            "vitals": [],  # latest reading per patient, like the real table
            "alerts": [],
        }
        self.worker = AlertWorker(FakeClient(self.db))
        self.worker.load_patients()
        self.tick = {}

    def add(self, pid, **vitals):
        """One simulator tick for `pid`: overwrite their vitals row, then poll."""
        self.tick[pid] = self.tick.get(pid, 0) + 1
        at = (START + timedelta(minutes=15 * self.tick[pid])).isoformat()
        row = {"patient_id": pid, "encounter_id": f"enc-{pid}", "recorded_at": at, **vitals}
        self.db["vitals"] = [r for r in self.db["vitals"] if r["patient_id"] != pid] + [row]
        self.worker.poll_once()

    def tiers(self):
        return [a["tier"] for a in self.db["alerts"]]

    def test_reading_from_row_maps_to_camel_case(self):
        r = reading_from_row({"patient_id": "p1", **NORMAL})
        self.assertEqual(r["patientId"], "p1")
        self.assertEqual(r["temperatureC"], 36.8)
        self.assertIs(r["onOxygen"], False)

    def test_stable_patient_never_alerts(self):
        for _ in range(5):
            self.add("p1", **NORMAL)
        self.assertEqual(self.tiers(), [])

    def test_single_bad_reading_is_suppressed(self):
        self.add("p1", **NORMAL)
        self.add("p1", **dict(NORMAL, spo2_percent=82))  # loose probe
        self.add("p1", **NORMAL)
        self.assertEqual(self.tiers(), [])

    def test_sustained_deterioration_alerts_once(self):
        for _ in range(4):
            self.add("p1", **SEPTIC)
        self.assertEqual(self.tiers(), ["go now"])
        alert = self.db["alerts"][0]
        self.assertEqual(alert["encounter_id"], "enc-p1")
        self.assertGreaterEqual(alert["news2_score"], 7)
        self.assertIn("Respiratory rate", alert["reason"])

    def test_unchanged_row_is_not_scored_twice(self):
        self.add("p1", **SEPTIC)
        self.worker.poll_once()  # same row, polled again (worker polls twice per tick)
        self.assertEqual(self.tiers(), [])  # one reading only: still suppressed

    def test_wobble_across_band_edge_alerts_once(self):
        for v in (PULSE_91, PULSE_91, NORMAL, PULSE_91, PULSE_91, NORMAL, PULSE_91, PULSE_91):
            self.add("p1", **v)
        self.assertEqual(self.tiers(), ["watch"])

    def test_re_escalation_after_real_recovery_alerts_again(self):
        for v in [SEPTIC, SEPTIC] + [NORMAL] * RESET_AFTER + [SEPTIC, SEPTIC]:
            self.add("p1", **v)
        self.assertEqual(self.tiers(), ["go now", "go now"])

    def test_escalating_above_last_alert_is_immediate(self):
        for v in (PULSE_91, PULSE_91, SEPTIC, SEPTIC):
            self.add("p1", **v)
        self.assertEqual(self.tiers(), ["watch", "go now"])

    def test_simulator_restart_starts_patient_over(self):
        self.add("p1", **SEPTIC)
        self.add("p1", **SEPTIC)
        self.tick["p1"] = 0  # sim restarted: clock goes back
        self.add("p1", **SEPTIC)
        self.add("p1", **SEPTIC)
        self.assertEqual(self.tiers(), ["go now", "go now"])

    def test_copd_patient_uses_scale_2(self):
        self.assertEqual(self.worker.monitor.spo2_scale("copd"), 2)
        for _ in range(3):
            self.add("copd", **dict(NORMAL, spo2_percent=89))  # fine on Scale 2
        self.assertEqual(self.tiers(), [])

    def test_unknown_patient_is_loaded_on_first_reading(self):
        self.db["patients"].append({"id": "late", "conditions": ["Emphysema (disorder)"]})
        self.add("late", **NORMAL)
        self.assertEqual(self.worker.monitor.spo2_scale("late"), 2)

    def test_missing_input_is_skipped_not_fatal(self):
        self.add("p1", **dict(NORMAL, spo2_percent=None))
        self.add("p1", **NORMAL)
        self.assertEqual(self.tiers(), [])


if __name__ == "__main__":
    unittest.main()
