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
- Base FHIR parsing on a real Synthea bundle in `server/data/raw/`, not on assumptions about structure.
- Never commit `server/data/raw/` or the Synthea jar (`server/tools/`). `server/data/clean/` IS committed.
- Ask before deciding anything listed under **Open decisions**.
- "Agent" is reserved for actual AI agents. Plain loops (like the alert worker) are "workers".

## Repo layout

```
apps/nurse-web/          Vite + React nurse dashboard (TS), on Vercel
apps/patient-desktop/    Electron + React patient app (TS), runs locally
packages/shared/         @repo/shared - TS types shared by both apps (+ Supabase row types)
supabase/migrations/     database schema, RLS, Realtime
render.yaml              Render Blueprint (simulator web service + alert worker)
requirements.txt         Python deps for Render
server/                  all backend Python
  Synthea_Gen/synthea.py   runs Synthea -> server/data/raw/ (gitignored)
  Synthea_Gen/transform.py scrubs raw FHIR -> server/data/clean/ (committed)
  sim/                     vitals simulator + HTTP server; writes vitals to Supabase (supabase_sink.py)
  news2/scoring.py         NEWS2 scoring + alert persistence rule (stdlib only)
  news2/alert_worker.py    reads `vitals` from Supabase, scores, writes `alerts` (Render worker)
```

## Stack

| Area | Choice |
|---|---|
| Frontends | TypeScript: `apps/nurse-web` (Vite + React, hosted on **Vercel**), `apps/patient-desktop` (Electron + React, runs locally) |
| Shared TS types | `packages/shared` (`@repo/shared`), incl. Supabase row types + mappers |
| Backend | Python services on **Render** (paid plan): `server/sim/` (simulator) and `server/news2/alert_worker.py`. Deps in `requirements.txt` |
| Database / realtime / auth | **Supabase** (Postgres + Realtime + Auth). Schema: `supabase/migrations/` |
| Severity scoring | NEWS2, deterministic and authoritative |
| ML layer | scikit-learn, running in our own Render service (never a third-party AI service) |
| Data model | HL7 FHIR R4 (`fhir.resources` in Python, `@types/fhir` in TS) |
| Mock patients | Synthea (Java CLI, run once to generate data) |
| JS package manager | pnpm (version pinned in root `package.json`) |

The Python services are **not** part of the pnpm workspace, and they don't talk to the apps directly:
Python writes to Supabase (secret key), the apps read with `@supabase/supabase-js` + Realtime
(publishable key + sign-in). The one exception is the demo controls (trigger sepsis, oxygen, ...),
which are HTTP POSTs to the simulator on Render. Row types in `packages/shared` mirror the SQL by
hand; if they drift, generate them with `supabase gen types typescript`.

```
Synthea -> transform -> server/data/clean/ (committed)
                            |
     Render: server/sim/ ---+--> Supabase: patients, encounters, vitals --Realtime--> nurse-web (Vercel)
     Render: alert worker <-- vitals (poll 2 s), --> alerts ---------------Realtime--> patient-desktop
```

## Prerequisites

- Node + pnpm: everyone. pnpm is auto-downloaded via `devEngines`.
- Python 3.12+: everyone working on the backend. Use a venv:
  `python3.12 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt`.
  (The data pipeline, simulator and NEWS2 scoring also run on plain `python3` 3.9+, stdlib only,
  without Supabase.)
- Supabase settings: `cp .env_sample .env` (repo root) and fill in the keys (Project Settings -> API Keys).
  Frontend: `cp apps/nurse-web/.env.example apps/nurse-web/.env`.
- Java 17 (LTS): **only** to regenerate Synthea data. `server/data/clean/` is committed, so most
  people never need Java. Mac: `brew install openjdk@17`.

## Commands

```sh
pnpm dev           # nurse web app + patient desktop app
pnpm dev:nurse     # nurse web app only
pnpm dev:patient   # Electron app only
pnpm typecheck
pnpm lint
```

Data pipeline + simulator + alerts (Python):

