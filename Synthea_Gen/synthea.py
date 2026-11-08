#!/usr/bin/env python3
"""Generate synthetic patient data with Synthea (https://github.com/synthetichealth/synthea)
and sanity-check the output.

Usage:
  python3 Synthea_Gen/synthea.py [-p POPULATION] [-s SEED] [-a AGE_RANGE] [-S STATE] [-c CITY] [-- extra synthea args]

Examples:
  python3 Synthea_Gen/synthea.py                       # 25 adult patients in Boston, MA, seed 1984
  python3 Synthea_Gen/synthea.py -p 100 -s 42          # 100 patients, different seed
  python3 Synthea_Gen/synthea.py -- --exporter.years_of_history=2

Output (gitignored - raw data contains names/addresses, never commit it):
  data/raw/csv/   patients.csv, observations.csv, conditions.csv, medications.csv, ...
  data/raw/fhir/  one FHIR R4 Bundle JSON per patient

Requires Java 17+ and Python 3.9+ (standard library only).
The Synthea jar is downloaded once to tools/ (gitignored).
Defaults come from .env (see .env_sample): SYNTHEA_VERSION, SYNTHEA_SEED, SYNTHEA_POPULATION,
SYNTHEA_AGES, SYNTHEA_STATE, SYNTHEA_CITY. Command-line flags override them.
"""

from __future__ import annotations

import argparse
import csv
import os
import re
import shutil
import subprocess
import sys
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from pylib.env import load_dotenv  # noqa: E402
from pylib.loinc import VITAL_LOINC  # noqa: E402

TOOLS_DIR = ROOT / "tools"
OUT_DIR = ROOT / "data" / "raw"

REQUIRED_CSVS = ("patients.csv", "observations.csv", "conditions.csv", "encounters.csv", "medications.csv")


def die(msg: str) -> None:
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def check_java() -> None:
    if not shutil.which("java"):
        die("java not found. Install JDK 17+ (e.g. 'brew install --cask temurin').")
    out = subprocess.run(["java", "-version"], capture_output=True, text=True).stderr
    m = re.search(r'version "(\d+)', out)
    major = int(m.group(1)) if m else 0
    if major < 17:
        die(f"Synthea needs Java 17+, found {major or 'unknown'}.")


def download_synthea(version: str) -> Path:
    """Return the cached jar for `version`, downloading it to tools/ the first time."""
    jar = TOOLS_DIR / f"synthea-with-dependencies-{version}.jar"
    if jar.exists() and jar.stat().st_size > 0:
        return jar
    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    url = f"https://github.com/synthetichealth/synthea/releases/download/{version}/synthea-with-dependencies.jar"
    print(f"==> Downloading Synthea {version}")
    part = jar.with_suffix(".jar.part")
    with urllib.request.urlopen(url) as resp, open(part, "wb") as f:
        total = int(resp.headers.get("Content-Length") or 0)
        done = 0
        while chunk := resp.read(1 << 20):
            f.write(chunk)
            done += len(chunk)
            if total and sys.stderr.isatty():
                print(f"\r    {done / total:6.1%} of {total / 1e6:.0f} MB", end="", file=sys.stderr)
    if sys.stderr.isatty():
        print(file=sys.stderr)
    part.rename(jar)
    return jar


def generate(jar: Path, args: argparse.Namespace) -> None:
    print(f"==> Generating {args.population} patients (seed {args.seed}, ages {args.ages}, {args.city}, {args.state})")
    shutil.rmtree(OUT_DIR, ignore_errors=True)
    OUT_DIR.mkdir(parents=True)
    log = OUT_DIR / "synthea.log"
    cmd = [
        "java", "-jar", str(jar),
        "-p", str(args.population),
        "-s", str(args.seed),
        "-cs", str(args.seed),
        "-a", args.ages,
        f"--exporter.baseDirectory={OUT_DIR}",
        "--exporter.csv.export=true",
        "--exporter.fhir.export=true",
        "--exporter.hospital.fhir.export=false",
        "--exporter.practitioner.fhir.export=false",
        "--exporter.years_of_history=5",
        "--generate.only_alive_patients=true",
        *args.extra,
        args.state, args.city,
    ]
    # Run from the output dir so Synthea's ./output default and any logs land there.
    with open(log, "w") as f:
        result = subprocess.run(cmd, cwd=OUT_DIR, stdout=f, stderr=subprocess.STDOUT)
    if result.returncode != 0:
        tail = log.read_text().splitlines()[-20:]
        die(f"Synthea failed. Last lines of {log}:\n" + "\n".join(tail))


def verify_and_summarise() -> None:
    print("==> Checking output")
    csv_dir = OUT_DIR / "csv"
    missing = [f for f in REQUIRED_CSVS if not (csv_dir / f).exists() or (csv_dir / f).stat().st_size == 0]
    for f in missing:
        print(f"  FAIL  csv/{f} missing or empty", file=sys.stderr)
    fhir_count = len(list((OUT_DIR / "fhir").glob("*.json")))
    if fhir_count == 0:
        print("  FAIL  no FHIR bundles in fhir/", file=sys.stderr)
    if missing or fhir_count == 0:
        sys.exit(1)

    with open(csv_dir / "patients.csv", newline="") as f:
        patients = list(csv.DictReader(f))
    counts: Counter = Counter()
    total = 0
    with open(csv_dir / "observations.csv", newline="") as f:
        for row in csv.DictReader(f):
            total += 1
            if row["CODE"] in VITAL_LOINC:
                counts[VITAL_LOINC[row["CODE"]]] += 1

    print(f"  patients:      {len(patients)}")
    print(f"  observations:  {total}")
    for vital in dict.fromkeys(VITAL_LOINC.values()):  # unique, in map order
        print(f"    {vital:<16} {counts[vital]}")
    print(f"  FHIR bundles:  {fhir_count}")


def main(argv=None) -> None:
    load_dotenv(ROOT / ".env")
    parser = argparse.ArgumentParser(
        description="Generate synthetic patients with Synthea.",
        epilog="Anything after -- is passed straight to Synthea, e.g. -- --exporter.years_of_history=2",
    )
    env = os.environ.get
    parser.add_argument("-p", "--population", type=int, default=int(env("SYNTHEA_POPULATION", 25)))
    parser.add_argument("-s", "--seed", type=int, default=int(env("SYNTHEA_SEED", 1984)))
    parser.add_argument("-a", "--ages", default=env("SYNTHEA_AGES", "18-90"), help="age range, e.g. 18-90")
    parser.add_argument("-S", "--state", default=env("SYNTHEA_STATE", "Massachusetts"))
    parser.add_argument("-c", "--city", default=env("SYNTHEA_CITY", "Boston"))
    parser.add_argument("--version", default=env("SYNTHEA_VERSION", "v4.0.0"), help="Synthea release tag")
    parser.add_argument("extra", nargs=argparse.REMAINDER, help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    if args.extra[:1] == ["--"]:
        args.extra = args.extra[1:]

    check_java()
    jar = download_synthea(args.version)
    generate(jar, args)
    verify_and_summarise()
    print(f"==> Done. Data in {OUT_DIR.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
