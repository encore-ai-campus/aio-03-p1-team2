-- Review and apply in Supabase SQL Editor. Does not change cameras, motion, or Storage.
-- Requires the existing profiles, feedback, and admin_audit_logs tables.
begin;

alter table public.feedback drop constraint if exists feedback_kind_check;
alter table public.feedback add constraint feedback_kind_check
check (kind in ('false_positive', 'false_negative', 'accurate', 'suggestion'));

create or replace function public.web_create_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function public.web_create_profile() from public, anon, authenticated;
drop trigger if exists web_create_profile_after_signup on auth.users;
create trigger web_create_profile_after_signup after insert on auth.users
for each row execute function public.web_create_profile();
insert into public.profiles(id) select id from auth.users on conflict (id) do nothing;

-- Writes to these tables go through the authenticated FastAPI server.
alter table public.profiles enable row level security;
alter table public.feedback enable row level security;
alter table public.admin_audit_logs enable row level security;
revoke all on public.profiles, public.feedback, public.admin_audit_logs from anon, authenticated;
grant select on public.profiles, public.feedback to authenticated;
grant all on public.profiles, public.feedback, public.admin_audit_logs to service_role;
grant usage, select on sequence public.feedback_id_seq, public.admin_audit_logs_id_seq to service_role;

-- Restrictive boundaries also constrain pre-existing permissive policies.
drop policy if exists web_profile_read on public.profiles;
create policy web_profile_read on public.profiles for select to authenticated using (id = (select auth.uid()));
drop policy if exists web_profile_boundary on public.profiles;
create policy web_profile_boundary on public.profiles as restrictive for all to authenticated
using (id = (select auth.uid())) with check (false);
drop policy if exists web_feedback_read on public.feedback;
create policy web_feedback_read on public.feedback for select to authenticated
using (user_id = (select auth.uid()) and deleted_at is null);
drop policy if exists web_feedback_boundary on public.feedback;
create policy web_feedback_boundary on public.feedback as restrictive for all to authenticated
using (user_id = (select auth.uid()) and deleted_at is null) with check (false);
drop policy if exists web_audit_boundary on public.admin_audit_logs;
create policy web_audit_boundary on public.admin_audit_logs as restrictive for all to anon, authenticated
using (false) with check (false);

create or replace function public.web_admin_users_page(p_actor_id uuid, p_limit integer, p_offset integer)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb;
begin
  if not exists(select 1 from public.profiles where id = p_actor_id and role = 'admin' and status = 'active') then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if p_limit is null or p_offset is null or p_limit < 1 or p_limit > 100 or p_offset < 0 then
    raise exception 'invalid page' using errcode = '22023';
  end if;
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(to_jsonb(t)) from (
      select p.*, u.email, u.last_sign_in_at from public.profiles p
      join auth.users u on u.id = p.id order by p.created_at desc, p.id
      limit p_limit offset p_offset
    ) t), '[]'::jsonb),
    'total', (select count(*) from public.profiles), 'limit', p_limit, 'offset', p_offset
  ) into result;
  return result;
end;
$$;
-- Read-only auth.users access requires owner privileges; execution is server-only.
alter function public.web_admin_users_page(uuid, integer, integer) security definer;
revoke all on function public.web_admin_users_page(uuid, integer, integer) from public, anon, authenticated;
grant execute on function public.web_admin_users_page(uuid, integer, integer) to service_role;

create or replace function public.web_admin_change(
  p_actor_id uuid, p_target_type text, p_target_id text, p_changes jsonb, p_action text default 'update'
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare before_row jsonb; after_row jsonb;
begin
  -- Serialize admin changes and protect the last active administrator.
  lock table public.profiles in share row exclusive mode;
  if not exists(select 1 from public.profiles where id = p_actor_id and role = 'admin' and status = 'active') then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'invalid changes' using errcode = '22023';
  end if;
  if p_target_type = 'users' and p_action = 'update' then
    if p_changes = '{}'::jsonb or p_changes - array['display_name','role','status'] <> '{}'::jsonb
       or (p_changes ? 'role' and (p_changes->>'role' is null or p_changes->>'role' not in ('user','admin')))
       or (p_changes ? 'status' and (p_changes->>'status' is null or p_changes->>'status' not in ('active','inactive')))
       or (p_changes ? 'display_name' and (p_changes->>'display_name' is null or char_length(btrim(p_changes->>'display_name')) not between 1 and 40)) then
      raise exception 'invalid profile changes' using errcode = '22023';
    end if;
    select to_jsonb(p) into before_row from public.profiles p where p.id = p_target_id::uuid for update;
    if before_row is null then raise exception 'not found' using errcode = 'P0002'; end if;
    if (p_changes->>'role' = 'user' or p_changes->>'status' = 'inactive') then
      if p_actor_id::text = p_target_id or (before_row->>'role' = 'admin' and before_row->>'status' = 'active'
        and (select count(*) from public.profiles where role = 'admin' and status = 'active') <= 1) then
        raise exception 'protected admin' using errcode = '22023';
      end if;
    end if;
    update public.profiles set
      display_name = case when p_changes ? 'display_name' then p_changes->>'display_name' else display_name end,
      role = coalesce(p_changes->>'role', role), status = coalesce(p_changes->>'status', status), updated_at = now()
      where id = p_target_id::uuid returning to_jsonb(profiles.*) into after_row;
  elsif p_target_type = 'feedback' and p_action in ('update','delete') then
    if (p_action = 'update' and (p_changes = '{}'::jsonb or p_changes - array['status','admin_note'] <> '{}'::jsonb))
       or (p_action = 'delete' and p_changes <> '{}'::jsonb)
       or (p_changes ? 'status' and (p_changes->>'status' is null or p_changes->>'status' not in ('pending','in_progress','resolved')))
       or char_length(p_changes->>'admin_note') > 1000 then
      raise exception 'invalid feedback changes' using errcode = '22023';
    end if;
    select to_jsonb(f) into before_row from public.feedback f where f.id = p_target_id::bigint and f.deleted_at is null for update;
    if before_row is null then raise exception 'not found' using errcode = 'P0002'; end if;
    update public.feedback set
      status = coalesce(p_changes->>'status', status),
      admin_note = case when p_changes ? 'admin_note' then p_changes->>'admin_note' else admin_note end,
      deleted_at = case when p_action = 'delete' then now() else deleted_at end, updated_at = now()
      where id = p_target_id::bigint returning to_jsonb(feedback.*) into after_row;
  else
    raise exception 'unsupported change' using errcode = '22023';
  end if;
  insert into public.admin_audit_logs(actor_id, action, target_type, target_id, old_data, new_data)
  values (p_actor_id, p_action, p_target_type, p_target_id, before_row, after_row);
  return after_row;
end;
$$;
revoke all on function public.web_admin_change(uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.web_admin_change(uuid, text, text, jsonb, text) to service_role;
commit;