```sh
pnpm data:synthea     # 1. generate: Synthea -> server/data/raw/ (needs Java 17+)
pnpm data:transform   # 2. transform: server/data/raw/fhir -> scrubbed server/data/clean/
pnpm sim:demo         # 3. simulate: scripted demo, fast-forwarded, printed as a table
pnpm sim:serve        #    same demo live on http://127.0.0.1:8765 (2 s = 15 min); also writes to
                      #    Supabase when SUPABASE_URL + SUPABASE_SECRET_KEY are set (needs the venv)
pnpm alerts           # 4. score: alert worker, polls Supabase vitals every 2 s (needs the venv + keys)
pnpm test:sim         # simulator + transform + Supabase-writer tests (no network)
pnpm test:alerts      # alert worker tests (fake Supabase client, no network)
```

## Deployment

1. **Supabase**: apply `supabase/migrations/` (SQL editor, or `supabase link` + `supabase db push`).
   Create staff users under Authentication; RLS lets only signed-in users read.
2. **Render**: New -> Blueprint -> this repo (`render.yaml`): simulator web service + alert worker.
   Set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` on both. `server/data/clean/` must be committed.
   Free instances sleep and stop the simulator, so demo on a paid instance (we have one).
   Demo controls need `Authorization: Bearer $SIM_CONTROL_TOKEN`.
3. **Vercel**: import the repo, Root Directory `apps/nurse-web` (Vite is auto-detected). Set
   `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. If install fails on the pinned pnpm
   version, add `ENABLE_EXPERIMENTAL_COREPACK=1`.

## Privacy rules (non-negotiable)

- Nothing past the **transform** step may contain names, addresses, telecom, identifiers
  (MRN/SSN etc.), exact birthDate, or free-text notes.
- Store age as an **age band** (e.g. `"70-79"`), not a birthdate.
- Key everything on random **pseudonymous IDs** (`Patient.id` / `Encounter.id`).
- **A bed number is a display label only, never a key.** Model beds as FHIR `Location` resources
  linked from `Encounter.location`. Patients transfer, and beds get reused.
- Only pseudonymized data is stored in Supabase or sent to Render. Scoring and the ML model run in
  our own Render service; no third-party AI service receives patient data. If an external LLM is
  ever called, it only receives pseudonymized clinical data.
- RLS is on for every Supabase table. The secret key (bypasses RLS) lives only in Render and local
  `.env`, never in a frontend or a `VITE_` variable. Browsers use the publishable key + sign-in.
- Scenario ground truth (who is "septic") is never written to Supabase; the alert worker and the
  nurse UI only see the vitals stream.
- `packages/shared` `Patient` is pseudonymous ID + age band; the bed label lives on
  `Encounter.location.display` (fixed; it used to have `firstName`/`lastName`/`room`).

## Pipeline (separate, independent steps)

Keep the steps independent so a simulator bug never requires regenerating data.

1. **generate**: run Synthea and write raw output to `server/data/raw/` (gitignored).
2. **transform**: read raw bundles and write one small clean JSON per patient to `server/data/clean/` (committed).
   - Skip `hospitalInformation*.json` and `practitionerInformation*.json`.
   - Drop deceased patients (`Patient.deceasedDateTime` / `deceasedBoolean`).
   - Scrub identifying fields (see Privacy rules).
   - Keep: Patient (scrubbed), active Conditions, active MedicationRequests, recent Observations.
3. **simulate**: load clean patients, create an `in-progress` inpatient `Encounter`
   (class `IMP`) and a bed `Location` for each, then emit vital-sign readings every **2 s** real
   time (= 15 min hospital time), driven by per-patient scenarios. Each tick is written to
   Supabase `vitals`.
4. **score**: `server/news2/alert_worker.py` polls `vitals` every 2 s (one tick), scores each row
   with `News2Monitor`, and writes `alerts` (see Alerting).

## Synthea

- Use the prebuilt `synthea-with-dependencies.jar` (kept in gitignored `server/tools/`).
- Example: `java -jar synthea-with-dependencies.jar -s 42 -p 10 -a 60-90 --exporter.years_of_history=5 Massachusetts`
  - `-s` is the seed. Keep it fixed so the whole team gets identical data. `-p` is population size and `-a` is the age range.
