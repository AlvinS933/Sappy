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
  (`git status`, `git diff`, `git log`, `git show`, `git blame`) are always fine.
- Work in small steps and show output before moving on.
- Base FHIR parsing on a real Synthea bundle in `data/raw/`, not on assumptions about structure.
- Never commit `data/raw/`.
- Ask before deciding anything listed under **Open decisions**.

## Stack

| Area | Choice |
|---|---|
| Frontends | TypeScript: `apps/nurse-web` (Vite + React), `apps/patient-desktop` (Electron + React) |
| Shared TS types | `packages/shared` (`@repo/shared`) |
| Backend | Python + FastAPI (`services/api/`), managed with `uv` and `pyproject.toml` |
| Severity scoring | NEWS2, deterministic and authoritative |
| ML layer | scikit-learn, running **locally** (no data leaves the machine) |
| Data model | HL7 FHIR R4 (`fhir.resources` in Python, `@types/fhir` in TS) |
| Mock patients | Synthea (Java CLI, run once to generate data) |
| JS package manager | pnpm (version pinned in root `package.json`) |

The Python backend is **not** part of the pnpm workspace. The TS apps talk to it over HTTP/WebSocket.
To keep the two languages in sync, generate TS types from FastAPI's OpenAPI schema
(e.g. `openapi-typescript`) rather than hand-writing duplicate types.

## Prerequisites

- Node + pnpm: everyone. pnpm is auto-downloaded via `devEngines`.
- Python 3.12+ and [`uv`](https://docs.astral.sh/uv/): everyone working on the backend.
  `uv sync` in `services/api/` installs dependencies from `pyproject.toml` / `uv.lock`.
- Java 17 (LTS): **only** to regenerate Synthea data. `data/clean/` is committed, so most
  people never need Java. Mac: `brew install openjdk@17`.

## Commands

```sh
pnpm dev           # nurse web app + patient desktop app
pnpm dev:nurse     # nurse web app only
pnpm dev:patient   # Electron app only
pnpm typecheck
pnpm lint
```

Backend commands (to be set up):

```sh
cd services/api
uv sync
uv run fastapi dev app/main.py
uv run pytest
```

## Privacy rules (non-negotiable)

- Nothing past the **transform** step may contain names, addresses, telecom, identifiers
  (MRN/SSN etc.), exact birthDate, or free-text notes.
- Store age as an **age band** (e.g. `"70-79"`), not a birthdate.
- Key everything on random **pseudonymous IDs** (`Patient.id` / `Encounter.id`).
- **A bed number is a display label only, never a key.** Model beds as FHIR `Location` resources
  linked from `Encounter.location`. Patients transfer, and beds get reused.
- The ML model runs locally. If an external LLM is ever called, it only receives
  pseudonymized clinical data.
- Known violation to fix: `packages/shared/src/index.ts` `Patient` currently has
  `firstName`/`lastName` and uses `room` as an attribute. Replace it with pseudonymous ID +
  age band + bed display label.

## Pipeline (separate, independent steps)

Keep the steps independent so a simulator bug never requires regenerating data.

1. **generate**: run Synthea and write raw output to `data/raw/` (gitignored).
2. **transform**: read raw bundles and write one small clean JSON per patient to `data/clean/` (committed).
   - Skip `hospitalInformation*.json` and `practitionerInformation*.json`.
   - Drop deceased patients (`Patient.deceasedDateTime` / `deceasedBoolean`).
   - Scrub identifying fields (see Privacy rules).
   - Keep: Patient (scrubbed), active Conditions, active MedicationRequests, recent Observations.
3. **simulate**: load clean patients, create an `in-progress` inpatient `Encounter`
   (class `IMP`) and a bed `Location` for each, then emit vital-sign `Observation`s on a timer
   (e.g. 1 tick every 2-5 s real time = 15 min hospital time), driven by per-patient scenarios.

## Synthea

- Use the prebuilt `synthea-with-dependencies.jar` (keep it in a gitignored `tools/` dir).
- Example: `java -jar synthea-with-dependencies.jar -s 42 -p 10 -a 60-90 --exporter.years_of_history=5 Massachusetts`
  - `-s` is the seed. Keep it fixed so the whole team gets identical data. `-p` is population size and `-a` is the age range.
- Output goes to `output/fhir/`, one transaction Bundle per patient. Bundles are large (often MBs),
  so start with small populations.
- **Gotcha:** references inside bundles are usually `urn:uuid:...` matching each entry's
  `fullUrl`, not `Patient/<id>`. Build a `fullUrl -> resource` map to resolve them.

## Vitals and codes

Verify these LOINC codes against a real Synthea bundle (grep the raw output) and use whatever
Synthea actually emits:

- Heart rate `8867-4`
- Respiratory rate `9279-1`
- Blood pressure panel `85354-9`, with components systolic `8480-6` and diastolic `8462-6`
- Body temperature `8310-5`
- Oxygen saturation: more than one code exists (e.g. `59408-5`, `2708-6`). Confirm which one Synthea uses.

Observation essentials: `status`, `category` = `vital-signs`, `code` (LOINC), `subject`,
`encounter`, `effectiveDateTime` (current sim time), and `valueQuantity` (UCUM units).
Identify vitals by LOINC code, never by display text.

## Alerting

- **NEWS2 is the deterministic core and always authoritative.** It needs inputs that Synthea
  doesn't provide, so the simulator must emit them too:
  - level of consciousness (ACVPU, where new confusion scores 3)
  - supplemental oxygen (yes/no, scores 2)
  - SpO2 Scale 1 vs Scale 2 (Scale 2 only for confirmed hypercapnic respiratory failure,
    e.g. some COPD patients; derive it from Conditions)
- **Tiers** map to NEWS2 clinical response bands:
  - **watch**: aggregate 1-4
  - **check soon**: aggregate 5-6, *or* a single parameter scoring 3
  - **go now**: aggregate 7+
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

## Open decisions (ask before building)

- Where the transform + simulate steps live: Python (`services/api`, alongside scoring) vs. TS.
  Python is currently assumed.
- Transport: the backend reads from a **HAPI FHIR server** (Docker `hapiproject/hapi`, more
  realistic) vs. a **direct event stream** (FastAPI WebSocket, faster to build).
- Exactly what the scikit-learn model does (artifact detection, trend, or both).
- Stretch: replay one patient from the MIMIC-IV demo on FHIR (PhysioNet) as a "real data" showcase.
