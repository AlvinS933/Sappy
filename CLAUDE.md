# Inpatient Deterioration Alert Agent (Hackathon)

An agent that watches inpatient vitals in real time and alerts nurses when a patient looks
like they're deteriorating. Alerts are tiered by severity. We're targeting the
**privacy-first** track, so data minimization is a core design rule.

**Demo goal:** several simulated patients streaming vitals. Most are stable, one is
deteriorating (e.g. early sepsis), and one has a brief false alarm (e.g. a single SpO2 dip from a
loose probe) that the agent deliberately does **not** escalate. The problem we're solving is
alert fatigue, so the aim is fewer, better alerts.

## Rules for Claude

- **Git: never make changes without explicit permission.** Don't commit, push, pull, merge,
  rebase, reset, stash, checkout/switch branches, create/delete branches or tags, amend, or
  edit git config unless a teammate asks for that specific action in the current conversation.
  Permission for one action doesn't carry over to the next. Read-only commands
  (`git status`, `git diff`, `git log`, `git show`, `git blame`, `git fetch`) are always fine.
- Work in small steps and show output before moving on.
- Never commit raw Synthea output (`server/data/raw/`, has names/addresses) or the jar (`server/tools/`).
  `server/data/clean/` (scrubbed) **is** committed; Render reads it.
- Ask before deciding anything listed under **Open decisions**.

## Repo layout

```
apps/nurse-web/          Vite + React nurse dashboard (TS)
apps/patient-desktop/    Electron + React patient app (TS)
packages/shared/         @repo/shared - TS types shared by both apps (VitalsReading, ...)
server/                  all backend Python (core: standard library only, Python 3.9+)
  Synthea_Gen/synthea.py   runs Synthea -> server/data/raw/{csv,fhir}/ (gitignored)
  Synthea_Gen/transform.py raw FHIR -> scrubbed server/data/clean/ (committed)
  sim/                     vitals simulator, HTTP/SSE server, Supabase writer (supabase_sink.py)
  news2/scoring.py         NEWS2 scoring + alert persistence rule
  pylib/                   small shared helpers (.env loader, LOINC map)
  supabase/migrations/     Postgres schema, RLS, Realtime (Supabase CLI project lives in server/)
render.yaml              Render blueprint (runs server/sim/cli.py serve --demo)
requirements.txt         Python deps for the Supabase writer (venv, 3.12+)
```

## Stack

| Area | Choice |
|---|---|
| Frontends | TypeScript: `apps/nurse-web` (Vite + React, hosted on **Vercel**), `apps/patient-desktop` (Electron + React, runs locally) |
| Shared TS types | `packages/shared` (`@repo/shared`), incl. Supabase row types + mappers |
| Backend | Python in `server/`, hosted on **Render** (`render.yaml`). Core is standard library only (3.9+); the optional Supabase writer needs `requirements.txt` |
| Database / realtime / auth | **Supabase** (Postgres + Realtime + Auth). Schema: `server/supabase/migrations/` |
| Severity scoring | NEWS2, a plain local algorithm (no ML model) |
| Data model | HL7 FHIR R4 concepts and LOINC codes; readings are plain camelCase JSON |
| Mock patients | Synthea (Java CLI, run once to generate data) |
| JS package manager | pnpm (version pinned in root `package.json`) |

The Python backend is **not** part of the pnpm workspace; `package.json` just has scripts that call
`python3`. Reading dicts use camelCase keys that match `VitalsReading` in `packages/shared`, so they
go to the apps as JSON unchanged. Keep the two in sync by hand when fields change.

Python doesn't talk to the apps directly: the simulator writes to Supabase (secret key), the apps
read with `@supabase/supabase-js` + Realtime (publishable key + sign-in). The exception is the demo
controls (trigger sepsis, oxygen, ...), which are HTTP POSTs to the simulator on Render. Supabase row
types in `packages/shared` mirror the SQL by hand; if they drift, use `supabase gen types typescript`.

```
Synthea -> transform -> server/data/clean/ (committed)
                              |
          Render: server/sim --+--> Supabase: patients, encounters, vitals --Realtime--> nurse-web (Vercel)
          NEWS2 (server/news2) <-- vitals, --> alerts ------------------------Realtime--> patient-desktop
```

## Prerequisites

- Node + pnpm: everyone. pnpm is auto-downloaded via `devEngines`.
- Python 3.9+: enough for the data pipeline, simulator and NEWS2 (standard library only).
  To write to Supabase, use a 3.12+ venv:
  `python3.12 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`.