- `server/Synthea_Gen/synthea.py` writes to `server/data/raw/fhir/` (Synthea's own default is `output/fhir/`), one transaction Bundle per patient. Bundles are large (often MBs),
  so start with small populations.
- **Gotcha:** references inside bundles are usually `urn:uuid:...` matching each entry's
  `fullUrl`, not `Patient/<id>`. Build a `fullUrl -> resource` map to resolve them.

## Vitals and codes

Verify these LOINC codes against a real Synthea bundle (grep the raw output) and use whatever
Synthea actually emits:

- Heart rate `8867-4`
- Respiratory rate `9279-1`
- Blood pressure panel `85354-9`, with components systolic `8480-6` and diastolic `8462-4`
  (verified in Synthea output)
- Body temperature `8310-5`
- Oxygen saturation: Synthea emits both `59408-5` and `2708-6`, but rarely (1 patient each in a
  25-patient run), so the simulator generates SpO2 rather than relying on Synthea values.

Observation essentials: `status`, `category` = `vital-signs`, `code` (LOINC), `subject`,
`encounter`, `effectiveDateTime` (current sim time), and `valueQuantity` (UCUM units).
Identify vitals by LOINC code, never by display text.

## Alerting

- **NEWS2 is the deterministic core and always authoritative.** Implemented in
  `server/news2/scoring.py`; NEWS2 tests are owned by a different teammate. It needs inputs that
  Synthea doesn't provide, so the simulator emits them too:
  - level of consciousness (ACVPU, where new confusion scores 3)
  - supplemental oxygen (yes/no, scores 2)
  - SpO2 Scale 1 vs Scale 2 (Scale 2 only for hypercapnic respiratory failure risk, e.g. COPD,
    emphysema; derived from Conditions. Asthma stays on Scale 1)
- **Scoring:** each of the 7 inputs is scored 0-3 from the RCP 2017 chart and summed (0-20).
  Bands are "value <= upper edge", so in-between decimals (38.05 °C) still score.
- **Tiers** map to NEWS2 clinical response bands:
  - **watch**: aggregate 1-4
  - **check soon**: aggregate 5-6, *or* a single parameter scoring 3
  - **go now**: aggregate 7+
- **Persistence rule (false-alarm suppression):** `News2Monitor` only escalates once a tier has
  held for 2 consecutive readings. One bad reading is `suppressed` instead of alerting.
  De-escalation is immediate.
- **Alert worker (`alerts` rows):** a row is written only when a patient's confirmed tier rises
  above the last tier alerted for them. Holding a tier doesn't repeat it; dropping lowers the bar,
  so a later re-escalation alerts again. All tiers are written, including `watch` (the UI shows
  `watch` quietly). `reason` is the NEWS2 reasons joined, e.g. `"Respiratory rate 26/min (+3); ..."`.
  Suppressed readings are logged, not written. Rows missing a NEWS2 input are skipped with a warning.
- **ML layer (scikit-learn, local).** It sits on top of NEWS2 and can never silently lower a
  NEWS2 "go now". Candidate uses:
  - artifact detection (e.g. an IsolationForest or rules + features flagging a physiologically
    implausible single reading like the loose-probe SpO2 dip)
  - trend detection (sustained drift across ticks vs. one-off noise)
  - Synthea data has no real deterioration labels, so any trained model learns from our own
    scenario-generated data. Be upfront about that in the demo.
- **Context:** use Conditions/Meds, e.g. beta blockers blunt the HR response.
- **Explanation:** every alert carries a plain-language reason (which parameters, what trend).
- Consider writing alerts back as FHIR `Flag` or `Communication` resources.

## Scenarios

Each patient has a stable baseline plus small random noise, and optionally a scripted
deterioration curve over N simulated hours. **They must be deterministic given a seed** so demo
runs are reproducible.

- **stable**: most patients
- **early sepsis**: HR, RR and temp rise; SpO2 drifts down; SBP falls late; possibly new confusion
- **false alarm**: one implausible SpO2 reading, immediately back to normal

## Decided

- Apps get live data from **Supabase Realtime**, not an SSE stream from our server.
- Server writes to Supabase via the `supabase` package + `SUPABASE_SECRET_KEY` (not raw Postgres).
- The alert worker **polls** `vitals` every 2 s (one simulator tick) rather than subscribing to Realtime.
- Alerts are written for every tier, including `watch`.

## Open decisions (ask before building)

- Whether to also store vitals as FHIR `Observation` JSON (today: one wide `vitals` row per tick).
- Exactly what the scikit-learn model does (artifact detection, trend, or both).
- Stretch: replay one patient from the MIMIC-IV demo on FHIR (PhysioNet) as a "real data" showcase.
