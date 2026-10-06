import test from "node:test";
import assert from "node:assert/strict";
import {
  quranVerse,
  quranVerses,
  quranSearchTokens,
} from "../apps/sakina/lib/quran-corpus";
import {
  QURAN_EMBEDDING_DIMENSIONS,
  QURAN_EMBEDDING_MODEL,
  quranEmbeddingInput,
  readQuranEmbeddings,
  semanticQuranKeys,
  validQuranEmbedding,
} from "../apps/sakina/lib/quran-semantic";
import { searchQuran } from "../apps/sakina/lib/quran-search";
import type { QuranSearchInput } from "../apps/sakina/lib/quran-search";

const vector = (position = 0) =>
  Array.from({ length: QURAN_EMBEDDING_DIMENSIONS }, (_, i) =>
    i === position ? 1 : 0,
  );
const embeddingResponse = () => ({
  model: QURAN_EMBEDDING_MODEL,
  data: [{ index: 0, embedding: vector() }],
});
const options = {
  apiKey: "unit-test-server-key",
  databaseUrl: "https://database.test",
  internalKey: "unit-test-internal-key",
};

test("semantic documents cover every exact verse with only same-chapter verbatim neighbors", () => {
  const all = quranVerses();
  assert.equal(all.length, 6236);
  for (const verse of all) {
    const input = quranEmbeddingInput(verse.key);
    assert.ok(
      input.startsWith(`الآية المقصودة (${verse.key}):\n${verse.text}`),
    );
    for (const neighbor of [verse.ayah - 1, verse.ayah + 1]) {
      const source = quranVerse(`${verse.surah}:${neighbor}`);
      if (source) assert.ok(input.includes(`(${source.key}):\n${source.text}`));
    }
  }
  const first = quranEmbeddingInput("2:1");
  assert.ok(!first.includes("الآية السابقة"));
  assert.ok(first.includes(quranVerse("2:2")!.text));
  const last = quranEmbeddingInput("2:286");
  assert.ok(!last.includes("الآية التالية"));
  assert.throws(() => quranEmbeddingInput("2:287"), /unknown_quran_verse/);
});

test("embedding response rejects wrong model, dimensions, zero/nonfinite values and ambiguous ordering", () => {
  const first = vector(0),
    second = vector(1);
  assert.deepEqual(
    readQuranEmbeddings(
      {
        model: QURAN_EMBEDDING_MODEL,
        data: [
          { index: 1, embedding: second },
          { index: 0, embedding: first },
        ],
      },
      2,
    ),
    [first, second],
  );
  for (const bad of [
    [1, 0],
    new Array(1024).fill(0),
    vector().map((v, i) => (i === 5 ? NaN : v)),
    vector().map((v, i) => (i === 5 ? Infinity : v)),
    new Array(1024).fill(100),
  ])
    assert.equal(validQuranEmbedding(bad), false);
  for (const response of [
    { model: "different-model", data: [{ index: 0, embedding: first }] },
    {
      model: QURAN_EMBEDDING_MODEL,
      data: [
        { index: 0, embedding: first },
        { index: 0, embedding: second },
      ],
    },
    {
      model: QURAN_EMBEDDING_MODEL,
      data: [
        { index: -1, embedding: first },
        { index: 1, embedding: second },
      ],
    },
  ])
    assert.throws(() => readQuranEmbeddings(response, 2), /invalid_embedding/);
});

test("query embeddings remain ephemeral and only real nonexcluded corpus keys survive RPC output", async () => {
  const calls: Array<{
    url: string;
    body: Record<string, unknown>;
    signal: AbortSignal | null | undefined;
  }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input),
      body = JSON.parse(String(init?.body));
    calls.push({ url, body, signal: init?.signal });
    if (url === "https://api.openai.com/v1/embeddings") {
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer unit-test-server-key",
      );
      assert.equal(body.dimensions, 1024);
      assert.equal(body.model, QURAN_EMBEDDING_MODEL);
      return Response.json(embeddingResponse());
    }
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    assert.equal(
      new Headers(init?.headers).get("X-Internal-Key"),
      "unit-test-internal-key",
    );
    assert.equal(body.take_count, 12);
    assert.deepEqual(body.excluded_surahs, [12]);
    assert.equal("query" in body, false);
    assert.equal("input" in body, false);
    assert.equal(init?.cache, "no-store");
    return Response.json([
      { verse_key: "12:86", similarity: 0.99 },
      { verse_key: "94:5", similarity: 0.9 },
      { verse_key: "94:5", similarity: 0.8 },
      { verse_key: "999:1", similarity: 0.8 },
      { verse_key: "94:6", similarity: 0.7 },
      { verse_key: "2:153", similarity: "0.6" },
    ]);
  };
  assert.deepEqual(
    await semanticQuranKeys(
      "ضغط العمل والخوف من الغد",
      [12, 12, 0, 115, NaN],
      500,
      { ...options, fetcher },
    ),
    ["94:5", "94:6"],
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.input, "ضغط العمل والخوف من الغد");
  assert.equal(calls[0].signal, calls[1].signal);
  assert.ok(calls[0].signal instanceof AbortSignal);
});

