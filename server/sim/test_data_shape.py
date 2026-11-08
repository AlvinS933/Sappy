"""Data shape + loader + simulator function tests.

Run: python3 -m unittest discover server/sim -v   (or: pnpm test:sim)

Sections:
  1. ReadingShapeTests   - each reading has the fields/types NEWS2 scoring will consume
  2. News2FieldTests     - the non-numeric NEWS2 inputs: onOxygen, consciousness
  3. LoaderTests         - load_clean_patients() against small hand-made clean JSON files
  4. SimulatorTests      - simulator behaviour not covered by test_vitals_sim.py
"""

from __future__ import annotations

import json
import math
import re
import statistics
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vitals_sim import (  # noqa: E402
    CONSCIOUSNESS_LEVELS,
    SCENARIOS,
    VITAL_LIMITS,
    VITAL_SIGNS,
    ActiveEvent,
    _consciousness,
    _envelope,
    _scenario_weights,
    load_clean_patients,
)
from _testutil import make_patient, quiet_sim, run  # noqa: E402

ISO_Z = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")

# Hard limits the simulator clamps every reading to.
LIMITS = VITAL_LIMITS
INT_VITALS = ("heartRateBpm", "systolicMmHg", "diastolicMmHg", "spo2Percent", "respiratoryRate")
# Every input NEWS2 scores. (diastolicMmHg is in the reading but NEWS2 doesn't use it.)
NEWS2_KEYS = ("respiratoryRate", "spo2Percent", "onOxygen", "systolicMmHg", "heartRateBpm",
              "consciousness", "temperatureC")


# ------------------------------------------------------------------------------------------------
# 1. Reading shape
# ------------------------------------------------------------------------------------------------

class ReadingShapeTests(unittest.TestCase):
    def test_one_reading_per_patient_in_order(self):
        patients = [make_patient(id=f"p{i}") for i in range(4)]
        readings = quiet_sim(patients).step(5)
        self.assertEqual([r["patientId"] for r in readings], ["p0", "p1", "p2", "p3"])

    def test_required_keys_present(self):
        (r,) = quiet_sim([make_patient()]).step(5)
        for key in ("patientId", "recordedAt", *VITAL_SIGNS, *NEWS2_KEYS):
            self.assertIn(key, r)

    def test_every_vital_has_limits(self):
        # If a vital is added to VITAL_SIGNS, add its limits here too.
        self.assertEqual(set(LIMITS), set(VITAL_SIGNS))

    def test_value_types(self):
        (r,) = quiet_sim([make_patient()]).step(5)
        self.assertIsInstance(r["patientId"], str)
        for k in INT_VITALS:
            self.assertIsInstance(r[k], int, k)
        self.assertIsInstance(r["temperatureC"], float)
        self.assertEqual(r["temperatureC"], round(r["temperatureC"], 1))

    def test_recorded_at_is_iso_utc_and_advances_by_dt(self):
        sim = quiet_sim([make_patient()])
        first = sim.step(5)[0]["recordedAt"]
        second = sim.step(60)[0]["recordedAt"]
        self.assertRegex(first, ISO_Z)
        self.assertEqual(first, "2026-01-01T08:00:05.000Z")
        self.assertEqual(second, "2026-01-01T08:01:05.000Z")

    def test_values_stay_in_range_under_every_scenario(self):
        # Severity 2 pushes every scenario well past its normal range to exercise the clamps.
        patients = [make_patient(id=name) for name in SCENARIOS]
        sim = quiet_sim(patients)
        for name in SCENARIOS:
            sim.trigger(name, name, severity=2)
        for r in run(sim, 4 * 60, dt=30):
            for vital, (lo, hi) in LIMITS.items():
                self.assertGreaterEqual(r[vital], lo, (r["patientId"], vital, r[vital]))
                self.assertLessEqual(r[vital], hi, (r["patientId"], vital, r[vital]))
            self.assertGreaterEqual(r["systolicMmHg"] - r["diastolicMmHg"], 25, r)
            self.assertIn(r["consciousness"], CONSCIOUSNESS_LEVELS, r)
            self.assertIsInstance(r["onOxygen"], bool)

    def test_scenarios_only_touch_known_vitals(self):
        # Catches typos like "spo2" in a scenario's offsets, which would otherwise crash mid-run.
        for name, spec in SCENARIOS.items():
            self.assertLessEqual(set(spec.offsets), set(VITAL_SIGNS), name)

    def test_patient_json_shape(self):
        p = make_patient(conditions=["Hypertension"])
        j = p.to_json()
        # Exact key set: nothing identifying (names, birthDate, room) can sneak in.
        self.assertEqual(set(j), {"id", "ageBand", "gender", "conditions", "medications", "lastVitals"})
        self.assertIsInstance(j["conditions"], list)
        self.assertIn(j["gender"], ("male", "female", "other", "unknown"))


