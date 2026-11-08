-- Patient requests get their own table, separate from NEWS2 `alerts`.
--
-- `alerts` is owned by the NEWS2 worker (server/news2/alert_worker.py). Requests a patient makes
-- through the bedside app (apps/patient-desktop) live here instead, so nothing the NEWS2 algorithm
-- does to `alerts` can change or remove them. The nurse dashboard shows both tables together.
--
-- Structured columns instead of a text reason: the app sends a kind + category from fixed lists
-- and a short fixed label, so there is no free text and nothing to parse.

create table public.patient_requests (
  id            bigint generated always as identity primary key,
  patient_id    text not null references public.patients (id) on delete cascade,
  encounter_id  uuid not null references public.encounters (id) on delete cascade,
  created_at    timestamptz not null default now(),
  kind          text not null check (kind in ('item_request', 'nurse_call', 'emergency')),
  category      text not null,                -- validated per kind by submit_patient_request()
  label         text not null check (label ~ '^[a-z -]{1,60}$'),  -- e.g. "help to the bathroom"
  tier          text not null check (tier in ('watch', 'check soon', 'go now')),  -- same scale as alerts
  source        text not null check (source in ('assistant', 'safety_check')),
  status        text not null default 'incomplete' check (status in ('incomplete', 'completed')),
  completed_at  timestamptz,
  constraint patient_requests_completed_at_matches_status check ((status = 'completed') = (completed_at is not null))
);
create index patient_requests_encounter_time on public.patient_requests (encounter_id, created_at desc);
create index patient_requests_incomplete on public.patient_requests (created_at) where status = 'incomplete';

-- completed_at is set by the database when the status changes (same function as alerts).
create trigger patient_requests_completed_at
  before update of status on public.patient_requests
  for each row execute function public.alerts_set_completed_at();

-- Row Level Security: signed-in staff read and change the status; nothing else.
alter table public.patient_requests enable row level security;
create policy "staff read patient requests" on public.patient_requests for select to authenticated using (true);
create policy "staff update patient request status" on public.patient_requests for update to authenticated
  using (true) with check (true);
revoke all on public.patient_requests from anon, authenticated;
grant select on public.patient_requests to authenticated;
grant update (status) on public.patient_requests to authenticated;

-- Realtime: push new/updated/deleted requests to the nurse dashboard.
alter publication supabase_realtime add table public.patient_requests;

-- The bedside app (publishable key, no sign-in) inserts only through this function.
create function public.submit_patient_request(
  p_patient_id text, p_kind text, p_category text, p_label text, p_tier text, p_source text
) returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_encounter uuid;
  v_id bigint;
begin
  -- Categories must match apps/patient-desktop/electron/actions.ts.
  if not (
       (p_kind = 'item_request' and p_category in ('drink', 'food', 'comfort', 'hygiene', 'other'))
    or (p_kind = 'nurse_call' and p_category in ('bathroom', 'pain', 'mobility', 'equipment', 'medication', 'comfort', 'talk', 'other'))
    or (p_kind = 'emergency' and p_category in ('chest_pain', 'breathing', 'fall', 'stroke_signs', 'bleeding', 'seizure',
                                                'fainting', 'severe_pain', 'self_harm', 'other'))
  ) then
    raise exception 'invalid kind/category: % / %', p_kind, p_category;
  end if;

  select e.id into v_encounter
  from encounters e
  where e.patient_id = p_patient_id and e.status = 'in-progress'
  limit 1;
  if v_encounter is null then
    raise exception 'patient % has no in-progress encounter', p_patient_id;
  end if;

  -- label/tier/source are checked by the table's constraints.
  insert into patient_requests (patient_id, encounter_id, kind, category, label, tier, source)
  values (p_patient_id, v_encounter, p_kind, p_category, p_label, p_tier, p_source)
  returning id into v_id;
  return v_id;
end;
$$;

revoke all on function public.submit_patient_request(text, text, text, text, text, text) from public;
grant execute on function public.submit_patient_request(text, text, text, text, text, text) to anon, authenticated;

-- Retire the old way of sending patient requests (into `alerts`).
drop function if exists public.submit_patient_alert(text, text, text);

-- Move any patient requests already written to `alerts` (news2_score null, "Patient …: <label>").
insert into public.patient_requests (patient_id, encounter_id, created_at, kind, category, label, tier, source, status, completed_at)
select
  a.patient_id,
  a.encounter_id,
  a.created_at,
  case
    when a.reason like 'Patient request: %' then 'item_request'
    when a.reason like 'Patient asked for the nurse: %' then 'nurse_call'
    else 'emergency'
  end,
  'other',
  left(regexp_replace(regexp_replace(a.reason, '^[^:]*: ', ''), ' \(keyword safety check\)$', ''), 60),
  a.tier,
  case when a.reason like '% (keyword safety check)' then 'safety_check' else 'assistant' end,
  a.status,
  a.completed_at
from public.alerts a
where a.news2_score is null
  and a.reason ~ '^Patient (request|asked for the nurse|reported a possible emergency): [a-z -]+( \(keyword safety check\))?$';

delete from public.alerts
where news2_score is null
  and reason ~ '^Patient (request|asked for the nurse|reported a possible emergency): [a-z -]+( \(keyword safety check\))?$';