test("missing config, invalid queries and malformed vectors never issue a database match", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return Response.json({
      model: QURAN_EMBEDDING_MODEL,
      data: [{ index: 0, embedding: [1] }],
    });
  };
  for (const query of ["", " ", "x".repeat(501)])
    assert.deepEqual(
      await semanticQuranKeys(query, [], 12, { ...options, fetcher }),
      [],
    );
  assert.deepEqual(
    await semanticQuranKeys("قلق", [], 12, { ...options, apiKey: "", fetcher }),
    [],
  );
  assert.equal(calls, 0);
  assert.deepEqual(
    await semanticQuranKeys("قلق", [], 12, { ...options, fetcher }),
    [],
  );
  assert.equal(calls, 1);
});

test("provider and database errors return a safe lexical fallback signal", async () => {
  const unavailable: typeof fetch = async () => {
    throw new Error("network unavailable");
  };
  const limited: typeof fetch = async () =>
    new Response("busy", { status: 429 });
  const badDb: typeof fetch = async (url) =>
    String(url) === "https://api.openai.com/v1/embeddings"
      ? Response.json(embeddingResponse())
      : new Response("offline", { status: 503 });
  for (const fetcher of [unavailable, limited, badDb])
    assert.deepEqual(
      await semanticQuranKeys("ضيق", [], 12, { ...options, fetcher }),
      [],
    );
});

test("semantic lookup has one three-second total deadline and does not retry the caller query", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    calls++;
    return new Promise((_resolve, reject) => {
      const keepAlive = setTimeout(
        () => reject(new Error("test_deadline_missing")),
        4500,
      );
      init?.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(keepAlive);
          reject(new DOMException("deadline", "TimeoutError"));
        },
        { once: true },
      );
    });
  };
  const started = Date.now();
  assert.deepEqual(
    await semanticQuranKeys("قلق", [], 12, { ...options, fetcher }),
    [],
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - started >= 2900);
  assert.ok(Date.now() - started < 4300);
});

async function withConfiguration(work: () => Promise<void>) {
  const names = [
    "OPENAI_API_KEY",
    "SUPABASE_URL",
    "INTERNAL_API_TOKEN",
  ] as const;
  const before = names.map((name) => process.env[name]);
  process.env.OPENAI_API_KEY = options.apiKey;
  process.env.SUPABASE_URL = options.databaseUrl;
  process.env.INTERNAL_API_TOKEN = options.internalKey;
  try {
    await work();
  } finally {
    names.forEach((name, i) => {
      if (before[i] === undefined) delete process.env[name];
      else process.env[name] = before[i];
    });
  }
}
function sourceTafsir(url: string) {
  const match =
    /^https:\/\/api\.quran\.com\/api\/v4\/tafsirs\/16\/by_ayah\/(\d{1,3}:\d{1,3})$/.exec(
      url,
    );
  assert.ok(match, "Unexpected tafsir request target");
  const key = match[1];
  return Response.json({
    tafsir: {
      resource_id: 16,
      verses: { [key]: {} },
      text: "نص تفسير في اختبار العقد فقط، لا ينشر للمستخدم ولا يمثل تفسيرًا حقيقيًا.",
    },
  });
}

test("search starts lexical and semantic work together, then ranks explicit references before semantic evidence", async () => {
  await withConfiguration(async () => {
    let embeddingStarted = false;
    let startedLexical: () => void = () => {};
    const lexicalStarted = new Promise<void>((resolve) => {
      startedLexical = resolve;
    });
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://api.openai.com/v1/embeddings") {
        embeddingStarted = true;
        await lexicalStarted;
        return Response.json(embeddingResponse());
      }
      if (
        url === "https://database.test/functions/v1/quran-search" &&
        JSON.parse(String(init?.body)).kind === "lexical"
      ) {
        assert.equal(embeddingStarted, true);
        startedLexical();
        return Response.json([{ verse_key: "12:86" }]);
      }
      if (
        url === "https://database.test/functions/v1/quran-search" &&
        JSON.parse(String(init?.body)).kind === "semantic"
      )
        return Response.json([
          { verse_key: "94:5", similarity: 0.9 },
          { verse_key: "94:6", similarity: 0.85 },
        ]);
      return sourceTafsir(url);
    };
    const result = await searchQuran(
      { query: "ضغط العمل", references: ["2:152"], limit: 4 },
      { fetcher },
    );
    assert.deepEqual(
      result.candidates.map((c) => c.id),
      ["ayah-2-152", "ayah-94-5", "ayah-94-6", "ayah-12-86"],
    );
    for (const candidate of result.candidates)
      assert.equal(
        candidate.verses[0].text,
        quranVerse(candidate.verses[0].key)!.text,
      );
  });
});

