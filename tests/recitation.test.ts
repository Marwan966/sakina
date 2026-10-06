import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  RECITATIONS,
  getRecitation,
  selectRecitation,
  type RecitationSelectionInput,
} from "../apps/sakina/lib/recitations";
import {
  hasQuranPrefix,
  isQuranRecitation,
  normalizeQuranSpeech,
} from "../apps/sakina/lib/quran-speech-guard";
import {
  QURAN_SPEECH_SOURCE,
  QURAN_SPEECH_CORPUS,
} from "../apps/sakina/lib/quran-speech-data";

const understood: RecitationSelectionInput = {
  intent: "overwhelmed",
  confidence: 0.9,
  consent: true,
  safety: "ordinary",
};

test("recitation catalog preserves complete chapters or exact provider verse boundaries", () => {
  const counts = new Map([
    [1, 7],
    [93, 11],
    [94, 8],
    [103, 3],
    [112, 4],
    [113, 5],
    [114, 6],
  ]);
  const ranges = new Map([
    ["2:186", [4071.84, 4098.02]],
    ["12:86", [1653.96, 1667.66]],
    ["39:53", [940.36, 970.54]],
    ["4:148", [3754.18, 3767.7]],
    ["13:28", [634.22, 650.18]],
    ["3:159", [3408.54, 3437.78]],
  ]);
  assert.equal(new Set(RECITATIONS.map((r) => r.id)).size, RECITATIONS.length);
  for (const entry of RECITATIONS) {
    const url = new URL(entry.audioUrl);
    assert.equal(url.protocol, "https:");
    assert.equal(url.hostname, "cdn.mp3quran.net");
    assert.equal(
      url.pathname,
      `/audio/yasser-dosari/r1/${String(entry.surah).padStart(3, "0")}.mp3`,
    );
    if (entry.fullSurah) {
      assert.equal(entry.ayahStart, 1);
      assert.equal(entry.ayahEnd, counts.get(entry.surah));
      assert.equal(entry.playbackStartSeconds, undefined);
      assert.equal(entry.playbackEndSeconds, undefined);
    } else {
      const expected = ranges.get(`${entry.surah}:${entry.ayahStart}`);
      assert.ok(expected, "only source-verified verse ranges may be included");
      assert.equal(entry.ayahEnd, entry.ayahStart);
      assert.equal(entry.playbackStartSeconds, expected[0]);
      assert.equal(entry.playbackEndSeconds, expected[1]);
      assert.ok(entry.durationSeconds! > 0 && entry.durationSeconds! <= 40);
      assert.ok(
        Math.abs(entry.durationSeconds! - (expected[1] - expected[0])) < 0.001,
      );
      assert.equal(
        entry.timingSourceUrl,
        `https://www.mp3quran.net/api/v3/ayat_timing?surah=${entry.surah}&read=92`,
      );
      assert.equal(entry.sourceUrl, entry.timingSourceUrl);
    }
    assert.equal(entry.reciter, "ياسر الدوسري");
    assert.ok(entry.tafsirUrls.length > 0);
    assert.ok(
      entry.tafsirUrls.every((url) =>
        url.startsWith(
          `https://api.quran.com/api/v4/tafsirs/16/by_ayah/${entry.surah}:`,
        ),
      ),
    );
    assert.ok(Object.isFrozen(entry));
    assert.ok(Object.isFrozen(entry.intents));
  }
});

test("distinct understood situations have appropriate passages without a generic fallback", () => {
  const cases = [
    ["loneliness", "closeness"],
    ["grief", "grief"],
    ["guilt_and_repentance", "repentance"],
    ["injustice", "injustice"],
    ["uncertainty", "reassurance"],
    ["parenting", "gentleness"],
  ] as const;
  for (const [intent, expectedId] of cases) {
    const selected = selectRecitation({ ...understood, intent });
    assert.equal(selected.status, "selected");
    if (selected.status === "selected")
      assert.equal(selected.recitation.id, expectedId);
    assert.equal(
      selectRecitation({ ...understood, intent, recentIds: [expectedId] })
        .status,
      "unavailable",
    );
    assert.equal(
      selectRecitation({ ...understood, intent, requestedId: "sharh" }).status,
      "clarify",
    );
  }
});

test("untrusted model URLs and object-shaped IDs never resolve to audio", () => {
  for (const id of [
    "https://evil.example/audio.mp3",
    "../sharh",
    "SHARH",
    "",
    null,
    { id: "sharh" },
  ]) {
    assert.equal(getRecitation(id), undefined);
  }
  assert.equal(
    selectRecitation({
      ...understood,
      requestedId: "https://evil.example/audio.mp3",
    }).status,
    "unavailable",
  );
});

