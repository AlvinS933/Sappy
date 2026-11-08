"""NEWS2 alert worker: reads new `vitals` rows from Supabase, scores them, writes `alerts`.

    python3 server/news2/alert_worker.py                 # follow new vitals (skips the existing backlog)
    python3 server/news2/alert_worker.py --from-start    # also score every vitals row already in the table

Needs SUPABASE_URL + SUPABASE_SECRET_KEY (legacy SUPABASE_SERVICE_ROLE_KEY also works), from the
environment or a .env file at the repo root. The secret key bypasses Row Level Security, so this
must only run server-side (Render worker or a laptop), never in a browser.

Alert rule (fewer, better alerts):
  - News2Monitor confirms a tier only after it has held for 2 readings (one bad reading is suppressed).
  - An `alerts` row is written only when a patient's confirmed tier rises above the last tier we
    alerted for. Holding a tier doesn't repeat the alert; dropping lowers the bar, so a later
    re-escalation alerts again.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

ROOT = Path(__file__).resolve().parents[2]  # repo root (for .env)
sys.path.insert(0, str(Path(__file__).resolve().parent))

from scoring import News2Monitor, spo2_scale_for  # noqa: E402

log = logging.getLogger("alert-worker")

# The simulator writes one vitals row per patient every 2 s (one tick); poll at the same rate.
POLL_SECONDS = 2.0

TIER_RANK = {"none": 0, "watch": 1, "check soon": 2, "go now": 3}

# vitals column -> VitalsReading key (what scoring.py expects)
READING_KEYS = {
    "patient_id": "patientId",
    "recorded_at": "recordedAt",
    "heart_rate_bpm": "heartRateBpm",
    "systolic_mmhg": "systolicMmHg",
    "diastolic_mmhg": "diastolicMmHg",
    "spo2_percent": "spo2Percent",
    "temperature_c": "temperatureC",
    "respiratory_rate": "respiratoryRate",
    "on_oxygen": "onOxygen",
    "consciousness": "consciousness",
}


def reading_from_row(row: Dict[str, Any]) -> Dict[str, Any]:
    reading = {key: row.get(col) for col, key in READING_KEYS.items()}
    if reading["temperatureC"] is not None:  # numeric(4,1) can arrive as a string
        reading["temperatureC"] = float(reading["temperatureC"])
    return reading


class AlertWorker:
    def __init__(self, client: Any, batch_size: int = 500) -> None:
        """`client` is a supabase.Client (or a fake with the same .table() API, for tests)."""
        self.client = client
        self.batch_size = batch_size
        self.monitor = News2Monitor()
        self.known_patients: set = set()
        self.last_alerted: Dict[str, str] = {}  # patient_id -> tier of the last alert written
        self.last_vitals_id = 0

    # --- Supabase reads/writes -----------------------------------------------------------------

    def load_patients(self, ids: Optional[Iterable[str]] = None) -> None:
        """Set each patient's SpO2 scale from their conditions (all patients, or just `ids`)."""
        q = self.client.table("patients").select("id,conditions")
        if ids is not None:
            q = q.in_("id", list(ids))
        for p in q.execute().data:
            self.monitor.set_spo2_scale(p["id"], spo2_scale_for(p.get("conditions") or []))
            self.known_patients.add(p["id"])

    def skip_backlog(self) -> None:
        rows = self.client.table("vitals").select("id").order("id", desc=True).limit(1).execute().data
        self.last_vitals_id = rows[0]["id"] if rows else 0

    def fetch_vitals(self) -> List[dict]:
        return (
            self.client.table("vitals").select("*")
            .gt("id", self.last_vitals_id).order("id").limit(self.batch_size)
            .execute().data
        )

    def write_alerts(self, alerts: List[dict]) -> None:
        if alerts:
            self.client.table("alerts").insert(alerts).execute()

    # --- Scoring -------------------------------------------------------------------------------

    def process(self, rows: List[dict]) -> List[dict]:
        """Score vitals rows in id order; return the alert rows to insert."""
        new_ids = {r["patient_id"] for r in rows} - self.known_patients
        if new_ids:
            self.load_patients(new_ids)

        alerts = []
        for row in rows:
            self.last_vitals_id = max(self.last_vitals_id, row["id"])
            pid = row["patient_id"]
            try:
                res = self.monitor.update(reading_from_row(row))
            except ValueError as e:
                log.warning("skipping vitals %s: %s", row["id"], e)
                continue

            if res.suppressed:
                log.info("suppressed %s: %s (NEWS2 %d) held at %s",
                         pid, res.news2.tier, res.news2.total, res.alert_tier)

            prev = self.last_alerted.get(pid, "none")
            if TIER_RANK[res.alert_tier] > TIER_RANK[prev]:
                alerts.append({
                    "patient_id": pid,
                    "encounter_id": row["encounter_id"],
                    "tier": res.alert_tier,
                    "news2_score": res.news2.total,
                    "reason": "; ".join(res.news2.reasons) or "NEWS2 tier confirmed",
                })
                log.info("ALERT %s: %s (NEWS2 %d)", pid, res.alert_tier, res.news2.total)
            self.last_alerted[pid] = res.alert_tier
        return alerts

    def poll_once(self) -> int:
        rows = self.fetch_vitals()
        self.write_alerts(self.process(rows))
        return len(rows)

    def run(self, interval: float, from_start: bool = False) -> None:
        self.load_patients()
        if not from_start:
            self.skip_backlog()
        log.info("watching vitals after id %d (%d patients)", self.last_vitals_id, len(self.known_patients))
        while True:
            try:
                n = self.poll_once()
            except Exception:  # network blips shouldn't kill the worker
                log.exception("poll failed; retrying")
                n = 0
            if n < self.batch_size:
                time.sleep(interval)


# --- Entry point -------------------------------------------------------------------------------

def load_dotenv(path: Path) -> None:
    """Minimal .env reader: KEY=VALUE lines; real environment variables win."""
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def make_client() -> Any:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit("SUPABASE_URL and SUPABASE_SECRET_KEY must be set (environment or .env)")
    from supabase import create_client  # imported lazily so tests run without the package
    return create_client(url, key)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interval", type=float, default=POLL_SECONDS,
                    help=f"seconds between polls (default {POLL_SECONDS:g}, one simulator tick)")
    ap.add_argument("--from-start", action="store_true", help="score existing vitals rows too")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    load_dotenv(ROOT / ".env")
    AlertWorker(make_client()).run(args.interval, args.from_start)


if __name__ == "__main__":
    main()