# ------------------------------------------------------------------------------------------------
# 2. Non-numeric NEWS2 inputs: supplemental oxygen + consciousness (ACVPU)
# ------------------------------------------------------------------------------------------------

class News2FieldTests(unittest.TestCase):
    def setUp(self):
        self.sim = quiet_sim([make_patient()])

    def test_defaults_room_air_and_alert(self):
        (r,) = self.sim.step(5)
        self.assertIs(r["onOxygen"], False)
        self.assertEqual(r["consciousness"], "A")

    def test_oxygen_toggle_reflected_in_readings(self):
        self.sim.set_oxygen("p1", True)
        self.assertIs(self.sim.on_oxygen("p1"), True)
        self.assertIs(self.sim.step(5)[0]["onOxygen"], True)
        self.sim.set_oxygen("p1", False)
        self.assertIs(self.sim.step(5)[0]["onOxygen"], False)

    def test_oxygen_value_coerced_to_bool(self):
        self.sim.set_oxygen("p1", 1)
        self.assertIs(self.sim.step(5)[0]["onOxygen"], True)

    def test_oxygen_on_healthy_patient_never_exceeds_100(self):
        self.sim.set_oxygen("p1", True)
        self.assertTrue(all(r["spo2Percent"] <= 100 for r in run(self.sim, 60)))

    def test_oxygen_survives_clear(self):
        # clear() drops scenarios only; the patient stays on oxygen until a nurse takes it off.
        self.sim.set_oxygen("p1", True)
        self.sim.clear("p1")
        self.assertIs(self.sim.step(5)[0]["onOxygen"], True)

    def test_unknown_patient(self):
        for call in (lambda: self.sim.set_oxygen("nope", True), lambda: self.sim.set_consciousness("nope", "A")):
            with self.assertRaises(KeyError):
                call()

    def test_every_consciousness_level_can_be_forced(self):
        for level in CONSCIOUSNESS_LEVELS:
            self.sim.set_consciousness("p1", level)
            self.assertEqual(self.sim.consciousness_override("p1"), level)
            self.assertEqual(self.sim.step(5)[0]["consciousness"], level)

    def test_invalid_consciousness_rejected(self):
        for bad in ("X", "a", "", "Alert"):
            with self.assertRaises(ValueError, msg=bad):
                self.sim.set_consciousness("p1", bad)


class ConsciousnessDerivationTests(unittest.TestCase):
    """_consciousness() thresholds, from the underlying (noise-free) state."""

    NORMAL = {"spo2Percent": 97, "systolicMmHg": 120, "temperatureC": 37}

    def level(self, confused=False, **overrides):
        return _consciousness({**self.NORMAL, **overrides}, confused)

    def test_normal_is_alert(self):
        self.assertEqual(self.level(), "A")

    def test_confusion(self):
        self.assertEqual(self.level(confused=True), "C")
        self.assertEqual(self.level(spo2Percent=83.9), "C")
        self.assertEqual(self.level(systolicMmHg=77.9), "C")
        self.assertEqual(self.level(temperatureC=40.5), "C")

    def test_voice(self):
        self.assertEqual(self.level(spo2Percent=74.9), "V")
        self.assertEqual(self.level(systolicMmHg=64.9), "V")

    def test_boundaries_stay_alert(self):
        self.assertEqual(self.level(spo2Percent=84, systolicMmHg=78, temperatureC=40.4), "A")

    def test_worst_wins(self):
        self.assertEqual(self.level(confused=True, spo2Percent=70), "V")

    def test_sepsis_only_scenario_that_confuses_directly(self):
        self.assertEqual([n for n, s in SCENARIOS.items() if s.confusion_at is not None], ["sepsis"])

    def test_mild_sepsis_does_not_confuse(self):
        # Severity 0.6 never reaches confusion_at=0.8, and vitals alone stay above the C thresholds.
        sim = quiet_sim([make_patient()])
        sim.trigger("p1", "sepsis", severity=0.6)
        self.assertTrue(all(r["consciousness"] == "A" for r in run(sim, 3 * 60)))


