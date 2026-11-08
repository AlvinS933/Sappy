-- Patient bedside app (apps/patient-desktop), demo without sign-in.
--
-- The app only has the publishable key (role `anon`). Rather than opening any table to `anon`,
-- it gets two narrow functions. They run with the owner's rights (security definer) and do
-- exactly one thing each:
--
--   patient_device_assignment()  which patient this device plays: the first patient (by id) that
--                                has an in-progress stay. Returns ids + bed label only, not
--                                conditions or medications.
--   submit_patient_alert(...)    create a patient-request alert. The encounter is looked up here,
--                                news2_score is always null, status starts 'incomplete', and the
--                                reason must match the app's fixed wording (no patient free text).
--
-- Demo trade-off: anyone with the publishable key can call these. For real devices, give each
-- device its own login and replace this with an RLS insert policy.

create function public.patient_device_assignment()
returns table (patient_id text, encounter_id uuid, bed_label text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, e.id, e.bed_label
  from patients p
  join encounters e on e.patient_id = p.id and e.status = 'in-progress'
  order by p.id
  limit 1
$$;

create function public.submit_patient_alert(p_patient_id text, p_tier text, p_reason text)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_encounter uuid;
  v_id bigint;
begin
  if p_tier is null or p_tier not in ('watch', 'check soon', 'go now') then
    raise exception 'invalid tier: %', p_tier;
  end if;

  -- Only the app's fixed wording, e.g. "Patient asked for the nurse: help to the bathroom".
  -- Labels come from fixed category lists (apps/patient-desktop/electron/actions.ts).
  if p_reason is null
     or length(p_reason) > 120
     or p_reason !~ '^Patient (request|asked for the nurse|reported a possible emergency): [a-z -]+( \(keyword safety check\))?$' then
    raise exception 'invalid reason';
  end if;

  select e.id into v_encounter
  from encounters e
  where e.patient_id = p_patient_id and e.status = 'in-progress'
  limit 1;
  if v_encounter is null then
    raise exception 'patient % has no in-progress encounter', p_patient_id;
  end if;

  insert into alerts (patient_id, encounter_id, tier, news2_score, reason)
  values (p_patient_id, v_encounter, p_tier, null, p_reason)
  returning id into v_id;
  return v_id;
end;
$$;

-- Only these two functions are reachable with the publishable key; no table grants change.
revoke all on function public.patient_device_assignment() from public;
revoke all on function public.submit_patient_alert(text, text, text) from public;
grant execute on function public.patient_device_assignment() to anon, authenticated;
grant execute on function public.submit_patient_alert(text, text, text) to anon, authenticated;
