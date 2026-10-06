do $$
begin
  if (select count(*) from public.quran_chapters) <> 114 then raise exception 'chapter coverage'; end if;
  if (select count(*) from public.quran_verses) <> 6236 then raise exception 'verse coverage'; end if;
  if (select count(*) from public.quran_verse_embeddings) <> 6236 then raise exception 'vector coverage'; end if;
  if has_table_privilege('anon','public.quran_verse_embeddings','select') then raise exception 'public vector access'; end if;
  if exists(select 1 from pg_policies where schemaname='public' and tablename='quran_verse_embeddings' and roles && array['anon','authenticated','public']::name[]) then raise exception 'public vector policy'; end if;
  if has_table_privilege('anon','public.voice_budget_buckets','select') then raise exception 'public quota access'; end if;
  if has_function_privilege('anon','public.match_quran_corpus(extensions.vector,integer[],integer)','execute') then raise exception 'public semantic RPC'; end if;
  if has_function_privilege('authenticated','public.search_quran_corpus(text[],integer[],integer)','execute') then raise exception 'public lexical RPC'; end if;
  if exists(select 1 from pg_class where oid in ('public.quran_verses'::regclass,'public.quran_verse_embeddings'::regclass,'public.voice_budget_buckets'::regclass) and not relrowsecurity) then raise exception 'RLS disabled'; end if;
end $$;
set role service_role;
do $$
declare results integer;
begin
  select count(*) into results from public.match_quran_corpus((select embedding from public.quran_verse_embeddings where verse_key='2:286'),array[]::integer[],3);
  if results <> 3 then raise exception 'semantic search failed'; end if;
  if not public.reserve_voice_session(repeat('a',64)) then raise exception 'first reservation denied'; end if;
  if public.reserve_voice_session(repeat('a',64)) then raise exception 'cooldown bypass'; end if;
end $$;
reset role;
