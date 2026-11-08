"""Continuous bedside-vitals simulator (pipeline step 3: simulate).

Loads scrubbed patients from data/clean/ (written by Synthea_Gen/transform.py - no names,
birthdates or addresses), admits each one (an in-progress inpatient Encounter + a bed Location,
whose bed number is a display label only), then produces a live vitals stream.

Synthea records almost no SpO2/temperature, so each vital wanders around a per-patient baseline
(Ornstein-Uhlenbeck process) plus measurement noise. "Scenarios" (sepsis, hypoxia, ...) push vitals
away from baseline with an onset -> hold -> recovery envelope; "artifacts" replace a single reading
with an implausible value (e.g. a loose SpO2 probe) without touching the patient's physiology.
Everything is deterministic given a seed.

Standard library only; Python 3.9+.

    from vitals_sim import VitalsSimulator, load_clean_patients

    sim = VitalsSimulator(load_clean_patients(), seed=1984, event_rate_per_hour=0)
    sim.trigger(sim.patients[0].id, "sepsis")
    sim.inject_artifact(sim.patients[1].id)          # one-off SpO2 dip, next reading only
    for readings in sim.stream(interval_sec=2, speed=450):
        ...

Readings are dicts with camelCase keys matching `VitalsReading` in packages/shared, so they can be
sent to the apps as JSON unchanged.
"""

from __future__ import annotations

import json
import math
import random
import re
import sys
import time
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Dict, Iterator, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
if str(REPO_ROOT) not in sys.path:
    sys.path.append(str(REPO_ROOT))  # for pylib/, shared with Synthea_Gen/
from pylib.loinc import VITAL_LOINC  # noqa: E402

DEFAULT_CLEAN_DIR = REPO_ROOT / "data" / "clean"

# Continuous vitals. Readings also carry `onOxygen` (bool) and `consciousness` (ACVPU letter).
VITAL_SIGNS = ("heartRateBpm", "systolicMmHg", "diastolicMmHg", "spo2Percent", "temperatureC", "respiratoryRate")

# ACVPU: Alert, new Confusion, responds to Voice, responds to Pain, Unresponsive.
CONSCIOUSNESS_LEVELS = ("A", "C", "V", "P", "U")

# On supplemental oxygen, SpO2 closes this fraction of its gap to 99.5% (hypoxic 88% -> ~95%).
OXYGEN_EFFECT = 0.6

# Every simulated stay is an in-progress inpatient Encounter (FHIR status + class).
ENCOUNTER_STATUS = "in-progress"
ENCOUNTER_CLASS = "IMP"

Vitals = Dict[str, float]
Reading = Dict[str, object]


# ------------------------------------------------------------------------------------------------
# Patients (scrubbed, from data/clean/)
# ------------------------------------------------------------------------------------------------

@dataclass
class SimPatient:
    """A scrubbed patient: pseudonymous id + age band, never names/birthdate/address (CLAUDE.md)."""

    id: str  # pseudonymous Synthea Patient.id (random UUID)
    age_band: str  # "70-79", "90+"
    gender: str  # FHIR AdministrativeGender: "male" | "female" | "other" | "unknown"
    conditions: List[str] = field(default_factory=list)  # active condition names
    medications: List[str] = field(default_factory=list)  # active medication names
    last_vitals: Vitals = field(default_factory=dict)  # most recent Synthea values (any may be missing)

    @property
    def approx_age(self) -> float:
        """Middle of the age band (used for age-dependent baselines)."""
        m = re.match(r"(\d+)", self.age_band)
        low = int(m.group(1)) if m else 50
        return low + (2 if self.age_band.endswith("+") else 4.5)

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "ageBand": self.age_band,
            "gender": self.gender,
            "conditions": self.conditions,
            "medications": self.medications,
            "lastVitals": self.last_vitals,
        }

    def to_row(self) -> dict:
        """Row for the Supabase `patients` table."""
        return {
            "id": self.id,
            "age_band": self.age_band,
            "gender": self.gender,
            "conditions": self.conditions,
            "medications": self.medications,
        }


