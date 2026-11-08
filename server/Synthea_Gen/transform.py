#!/usr/bin/env python3
"""Pipeline step 2 (transform): raw Synthea FHIR bundles -> one small, scrubbed JSON per patient.

    python3 server/Synthea_Gen/transform.py [--raw server/data/raw/fhir] [--out server/data/clean]

Reads   server/data/raw/fhir/*.json   (gitignored; contains names, addresses, SSNs, ...)
Writes  server/data/clean/<patient-id>.json   (committed; safe to share)

Privacy rules (see CLAUDE.md):
  - Output never contains names, addresses, telecom, identifiers (MRN/SSN/...), exact birthDate,
    narrative text or notes. Age is stored as a 10-year band ("70-79"), never a birthdate.
  - Everything is keyed on the pseudonymous Synthea Patient.id (a random UUID).
  - Social-determinant entries (employment, education, housing, criminal record, abuse, ...) are
    dropped: Synthea records them as Conditions tagged "(finding)", "(situation)" or "(person)".
    A small allowlist keeps clinically useful findings (obesity, prediabetes, ...).
  - Only vital-sign and laboratory Observations are kept (no surveys / social history), and only
    the latest value per LOINC code.
Every output file is checked against the raw Patient's identifying values before it is written.

Clean file shape:
  {
    "id": "ab4f00fe-...",
    "ageBand": "70-79",
    "gender": "female",
    "conditions":  [{"system": "http://snomed.info/sct", "code": "59621000", "display": "Essential hypertension (disorder)"}],
    "medications": [{"system": "http://www.nlm.nih.gov/research/umls/rxnorm", "code": "309362", "display": "Clopidogrel 75 MG Oral Tablet"}],
    "observations": [{"code": "8867-4", "display": "Heart rate", "category": "vital-signs",
                      "value": 80, "unit": "/min", "effectiveDate": "2025-09-09"}]
  }

Standard library only; Python 3.9+.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import date
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

SERVER_DIR = Path(__file__).resolve().parent.parent  # server/
REPO_ROOT = SERVER_DIR.parent
DEFAULT_RAW = SERVER_DIR / "data" / "raw" / "fhir"
DEFAULT_OUT = SERVER_DIR / "data" / "clean"

KEEP_OBSERVATION_CATEGORIES = {"vital-signs", "laboratory"}
_NON_CLINICAL_TAG = re.compile(r"\((finding|situation|person)\)\s*$")
_CLINICAL_FINDINGS = re.compile(r"obes|prediabet|chronic pain|hyperglycemia|body mass index", re.I)

# Keys that must never appear anywhere in clean output.
FORBIDDEN_KEYS = {"name", "address", "telecom", "identifier", "birthDate", "text", "note", "photo", "contact"}


# ------------------------------------------------------------------------------------------------
# Bundle helpers
# ------------------------------------------------------------------------------------------------

def _coding(concept: Optional[dict], system_hint: str = "") -> Optional[dict]:
    """First coding of a CodeableConcept (preferring `system_hint`), reduced to system/code/display."""
    codings = (concept or {}).get("coding") or []
    if not codings:
        return None
    c = next((c for c in codings if system_hint and system_hint in c.get("system", "")), codings[0])
    return {"system": c.get("system"), "code": c.get("code"), "display": c.get("display")}


def age_band(birth_date: str, today: date) -> str:
    born = date.fromisoformat(birth_date[:10])
    age = today.year - born.year - ((today.month, today.day) < (born.month, born.day))
    if age >= 90:
        return "90+"
    low = age // 10 * 10
    return f"{low}-{low + 9}"


# ------------------------------------------------------------------------------------------------
# Transform
# ------------------------------------------------------------------------------------------------

def transform_bundle(bundle: dict, today: date) -> Optional[dict]:
    """Return the clean dict for one patient bundle, or None if the patient should be skipped."""
    entries = bundle.get("entry") or []
    # References are usually "urn:uuid:..." matching an entry's fullUrl, not "Patient/<id>".
    by_full_url: Dict[str, dict] = {e["fullUrl"]: e["resource"] for e in entries if "fullUrl" in e}
    resources = [e["resource"] for e in entries]

    patients = [r for r in resources if r["resourceType"] == "Patient"]
    if len(patients) != 1:
        return None
    patient = patients[0]
    if patient.get("deceasedDateTime") or patient.get("deceasedBoolean"):
        return None
    patient_refs = {f"Patient/{patient['id']}"} | {u for u, r in by_full_url.items() if r is patient}
    ours = [r for r in resources if (r.get("subject") or {}).get("reference") in patient_refs]

    clean = {
        "id": patient["id"],
        "ageBand": age_band(patient["birthDate"], today),
        "gender": patient.get("gender", "unknown"),
        "conditions": sorted(_active_conditions(ours), key=_by_display),
        "medications": sorted(_active_medications(ours, by_full_url), key=_by_display),
        "observations": _latest_observations(ours),
    }
    assert_scrubbed(clean, patient)
    return clean


def _by_display(coding: dict) -> str:
    return coding["display"] or ""


def _unique_by_code(codings: Iterable[Optional[dict]]) -> List[dict]:
    """Drop missing codings and keep the first of each code, in order."""
    out: Dict[str, dict] = {}
    for c in codings:
        if c and c["code"] not in out:
            out[c["code"]] = c
    return list(out.values())


def _active_conditions(ours: List[dict]) -> List[dict]:
    """Active conditions, minus social determinants (employment, housing, criminal record, ...)."""
    found = []
    for r in ours:
        if r["resourceType"] == "Condition" and (_coding(r.get("clinicalStatus")) or {}).get("code") == "active":
            c = _coding(r.get("code"), "snomed")
            display = (c or {}).get("display") or ""
            if c and (not _NON_CLINICAL_TAG.search(display) or _CLINICAL_FINDINGS.search(display)):
                found.append(c)
    return _unique_by_code(found)


def _active_medications(ours: List[dict], by_full_url: Dict[str, dict]) -> List[dict]:
    """Active medication requests (inline concept, or a reference to a Medication resource)."""
    found = []
    for r in ours:
        if r["resourceType"] == "MedicationRequest" and r.get("status") == "active":
            concept = r.get("medicationCodeableConcept")
            if concept is None and "medicationReference" in r:
                concept = (by_full_url.get(r["medicationReference"].get("reference", "")) or {}).get("code")
            found.append(_coding(concept, "rxnorm"))
    return _unique_by_code(found)


def _latest_observations(ours: List[dict]) -> List[dict]:
    """Latest numeric value per LOINC code (BP panel components flattened into their own codes)."""
    latest: Dict[str, Tuple[str, dict]] = {}  # code -> (effective time, clean observation)
    for r in ours:
        if r["resourceType"] != "Observation":
            continue
        categories = {(_coding(c) or {}).get("code") for c in r.get("category") or []}
        category = next(iter(categories & KEEP_OBSERVATION_CATEGORIES), None)
        when = r.get("effectiveDateTime") or (r.get("effectivePeriod") or {}).get("start")
        if not category or not when:
            continue
        for part in [r, *(r.get("component") or [])]:
            q = part.get("valueQuantity")
            code = _coding(part.get("code"), "loinc")
            if not q or "value" not in q or not code:
                continue
            if code["code"] not in latest or when > latest[code["code"]][0]:
                latest[code["code"]] = (when, {
                    "code": code["code"],
                    "display": code["display"],
                    "category": category,
                    "value": q["value"],
                    "unit": q.get("unit") or q.get("code"),
                    "effectiveDate": when[:10],
                })
    return [obs for _, (_, obs) in sorted(latest.items())]


# ------------------------------------------------------------------------------------------------
# Privacy check
# ------------------------------------------------------------------------------------------------

def _walk(obj) -> Iterable[tuple]:
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield ("key", k)
            yield from _walk(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk(v)
    else:
        yield ("value", obj)


def identifying_strings(patient: dict) -> List[str]:
    """Values from the raw Patient that must not leak into clean output."""
    out = [patient.get("birthDate", "")]
    for n in patient.get("name") or []:
        out += n.get("given") or []
        out += [n.get("family", "")]
    for a in patient.get("address") or []:
        out += (a.get("line") or []) + [a.get("postalCode", "")]
    out += [t.get("value", "") for t in patient.get("telecom") or []]
    out += [i.get("value", "") for i in patient.get("identifier") or [] if i.get("value") != patient["id"]]
    for ext in patient.get("extension") or []:  # mother's maiden name, birthplace, ...
        for kind, v in _walk(ext):
            if kind == "value" and isinstance(v, str) and not v.startswith("http"):
                out.append(v)
    return [s for s in out if isinstance(s, str) and len(s) >= 4]


def assert_scrubbed(clean: dict, raw_patient: dict) -> None:
    """Raise if clean output contains a forbidden key or any identifying value from the raw Patient."""
    blob = json.dumps(clean)
    for kind, v in _walk(clean):
        if kind == "key" and v in FORBIDDEN_KEYS:
            raise ValueError(f"forbidden key {v!r} in clean output for {clean['id']}")
    for s in identifying_strings(raw_patient):
        # Whole-token match so e.g. a 4-digit ZIP fragment doesn't trip on a lab value.
        if re.search(rf"(?<![\w-]){re.escape(s)}(?![\w-])", blob):
            raise ValueError(f"identifying value leaked into clean output for {clean['id']}")


# ------------------------------------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------------------------------------

def bundle_files(raw_dir: Path) -> List[Path]:
    """Patient bundles in raw_dir (skips Synthea's hospital/practitioner organisation bundles)."""
    return sorted(
        p for p in raw_dir.glob("*.json")
        if not p.name.startswith(("hospitalInformation", "practitionerInformation"))
    )


def run(raw_dir: Path, out_dir: Path, today: Optional[date] = None) -> List[dict]:
    today = today or date.today()
    files = bundle_files(raw_dir)
    if not files:
        raise FileNotFoundError(f"no FHIR bundles in {raw_dir} - run server/Synthea_Gen/synthea.py first")

    cleaned = []
    for path in files:
        with open(path, encoding="utf-8") as f:
            clean = transform_bundle(json.load(f), today)
        if clean is not None:
            cleaned.append(clean)

    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("*.json"):
        stale.unlink()
    for clean in cleaned:
        with open(out_dir / f"{clean['id']}.json", "w", encoding="utf-8") as f:
            json.dump(clean, f, indent=2)
            f.write("\n")
    return cleaned


def main(argv=None) -> None:
    parser = argparse.ArgumentParser(description="Scrub raw Synthea FHIR bundles into server/data/clean/")
    parser.add_argument("--raw", type=Path, default=DEFAULT_RAW)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args(argv)
    try:
        cleaned = run(args.raw, args.out)
    except (FileNotFoundError, ValueError) as e:
        sys.exit(f"error: {e}")
    sizes = [len(json.dumps(c)) for c in cleaned]
    print(f"==> Wrote {len(cleaned)} clean patients to {args.out.relative_to(REPO_ROOT) if args.out.is_relative_to(REPO_ROOT) else args.out}/"
          f"  (avg {sum(sizes) // max(1, len(sizes)) / 1000:.1f} KB each)")


if __name__ == "__main__":
    main()
