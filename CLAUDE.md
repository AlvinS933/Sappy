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
- Never commit generated data (`server/data/`) or the Synthea jar cache (`server/.cache/`).
- Ask before deciding anything listed under **Open decisions**.

## Repo layout

```
apps/nurse-web/          Vite + React nurse dashboard (TS)
apps/patient-desktop/    Electron + React patient app (TS)
packages/shared/         @repo/shared - TS types shared by both apps (VitalsReading, ...)
server/                  all backend Python
  requirements.txt         pip deps for Render (supabase)
  Synthea_Gen/synthea.py   runs Synthea -> server/data/synthea/{csv,fhir}/ (gitignored)
  sim/                     vitals simulator: loads Synthea CSV, streams readings, HTTP/SSE server
  news2/scoring.py         NEWS2 scoring + alert persistence rule (stdlib only)
  news2/alert_worker.py    reads `vitals` from Supabase, scores, writes `alerts` (Render worker)
```

"Agent" is reserved for the actual AI agents; plain loops like the alert worker are "workers".

## Stack

| Area | Choice |
|---|---|
| Frontends | TypeScript: `apps/nurse-web` (Vite + React), `apps/patient-desktop` (Electron + React) |
| Shared TS types | `packages/shared` (`@repo/shared`) |
| Backend | Python in `server/`. Sim + scoring are stdlib only; Supabase writers use the `supabase` package |
| Database | Supabase (Postgres), schema in teammate's `supabase/migrations/`. RLS on every table |
| Hosting | Backend on Render (paid plan, so the tick loop never sleeps); frontends on Vercel |
| Severity scoring | NEWS2, a plain local algorithm (no ML model) |
| Data model | HL7 FHIR R4 concepts and LOINC codes; readings are plain camelCase JSON |
| Mock patients | Synthea (Java CLI, run once to generate data) |
| JS package manager | pnpm (version pinned in root `package.json`) |

The Python backend is **not** part of the pnpm workspace; `package.json` just has scripts that call
`python3`. Reading dicts use camelCase keys that match `VitalsReading` in `packages/shared`, so they
go to the apps as JSON unchanged. Keep the two in sync by hand when fields change.

## Prerequisites

- Node + pnpm: everyone. pnpm is auto-downloaded via `devEngines`.
- Python 3.9+: everyone working on the backend (Render uses 3.12). Sim + scoring need no packages;
  the alert worker needs `pip install -r server/requirements.txt`.
- Java 17+: **only** to regenerate Synthea data. Mac: `brew install openjdk@17`.

## Commands

```sh
pnpm dev             # nurse web app + patient desktop app
pnpm dev:nurse       # nurse web app only
pnpm dev:patient     # Electron app only
pnpm typecheck
pnpm lint

pnpm data:synthea    # generate patients -> server/data/synthea/ (needs Java)
pnpm sim:demo        # fast-forward 3 h and print a ward table
pnpm sim:serve       # HTTP + Server-Sent Events on http://127.0.0.1:8765
pnpm test:sim        # simulator + data shape tests
pnpm alerts          # alert worker (needs SUPABASE_URL + SUPABASE_SECRET_KEY in env or .env)
pnpm test:alerts     # alert worker tests (fake Supabase client, no network)
```

## Privacy rules

- Synthea data is synthetic. The local simulator loads Synthea names and birthdates as-is;
  the team has accepted that for mock data. **Supabase only ever gets pseudonymized data**:
  patient ID, age band, gender, coded conditions/medications, vitals. No names or birthdates.
- `SUPABASE_SECRET_KEY` bypasses RLS: server-side only (Render, a laptop's `.env`), never in a
  frontend or a `VITE_` variable. Browsers use the publishable key and must sign in.
- `.env` is gitignored; never commit keys.
- Key everything on patient IDs, never on bed/room number. Room is a display label only.
- If an external LLM is ever called, it only receives pseudonymized clinical data (no names,
  addresses, phone numbers, identifiers, exact birthdates, or free-text notes).

## Data flow

1. **generate**: `server/Synthea_Gen/synthea.py` runs Synthea with a fixed seed (1984), living
   patients only, and writes CSV + FHIR to `server/data/synthea/`.
2. **simulate**: `server/sim/vitals_sim.py` loads patients from the Synthea **CSV** (active
   conditions, latest vitals), derives a baseline per patient, and emits one reading per patient
   per tick. Scenarios (sepsis, hypoxia, ...) push vitals away from baseline. Deterministic given a seed.
3. **store**: the simulator (Render web service) writes one `vitals` row per patient every
   **2 seconds** (one tick) to Supabase. (Supabase writer is on the `supabase-v1` branch.)
4. **score**: `server/news2/alert_worker.py` (Render worker) polls `vitals` every 2 s, scores with
   `scoring.py`'s `News2Monitor`, and inserts an `alerts` row only when a patient's confirmed
   tier rises above the last tier alerted (holding a tier doesn't repeat it). All tiers,
   including `watch`, are written; the frontend shows `watch` quietly.
5. **show**: the nurse app (Vercel) reads Supabase directly with the publishable key after login,
   gets new `vitals`/`alerts` via Supabase Realtime, and sets `alerts.acknowledged_at`.
   The apps never call Render for data (only the sim's optional demo controls).

Reading shape (one per patient per tick):

```json
{ "patientId": "...", "recordedAt": "2026-01-01T08:00:05.000Z",
  "heartRateBpm": 78, "systolicMmHg": 136, "diastolicMmHg": 80, "spo2Percent": 94,
  "temperatureC": 36.6, "respiratoryRate": 16, "onOxygen": false, "consciousness": "A" }
```

## Synthea

- `pnpm data:synthea` downloads the jar once to `server/.cache/synthea/` and runs it.
  Options: `-p` population, `-s` seed, `-a` age range. Keep the seed fixed so the team gets
  identical data.
- Bundles are large (often MBs), so start with small populations.
- **Gotcha (FHIR output):** references inside bundles are usually `urn:uuid:...` matching each
  entry's `fullUrl`, not `Patient/<id>`. Build a `fullUrl -> resource` map to resolve them.

## Vitals and codes

LOINC codes the loader reads from Synthea. Identify vitals by code, never by display text.

- Heart rate `8867-4`
- Respiratory rate `9279-1`
- Systolic BP `8480-6`, diastolic BP `8462-4`
- Body temperature `8310-5`
- Oxygen saturation `2708-6` and `59408-5` (both are used)

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
- **sepsis**: HR, RR and temp rise; SBP falls; SpO2 drifts down; new confusion at high intensity
- also: hypoxia, fever, tachycardia, hypotension, hypertensive crisis
- **false alarm**: one implausible SpO2 reading, immediately back to normal. **Not in the
  simulator yet**; needed to demo the persistence rule.

## Decided

- Apps get live data from **Supabase Realtime**, not an SSE stream from our server.
- Server writes to Supabase via the `supabase` package + `SUPABASE_SECRET_KEY` (not raw Postgres).
- Alerts are written for every tier, including `watch`.

## Open decisions (ask before building)

- Stretch: replay one patient from the MIMIC-IV demo on FHIR (PhysioNet) as a "real data" showcase.
