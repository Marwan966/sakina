-- Additive public-source corpus. No user audio, transcripts or inferred conditions.
create table if not exists public.quran_sources (
  id text primary key,
  provider text not null,
  version text not null,
  source_url text not null,
  license_url text not null,
  sha256 text not null check (sha256 ~ '^[a-f0-9]{64}$'),
  original_notice text not null,
  imported_at timestamptz not null default now()
);
create table if not exists public.quran_chapters (
  surah integer primary key check (surah between 1 and 114),
  name_arabic text not null,
  ayah_count integer not null check (ayah_count between 3 and 286),
  reciter text not null,
  audio_url text not null check (audio_url ~ '^https://cdn[.]mp3quran[.]net/audio/yasser-dosari/r1/[0-9]{3}[.]mp3$'),
  timing_source_url text not null
);
create table if not exists public.quran_verses (
  verse_key text primary key,
  surah integer not null references public.quran_chapters(surah),
  ayah integer not null check (ayah between 1 and 286),
  text_exact text not null,
  search_text text not null,
  source_id text not null references public.quran_sources(id),
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null,
  search_vector tsvector generated always as (to_tsvector('simple'::regconfig, search_text)) stored,
  unique (surah,ayah),
  check (verse_key = surah::text || ':' || ayah::text),
  check (end_ms > start_ms)
);
create index if not exists quran_verses_search_idx on public.quran_verses using gin(search_vector);
create index if not exists quran_verses_source_idx on public.quran_verses(source_id);
alter table public.quran_sources enable row level security;
alter table public.quran_chapters enable row level security;
alter table public.quran_verses enable row level security;
create policy "Public Quran source attribution" on public.quran_sources for select to anon, authenticated using (true);
create policy "Public Quran chapter metadata" on public.quran_chapters for select to anon, authenticated using (true);
create policy "Public licensed Quran verses" on public.quran_verses for select to anon, authenticated using (true);
revoke all on public.quran_sources, public.quran_chapters, public.quran_verses from anon, authenticated;
grant select on public.quran_sources, public.quran_chapters, public.quran_verses to anon, authenticated;

create or replace function public.search_quran_corpus(terms text[], excluded_surahs integer[] default '{}', take_count integer default 6)
returns table (verse_key text, rank real)
language sql stable security invoker set search_path = ''
as $$
  with query as (
    select pg_catalog.to_tsquery('simple', string_agg(pg_catalog.quote_literal(word), ' | ')) as value
    from (select word from unnest(terms) as word where char_length(word) between 2 and 50 limit 24) limited
  )
  select v.verse_key, pg_catalog.ts_rank_cd(v.search_vector,q.value,32) as rank
  from public.quran_verses v cross join query q
  where v.search_vector @@ q.value and not (v.surah = any(coalesce(excluded_surahs,'{}'::integer[])))
  order by rank desc, v.surah, v.ayah
  limit greatest(1,least(coalesce(take_count,6),12));
$$;
revoke all on function public.search_quran_corpus(text[],integer[],integer) from public, anon, authenticated;
grant execute on function public.search_quran_corpus(text[],integer[],integer) to service_role;

grant select on public.quran_sources, public.quran_chapters, public.quran_verses to service_role;
