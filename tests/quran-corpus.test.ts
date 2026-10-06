import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  quranVerses,
  quranVerse,
  rankQuranVerses,
  parseQuranReference,
} from "../apps/sakina/lib/quran-corpus";
import {
  QURAN_SPEECH_CORPUS,
  QURAN_SPEECH_SOURCE,
} from "../apps/sakina/lib/quran-speech-data";
import { QURAN_CHAPTERS } from "../apps/sakina/lib/quran-catalog";
import { getRecitation } from "../apps/sakina/lib/recitations";
import { searchQuran } from "../apps/sakina/lib/quran-search";

test("whole Quran retains licensed source bytes and all114chapter/6236ayah audio boundaries", () => {
  assert.equal(
    createHash("sha256").update(QURAN_SPEECH_CORPUS).digest("hex"),
    QURAN_SPEECH_SOURCE.sha256,
  );
  assert.match(QURAN_SPEECH_CORPUS, /CHANGING IT IS NOT ALLOWED/);
  assert.equal(QURAN_CHAPTERS.length, 114);
  assert.equal(quranVerses().length, 6236);
  assert.equal(new Set(quranVerses().map((v) => v.key)).size, 6236);
  for (const chapter of QURAN_CHAPTERS) {
    assert.equal(chapter.timings.length, chapter.ayahCount);
    assert.equal(
      quranVerses().filter((v) => v.surah === chapter.surah).length,
      chapter.ayahCount,
    );
    chapter.timings.forEach(([start, end], i) => {
      assert.ok(start >= 0 && end > start);
      if (i) assert.ok(start >= chapter.timings[i - 1][1]);
      assert.ok(quranVerse(`${chapter.surah}:${i + 1}`));
    });
    const full = getRecitation(`surah-${chapter.surah}`)!;
    assert.equal(full.ayahEnd, chapter.ayahCount);
    assert.equal(full.fullSurah, true);
    assert.equal(full.audioUrl, chapter.audioUrl);
  }
  assert.equal(getRecitation("surah-2")!.durationSeconds, 7245.78);
});
test("canonical passage cannot guess boundaries, accept URLs or turn a fullsurah into an excerpt", () => {
  const clip = getRecitation("ayah-12-86")!;
  assert.equal(clip.playbackStartSeconds, 1653.96);
  assert.equal(clip.playbackEndSeconds, 1667.66);
  assert.equal(clip.fullSurah, false);
  assert.equal(getRecitation("surah-12")!.fullSurah, true);
  for (const invalid of [
    "surah-0",
    "surah-115",
    "surah-001",
    "ayah-2-287",
    "ayah-94-5-6",
    "passage-94-5",
    "passage-94-5-5",
    "passage-2-12-2",
    "https://example.com/a.mp3",
  ])
    assert.equal(getRecitation(invalid), undefined);
  assert.equal(parseQuranReference("2:1-286"), undefined);
});
test("retrieval searches beyond the old13records and honors exclusions without invented verses", () => {
  const found = rankQuranVerses("فاذكروني اذكركم", [], 6);
  assert.ok(found.some((v) => v.key === "2:152"));
  assert.ok(
    rankQuranVerses("فاذكروني اذكركم", [2], 6).every(
      (v) => !v.key.startsWith("2:"),
    ),
  );
  assert.deepEqual(rankQuranVerses("زززززظظظظ", [], 6), []);
});
const lookup: typeof fetch = async (input) => {
  const key = String(input).split("/").at(-1)!;
  return Response.json({
    tafsir: {
      resource_id: 16,
      verses: { [key]: {} },
      text: "<p>تفسير موثق في اختبار مصدر البيانات فقط، وليس نصًا منشورًا في المنتج.</p>",
    },
  });
};
test("runtime search returns actual verses, neighbors, source and original audio only after tafsir proof", async () => {
  const result = await searchQuran(
    { query: "", references: ["2:152", "12:86"], limit: 2 },
    { fetcher: lookup, skipDatabase: true },
  );
  assert.equal(result.status, "ok");
  assert.equal(result.candidates.length, 2);
  const c = result.candidates[0];
  assert.equal(c.id, "ayah-2-152");
  assert.equal(c.verses[0].text, quranVerse("2:152")!.text);
  assert.equal(c.surroundingVerses[0].key, "2:151");
  assert.equal(c.surroundingVerses[1].key, "2:153");
  assert.equal(
    c.verses[0].tafsirSourceUrl,
    "https://api.quran.com/api/v4/tafsirs/16/by_ayah/2:152",
  );
  assert.ok(!c.verses[0].tafsir.includes("<p>"));
});
test("missing tafsir, mismatched verse keys, provider outage and wrong resource cannot fabricate a proposal", async () => {
  const bad: typeof fetch = async () =>
    Response.json({
      tafsir: {
        resource_id: 16,
        verses: { "1:1": {} },
        text: "هذا تفسير آية مختلفة تمامًا عن الآية المطلوبة.",
      },
    });
  const unavailable: typeof fetch = async () => {
    throw new Error("offline");
  };
  for (const fetcher of [bad, unavailable]) {
    assert.deepEqual(
      await searchQuran(
        { query: "", references: ["12:86"] },
        { fetcher, skipDatabase: true },
      ),
      { status: "unavailable", candidates: [] },
    );
  }
});
test("runtime search does not replay excluded surah or return unbounded long passages", async () => {
  const result = await searchQuran(
    {
      query: "",
      references: ["12:86", "2:1-286", "3:999"],
      excludeSurahs: [12],
    },
    { fetcher: lookup, skipDatabase: true },
  );
  assert.equal(result.status, "unavailable");
  assert.equal(result.candidates.length, 0);
});