test("playback requires consent even for a clear explicit request", () => {
  assert.equal(
    selectRecitation({ ...understood, consent: false }).status,
    "declined",
  );
  assert.equal(
    selectRecitation({
      ...understood,
      intent: "explicit_request",
      requestedId: "sharh",
      consent: false,
    }).status,
    "declined",
  );
});

test("urgent or unresolved safety overrides consent, confidence, and a selected surah", () => {
  for (const safety of ["urgent", "uncertain"] as const) {
    assert.equal(
      selectRecitation({
        ...understood,
        safety,
        intent: "explicit_request",
        requestedId: "sharh",
      }).status,
      "safety",
    );
  }
});

test("unclear context and invalid confidence ask for clarification instead of false precision", () => {
  for (const confidence of [
    0,
    0.74,
    -1,
    1.01,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.equal(
      selectRecitation({ ...understood, confidence }).status,
      "clarify",
    );
  }
  assert.equal(
    selectRecitation({ ...understood, intent: "unclear" }).status,
    "clarify",
  );
});

test("a named unsupported recording gets an honest unavailable response, never a substitute", () => {
  for (const requestedId of [null, undefined]) {
    const result = selectRecitation({
      ...understood,
      intent: "explicit_request",
      confidence: 1,
      requestedId,
    });
    assert.equal(result.status, "unavailable");
    assert.ok(!("recitation" in result));
    if (result.status === "unavailable") {
      assert.match(result.message, /غير متاحة/);
      assert.match(result.message, /لا تطلب منه توضيح/);
      assert.match(result.message, /لا تشغّل سورة أخرى/);
    }
  }
});

test("grounded thematic intent selects context, and conflicts require clarification", () => {
  const result = selectRecitation(understood);
  assert.equal(result.status, "selected");
  if (result.status === "selected") assert.equal(result.recitation.id, "sharh");
  assert.equal(
    selectRecitation({ ...understood, requestedId: "nas" }).status,
    "clarify",
  );
});

test("do not cycle the same recitation indefinitely or substitute an unrelated surah", () => {
  assert.equal(
    selectRecitation({ ...understood, recentIds: ["sharh"] }).status,
    "unavailable",
  );
  const result = selectRecitation({
    ...understood,
    intent: "seeking_refuge",
    recentIds: ["falaq"],
  });
  assert.equal(result.status, "selected");
  if (result.status === "selected") assert.equal(result.recitation.id, "nas");
});

test("an explicit user choice may replay a known recording without guessed emotional relevance", () => {
  const result = selectRecitation({
    ...understood,
    intent: "explicit_request",
    requestedId: "nas",
    confidence: 0,
    recentIds: ["nas"],
  });
  assert.equal(result.status, "selected");
  if (result.status === "selected") assert.equal(result.recitation.id, "nas");
});

test("speech guard preserves all 6236 Tanzil records and the original license verbatim", () => {
  assert.equal(QURAN_SPEECH_SOURCE.verseCount, 6236);
  assert.equal(QURAN_SPEECH_SOURCE.provider, "Tanzil Project");
  assert.equal(QURAN_SPEECH_SOURCE.version, "1.1");
  assert.equal(
    QURAN_SPEECH_SOURCE.licenseUrl,
    "https://tanzil.net/docs/text_license",
  );
  assert.equal(
    createHash("sha256").update(QURAN_SPEECH_CORPUS, "utf8").digest("hex"),
    QURAN_SPEECH_SOURCE.sha256,
  );
  assert.equal(
    QURAN_SPEECH_SOURCE.sha256,
    "228df2a717671aeb9d2ff573002bd28d6b3f973f4bc7153554e3a81663d67610",
  );
  const keys = QURAN_SPEECH_CORPUS.split(/\r?\n/)
    .filter((line) => /^\d+\|\d+\|/.test(line))
    .map((line) => line.split("|").slice(0, 2).join(":"));
  assert.equal(keys.length, 6236);
  assert.equal(new Set(keys).size, 6236);
  assert.equal(keys[0], "1:1");
  assert.equal(keys.at(-1), "114:6");
  assert.match(QURAN_SPEECH_CORPUS, /Copyright \(C\) 2007-2026 Tanzil Project/);
  assert.match(QURAN_SPEECH_CORPUS, /CHANGING IT IS NOT ALLOWED/);
  assert.match(QURAN_SPEECH_CORPUS, /Creative Commons Attribution 3\.0/);
});

test("runtime indexing retains chapter openings and transcript spelling variants", () => {
  for (const text of [
    "قل هو الله أحد",
    "ألم نشرح لك صدرك",
    "إنا أعطيناك الكوثر",
    "فمن بدله بعدما سمعه",
    "فمن بدله بعد ما سمعه",
    "يجادلونك في الحق بعدما تبين",
    "يجادلونك في الحق بعد ما تبين",
    "ولئن اتبعت أهواءهم بعدما جاءك",
    "ولئن اتبعت أهواءهم بعد ما جاءك",
    "يا ويلتا أعجزت أن أكون",
    "يا ويلتى أعجزت أن أكون",
    "ولا تقربوا الزنا إنه كان",
    "ولا تقربوا الزنى إنه كان",
    "يا حسرتا على ما فرطت",
    "يا حسرتى على ما فرطت",
  ])
    assert.equal(isQuranRecitation(text), true, text);
  for (const text of ["قل هو", "ألم نشرح", "إنا أعطيناك"]) {
    assert.equal(hasQuranPrefix(text), true, text);
  }
});

test("speech guard catches quotations across punctuation and Arabic vocalization", () => {
  for (const text of [
    "فَإِنَّ مَعَ الْعُسْرِ يُسْرًا",
    "هناك آية تقول: لا يكلف الله نفسًا إلا وسعها",
    "قُلْ هُوَ ٱللَّهُ أَحَدٌ",
    "الله الصمد",
    "لم يلد ولم يولد",
    "سأقول الحمد لله رب العالمين ثم نكمل",
    "الذين آمنوا وتطمئن قلوبهم بذكر الله",
    "ومن يتق الله يجعل له مخرجا ويرزقه من حيث لا يحتسب",
    "وَإِلَىٰ رَبِّكَ فَارْغَب",
    "والضحى والليل إذا سجى",
  ])
    assert.equal(isQuranRecitation(text), true, text);
});

test("speech guard allows supportive conversation and references without quoting Quran", () => {
  for (const text of [
    "أنا هنا لأسمعك، خذ وقتك.",
    "قد تساعدك سورة الشرح إن أحببت أن تسمعها بصوت القارئ.",
    "من حقك تشعر بالحزن وتطلب المساعدة.",
    "لا أستطيع أن أضمن أن كل شيء سيتحسن الليلة.",
    "نقدر نتأمل في معاني الرجاء والصبر، إذا أحببت.",
    "الحمد لله أنك شاركتني ما تشعر به.",
    "",
    "١٢٣",
    "Take your time; I am listening.",
  ])
    assert.equal(isQuranRecitation(text), false, text);
});

test("normalization handles alif, tatweel, diacritics and punctuation consistently", () => {
  assert.equal(
    normalizeQuranSpeech("  أَلَـمْ نَشْرَحْ، لَكَ صَدْرَكَ؟  "),
    "الم نشرح لك صدرك",
  );
});

test("speech gate must accumulate partial transcripts before releasing sound", () => {
  assert.equal(isQuranRecitation("فإن مع"), false);
  assert.equal(isQuranRecitation("العسر يسرا"), false);
  assert.equal(isQuranRecitation("فإن مع العسر يسرا"), true);
});

test("source prefixes hold partial quotations until sufficient continuation arrives", () => {
  for (const text of [
    "فإن مع",
    "إن مع",
    "قل هو",
    "قُلْ هُوَ ٱللَّهُ",
    "لا يكلف الله نفسا",
    "أذكر هنا: لا تحزن إن",
    "ألا بذكر الله تطمئن",
    "ورفعنا لك",
  ])
    assert.equal(hasQuranPrefix(text), true, text);
});

test("ordinary supportive endings do not become unresolved Quran prefixes", () => {
  for (const text of [
    "أنا هنا لأسمعك، خذ وقتك.",
    "هل تحب أن تخبرني أكثر؟",
    "نقدر نأخذ خطوة صغيرة مع بعض.",
    "قد تساعدك سورة الشرح إن أحببت أن تسمعها بصوت القارئ.",
    "من حقك تشعر بالحزن وتطلب المساعدة.",
    "الحمد لله أنك شاركتني ما تشعر به.",
    "إن مع هذه المسؤوليات عندك مشاعر كثيرة.",
    "",
    "فإن",
    "الله",
    "Take your time; I am listening.",
  ])
    assert.equal(hasQuranPrefix(text), false, text);
});

test("new non-Quran words can clear a prefix hold while a completed verse is rejected", () => {
  assert.equal(hasQuranPrefix("فإن مع"), true);
  assert.equal(
    hasQuranPrefix("فإن مع زيادة المسؤوليات تحتاج وقتا لنفسك"),
    false,
  );
  assert.equal(
    isQuranRecitation("فإن مع زيادة المسؤوليات تحتاج وقتا لنفسك"),
    false,
  );
  assert.equal(isQuranRecitation("فإن مع العسر يسرا"), true);
});