@dataclass(frozen=True)
class Admission:
    """In-progress inpatient Encounter (class IMP) at a bed Location. The bed label is display-only;
    everything is keyed on patient/encounter ids, since patients transfer and beds get reused."""

    encounter_id: str
    location_id: str
    bed_label: str

    def to_json(self) -> dict:
        return {
            "id": self.encounter_id,
            "status": ENCOUNTER_STATUS,
            "class": ENCOUNTER_CLASS,
            "location": {"id": self.location_id, "display": self.bed_label},
        }

    def to_row(self, patient_id: str) -> dict:
        """Row for the Supabase `encounters` table."""
        return {
            "id": self.encounter_id,
            "patient_id": patient_id,
            "status": ENCOUNTER_STATUS,
            "class": ENCOUNTER_CLASS,
            "location_id": self.location_id,
            "bed_label": self.bed_label,
        }


_SEMANTIC_TAG = re.compile(r"\s*\((disorder|finding|situation|person|morphologic abnormality)\)\s*$")


def _plain_name(display: str) -> str:
    """'Essential hypertension (disorder)' -> 'Essential hypertension'."""
    return re.sub(r"\s{2,}", " ", _SEMANTIC_TAG.sub("", display)).strip()


def load_clean_patients(clean_dir: Path | str = DEFAULT_CLEAN_DIR) -> List[SimPatient]:
    """Load scrubbed patients written by Synthea_Gen/transform.py, sorted by id (stable order)."""
    files = sorted(Path(clean_dir).glob("*.json"))
    if not files:
        raise FileNotFoundError(
            f"no clean patients in {clean_dir} - run Synthea_Gen/synthea.py then Synthea_Gen/transform.py"
        )
    patients = []
    for path in files:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        last_vitals: Vitals = {}
        for o in d.get("observations") or []:
            vital = VITAL_LOINC.get(o.get("code"))
            if vital and isinstance(o.get("value"), (int, float)) and not isinstance(o.get("value"), bool):
                last_vitals[vital] = float(o["value"])
        patients.append(SimPatient(
            id=d["id"],
            age_band=d["ageBand"],
            gender=d.get("gender", "unknown"),
            conditions=sorted({_plain_name(c["display"]) for c in d.get("conditions") or [] if c.get("display")}),
            medications=sorted({m["display"] for m in d.get("medications") or [] if m.get("display")}),
            last_vitals=last_vitals,
        ))
    return sorted(patients, key=lambda p: p.id)


# ------------------------------------------------------------------------------------------------
# Scenarios
# ------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class ScenarioSpec:
    label: str
    offsets: Vitals  # shift from baseline at severity 1
    onset_min: float
    hold_min: float
    recovery_min: float
    # Event intensity (severity x envelope) at which the patient becomes newly confused, if ever.
    confusion_at: Optional[float] = None
    # Per-vital delay as a fraction of onset_min, for vitals that change late (e.g. BP in sepsis).
    lag: Dict[str, float] = field(default_factory=dict)

    @property
    def max_lag(self) -> float:
        return max(self.lag.values(), default=0.0)


SCENARIOS: Dict[str, ScenarioSpec] = {
    "hypoxia": ScenarioSpec(
        "Hypoxia", {"spo2Percent": -10, "heartRateBpm": 18, "respiratoryRate": 8}, 8, 20, 15
    ),
    "fever": ScenarioSpec(
        "Fever", {"temperatureC": 1.8, "heartRateBpm": 15, "respiratoryRate": 3}, 30, 60, 60
    ),
    "sepsis": ScenarioSpec(
        "Sepsis",
        {"temperatureC": 2.0, "heartRateBpm": 35, "systolicMmHg": -30, "diastolicMmHg": -18, "spo2Percent": -4,
         "respiratoryRate": 10},
        45, 90, 120,
        confusion_at=0.8,
        # HR, RR and temp rise first; SpO2 drifts down a bit later; SBP falls late.
        lag={"spo2Percent": 0.25, "systolicMmHg": 0.75, "diastolicMmHg": 0.75},
    ),
    "tachycardia": ScenarioSpec(
        "Tachycardia", {"heartRateBpm": 50, "systolicMmHg": -8, "respiratoryRate": 2}, 2, 20, 10
    ),
    "hypotension": ScenarioSpec(
        "Hypotension", {"systolicMmHg": -35, "diastolicMmHg": -20, "heartRateBpm": 25, "respiratoryRate": 4},
        10, 30, 30,
    ),
    "hypertensive-crisis": ScenarioSpec(
        "Hypertensive crisis", {"systolicMmHg": 55, "diastolicMmHg": 28, "heartRateBpm": 8}, 15, 30, 45
    ),
}


