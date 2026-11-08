"""Write simulator output to Supabase (tables in supabase/migrations/).

Used by `python3 server/sim/cli.py serve` when SUPABASE_URL and SUPABASE_SECRET_KEY are set
(SUPABASE_SERVICE_ROLE_KEY, the legacy name, also works):
  - on start: upsert patients + their in-progress encounters, finish encounters from older runs
  - every tick: insert one `vitals` row per patient

Uses the secret key (sb_secret_..., bypasses Row Level Security), so it must only run server-side
(Render or a laptop) - never in a browser. Ground truth (which scenario is running) is NOT written:
the alert worker and the nurse UI only ever see the vitals stream.

The `supabase` package is imported lazily, so the rest of the simulator keeps working on the
standard library alone.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional

from vitals_sim import VitalsSimulator

# VitalsReading key -> vitals column
VITALS_COLUMNS = {
    "patientId": "patient_id",
    "encounterId": "encounter_id",
    "recordedAt": "recorded_at",
    "heartRateBpm": "heart_rate_bpm",
    "systolicMmHg": "systolic_mmhg",
    "diastolicMmHg": "diastolic_mmhg",
    "spo2Percent": "spo2_percent",
    "temperatureC": "temperature_c",
    "respiratoryRate": "respiratory_rate",
    "onOxygen": "on_oxygen",
    "consciousness": "consciousness",
}


def vitals_row(reading: Dict[str, Any]) -> Dict[str, Any]:
    return {column: reading.get(key) for key, column in VITALS_COLUMNS.items()}


def patient_rows(sim: VitalsSimulator) -> List[dict]:
    return [
        {
            "id": p.id,
            "age_band": p.age_band,
            "gender": p.gender,
            "conditions": p.conditions,
            "medications": p.medications,
        }
        for p in sim.patients
    ]


def encounter_rows(sim: VitalsSimulator) -> List[dict]:
    rows = []
    for p in sim.patients:
        a = sim.admission(p.id)
        rows.append({
            "id": a.encounter_id,
            "patient_id": p.id,
            "status": "in-progress",
            "class": "IMP",
            "location_id": a.location_id,
            "bed_label": a.bed_label,
        })
    return rows


class SupabaseSink:
    def __init__(self, client: Any) -> None:
        """`client` is a supabase.Client (or a fake with the same .table() API, for tests)."""
        self.client = client

    @classmethod
    def from_env(cls) -> Optional["SupabaseSink"]:
        """Build from SUPABASE_URL + SUPABASE_SECRET_KEY (or legacy SUPABASE_SERVICE_ROLE_KEY);
        None if unset."""
        url = os.environ.get("SUPABASE_URL")
        key = os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        if not url or not key:
            return None
        try:
            from supabase import create_client
        except ImportError as e:
            raise RuntimeError(
                "SUPABASE_URL is set but the supabase package isn't installed - "
                "use the venv: source .venv/bin/activate && pip install -r requirements.txt"
            ) from e
        return cls(create_client(url, key))

    def reset(self) -> None:
        """Delete all vitals and alerts (a fresh demo run). Patients/encounters are upserted anyway."""
        self.client.table("alerts").delete().not_.is_("id", "null").execute()
        self.client.table("vitals").delete().not_.is_("id", "null").execute()

    def admit(self, sim: VitalsSimulator) -> None:
        """Upsert this run's patients + encounters; mark any other in-progress encounter finished."""
        self.client.table("patients").upsert(patient_rows(sim), on_conflict="id").execute()
        encounters = encounter_rows(sim)
        self.client.table("encounters").upsert(encounters, on_conflict="id").execute()
        (
            self.client.table("encounters")
            .update({"status": "finished"})
            .not_.in_("id", [e["id"] for e in encounters])
            .eq("status", "in-progress")
            .execute()
        )

    def write(self, readings: List[Dict[str, Any]]) -> None:
        if readings:
            self.client.table("vitals").insert([vitals_row(r) for r in readings]).execute()
