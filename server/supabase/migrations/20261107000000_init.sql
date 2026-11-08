-- Inpatient deterioration alerts: schema, Row Level Security and Realtime.
--
-- Privacy (CLAUDE.md): only pseudonymized data lives here - Synthea Patient.id, age band, coded
-- conditions/medications and simulated vitals. No names, birthdates, addresses or identifiers.
-- Writers (simulator, NEWS2 agent on Render) use the secret key, which bypasses RLS.
-- Browsers use the publishable key and must sign in: every table is readable only by `authenticated`.

-- Patients: loaded from data/clean/ by the simulator (upserted on start).
create table public.patients (
  id          text primary key,                 -- pseudonymous Synthea Patient.id
  age_band    text not null,                    -- "70-79", "90+"
  gender      text,                             -- FHIR AdministrativeGender
  conditions  text[] not null default '{}',
  medications text[] not null default '{}',
  updated_at  timestamptz not null default now()
);

-- Encounters: one in-progress inpatient stay (class IMP) per patient, at a bed Location.
-- bed_label is a display label only - never join or key on it (patients transfer, beds get reused).
create table public.encounters (
  id          uuid primary key,
  patient_id  text not null references public.patients (id) on delete cascade,
  status      text not null default 'in-progress' check (status in ('in-progress', 'finished')),
  class       text not null default 'IMP',
  location_id uuid not null,
  bed_label   text not null,
  updated_at  timestamptz not null default now()
);
create index encounters_patient on public.encounters (patient_id);

-- Vitals: the LATEST reading per patient (same fields as VitalsReading in packages/shared).
-- The simulator upserts on patient_id every tick: it updates the patient's row, or inserts it on
-- the first tick. There is no history here - subscribe to Realtime UPDATEs to follow changes.
create table public.vitals (
  patient_id       text primary key references public.patients (id) on delete cascade,
  encounter_id     uuid not null references public.encounters (id) on delete cascade,
  recorded_at      timestamptz not null,       -- simulated hospital time
  heart_rate_bpm   smallint,
  systolic_mmhg    smallint,
  diastolic_mmhg   smallint,
  spo2_percent     smallint,
  temperature_c    numeric(4, 1),
  respiratory_rate smallint,
  on_oxygen        boolean,
  consciousness    text check (consciousness in ('A', 'C', 'V', 'P', 'U'))  -- ACVPU
);
create index vitals_encounter on public.vitals (encounter_id);

-- Alerts: written by the NEWS2 + ML agent. Tiers follow the NEWS2 clinical response bands.
create table public.alerts (
  id              bigint generated always as identity primary key,
  patient_id      text not null references public.patients (id) on delete cascade,
  encounter_id    uuid not null references public.encounters (id) on delete cascade,
  created_at      timestamptz not null default now(),
  tier            text not null check (tier in ('watch', 'check soon', 'go now')),
  news2_score     smallint,
  reason          text not null,                -- plain-language explanation (no patient free text)
  acknowledged_at timestamptz
);
create index alerts_encounter_time on public.alerts (encounter_id, created_at desc);

-- Row Level Security: signed-in staff can read everything and acknowledge alerts; nothing else.
alter table public.patients   enable row level security;
alter table public.encounters enable row level security;
alter table public.vitals     enable row level security;
alter table public.alerts     enable row level security;

create policy "staff read patients"   on public.patients   for select to authenticated using (true);
create policy "staff read encounters" on public.encounters for select to authenticated using (true);
create policy "staff read vitals"     on public.vitals     for select to authenticated using (true);
create policy "staff read alerts"     on public.alerts     for select to authenticated using (true);
create policy "staff acknowledge alerts" on public.alerts for update to authenticated
  using (true) with check (true);

-- Only the acknowledged_at column may be changed from the browser.
revoke update on public.alerts from authenticated;
grant update (acknowledged_at) on public.alerts to authenticated;

-- Realtime: push new vitals and alerts to the apps (RLS still applies to subscribers).
alter publication supabase_realtime add table public.vitals, public.alerts;
