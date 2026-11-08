# Sappy
Login for use: testuser00@gmail.com
Password: 123456
**A privacy-first bedside companion for patients, and a prioritized request dashboard for the nurses who care for them.**

Sappy has two sides:

- **For hospitals (B2B), the nurse dashboard.** One prioritized queue of everything that needs a nurse: vitals-based deterioration alerts (NEWS2) and patient requests, ranked by urgency and wait time, with a live ward map.
- **For patients (B2C), the bedside companion.** A friendly animated character the patient can simply talk to ("Hey Sappy…"). It answers everyday questions, and when the patient needs something it works out what the need is and how urgent it is, then sends a structured request to the nurses. The AI runs on the bedside device, so the conversation never leaves the room.

---

## The problem

Today, a hospitalized patient who needs help has a call button. Every press looks the same at the nurses' station: a request for a glass of water and a patient who can't breathe arrive the same way, with no information about what's needed or how urgent it is.

When several call lights go off at once, nurses have to walk to each room just to find out what the patient wants, and they can't prioritize until they get there. That costs time on routine requests, delays the urgent ones, and adds to the alarm fatigue and burnout that already weigh on nursing staff.

## How Sappy helps

| Without Sappy | With Sappy |
|---|---|
| Every call press looks identical | Each request arrives labeled: "Requested water", "Help to the bathroom", "Possible emergency: chest pain" |
| No urgency information | Every request has a tier (**Go now / Check soon / Watch**) on the same scale as clinical NEWS2 alerts |
| Nurses walk in to find out what's needed | Nurses see the need first and can bring the water on the way, or run |
| Deterioration and patient requests live in separate systems | One queue, sorted by urgency, then by how long the patient has waited |
| Talking to a voice assistant usually means sending audio to the cloud | Speech recognition, the language model and the voice all run **locally** on the bedside device |

**Emergencies are never left to the AI alone.** A keyword safety check runs before the language model, so phrases like "I can't breathe", "my chest hurts" or "I just fell" raise a **Go now** request within about a second, even if the model misunderstands. If a request can't be delivered, the companion tells the patient to press their call button instead of pretending help is on the way.

---

## How it works

```
 BEDSIDE (patient device, all AI local)                       CLOUD                         NURSES

 "Hey Sappy, I need help          ┌───────────────────┐
  getting to the bathroom"  ───▶  │ Wake word         │
                                  │ Speech → text     │
                                  │ Safety check      │      ┌──────────────────────┐
                                  │ Local LLM + tools ├────▶ │ Supabase             │      ┌─────────────────────┐
                                  │ Text → speech     │      │  patient_requests    ├────▶ │ Nurse dashboard     │
                                  └───────────────────┘      │  alerts (NEWS2)      │ Real │ (web, Vercel)       │
                                   only a structured         │  vitals, patients    │ time │ prioritized queue,  │
                                   request leaves the room   └──────────▲───────────┘      │ ward map, history   │
                                                                        │                  └─────────────────────┘
                                         Render: vitals simulator ──────┤
                                         Render: NEWS2 alert worker ────┘
```

1. **Bedside companion** (`apps/patient-desktop`, Electron): the patient wakes it by voice, or uses the mic button or keyboard. The local model chooses between chatting and one of three actions: **request an item**, **call the nurse** (with a reason such as bathroom, pain or equipment), or **raise an emergency**. Each action becomes a `patient_requests` row made only of fixed categories and labels.
2. **NEWS2 worker** (`server/news2`, on Render): scores each patient's latest vitals with the National Early Warning Score 2. It only escalates once a tier holds for two consecutive readings, so a single bad reading (like a loose SpO₂ probe) doesn't page anyone. It writes `alerts`.
3. **Vitals simulator** (`server/sim`, on Render): streams realistic vitals for five synthetic Synthea patients, including a scripted sepsis deterioration and a false alarm, for demos.
4. **Nurse dashboard** (`apps/nurse-web`, on Vercel): merges `alerts` and `patient_requests` into one live queue. Nurses mark items **complete**; the database records when.

---

## Privacy by design