- Supabase settings: `cp .env_sample .env` (repo root) and fill in the keys (Project Settings ->
  API Keys). Frontend: `cp apps/nurse-web/.env.example apps/nurse-web/.env`.
- Java 17+: **only** to regenerate Synthea data. `server/data/clean/` is committed, so most people
  never need Java. Mac: `brew install openjdk@17`.

## Commands

```sh
pnpm dev             # nurse web app + patient desktop app
pnpm dev:nurse       # nurse web app only
pnpm dev:patient     # Electron app only
pnpm typecheck
pnpm lint

pnpm ai:setup        # download the local AI model files (patient app)

pnpm data:synthea    # 1. generate: Synthea -> server/data/raw/ (needs Java)
pnpm data:transform  # 2. transform: raw FHIR -> scrubbed server/data/clean/
pnpm sim:demo        # 3. simulate: scripted demo, fast-forwarded, printed as a ward table
pnpm sim:serve       #    same demo live on http://127.0.0.1:8765 (2 s = 15 min); also writes to
                     #    Supabase when SUPABASE_URL + SUPABASE_SECRET_KEY are set (needs the venv)
pnpm test:sim        # simulator + transform + Supabase-writer tests (no network)
```

## Deployment

1. **Supabase**: apply `server/supabase/migrations/` (SQL editor, or from `server/`: `supabase link` +
   `supabase db push`).
   Create staff users under Authentication; RLS lets only signed-in users read.
2. **Render**: New -> Blueprint -> this repo (`render.yaml`). Set `SUPABASE_URL` and
   `SUPABASE_SECRET_KEY`. `server/data/clean/` must be committed. Free instances sleep and stop the
   simulator, so demo on a paid instance. Demo controls need `Authorization: Bearer $SIM_CONTROL_TOKEN`.
3. **Vercel**: import the repo, Root Directory `apps/nurse-web` (Vite is auto-detected). Set
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. If install fails on the pinned pnpm
   version, add `ENABLE_EXPERIMENTAL_COREPACK=1`.

## Privacy rules (non-negotiable)

- Nothing past the **transform** step may contain names, addresses, telecom, identifiers
  (MRN/SSN etc.), exact birthDate, or free-text notes. The simulator only loads `server/data/clean/`.
- Store age as an **age band** (e.g. `"70-79"`), not a birthdate.
- Key everything on random **pseudonymous IDs** (`Patient.id` / `Encounter.id`).
- **A bed number is a display label only, never a key.** Beds are FHIR-style `Location`s linked from
  the patient's in-progress `Encounter`. Patients transfer, and beds get reused.
- Only pseudonymized data is stored in Supabase or sent to Render. NEWS2 runs in our own code; no
  third-party AI service receives patient data. If an external LLM is ever called, it only receives
  pseudonymized clinical data.
- RLS is on for every Supabase table. The secret key (bypasses RLS) lives only in Render and the
  local `.env`, never in a frontend or a `VITE_` variable. Browsers use the publishable key + sign-in.
- Scenario ground truth (who is "septic") is never written to Supabase; the agent and the nurse UI
  only see the vitals stream.

## Data flow (separate, independent steps)

Keep the steps independent so a simulator bug never requires regenerating data.

1. **generate**: `server/Synthea_Gen/synthea.py` runs Synthea with a fixed seed (1984), living
   patients only, and writes CSV + FHIR to `server/data/raw/` (gitignored).
2. **transform**: `server/Synthea_Gen/transform.py` reads the raw FHIR bundles and writes one small
   scrubbed JSON per patient to `server/data/clean/` (committed): age band, active Conditions,
   active MedicationRequests, latest vital/lab Observations. Skips hospital/practitioner bundles and
   deceased patients, and refuses to write a file if anything identifying would leak.
3. **simulate**: `server/sim/vitals_sim.py` loads the clean patients, admits the 5-patient ward
   (in-progress Encounter + bed), derives a baseline per patient, and emits one reading per patient
   per tick. Scenarios push vitals away from baseline. Deterministic given a seed.
4. **score**: `server/news2/scoring.py` scores each reading and decides the alert tier.

Reading shape (one per patient per tick):

```json
{ "patientId": "...", "encounterId": "...", "recordedAt": "2026-01-01T08:00:05.000Z",
  "heartRateBpm": 78, "systolicMmHg": 136, "diastolicMmHg": 80, "spo2Percent": 94,
  "temperatureC": 36.6, "respiratoryRate": 16, "onOxygen": false, "consciousness": "A" }
```