# ------------------------------------------------------------------------------------------------
# 3. Loader
# ------------------------------------------------------------------------------------------------

def clean_patient(pid: str, **overrides) -> dict:
    """A patient file as written by server/Synthea_Gen/transform.py."""
    d = {"id": pid, "ageBand": "60-69", "gender": "female", "conditions": [], "medications": [], "observations": []}
    d.update(overrides)
    return d


def obs(code: str, value, category: str = "vital-signs") -> dict:
    return {"code": code, "display": code, "category": category, "value": value, "unit": "", "effectiveDate": "2025-01-01"}


class LoaderTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.patients = [
            clean_patient("id-b", ageBand="70-79"),
            clean_patient(
                "id-a",
                conditions=[
                    {"system": "http://snomed.info/sct", "code": "1", "display": "Essential hypertension (disorder)"},
                    {"system": "http://snomed.info/sct", "code": "2", "display": "Prediabetes (finding)"},
                    {"system": "http://snomed.info/sct", "code": "3", "display": "Essential  hypertension"},  # dup
                ],
                medications=[{"system": "rxnorm", "code": "9", "display": "Metformin 500 MG Oral Tablet"}],
                observations=[
                    obs("8867-4", 88),
                    obs("8480-6", "not-a-number"),
                    obs("59408-5", 96),
                    obs("9279-1", 16),
                    obs("39156-5", 27.1),  # BMI: not a simulated vital, ignored
                    obs("2339-0", 101, "laboratory"),  # glucose: ignored
                ],
            ),
        ]
        self.write()

    def tearDown(self):
        self._tmp.cleanup()

    def write(self):
        for p in self.patients:
            (self.dir / f"{p['id']}.json").write_text(json.dumps(p))

    def load(self) -> dict:
        return {p.id: p for p in load_clean_patients(self.dir)}

    def test_missing_or_empty_dir_raises(self):
        with self.assertRaises(FileNotFoundError):
            load_clean_patients(self.dir / "nope")

    def test_all_patients_loaded_sorted_by_id(self):
        self.assertEqual([p.id for p in load_clean_patients(self.dir)], ["id-a", "id-b"])

    def test_age_band_and_gender_kept(self):
        b = self.load()["id-b"]
        self.assertEqual((b.age_band, b.gender), ("70-79", "female"))

    def test_conditions_tag_stripped_and_deduplicated(self):
        self.assertEqual(self.load()["id-a"].conditions, ["Essential hypertension", "Prediabetes"])

    def test_medications_loaded(self):
        self.assertEqual(self.load()["id-a"].medications, ["Metformin 500 MG Oral Tablet"])

    def test_patient_with_no_conditions_gets_empty_list(self):
        self.assertEqual(self.load()["id-b"].conditions, [])

    def test_vitals_mapped_by_loinc_and_bad_values_skipped(self):
        a = self.load()["id-a"]
        self.assertEqual(a.last_vitals, {"heartRateBpm": 88.0, "spo2Percent": 96.0, "respiratoryRate": 16.0})

    def test_patient_with_no_vitals_gets_empty_dict(self):
        self.assertEqual(self.load()["id-b"].last_vitals, {})

    def test_bed_labels_follow_patient_order_and_are_not_keys(self):
        sim = quiet_sim(load_clean_patients(self.dir))
        self.assertEqual([sim.admission(i).bed_label for i in ("id-a", "id-b")], ["4W-01", "4W-02"])
        self.assertEqual(sim.step(5)[0]["patientId"], "id-a")