- **The conversation stays on the device.** Speech recognition (Whisper), the language model (Qwen via Ollama) and the voice (Kokoro) all run locally. No audio and no transcript is sent anywhere.
- **Only structured requests leave the room,** for example `{kind: nurse_call, category: bathroom, label: "help to the bathroom", tier: check soon}`. The patient's own words are never stored in the database.
- **Pseudonymous data only.** Patients are synthetic (Synthea), scrubbed of names, addresses and exact birth dates, keyed by random IDs, and shown as *bed + age band + sex*. Bed labels are for display only, never a key.
- **Row Level Security on every table.** Signed-in staff can read, and can change only an item's status. The bedside app can't read tables at all; it can only call two narrow database functions that validate every field.
- **NEWS2 runs in our own code.** No third-party AI service receives patient data.

---

## Features

**Nurse dashboard (web)**
- **Alerts:** the most urgent open item, with a live waiting timer and its explanation (NEWS2 breakdown or patient request), plus **Mark complete**. Below it, an "Up next" queue (by tier, then wait time) where any item can be completed, a color-coded ward map, and a completed-vs-incomplete dial.
- **Patients:** each bed's live vitals (HR, BP, RR, SpO₂ / O₂, temperature, consciousness), active conditions, medications and alert history.
- **Activity:** the last 24 hours by hour, filters, time-to-complete by hour, and alerts per bed.
- Live updates over Supabase Realtime, with automatic reconnection and a 30-second safety refresh.

**Bedside companion (desktop)**
- **"Hey Sappy" wake word,** custom-trained with openWakeWord, plus a push-to-talk mic button.
- **An animated 3D companion** that floats in the corner of the screen, with a speech bubble showing each sentence as it's spoken.
- **A natural voice** (Kokoro): the first sentence starts playing about 0.3 s after the reply arrives.
- **Patient-friendly assistant:** short spoken replies, no diagnoses or medication advice, honest that it's an AI, and it escalates when unsure.

---

## Tech stack

| Area | Technology |
|---|---|
| Nurse dashboard | React 19 + Vite + TypeScript, hosted on **Vercel** |
| Bedside app | Electron 45 + React 19 + three.js (React Three Fiber) |
| Local language model | **Qwen 3.5 4B** via **Ollama**, with tool calling |
| Speech to text | **Whisper base.en** (ONNX, Transformers.js) |
| Text to speech | **Kokoro-82M** (ONNX), voice `af_heart` |
| Wake word / end of speech | **openWakeWord** ("Hey Sappy", custom-trained) + **Silero VAD** |
| Database, auth, realtime | **Supabase** (Postgres, Row Level Security, Realtime) |
| Backend workers | Python, hosted on **Render** (vitals simulator + NEWS2 worker) |
| Synthetic patients | **Synthea**, transformed into scrubbed FHIR-style JSON |
| Monorepo | pnpm workspaces (`apps/*`, `packages/*`) |

---

## Repository layout

```
apps/
  nurse-web/          Nurse dashboard (Vite + React)
  patient-desktop/    Bedside companion (Electron + React + local AI)
packages/
  shared/             @repo/shared: TypeScript types for database rows and vitals
server/
  Synthea_Gen/        Generate and scrub synthetic patients → server/data/clean/
  sim/                Vitals simulator (HTTP + writes to Supabase)
  news2/              NEWS2 scoring and the alert worker
  supabase/migrations Database schema, security rules, Realtime
scripts/
  ai-setup.mjs        Downloads every local AI model
  wake-test.mjs       Measures wake word accuracy across ~35 voices
render.yaml           Render blueprint (simulator + NEWS2 worker)
```

---

## Getting started