## Synthea

- `pnpm data:synthea` downloads the jar once to `server/tools/` (gitignored) and runs it.
  Options: `-p` population, `-s` seed, `-a` age range. Keep the seed fixed so the team gets
  identical data.
- Bundles are large (often MBs), so start with small populations.
- **Gotcha (FHIR output):** references inside bundles are usually `urn:uuid:...` matching each
  entry's `fullUrl`, not `Patient/<id>`. Build a `fullUrl -> resource` map to resolve them.

## Vitals and codes

LOINC codes the loader reads from Synthea. Identify vitals by code, never by display text.

- Heart rate `8867-4`
- Respiratory rate `9279-1`
- Blood pressure panel `85354-9`, with components systolic `8480-6` and diastolic `8462-4`
- Body temperature `8310-5`
- Oxygen saturation `2708-6` and `59408-5` (both are used), but Synthea rarely records SpO2, so the
  simulator generates it rather than relying on Synthea values.

## Alerting (NEWS2)

Implemented in `server/news2/scoring.py`. NEWS2 tests are owned by a different teammate.

- **Scoring:** each of the 7 inputs (respiratory rate, SpO2, air or oxygen, systolic BP, pulse,
  consciousness, temperature) is scored 0-3 from the RCP 2017 chart and summed (0-20).
  Bands are "value <= upper edge", so in-between decimals (38.05 °C) still score.
- **SpO2 scale:** Scale 2 is used automatically for patients whose conditions indicate
  hypercapnic respiratory failure risk (COPD, emphysema, ...). Asthma stays on Scale 1.
- **Risk and tiers:**

  | NEWS2 | Risk | Tier |
  |---|---|---|
  | total 0 | low | none |
  | total 1-4 | low | watch |
  | any single input scores 3 | low-medium | check soon |
  | total 5-6 | medium | check soon |
  | total 7+ | high | go now |

- **Persistence rule (false-alarm suppression):** `News2Monitor` only escalates once a tier has
  held for 2 consecutive readings. One bad reading is marked `suppressed` instead of alerting.
  De-escalation is immediate. This sits on top of NEWS2; the raw score is always reported too.
- **Missing inputs:** a reading without all 7 inputs raises `ValueError`. The data shape tests
  guarantee the simulator always sends them.
- **Explanation:** every result carries `reasons` (e.g. `"Respiratory rate 23/min (+2)"`) and
  the NEWS2 recommended `response`.
- Later: use Conditions/Meds for context (e.g. beta blockers blunt HR); write alerts back as
  FHIR `Flag` or `Communication` resources.

## Scenarios

Each patient has a stable baseline plus noise; scenarios have an onset -> hold -> recovery curve.
**Deterministic given a seed** so demo runs are reproducible.

- **stable**: most patients
- **sepsis**: HR, RR and temp rise; SpO2 drifts down; SBP falls late; new confusion at high intensity
- also: hypoxia, fever, tachycardia, hypotension, hypertensive crisis
- **false alarm**: one implausible SpO2 reading (72-80%) with a normal heart rate, immediately back
  to normal (`inject_artifact`, or `POST /patients/<id>/artifact`). Demos the persistence rule.

The ward is **5 patients** (`DEMO_WARD` in `server/sim/vitals_sim.py`, beds 4W-01..05; override with
`SIM_PATIENT_IDS`). Bed 4W-02 gets sepsis and 4W-04 the loose probe. Only these 5 are simulated and
written to Supabase; on start the simulator removes any other patients from the tables.

`vitals` in Supabase holds **one row per patient** with their latest reading: every tick the
simulator upserts on `patient_id` (update the row, or insert it the first time). There's no history
in the table, so the NEWS2 agent and the UI must keep their own history from Realtime UPDATE events
for trend detection and charts.

## Open decisions (ask before building)

- Where NEWS2 runs: inside the simulator process on Render, or as a separate Render worker that
  reads `vitals` from Supabase (Realtime subscription vs. polling) and writes `alerts`.
- Whether to also keep vitals history in Supabase (today `vitals` holds only the latest reading per
  patient, updated in place), and/or store vitals as FHIR `Observation` JSON.
- Stretch: replay one patient from the MIMIC-IV demo on FHIR (PhysioNet) as a "real data" showcase.
