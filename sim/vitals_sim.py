"""Continuous bedside-vitals simulator layered on top of Synthea patients.

Synthea only records a handful of outpatient vitals per patient (almost no SpO2/temperature), so
this produces a live stream: each vital wanders around a per-patient baseline (Ornstein-Uhlenbeck
process) plus measurement noise, and "scenarios" (sepsis, hypoxia, ...) push vitals away from
baseline with an onset -> hold -> recovery envelope. Scenarios can be triggered manually (demo
buttons) or occur randomly, weighted by the patient's conditions (COPD -> hypoxia, cardiac ->
tachycardia, ...).

Standard library only; Python 3.9+.

    from vitals_sim import VitalsSimulator, load_synthea_patients, vitals_alerts

    sim = VitalsSimulator(load_synthea_patients(), seed=1984)
    sim.trigger(sim.patients[0].id, "sepsis")
    for readings in sim.stream(interval_sec=2, speed=30):
        ...

Readings are dicts with camelCase keys matching `VitalsReading` in packages/shared, so they can be
sent to the apps as JSON unchanged.
"""

from __future__ import annotations

import csv
import math
import random
import re
import time
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterator, List, Optional

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CSV_DIR = REPO_ROOT / "data" / "synthea" / "csv"

VITAL_SIGNS = ("heartRateBpm", "systolicMmHg", "diastolicMmHg", "spo2Percent", "temperatureC")

Vitals = Dict[str, float]
Reading = Dict[str, object]


# ------------------------------------------------------------------------------------------------
# Patients (loaded straight from Synthea CSV output)
# ------------------------------------------------------------------------------------------------

@dataclass
class SimPatient:
    id: str
    first_name: str
    last_name: str
    room: str
    birth_date: str  # YYYY-MM-DD
    gender: str  # "M" | "F"
    conditions: List[str] = field(default_factory=list)
    last_vitals: Vitals = field(default_factory=dict)  # most recent Synthea values (any may be missing)

    @property
    def display_name(self) -> str:
        return f"{self.first_name} {self.last_name}"

    def to_json(self) -> dict:
        """camelCase dict matching the shared TypeScript `Patient` shape (plus extras)."""
        return {
            "id": self.id,
            "firstName": self.first_name,
            "lastName": self.last_name,
            "room": self.room,
            "birthDate": self.birth_date,
            "gender": self.gender,
            "conditions": self.conditions,
            "lastVitals": self.last_vitals,
        }


_VITAL_CODES = {
    "8867-4": "heartRateBpm",
    "8480-6": "systolicMmHg",
    "8462-4": "diastolicMmHg",
    "2708-6": "spo2Percent",
    "59408-5": "spo2Percent",
    "8310-5": "temperatureC",
}
_IGNORED_CONDITIONS = re.compile(r"gingivitis|dental|teeth|molars|oral region", re.I)
_NON_CLINICAL = re.compile(r"\((finding|situation|person)\)")


def _clean_name(s: str) -> str:
    # Synthea appends digits to names to mark them synthetic ("Johnathan55").
    return re.sub(r"\d+", "", s).strip()


def _read_csv(path: Path) -> List[dict]:
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def load_synthea_patients(csv_dir: Path | str = DEFAULT_CSV_DIR) -> List[SimPatient]:
    """Load living patients from Synthea CSV output, with active conditions and latest vitals."""
    csv_dir = Path(csv_dir)
    if not (csv_dir / "patients.csv").exists():
        raise FileNotFoundError(f"{csv_dir}/patients.csv not found - run scripts/synthea.py first")

    latest: Dict[str, Dict[str, tuple]] = {}
    for o in _read_csv(csv_dir / "observations.csv"):
        vital = _VITAL_CODES.get(o["CODE"])
        if not vital:
            continue
        try:
            value = float(o["VALUE"])
        except ValueError:
            continue
        by_vital = latest.setdefault(o["PATIENT"], {})
        if vital not in by_vital or o["DATE"] > by_vital[vital][0]:
            by_vital[vital] = (o["DATE"], value)

    conditions: Dict[str, set] = {}
    for c in _read_csv(csv_dir / "conditions.csv"):
        desc = c["DESCRIPTION"]
        if c["STOP"] or _NON_CLINICAL.search(desc) or _IGNORED_CONDITIONS.search(desc):
            continue
        name = re.sub(r"\s{2,}", " ", re.sub(r"\s*\(disorder\)\s*$", "", desc)).strip()
        conditions.setdefault(c["PATIENT"], set()).add(name)

    rows = [p for p in _read_csv(csv_dir / "patients.csv") if not p["DEATHDATE"]]
    # Synthea is multithreaded so row order varies between runs - sort so rooms are stable.
    rows.sort(key=lambda p: (_clean_name(p["LAST"]), _clean_name(p["FIRST"]), p["Id"]))

    return [
        SimPatient(
            id=p["Id"],
            first_name=_clean_name(p["FIRST"]),
            last_name=_clean_name(p["LAST"]),
            room=str(401 + i),
            birth_date=p["BIRTHDATE"],
            gender="F" if p["GENDER"] == "F" else "M",
            conditions=sorted(conditions.get(p["Id"], ())),
            last_vitals={k: v for k, (_, v) in latest.get(p["Id"], {}).items()},
        )
        for i, p in enumerate(rows)
    ]


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


