#!/usr/bin/env bash
# Generate synthetic patient data with Synthea (https://github.com/synthetichealth/synthea)
# and sanity-check the output.
#
# Usage:
#   scripts/synthea.sh [-p POPULATION] [-s SEED] [-a AGE_RANGE] [-S STATE] [-c CITY] [-- extra synthea args]
#
# Examples:
#   scripts/synthea.sh                       # 25 adult patients in Boston, MA, seed 1984
#   scripts/synthea.sh -p 100 -s 42          # 100 patients, different seed
#   scripts/synthea.sh -- --exporter.years_of_history=2
#
# Output (gitignored):
#   data/synthea/csv/   patients.csv, observations.csv, conditions.csv, medications.csv, ...
#   data/synthea/fhir/  one FHIR R4 Bundle JSON per patient
#
# Requires Java 17+. The Synthea jar is downloaded once to .cache/synthea/.

set -euo pipefail

SYNTHEA_VERSION="${SYNTHEA_VERSION:-v4.0.0}"
POPULATION=25
SEED=1984
AGE_RANGE="18-90"
STATE="Massachusetts"
CITY="Boston"

while getopts ":p:s:a:S:c:h" opt; do
  case "$opt" in
    p) POPULATION="$OPTARG" ;;
    s) SEED="$OPTARG" ;;
    a) AGE_RANGE="$OPTARG" ;;
    S) STATE="$OPTARG" ;;
    c) CITY="$OPTARG" ;;
    h) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    \?) echo "Unknown option: -$OPTARG" >&2; exit 2 ;;
    :) echo "Option -$OPTARG needs a value" >&2; exit 2 ;;
  esac
done
shift $((OPTIND - 1))
[[ "${1:-}" == "--" ]] && shift

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="$ROOT/.cache/synthea"
JAR="$CACHE_DIR/synthea-with-dependencies-$SYNTHEA_VERSION.jar"
OUT_DIR="$ROOT/data/synthea"

# --- 1. Java check -----------------------------------------------------------
if ! command -v java >/dev/null 2>&1; then
  echo "error: java not found. Install JDK 17+ (e.g. 'brew install --cask temurin')." >&2
  exit 1
fi
JAVA_MAJOR="$(java -version 2>&1 | awk -F'"' '/version/ {split($2, v, "."); print v[1]}')"
if [[ "${JAVA_MAJOR:-0}" -lt 17 ]]; then
  echo "error: Synthea needs Java 17+, found $JAVA_MAJOR." >&2
  exit 1
fi

# --- 2. Download Synthea (cached) --------------------------------------------
if [[ ! -s "$JAR" ]]; then
  mkdir -p "$CACHE_DIR"
  URL="https://github.com/synthetichealth/synthea/releases/download/$SYNTHEA_VERSION/synthea-with-dependencies.jar"
  echo "==> Downloading Synthea $SYNTHEA_VERSION"
  curl -fL --progress-bar -o "$JAR.part" "$URL"
  mv "$JAR.part" "$JAR"
fi

# --- 3. Generate -------------------------------------------------------------
echo "==> Generating $POPULATION patients (seed $SEED, ages $AGE_RANGE, $CITY, $STATE)"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Run from the output dir so Synthea's ./output default and any logs land there.
(
  cd "$OUT_DIR"
  java -jar "$JAR" \
    -p "$POPULATION" \
    -s "$SEED" \
    -cs "$SEED" \
    -a "$AGE_RANGE" \
    --exporter.baseDirectory="$OUT_DIR" \
    --exporter.csv.export=true \
    --exporter.fhir.export=true \
    --exporter.hospital.fhir.export=false \
    --exporter.practitioner.fhir.export=false \
    --exporter.years_of_history=5 \
    --generate.only_alive_patients=true \
    "$@" \
    "$STATE" "$CITY"
) > "$OUT_DIR/synthea.log" 2>&1 || {
  echo "error: Synthea failed. Last lines of $OUT_DIR/synthea.log:" >&2
  tail -20 "$OUT_DIR/synthea.log" >&2
  exit 1
}

# --- 4. Verify output --------------------------------------------------------
echo "==> Checking output"
fail=0
for f in patients.csv observations.csv conditions.csv encounters.csv medications.csv; do
  if [[ ! -s "$OUT_DIR/csv/$f" ]]; then
    echo "  FAIL  csv/$f missing or empty" >&2
    fail=1
  fi
done
FHIR_COUNT="$(find "$OUT_DIR/fhir" -name '*.json' 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$FHIR_COUNT" -eq 0 ]]; then
  echo "  FAIL  no FHIR bundles in fhir/" >&2
  fail=1
fi
[[ "$fail" -eq 0 ]] || exit 1

# Summarise the bits the apps care about (patients + vitals), parsed with a real CSV reader.
python3 -I - "$OUT_DIR/csv" <<'PY'
import csv, sys, os
from collections import Counter

d = sys.argv[1]
with open(os.path.join(d, "patients.csv"), newline="") as f:
    patients = list(csv.DictReader(f))

# LOINC codes that map to VitalsReading in packages/shared
VITALS = {
    "8867-4": "heartRateBpm",
    "8480-6": "systolicMmHg",
    "8462-4": "diastolicMmHg",
    "2708-6": "spo2Percent",
    "59408-5": "spo2Percent",
    "8310-5": "temperatureC",
}
counts, total = Counter(), 0
with open(os.path.join(d, "observations.csv"), newline="") as f:
    for row in csv.DictReader(f):
        total += 1
        if row["CODE"] in VITALS:
            counts[VITALS[row["CODE"]]] += 1

print(f"  patients:      {len(patients)}")
print(f"  observations:  {total}")
for k in ["heartRateBpm", "systolicMmHg", "diastolicMmHg", "spo2Percent", "temperatureC"]:
    print(f"    {k:<13} {counts[k]}")
print("  sample:")
for p in patients[:3]:
    print(f"    {p['Id']}  {p['FIRST']} {p['LAST']}  born {p['BIRTHDATE']}  {p['GENDER']}")
PY
echo "  FHIR bundles:  $FHIR_COUNT"
echo "==> Done. Data in ${OUT_DIR#"$ROOT"/}/"
