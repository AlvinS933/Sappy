-- Alerts: replace "acknowledged" with a completed / incomplete status.
--
-- Every alert starts 'incomplete'. Signed-in staff mark it 'completed' (or back to 'incomplete').
-- `completed_at` is filled in by the database (trigger below), never by the browser, so completion
-- times can't be faked and always match the status.

alter table public.alerts
  add column status text not null default 'incomplete' check (status in ('incomplete', 'completed')),
  add column completed_at timestamptz;

-- Carry over alerts that were already acknowledged.
update public.alerts
set status = 'completed', completed_at = acknowledged_at
where acknowledged_at is not null;

alter table public.alerts
  add constraint alerts_completed_at_matches_status check ((status = 'completed') = (completed_at is not null));

-- Remove the old column and its browser permissions.
drop policy "staff acknowledge alerts" on public.alerts;
revoke update on public.alerts from authenticated; -- also revokes the column grant on acknowledged_at
alter table public.alerts drop column acknowledged_at;

-- Set/clear completed_at whenever the status changes.
create function public.alerts_set_completed_at() returns trigger
language plpgsql as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    new.completed_at := now();
  elsif new.status = 'incomplete' then
    new.completed_at := null;
  else
    new.completed_at := old.completed_at; -- unchanged status: keep the original time
  end if;
  return new;
end;
$$;

create trigger alerts_completed_at
  before update of status on public.alerts
  for each row execute function public.alerts_set_completed_at();

-- Signed-in staff may change only the status column (completed_at is set by the trigger).
create policy "staff update alert status" on public.alerts for update to authenticated
  using (true) with check (true);
grant update (status) on public.alerts to authenticated;

-- The dashboard loads every incomplete alert; keep that query fast.
create index alerts_incomplete on public.alerts (created_at) where status = 'incomplete';