@dataclass
class ActiveEvent:
    scenario: str
    started_at: float  # sim-clock epoch seconds
    severity: float
    onset_min: float
    hold_min: float  # math.inf = hold until resolve()
    recovery_min: float
    resolved_at: Optional[float] = None  # set by resolve(): recovery starts here instead of after hold

    def to_json(self) -> dict:
        """camelCase dict for the apps (holdMin is null when holding until resolved)."""
        return {
            "scenario": self.scenario,
            "startedAt": _iso(self.started_at),
            "severity": self.severity,
            "onsetMin": self.onset_min,
            "holdMin": None if math.isinf(self.hold_min) else self.hold_min,  # JSON has no Infinity
            "recoveryMin": self.recovery_min,
            "resolvedAt": None if self.resolved_at is None else _iso(self.resolved_at),
        }


# ------------------------------------------------------------------------------------------------
# Dynamics
# ------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class _Dynamics:
    sd: float  # stationary SD of physiological wander around target
    tau_sec: float  # mean-reversion time constant
    noise: float  # measurement noise SD (added to readings, not state)
    lo: float
    hi: float
    decimals: int


_DYNAMICS = {
    "heartRateBpm": _Dynamics(3, 120, 1, 30, 200, 0),
    "systolicMmHg": _Dynamics(4, 300, 2, 60, 240, 0),
    "diastolicMmHg": _Dynamics(3, 300, 1.5, 30, 140, 0),
    "spo2Percent": _Dynamics(0.7, 60, 0.4, 70, 100, 0),
    "temperatureC": _Dynamics(0.08, 900, 0.03, 34, 42, 1),
    "respiratoryRate": _Dynamics(0.9, 180, 0.5, 6, 50, 0),
}

# Hard limits every reading is clamped to.
VITAL_LIMITS: Dict[str, Tuple[float, float]] = {v: (d.lo, d.hi) for v, d in _DYNAMICS.items()}

# Default value range for inject_artifact() per vital (other vitals need an explicit value).
_ARTIFACT_RANGES: Dict[str, Tuple[int, int]] = {
    "spo2Percent": (72, 80),  # probe slipping: sudden, deep, with a normal heart rate
}

_CHRONIC_LUNG = re.compile(r"copd|chronic obstructive|emphysema|asthma|pulmonary fibrosis", re.I)
_CARDIAC = re.compile(r"heart|myocardial|coronary|atrial|cardi", re.I)
_HYPERTENSION = re.compile(r"hypertension", re.I)
_INFECTION_RISK = re.compile(r"diabetes|sepsis|kidney|urinary tract|neoplasm|transplant", re.I)


@dataclass
class _PatientState:
    patient: SimPatient
    admission: Admission
    baseline: Vitals
    state: Vitals
    events: List[ActiveEvent] = field(default_factory=list)
    on_oxygen: bool = False
    consciousness_override: Optional[str] = None  # None = derived from physiology
    pending_artifacts: Dict[str, float] = field(default_factory=dict)  # vital -> value for next reading


# ------------------------------------------------------------------------------------------------
# Simulator
# ------------------------------------------------------------------------------------------------

