-- Apply AFTER deploying the authenticated quran-search Edge function and its caller.
-- Public Quran data is distributed in dataset/; costly RPCs are server-only.
revoke all on public.quran_verse_embeddings from public, anon, authenticated;
drop policy if exists "Public Quran retrieval vectors" on public.quran_verse_embeddings;
grant select, insert, update, delete on public.quran_verse_embeddings to service_role;
revoke all on function public.search_quran_corpus(text[],integer[],integer) from public, anon, authenticated;
revoke all on function public.match_quran_corpus(extensions.vector,integer[],integer) from public, anon, authenticated;
grant execute on function public.search_quran_corpus(text[],integer[],integer) to service_role;
grant execute on function public.match_quran_corpus(extensions.vector,integer[],integer) to service_role;
