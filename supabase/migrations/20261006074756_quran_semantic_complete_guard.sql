create or replace function public.match_quran_corpus(
  query_embedding extensions.vector(1024),
  excluded_surahs integer[] default '{}',
  take_count integer default 6
)
returns table (verse_key text, similarity double precision)
language plpgsql stable security invoker set search_path = ''
as $$
begin
  -- Function argument typmods are not a substitute for validating dimensions.
  if query_embedding is null
     or extensions.vector_dims(query_embedding) <> 1024
     or extensions.vector_norm(query_embedding) not between 0.9 and 1.1
     or coalesce(cardinality(excluded_surahs),0) > 114 then
    return;
  end if;
  -- Seed batches are resumable. A partly imported corpus must not masquerade
  -- as whole-Quran search; the application uses lexical retrieval meanwhile.
  if (select count(*) from public.quran_verse_embeddings) <> 6236 then
    return;
  end if;
  return query
    select v.verse_key,
           1 - (e.embedding operator(extensions.<=>) query_embedding) as similarity
    from public.quran_verse_embeddings e
    join public.quran_verses v on v.verse_key = e.verse_key
    where not (v.surah = any(coalesce(excluded_surahs,'{}'::integer[])))
      and e.model = 'text-embedding-3-large'
      and e.source_sha256 = '228df2a717671aeb9d2ff573002bd28d6b3f973f4bc7153554e3a81663d67610'
      and e.input_version = 'tanzil-target-neighbors-v1'
    order by e.embedding operator(extensions.<=>) query_embedding, v.surah, v.ayah
    limit greatest(1,least(coalesce(take_count,6),12));
end;
$$;
revoke all on function public.match_quran_corpus(extensions.vector,integer[],integer) from public, anon, authenticated;
grant execute on function public.match_quran_corpus(extensions.vector,integer[],integer) to service_role;