test("semantic outages keep lexical search working and missing tafsir still blocks a candidate", async () => {
  await withConfiguration(async () => {
    const fallback: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://api.openai.com/v1/embeddings")
        return new Response("busy", { status: 503 });
      if (
        url === "https://database.test/functions/v1/quran-search" &&
        JSON.parse(String(init?.body)).kind === "lexical"
      )
        return Response.json([{ verse_key: "12:86" }]);
      return sourceTafsir(url);
    };
    const result = await searchQuran(
      { query: "أنا حزين", limit: 1 },
      { fetcher: fallback },
    );
    assert.deepEqual(
      result.candidates.map((c) => c.id),
      ["ayah-12-86"],
    );
    const withoutProof: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://api.openai.com/v1/embeddings")
        return Response.json(embeddingResponse());
      if (
        url === "https://database.test/functions/v1/quran-search" &&
        JSON.parse(String(init?.body)).kind === "semantic"
      )
        return Response.json([{ verse_key: "94:5", similarity: 0.9 }]);
      if (
        url === "https://database.test/functions/v1/quran-search" &&
        JSON.parse(String(init?.body)).kind === "lexical"
      )
        return Response.json([]);
      return new Response("unavailable", { status: 503 });
    };
    assert.deepEqual(
      await searchQuran({ query: "ضيق", limit: 1 }, { fetcher: withoutProof }),
      { status: "unavailable", candidates: [] },
    );
  });
});

test("planned concepts replace raw personal wording in both semantic and database lexical ranking", async () => {
  await withConfiguration(async () => {
    const concepts = [" الصبر ", "التوكل", "عدم ضياع الأجر"];
    const planned = "الصبر التوكل عدم ضياع الأجر";
    let embedded = "";
    let lexical: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === "https://api.openai.com/v1/embeddings") {
        embedded = JSON.parse(String(init?.body)).input;
        return Response.json(embeddingResponse());
      }
      if (
        url === "https://database.test/functions/v1/quran-search" &&
        JSON.parse(String(init?.body)).kind === "lexical"
      ) {
        lexical = JSON.parse(String(init?.body)).terms;
        return Response.json([{ verse_key: "12:86" }]);
      }
      if (
        url === "https://database.test/functions/v1/quran-search" &&
        JSON.parse(String(init?.body)).kind === "semantic"
      )
        return Response.json([{ verse_key: "94:5", similarity: 0.9 }]);
      return sourceTafsir(url);
    };
    const result = await searchQuran(
      {
        query: "مديري والدوام يرهقانني",
        concepts,
        references: ["2:152"],
        limit: 3,
      },
      { fetcher },
    );
    assert.equal(embedded, planned);
    assert.deepEqual(lexical, quranSearchTokens(planned));
    assert.deepEqual(
      result.candidates.map((c) => c.id),
      ["ayah-2-152", "ayah-94-5", "ayah-12-86"],
    );
    assert.equal(result.candidates[1].verses[0].text, quranVerse("94:5")!.text);
  });
});

test("local lexical fallback also uses supplied concepts and retains original tafsir proof", async () => {
  const fetcher: typeof fetch = async (input) => sourceTafsir(String(input));
  const result = await searchQuran(
    { query: "زززززظظظظ", concepts: ["فاذكروني", "اذكركم"], limit: 3 },
    { fetcher, skipDatabase: true },
  );
  assert.ok(result.candidates.some((c) => c.id === "ayah-2-152"));
  const unavailable: typeof fetch = async () =>
    new Response("missing proof", { status: 503 });
  assert.deepEqual(
    await searchQuran(
      { query: "زززززظظظظ", concepts: ["فاذكروني", "اذكركم"], limit: 3 },
      { fetcher: unavailable, skipDatabase: true },
    ),
    { status: "unavailable", candidates: [] },
  );
});

test("invalid concept plans are rejected before any provider, database or tafsir request", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++;
    throw new Error("must not fetch");
  };
  for (const concepts of [
    [],
    ["الصبر"],
    new Array(7).fill("الصبر"),
    ["الصبر", " "],
    ["الصبر", "x".repeat(41)],
    ["الصبر", 7],
    "الصبر التوكل",
    null,
  ]) {
    const input = {
      query: "العمل",
      concepts,
      references: ["2:152"],
    } as QuranSearchInput;
    assert.deepEqual(await searchQuran(input, { fetcher }), {
      status: "unavailable",
      candidates: [],
    });
  }
  assert.equal(requests, 0);
});