# ------------------------------------------------------------------------------------------------
# 4. Simulator functions
# ------------------------------------------------------------------------------------------------

class BaselineTests(unittest.TestCase):
    def test_baseline_independent_of_patient_order(self):
        a, b = make_patient(id="a"), make_patient(id="b")
        self.assertEqual(quiet_sim([a, b]).baseline("a"), quiet_sim([b, a]).baseline("a"))

    def test_baseline_clamps_extreme_synthea_values(self):
        p = make_patient(last_vitals={"heartRateBpm": 150, "systolicMmHg": 80, "diastolicMmHg": 130})
        base = quiet_sim([p]).baseline("p1")
        self.assertEqual(base["heartRateBpm"], 100)
        self.assertEqual(base["systolicMmHg"], 110)
        self.assertLessEqual(base["diastolicMmHg"], base["systolicMmHg"] - 38)

    def test_baseline_without_synthea_vitals(self):
        base = quiet_sim([make_patient(last_vitals={})]).baseline("p1")
        self.assertTrue(58 <= base["heartRateBpm"] <= 100)
        self.assertTrue(110 <= base["systolicMmHg"] <= 160)

    def test_spo2_baseline_by_age_and_lung_disease(self):
        young = quiet_sim([make_patient(age_band="30-39")]).baseline("p1")["spo2Percent"]
        old = quiet_sim([make_patient(age_band="80-89")]).baseline("p1")["spo2Percent"]
        copd = quiet_sim([make_patient(conditions=["Chronic obstructive bronchitis"])]).baseline("p1")["spo2Percent"]
        self.assertTrue(97 <= young <= 99, young)
        self.assertTrue(95.5 <= old <= 97.5, old)
        self.assertTrue(94 <= copd <= 95, copd)

    def test_respiratory_rate_baseline(self):
        normal = quiet_sim([make_patient()]).baseline("p1")["respiratoryRate"]
        self.assertTrue(13 <= normal <= 18, normal)
        fast = quiet_sim([make_patient(last_vitals={"respiratoryRate": 30})]).baseline("p1")["respiratoryRate"]
        slow = quiet_sim([make_patient(last_vitals={"respiratoryRate": 8})]).baseline("p1")["respiratoryRate"]
        self.assertEqual((fast, slow), (18, 13))  # Synthea values clamped to 13-18

    def test_lung_disease_raises_respiratory_rate_capped_at_18(self):
        def rr(value):
            p = make_patient(conditions=["Chronic obstructive bronchitis"], last_vitals={"respiratoryRate": value})
            return quiet_sim([p]).baseline("p1")["respiratoryRate"]

        self.assertEqual(rr(14), 16)
        self.assertEqual(rr(17), 18)

    def test_temperature_baseline_normal(self):
        temp = quiet_sim([make_patient()]).baseline("p1")["temperatureC"]
        self.assertTrue(36.55 <= temp <= 37.05, temp)