class VitalsSimulator:
    """Seeded, deterministic vitals generator. Same seed + same calls => same readings.

    Not thread-safe: if you call it from several threads (e.g. a web server), hold a lock.
    """

    def __init__(
        self,
        patients: List[SimPatient],
        seed: int = 1984,
        start_time: Optional[float] = None,
        event_rate_per_hour: float = 0.15,
    ) -> None:
        """
        :param start_time: sim clock start, epoch seconds (default: now)
        :param event_rate_per_hour: random (untriggered) events per patient per sim-hour; 0 disables
        """
        self._rng = random.Random(seed)
        self._event_rate = event_rate_per_hour
        self._clock = time.time() if start_time is None else float(start_time)
        self._patients: Dict[str, _PatientState] = {}
        self._scheduled: List[Tuple[float, Callable[["VitalsSimulator"], None]]] = []  # (due, action)
        self._artifact_log: List[dict] = []
        for i, p in enumerate(patients):
            # Baselines depend only on (seed, patient id) so they're stable regardless of list order.
            baseline = _derive_baseline(p, random.Random(f"{seed}:{p.id}"))
            ids = random.Random(f"{seed}:admission:{p.id}")
            admission = Admission(
                encounter_id=str(uuid.UUID(int=ids.getrandbits(128), version=4)),
                location_id=str(uuid.UUID(int=ids.getrandbits(128), version=4)),
                bed_label=f"4W-{i + 1:02d}",
            )
            self._patients[p.id] = _PatientState(p, admission, baseline, dict(baseline))

    @property
    def now(self) -> float:
        """Current sim time (epoch seconds)."""
        return self._clock

    @property
    def patients(self) -> List[SimPatient]:
        return [s.patient for s in self._patients.values()]

    def baseline(self, patient_id: str) -> Vitals:
        return dict(self._get(patient_id).baseline)

    def admission(self, patient_id: str) -> Admission:
        return self._get(patient_id).admission

    @property
    def artifact_log(self) -> List[dict]:
        """Ground truth for every artifact emitted so far: [{patientId, vital, value, recordedAt}]."""
        return [dict(a) for a in self._artifact_log]

    def inject_artifact(self, patient_id: str, vital: str = "spo2Percent", value: Optional[float] = None) -> None:
        """Replace the patient's *next* reading of `vital` with a one-off implausible value - a false
        alarm such as a loose SpO2 probe. Physiology is untouched, so the reading after is normal."""
        state = self._get(patient_id)
        if vital not in VITAL_SIGNS:
            raise ValueError(f"unknown vital {vital!r}; expected one of {VITAL_SIGNS}")
        if value is None:
            if vital not in _ARTIFACT_RANGES:
                raise ValueError(f"pass a value for artifacts on {vital} (defaults exist for {sorted(_ARTIFACT_RANGES)})")
            value = self._rng.randint(*_ARTIFACT_RANGES[vital])
        state.pending_artifacts[vital] = value

    def schedule(self, after_min: float, action: Callable[["VitalsSimulator"], None]) -> None:
        """Run `action(sim)` at the first step whose sim time reaches now + after_min (for scripts)."""
        self._scheduled.append((self._clock + after_min * 60, action))
        self._scheduled.sort(key=lambda t: t[0])  # stable: same-time actions run in schedule order

    def active_events(self, patient_id: str) -> List[ActiveEvent]:
        return [replace(e) for e in self._get(patient_id).events]

    def trigger(
        self,
        patient_id: str,
        scenario: str,
        severity: float = 1.0,
        onset_min: Optional[float] = None,
        hold_min: Optional[float] = None,
        recovery_min: Optional[float] = None,
    ) -> ActiveEvent:
        """Start a deterioration scenario (stacks with any already running).
        Pass hold_min=math.inf to hold until resolve()."""
        if scenario not in SCENARIOS:
            raise ValueError(f"unknown scenario {scenario!r}; expected one of {sorted(SCENARIOS)}")
        spec = SCENARIOS[scenario]
        event = ActiveEvent(
            scenario=scenario,
            started_at=self._clock,
            severity=severity,
            onset_min=spec.onset_min if onset_min is None else onset_min,
            hold_min=spec.hold_min if hold_min is None else hold_min,
            recovery_min=spec.recovery_min if recovery_min is None else recovery_min,
        )
        self._get(patient_id).events.append(event)
        return replace(event)

    def resolve(self, patient_id: str, scenario: Optional[str] = None) -> None:
        """Begin recovery now (e.g. after a nurse intervenes) for all events, or one scenario."""
        for e in self._get(patient_id).events:
            if (scenario is None or e.scenario == scenario) and e.resolved_at is None:
                e.resolved_at = self._clock

    def on_oxygen(self, patient_id: str) -> bool:
        return self._get(patient_id).on_oxygen

    def set_oxygen(self, patient_id: str, on: bool) -> None:
        """Start/stop supplemental oxygen. Raises SpO2 toward 99.5% (see OXYGEN_EFFECT) while on."""
        self._get(patient_id).on_oxygen = bool(on)

    def consciousness_override(self, patient_id: str) -> Optional[str]:
        return self._get(patient_id).consciousness_override

    def set_consciousness(self, patient_id: str, level: Optional[str]) -> None:
        """Force an ACVPU level ("A", "C", "V", "P", "U"), or None to go back to deriving it."""
        if level is not None and level not in CONSCIOUSNESS_LEVELS:
            raise ValueError(f"unknown consciousness level {level!r}; expected one of {CONSCIOUSNESS_LEVELS}")
        self._get(patient_id).consciousness_override = level

    def clear(self, patient_id: Optional[str] = None) -> None:
        """Drop events immediately; vitals drift back to baseline on their own time constants."""
        targets = [self._get(patient_id)] if patient_id else self._patients.values()
        for s in targets:
            s.events = []

    def step(self, dt_sec: float = 5) -> List[Reading]:
        """Advance the sim clock by dt_sec and return one reading per patient."""
        if not dt_sec > 0:
            raise ValueError("dt_sec must be > 0")
        self._clock += dt_sec
        recorded_at = _iso(self._clock)
        while self._scheduled and self._scheduled[0][0] <= self._clock:
            self._scheduled.pop(0)[1](self)

        readings: List[Reading] = []
        for s in self._patients.values():
            self._maybe_start_random_event(s, dt_sec)
            target, confused_by_event = self._target(s)
            values = self._sample(s, target, dt_sec)
            for vital, value in s.pending_artifacts.items():
                values[vital] = value
                self._artifact_log.append(
                    {"patientId": s.patient.id, "vital": vital, "value": value, "recordedAt": recorded_at}
                )
            s.pending_artifacts.clear()
            readings.append({
                "patientId": s.patient.id,
                "encounterId": s.admission.encounter_id,
                "recordedAt": recorded_at,
                **values,
                "onOxygen": s.on_oxygen,
                "consciousness": s.consciousness_override or _consciousness(s.state, confused_by_event),
            })
        return readings

    def _target(self, s: _PatientState) -> Tuple[Vitals, bool]:
        """Where each vital is heading now (baseline + active scenarios + oxygen), and whether a
        scenario is severe enough to cause new confusion. Drops fully recovered events."""
        target = dict(s.baseline)
        confused_by_event = False
        still_active = []
        for e in s.events:
            spec = SCENARIOS[e.scenario]
            onset_sec = e.onset_min * 60
            # The event lasts until its most-delayed vital has recovered.
            if _envelope(e, self._clock - spec.max_lag * onset_sec) is None:
                continue
            still_active.append(e)
            for vital, offset in spec.offsets.items():
                level = _envelope(e, self._clock - spec.lag.get(vital, 0.0) * onset_sec) or 0.0
                target[vital] += offset * e.severity * level
            if spec.confusion_at is not None and e.severity * (_envelope(e, self._clock) or 0.0) >= spec.confusion_at:
                confused_by_event = True
        s.events = still_active
        if s.on_oxygen and target["spo2Percent"] < 99.5:
            target["spo2Percent"] += (99.5 - target["spo2Percent"]) * OXYGEN_EFFECT
        return target, confused_by_event

    def _sample(self, s: _PatientState, target: Vitals, dt_sec: float) -> Dict[str, float]:
        """Move each vital toward its target (exact OU update - stable for any dt, so fast-forwarding
        with big steps is fine) and return noisy, clamped, rounded readings."""
        values: Dict[str, float] = {}
        for vital in VITAL_SIGNS:
            d = _DYNAMICS[vital]
            decay = math.exp(-dt_sec / d.tau_sec)
            s.state[vital] = (
                target[vital]
                + (s.state[vital] - target[vital]) * decay
                + d.sd * math.sqrt(1 - decay * decay) * self._rng.gauss(0, 1)
            )
            value = _clamp(s.state[vital] + d.noise * self._rng.gauss(0, 1), d.lo, d.hi)
            values[vital] = round(value, d.decimals) if d.decimals else int(round(value))
        # Keep pulse pressure physiological.
        values["diastolicMmHg"] = min(values["diastolicMmHg"], values["systolicMmHg"] - 25)
        return values

    def stream(self, interval_sec: float = 2, speed: float = 1) -> Iterator[List[Reading]]:
        """Yield a batch of readings every `interval_sec` real seconds, forever.

        :param speed: sim seconds per real second (e.g. 60 = one sim-minute per second)
        """
        dt = interval_sec * speed
        next_tick = time.monotonic()
        while True:
            yield self.step(dt)
            next_tick += interval_sec
            time.sleep(max(0.0, next_tick - time.monotonic()))

    def _get(self, patient_id: str) -> _PatientState:
        try:
            return self._patients[patient_id]
        except KeyError:
            raise KeyError(f"unknown patient: {patient_id}") from None

    def _maybe_start_random_event(self, s: _PatientState, dt_sec: float) -> None:
        if self._event_rate <= 0 or s.events:
            return
        if self._rng.random() >= 1 - math.exp(-self._event_rate * dt_sec / 3600):
            return
        weights = _scenario_weights(s.patient)
        scenario = self._rng.choices(list(weights), weights=list(weights.values()))[0]
        self.trigger(s.patient.id, scenario, severity=0.6 + self._rng.random() * 0.6)


