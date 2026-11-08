"""Tests for the NEWS2 alert worker, using an in-memory fake of the supabase client.

    python3 -m unittest server/news2/test_alert_worker.py -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from alert_worker import AlertWorker, reading_from_row  # noqa: E402


class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table, self.filters = db, table, []
        self._order, self._desc, self._limit = None, False, None

    def select(self, _cols):
        return self

    def in_(self, col, values):
        self.filters.append(lambda r: r[col] in values)
        return self

    def gt(self, col, value):
        self.filters.append(lambda r: r[col] > value)
        return self

    def order(self, col, desc=False):
        self._order, self._desc = col, desc
        return self

    def limit(self, n):
        self._limit = n
        return self

    def insert(self, rows):
        self.db.setdefault(self.table, []).extend(rows)
        return self

    def execute(self):
        rows = [r for r in self.db.get(self.table, []) if all(f(r) for f in self.filters)]
        if self._order:
            rows.sort(key=lambda r: r[self._order], reverse=self._desc)
        if self._limit is not None:
            rows = rows[: self._limit]
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


class AlertWorkerTest(unittest.TestCase):
    def setUp(self):
        self.db = {
            "patients": [{"id": "p1", "conditions": []},
                         {"id": "copd", "conditions": ["Chronic obstructive bronchitis (disorder)"]}],
            "vitals": [],
            "alerts": [],
        }
        self.worker = AlertWorker(FakeClient(self.db))
        self.worker.load_patients()

    def add(self, pid, **vitals):
        row = {"id": len(self.db["vitals"]) + 1, "patient_id": pid, "encounter_id": f"enc-{pid}",
               "recorded_at": "2026-01-01T08:00:00Z", **vitals}
        self.db["vitals"].append(row)
        self.worker.poll_once()

    def test_reading_from_row_maps_to_camel_case(self):
        r = reading_from_row({"patient_id": "p1", **NORMAL})
        self.assertEqual(r["patientId"], "p1")
        self.assertEqual(r["temperatureC"], 36.8)
        self.assertIs(r["onOxygen"], False)

    def test_stable_patient_never_alerts(self):
        for _ in range(5):
            self.add("p1", **NORMAL)
        self.assertEqual(self.db["alerts"], [])

    def test_single_bad_reading_is_suppressed(self):
        self.add("p1", **NORMAL)
        self.add("p1", **dict(NORMAL, spo2_percent=82))  # loose probe
        self.add("p1", **NORMAL)
        self.assertEqual(self.db["alerts"], [])

    def test_sustained_deterioration_alerts_once(self):
        for _ in range(4):
            self.add("p1", **SEPTIC)
        self.assertEqual(len(self.db["alerts"]), 1)
        alert = self.db["alerts"][0]
        self.assertEqual(alert["tier"], "go now")
        self.assertEqual(alert["encounter_id"], "enc-p1")
        self.assertGreaterEqual(alert["news2_score"], 7)
        self.assertIn("Respiratory rate", alert["reason"])

    def test_re_escalation_after_recovery_alerts_again(self):
        for v in (SEPTIC, SEPTIC, NORMAL, SEPTIC, SEPTIC):
            self.add("p1", **v)
        self.assertEqual([a["tier"] for a in self.db["alerts"]], ["go now", "go now"])

    def test_copd_patient_uses_scale_2(self):
        self.assertEqual(self.worker.monitor.spo2_scale("copd"), 2)
        for _ in range(3):
            self.add("copd", **dict(NORMAL, spo2_percent=89))  # fine on Scale 2
        self.assertEqual(self.db["alerts"], [])

    def test_unknown_patient_is_loaded_on_first_reading(self):
        self.db["patients"].append({"id": "late", "conditions": ["Emphysema (disorder)"]})
        self.add("late", **NORMAL)
        self.assertEqual(self.worker.monitor.spo2_scale("late"), 2)

    def test_missing_input_is_skipped_not_fatal(self):
        self.add("p1", **dict(NORMAL, spo2_percent=None))
        self.add("p1", **NORMAL)
        self.assertEqual(self.worker.last_vitals_id, 2)
        self.assertEqual(self.db["alerts"], [])

    def test_skip_backlog_starts_after_latest_row(self):
        self.db["vitals"] = [{"id": 41}, {"id": 42}]
        self.worker.skip_backlog()
        self.assertEqual(self.worker.last_vitals_id, 42)


if __name__ == "__main__":
    unittest.main()