SCENARIOS: Dict[str, ScenarioSpec] = {
    "hypoxia": ScenarioSpec("Hypoxia", {"spo2Percent": -10, "heartRateBpm": 18}, 8, 20, 15),
    "fever": ScenarioSpec("Fever", {"temperatureC": 1.8, "heartRateBpm": 15}, 30, 60, 60),
    "sepsis": ScenarioSpec(
        "Sepsis",
        {"temperatureC": 2.0, "heartRateBpm": 35, "systolicMmHg": -30, "diastolicMmHg": -18, "spo2Percent": -4},
        45, 90, 120,
    ),
    "tachycardia": ScenarioSpec("Tachycardia", {"heartRateBpm": 50, "systolicMmHg": -8}, 2, 20, 10),
    "hypotension": ScenarioSpec(
        "Hypotension", {"systolicMmHg": -35, "diastolicMmHg": -20, "heartRateBpm": 25}, 10, 30, 30
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
}

_CHRONIC_LUNG = re.compile(r"copd|chronic obstructive|emphysema|asthma|pulmonary fibrosis", re.I)
_CARDIAC = re.compile(r"heart|myocardial|coronary|atrial|cardi", re.I)
_HYPERTENSION = re.compile(r"hypertension", re.I)
_INFECTION_RISK = re.compile(r"diabetes|sepsis|kidney|urinary tract|neoplasm|transplant", re.I)


@dataclass
class _PatientState:
    patient: SimPatient
    baseline: Vitals
    state: Vitals
    events: List[ActiveEvent] = field(default_factory=list)


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
        for p in patients:
            # Baselines depend only on (seed, patient id) so they're stable regardless of list order.
            baseline = _derive_baseline(p, random.Random(f"{seed}:{p.id}"), self._clock)
            self._patients[p.id] = _PatientState(p, baseline, dict(baseline))

    @property
    def now(self) -> float:
        """Current sim time (epoch seconds)."""
        return self._clock

    @property
    def patients(self) -> List[SimPatient]:
        return [s.patient for s in self._patients.values()]

    def baseline(self, patient_id: str) -> Vitals:
        return dict(self._get(patient_id).baseline)

    def active_events(self, patient_id: str) -> List[ActiveEvent]:
        return [ActiveEvent(**asdict(e)) for e in self._get(patient_id).events]

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
        return ActiveEvent(**asdict(event))

    def resolve(self, patient_id: str, scenario: Optional[str] = None) -> None:
        """Begin recovery now (e.g. after a nurse intervenes) for all events, or one scenario."""
        for e in self._get(patient_id).events:
            if (scenario is None or e.scenario == scenario) and e.resolved_at is None:
                e.resolved_at = self._clock

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
        readings: List[Reading] = []

        for s in self._patients.values():
            self._maybe_start_random_event(s, dt_sec)

            target = dict(s.baseline)
            still_active = []
            for e in s.events:
                level = _envelope(e, self._clock)
                if level is None:
                    continue
                still_active.append(e)
                for vital, offset in SCENARIOS[e.scenario].offsets.items():
                    target[vital] += offset * e.severity * level
            s.events = still_active

            values: Dict[str, float] = {}
            for vital in VITAL_SIGNS:
                d = _DYNAMICS[vital]
                # Exact OU update - stable for any dt, so fast-forwarding with big steps is fine.
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
            readings.append({"patientId": s.patient.id, "recordedAt": recorded_at, **values})
        return readings

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
# Alerts (NEWS2-inspired thresholds - for demo purposes, not clinical use)
# ------------------------------------------------------------------------------------------------

def vitals_alerts(r: dict) -> List[dict]:
    """Return [{vital, level: 'warning'|'critical', value, message}] for out-of-range vitals."""
    alerts: List[dict] = []

    def add(vital: str, level: str, message: str) -> None:
        alerts.append({"vital": vital, "level": level, "value": r[vital], "message": message})

    spo2, hr, sys_, temp = (r.get(k) for k in ("spo2Percent", "heartRateBpm", "systolicMmHg", "temperatureC"))
    if spo2 is not None:
        if spo2 <= 91:
            add("spo2Percent", "critical", f"SpO2 {spo2}%")
        elif spo2 <= 93:
            add("spo2Percent", "warning", f"SpO2 {spo2}%")
    if hr is not None:
        if hr <= 40 or hr >= 131:
            add("heartRateBpm", "critical", f"HR {hr} bpm")
        elif hr <= 50 or hr >= 111:
            add("heartRateBpm", "warning", f"HR {hr} bpm")
    if sys_ is not None:
        if sys_ <= 90 or sys_ >= 220:
            add("systolicMmHg", "critical", f"SBP {sys_} mmHg")
        elif sys_ <= 100 or sys_ >= 180:
            add("systolicMmHg", "warning", f"SBP {sys_} mmHg")
    if temp is not None:
        if temp <= 35 or temp >= 39.5:
            add("temperatureC", "critical", f"Temp {temp} °C")
        elif temp >= 38.1:
            add("temperatureC", "warning", f"Temp {temp} °C")
    return alerts


# ------------------------------------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------------------------------------

def _derive_baseline(p: SimPatient, rng: random.Random, now: float) -> Vitals:
    birth = datetime.strptime(p.birth_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
    age = (now - birth) / (365.25 * 24 * 3600)
    text = " | ".join(p.conditions)
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
    if _CHRONIC_LUNG.search(text):
        # Lower baseline, but kept above the 93% warning line so they aren't always alarming.
        spo2 = 94.5 + jitter(0.5)

    # Ignore Synthea's last temperature - it's often from a sick visit, not a resting baseline.
    temp = 36.8 + jitter(0.25)

    return {
        "heartRateBpm": hr,
        "systolicMmHg": sys_,
        "diastolicMmHg": min(dia, sys_ - 38),
        "spo2Percent": spo2,
        "temperatureC": temp,
    }


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