# ------------------------------------------------------------------------------------------------
# Scripted demo (CLAUDE.md "Demo goal")
# ------------------------------------------------------------------------------------------------

# Demo timing (CLAUDE.md): one tick every DEMO_INTERVAL_SEC real seconds = DEMO_TICK_MIN hospital minutes.
DEMO_TICK_MIN = 15
DEMO_INTERVAL_SEC = 2.0
DEMO_SPEED = DEMO_TICK_MIN * 60 / DEMO_INTERVAL_SEC  # sim seconds per real second

# Demo timeline, in sim minutes from the start of the run.
DEMO_SEPSIS_AT_MIN = 60
DEMO_SEPSIS_ONSET_MIN = 240
DEMO_FALSE_ALARM_AT_MIN = 150

# The ward: 5 patients in bed order (4W-01 .. 4W-05). schedule_demo() gives bed 4W-02 sepsis and
# 4W-04 the loose-probe false alarm. Picked from the seed-1984 Synthea run for a realistic inpatient
# mix: mostly older, both genders, cardiac / renal / diabetic history.
DEMO_WARD = (
    "8398b128-7c86-69f2-456a-a0afb52067c1",  # 80-89 M  hypertension, ischemic heart disease
    "5a4445ed-e27a-6c4c-96bd-307b7bbee226",  # 80-89 F  type 2 diabetes, CKD          -> sepsis
    "9020f065-b607-4ea6-719f-2ea65bb06c8b",  # 70-79 M  recent NSTEMI, 16 medications
    "1ebf325c-5fd9-9259-79cf-44f209b97ee8",  # 60-69 F  hypertension                  -> loose SpO2 probe
    "94011f7c-9aaa-e26e-a4e8-fe735f840734",  # 60-69 M  alcoholism, CKD, anemia
)


