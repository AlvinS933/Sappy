"""LOINC codes for the vitals we simulate -> VitalsReading key (packages/shared).

Verified against Synthea output (see CLAUDE.md -> Vitals and codes). Blood pressure arrives as a
panel (85354-9) whose components carry these systolic/diastolic codes.
"""

VITAL_LOINC = {
    "8867-4": "heartRateBpm",
    "8480-6": "systolicMmHg",
    "8462-4": "diastolicMmHg",
    "2708-6": "spo2Percent",
    "59408-5": "spo2Percent",
    "8310-5": "temperatureC",
    "9279-1": "respiratoryRate",
}