### Prerequisites
- **Node 22.12+** (pnpm 12 is installed automatically through `packageManager`)
- **Python 3.12+** for the simulator and NEWS2 worker
- **Ollama:** `brew install ollama && brew services start ollama` (or the [Ollama app](https://ollama.com/download))
- A **Supabase** project
- Java 17+ only if you want to regenerate the Synthea patients (`server/data/clean/` is already committed)

### 1. Install
```sh
pnpm install
python3.12 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
```

### 2. Set up the database
Apply every file in `server/supabase/migrations/`, **in order**, in Supabase → **SQL Editor** (or `supabase db push` from `server/`). Then create a staff login: **Authentication → Users → Add user**, with *Auto Confirm*.

### 3. Configure the three environment files (all gitignored)

| File | Template | Contains |
|---|---|---|
| `.env` (repo root) | `.env_sample` | `SUPABASE_URL`, `SUPABASE_SECRET_KEY`: **backend only** |
| `apps/nurse-web/.env` | `apps/nurse-web/.env.example` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY` |
| `apps/patient-desktop/.env` | `apps/patient-desktop/.env.example` | `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` |

> Never put the secret key (`sb_secret_…`) in either app. It bypasses all database security.

### 4. Download the local AI models (about 4.6 GB, once)
```sh
pnpm ai:setup
```
This pulls Qwen 3.5 4B through Ollama, and puts Kokoro, Whisper, openWakeWord ("Hey Sappy") and Silero VAD in `apps/patient-desktop/.models/`.

### 5. Run it
```sh
pnpm sim:serve --speed 60   # vitals simulator → Supabase (2 s per reading = 2 hospital minutes)
pnpm alerts                 # NEWS2 alert worker
pnpm dev:nurse              # nurse dashboard   → http://localhost:5173
pnpm dev:patient            # bedside companion (Electron)
```
Sign in to the dashboard with your staff login, then say **"Hey Sappy, can I get some water?"** to the companion. The request appears in the nurses' queue within a second or two.

The bedside app plays the first patient (by ID) who has a bed, shown in its window as e.g. *"Patient 1ebf325c · bed 4W-04"*.

---

## Commands

| Command | What it does |
|---|---|
| `pnpm dev` | Nurse dashboard + bedside app together |
| `pnpm dev:nurse` / `pnpm dev:patient` | One app only |
| `pnpm ai:setup` | Download or update all local AI models |
| `pnpm sim:serve` | Live vitals simulator (demo script); add `--speed N` to change the pace |
| `pnpm sim:demo` | Fast-forwarded demo printed as a ward table (no database) |
| `pnpm alerts` | NEWS2 alert worker |
| `pnpm wake:test` | Wake word accuracy and false-trigger report |
| `pnpm typecheck` / `pnpm lint` | Checks for all TypeScript packages |
| `pnpm test:sim` / `pnpm test:alerts` | Python tests (no network) |
| `pnpm data:synthea` → `pnpm data:transform` | Regenerate synthetic patients (needs Java) |

---

## Deployment

- **Backend on Render:** **New → Blueprint** → this repo. `render.yaml` creates the vitals simulator and the NEWS2 worker. Set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` on both. `SIM_SPEED` (default `60`) sets the demo pace. Use a paid instance for demos, because free instances sleep.
- **Nurse dashboard on Vercel:** import the repo with **Root Directory** `apps/nurse-web`, and keep "Include files outside the root directory" **on**. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. The build settings come from `apps/nurse-web/vercel.json`.
- **Bedside app:** runs locally on each bedside device, after `pnpm ai:setup`.
- **Updates:** pushing to `main` redeploys Render and Vercel. Database migrations are applied by hand.

---

## Limitations and notes

- **This is a hackathon prototype, not a medical device.** All patients are synthetic. Clinical staff should review the assistant's prompt, the emergency phrases and the tier mapping before any real use.
- **Bedside authentication is simplified for the demo.** The app has no login: it uses the publishable key and two validated database functions. Real devices should each have their own login, limited to their own patient.
- **Wake word licensing:** the "Hey Sappy" model was trained with openWakeWord's pipeline, whose training data is licensed for **non-commercial use only**. A commercial version needs a model trained on commercially licensed data.
- **"Hey Sappy" sometimes triggers on similar-sounding phrases** ("hey Sammy", "hey happy"). A planned fix is to double-check the wake phrase with the speech-to-text model before responding.
- **Hardware:** the 4B language model and the voice models need a reasonably modern machine. Measure performance on the actual bedside hardware.

### Credits
Qwen 3.5 (Alibaba, Apache 2.0) · Kokoro-82M (Apache 2.0) · Whisper (OpenAI, MIT) · openWakeWord (Apache 2.0 code; non-commercial pre-trained data) · Silero VAD (MIT) · Synthea (Apache 2.0) · NEWS2 (Royal College of Physicians) · 3D companion model made with Meshy AI.