def select_ward(patients: List[SimPatient], ids: Tuple[str, ...] = DEMO_WARD) -> Tuple[List[SimPatient], bool]:
    """Return (the ward's patients in bed order, whether the requested ids were all found).

    If any id is missing (e.g. data regenerated with another seed), falls back to the first
    len(ids) patients by id so the ward size stays the same.
    """
    by_id = {p.id: p for p in patients}
    if all(i in by_id for i in ids):
        return [by_id[i] for i in ids], True
    return sorted(patients, key=lambda p: p.id)[: len(ids)], False


def schedule_demo(sim: VitalsSimulator, sepsis_bed: int = 1, false_alarm_bed: int = 3) -> Dict[str, str]:
    """Script the demo: most patients stay stable, one develops early sepsis, one gets a single
    loose-probe SpO2 dip that should NOT be escalated. Use with event_rate_per_hour=0.

    Timeline (sim time from now, see the DEMO_* constants):
      +1 h    sepsis starts on `sepsis_bed`: HR/RR/temp climb over ~4 h, SpO2 drifts down after
              ~1 h, SBP falls late (~3 h in), new confusion ~2.5-3 h in. Holds until resolve().
      +2.5 h  one implausible SpO2 reading (72-80%) on `false_alarm_bed`, normal again next tick.

    Returns the ground truth {"sepsis": patient_id, "falseAlarm": patient_id}. Don't show it in the
    nurse UI - it's for checking the agent's output (and labelling training data).
    """
    ids = [p.id for p in sim.patients]
    sepsis_id = ids[sepsis_bed % len(ids)]
    false_alarm_id = ids[false_alarm_bed % len(ids)]
    sim.schedule(DEMO_SEPSIS_AT_MIN,
                 lambda s: s.trigger(sepsis_id, "sepsis", onset_min=DEMO_SEPSIS_ONSET_MIN, hold_min=math.inf))
    sim.schedule(DEMO_FALSE_ALARM_AT_MIN, lambda s: s.inject_artifact(false_alarm_id))
    return {"sepsis": sepsis_id, "falseAlarm": false_alarm_id}


