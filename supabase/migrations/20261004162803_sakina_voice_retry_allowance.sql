-- Allow six short sessions per client for the public voice pilot; global30/day, cooldown and full-duration reservations remain unchanged.
create or replace function public.reserve_voice_session(p_client_hash text)
returns boolean language plpgsql security invoker set search_path = '' as $$
declare
  day_key text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD');
  global_key text;
  client_key text;
  expiry timestamptz := ((date_trunc('day', now() at time zone 'UTC') + interval '1 day') at time zone 'UTC');
  global_count integer;
  client_count integer;
  last_start timestamptz;
begin
  if p_client_hash is null or p_client_hash !~ '^[a-f0-9]{64}$' then return false; end if;
  global_key := 'global:' || day_key;
  client_key := 'client:' || day_key || ':' || p_client_hash;
  delete from public.voice_budget_buckets where expires_at < now();
  insert into public.voice_budget_buckets(bucket_key, expires_at) values(global_key, expiry)
    on conflict do nothing;
  -- One short global row lock serializes admission; no external IO in this transaction.
  select starts into global_count from public.voice_budget_buckets where bucket_key = global_key for update;
  if global_count >= 30 then return false; end if;
  insert into public.voice_budget_buckets(bucket_key, expires_at) values(client_key, expiry)
    on conflict do nothing;
  select starts, last_started_at into client_count, last_start
    from public.voice_budget_buckets where bucket_key = client_key for update;
  if client_count >= 6 or last_start > now() - interval '1 minute' then return false; end if;
  update public.voice_budget_buckets set starts = starts + 1, last_started_at = now()
    where bucket_key in (global_key, client_key);
  return true;
end;
$$;
revoke all on function public.reserve_voice_session(text) from public, anon, authenticated;
grant execute on function public.reserve_voice_session(text) to service_role;