class EventTests(unittest.TestCase):
    def setUp(self):
        self.sim = quiet_sim([make_patient()])

    def test_step_rejects_non_positive_dt(self):
        for dt in (0, -5):
            with self.assertRaises(ValueError):
                self.sim.step(dt)

    def test_events_stack(self):
        self.sim.trigger("p1", "fever")
        self.sim.trigger("p1", "hypoxia")
        self.assertEqual(sorted(e.scenario for e in self.sim.active_events("p1")), ["fever", "hypoxia"])

    def test_resolve_single_scenario_leaves_others(self):
        self.sim.trigger("p1", "fever")
        self.sim.trigger("p1", "hypoxia")
        self.sim.resolve("p1", "fever")
        by_name = {e.scenario: e for e in self.sim.active_events("p1")}
        self.assertIsNotNone(by_name["fever"].resolved_at)
        self.assertIsNone(by_name["hypoxia"].resolved_at)

    def test_resolve_unknown_patient(self):
        with self.assertRaises(KeyError):
            self.sim.resolve("nope")

    def test_clear_one_patient_and_all(self):
        sim = quiet_sim([make_patient(id="a"), make_patient(id="b")])
        sim.trigger("a", "fever")
        sim.trigger("b", "fever")
        sim.clear("a")
        self.assertEqual((len(sim.active_events("a")), len(sim.active_events("b"))), (0, 1))
        sim.clear()
        self.assertEqual(len(sim.active_events("b")), 0)

    def test_trigger_overrides_timings(self):
        e = self.sim.trigger("p1", "fever", onset_min=1, hold_min=2, recovery_min=3)
        self.assertEqual((e.onset_min, e.hold_min, e.recovery_min), (1, 2, 3))

    def test_returned_events_are_copies(self):
        self.sim.trigger("p1", "fever").severity = 99
        self.sim.active_events("p1")[0].severity = 99
        self.assertEqual(self.sim.active_events("p1")[0].severity, 1.0)

    def test_higher_severity_bigger_effect(self):
        def mean_sbp(severity):
            sim = quiet_sim([make_patient()])
            sim.trigger("p1", "hypotension", severity=severity)
            run(sim, 15)  # past the 10 min onset
            return statistics.mean(r["systolicMmHg"] for r in run(sim, 20))

        self.assertLess(mean_sbp(1.0), 100)
        self.assertLess(mean_sbp(1.5), mean_sbp(1.0) - 10)

    def test_no_random_events_when_rate_zero(self):
        run(self.sim, 24 * 60, dt=60)
        self.assertEqual(self.sim.active_events("p1"), [])

    def test_event_json(self):
        e = self.sim.trigger("p1", "fever", hold_min=math.inf).to_json()
        self.assertEqual(e["holdMin"], None)
        self.assertEqual(e["resolvedAt"], None)
        self.assertRegex(e["startedAt"], ISO_Z)
        self.sim.step(60)
        self.sim.resolve("p1")
        self.assertRegex(self.sim.active_events("p1")[0].to_json()["resolvedAt"], ISO_Z)


class EnvelopeTests(unittest.TestCase):
    def event(self, **kw):
        fields = dict(scenario="fever", started_at=0, severity=1, onset_min=10, hold_min=20, recovery_min=10)
        fields.update(kw)
        return ActiveEvent(**fields)

    def test_phases(self):
        e = self.event()
        self.assertEqual(_envelope(e, 0), 0)                    # start
        self.assertAlmostEqual(_envelope(e, 5 * 60), 0.5)      # halfway through onset
        self.assertEqual(_envelope(e, 10 * 60), 1)              # end of onset
        self.assertEqual(_envelope(e, 25 * 60), 1)              # holding
        self.assertAlmostEqual(_envelope(e, 35 * 60), 0.5)     # halfway through recovery
        self.assertIsNone(_envelope(e, 40 * 60))                # fully recovered

    def test_resolve_during_onset_recovers_from_partial_level(self):
        e = self.event(resolved_at=5 * 60)
        self.assertAlmostEqual(_envelope(e, 5 * 60), 0.5)
        self.assertLess(_envelope(e, 10 * 60), 0.5)
        self.assertIsNone(_envelope(e, 15 * 60))

    def test_hold_forever(self):
        self.assertEqual(_envelope(self.event(hold_min=math.inf), 10_000 * 60), 1)


class ScenarioWeightTests(unittest.TestCase):
    def test_default_weights_for_no_conditions(self):
        w = _scenario_weights(make_patient())
        self.assertEqual(set(w), set(SCENARIOS))
        self.assertTrue(all(v > 0 for v in w.values()))

    def test_conditions_boost_matching_scenarios(self):
        base = _scenario_weights(make_patient())
        cases = {
            "Chronic obstructive bronchitis": "hypoxia",
            "Coronary heart disease": "tachycardia",
            "Essential hypertension": "hypertensive-crisis",
            "Diabetes mellitus type 2": "sepsis",
        }
        for condition, scenario in cases.items():
            w = _scenario_weights(make_patient(conditions=[condition]))
            self.assertGreater(w[scenario], base[scenario], condition)


if __name__ == "__main__":
    unittest.main()