# ------------------------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------------------------

def _derive_baseline(p: SimPatient, rng: random.Random) -> Vitals:
    age = p.approx_age
    lung_disease = bool(_CHRONIC_LUNG.search(" | ".join(p.conditions)))
    last = p.last_vitals

    def jitter(spread: float) -> float:
        return (rng.random() * 2 - 1) * spread

    hr = _clamp(last.get("heartRateBpm", 74 + jitter(10)), 58, 100)
    sys_ = _clamp(last.get("systolicMmHg", 120 + jitter(12)), 110, 160)
    dia = _clamp(last.get("diastolicMmHg", 78 + jitter(8)), 62, 95)

    # Synthea rarely records SpO2/temperature, so derive them from age + conditions.
    spo2 = 98 + jitter(1)
    if age > 70:
        spo2 -= 1.5
    if lung_disease:
        # Lower baseline, but kept above the 93% warning line so they aren't always alarming.
        spo2 = 94.5 + jitter(0.5)

    # Ignore Synthea's last temperature - it's often from a sick visit, not a resting baseline.
    temp = 36.8 + jitter(0.25)

    # Kept within 13-18 so normal wander stays in the normal adult range (roughly 12-20).
    rr = _clamp(last.get("respiratoryRate", 15 + jitter(2)), 13, 18)
    if lung_disease:
        rr = min(rr + 2, 18)

    return {
        "heartRateBpm": hr,
        "systolicMmHg": sys_,
        "diastolicMmHg": min(dia, sys_ - 38),
        "spo2Percent": spo2,
        "temperatureC": temp,
        "respiratoryRate": rr,
    }


def _consciousness(state: Vitals, confused_by_event: bool) -> str:
    """ACVPU from the underlying (noise-free) physiology, so it doesn't flicker on noisy readings."""
    spo2, sbp, temp = state["spo2Percent"], state["systolicMmHg"], state["temperatureC"]
    if spo2 < 75 or sbp < 65:
        return "V"
    if confused_by_event or spo2 < 84 or sbp < 78 or temp >= 40.5:
        return "C"
    return "A"


def _scenario_weights(p: SimPatient) -> Dict[str, float]:
    text = " | ".join(p.conditions)
    w = {"hypoxia": 1, "fever": 1.5, "sepsis": 0.5, "tachycardia": 1, "hypotension": 0.5, "hypertensive-crisis": 0.5}
    if _CHRONIC_LUNG.search(text):
        w["hypoxia"] *= 4
    if _CARDIAC.search(text):
        w["tachycardia"] *= 3
    if _HYPERTENSION.search(text):
        w["hypertensive-crisis"] *= 3
    if _INFECTION_RISK.search(text):
        w["sepsis"] *= 2
        w["fever"] *= 1.5
    return w


def _envelope(e: ActiveEvent, t: float) -> Optional[float]:
    """0..1 intensity of an event at sim time t, or None once fully recovered."""
    elapsed = (t - e.started_at) / 60
    onset_level = _smoothstep(elapsed / e.onset_min) if e.onset_min > 0 else 1.0

    if e.resolved_at is not None:
        recovery_start = (e.resolved_at - e.started_at) / 60
    else:
        recovery_start = e.onset_min + e.hold_min
    if elapsed < recovery_start:
        return onset_level

    # Recover from whatever level the event had reached when recovery began.
    peak = _smoothstep(recovery_start / e.onset_min) if e.onset_min > 0 else 1.0
    progress = (elapsed - recovery_start) / e.recovery_min if e.recovery_min > 0 else 1.0
    return None if progress >= 1 else peak * (1 - _smoothstep(progress))


def _smoothstep(x: float) -> float:
    t = _clamp(x, 0, 1)
    return t * t * (3 - 2 * t)


def _clamp(x: float, lo: float, hi: float) -> float:
    return min(hi, max(lo, x))


def _iso(epoch_sec: float) -> str:
    # Same format as JS Date#toISOString: 2026-01-01T08:00:05.000Z
    return datetime.fromtimestamp(epoch_sec, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
