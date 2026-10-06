/**
 * Original MP3Quran recordings and provider-defined verse ranges. Public metadata only: no credentials,
 * user speech, generated Quran text, synthesized audio, or guessed time cuts.
 * Evidence and reuse terms: docs/VOICE-SOURCES.md (checked 2026-10-04).
 */
import { QURAN_CATALOG, quranRange } from "./quran-catalog";

export const RECITATION_INTENTS = [
  "seeking_guidance",
  "overwhelmed",
  "feeling_forgotten",
  "patience_and_support",
  "faith_and_trust",
  "seeking_refuge",
  "loneliness",
  "grief",
  "guilt_and_repentance",
  "injustice",
  "uncertainty",
  "parenting",
  "explicit_request",
  "unclear",
] as const;

export type RecitationIntent = (typeof RECITATION_INTENTS)[number];

export type Recitation = Readonly<{
  id: string;
  title: string;
  reference: string;
  surah: number;
  ayahStart: number;
  ayahEnd: number;
  fullSurah: boolean;
  playbackStartSeconds?: number;
  playbackEndSeconds?: number;
  durationSeconds?: number;
  timingSourceUrl?: string;
  reciter: string;
  riwayah: string;
  audioUrl: string;
  sourceUrl: string;
  meaning: string;
  context: string;
  tafsirUrls: readonly string[];
  intents: readonly RecitationIntent[];
}>;

const AUDIO_BASE = "https://cdn.mp3quran.net/audio/yasser-dosari/r1/";
const SOURCE_URL =
  "https://www.mp3quran.net/api/v3/reciters?language=ar&reciter=92";

function completeSurah(
  entry: Omit<
    Recitation,
    "fullSurah" | "ayahStart" | "reciter" | "riwayah" | "audioUrl" | "sourceUrl"
  >,
): Recitation {
  return Object.freeze({
    ...entry,
    fullSurah: true as const,
    ayahStart: 1,
    reciter: "ياسر الدوسري",
    riwayah: "حفص عن عاصم — مرتل",
    audioUrl: `${AUDIO_BASE}${String(entry.surah).padStart(3, "0")}.mp3`,
    sourceUrl: SOURCE_URL,
    tafsirUrls: Object.freeze([...entry.tafsirUrls]),
    intents: Object.freeze([...entry.intents]),
  });
}

const tafsir = (verseKey: string) =>
  `https://api.quran.com/api/v4/tafsirs/16/by_ayah/${verseKey}`;

function originalVerse(
  entry: Omit<
    Recitation,
    | "fullSurah"
    | "reciter"
    | "riwayah"
    | "audioUrl"
    | "sourceUrl"
    | "timingSourceUrl"
    | "durationSeconds"
  > & { playbackStartSeconds: number; playbackEndSeconds: number },
): Recitation {
  const timingSourceUrl = `https://www.mp3quran.net/api/v3/ayat_timing?surah=${entry.surah}&read=92`;
  return Object.freeze({
    ...entry,
    fullSurah: false,
    reciter: "ياسر الدوسري",
    riwayah: "حفص عن عاصم — مرتل",
    audioUrl: `${AUDIO_BASE}${String(entry.surah).padStart(3, "0")}.mp3`,
    sourceUrl: timingSourceUrl,
    timingSourceUrl,
    durationSeconds:
      Math.round(
        (entry.playbackEndSeconds - entry.playbackStartSeconds) * 1000,
      ) / 1000,
    tafsirUrls: Object.freeze([...entry.tafsirUrls]),
    intents: Object.freeze([...entry.intents]),
  });
}

/** Meanings below are brief editorial paraphrases, not Quran or new tafsir. */
export const RECITATIONS: readonly Recitation[] = Object.freeze([
  completeSurah({
    id: "fatihah",
    title: "سورة الفاتحة",
    reference: "الفاتحة ١–٧",
    surah: 1,
    ayahEnd: 7,
    meaning: "ثناء على الله ورحمته، وطلب العون والهداية منه.",
    context:
      "تُعرض عند رغبة المستخدم في الدعاء وطلب الهداية. لا تُقدَّم كتشخيص أو علاج مضمون لمشكلة نفسية.",
    tafsirUrls: [tafsir("1:1"), tafsir("1:5"), tafsir("1:6")],
    intents: ["seeking_guidance"],
  }),
  completeSurah({
    id: "duha",
    title: "سورة الضحى",
    reference: "الضحى ١–١١",
    surah: 93,
    ayahEnd: 11,
    meaning:
      "تسلية للنبي ﷺ، وتذكير بنعم الله، ودعوة إلى الإحسان لليتيم والسائل.",
    context:
      "خطاب السورة للنبي ﷺ في سياقه. يمكن التأمل في معاني الرعاية والإحسان، ولا تُحوَّل وعودها الخاصة إلى وعد شخصي بأن رغبات المستخدم ستتحقق.",
    tafsirUrls: [tafsir("93:3"), tafsir("93:6"), tafsir("93:11")],
    intents: ["feeling_forgotten"],
  }),
  completeSurah({
    id: "sharh",
    title: "سورة الشرح",
    reference: "الشرح ١–٨",
    surah: 94,
    ayahEnd: 8,
    meaning: "تذكير النبي ﷺ بنعم الله، وباليسر مع العسر، والتوجه إلى الله.",
    context:
      "تُسمع للتأمل والرجاء، مع حفظ خطابها للنبي ﷺ. لا تعني أن الضيق سيزول فورًا أو في موعد محدد، ولا تُستخدم لإسكات الشكوى أو منع طلب المساعدة.",
    tafsirUrls: [tafsir("94:1"), tafsir("94:5"), tafsir("94:7")],
    intents: ["overwhelmed"],
  }),
  completeSurah({
    id: "asr",
    title: "سورة العصر",
    reference: "العصر ١–٣",
    surah: 103,
    ayahEnd: 3,
    meaning: "الإيمان والعمل الصالح، والتواصي بالحق والصبر.",
    context:
      "يمكن التأمل في الصبر والمساندة المتبادلة عند رغبة المستخدم. الصبر لا يعني قبول الأذى، ولا يُستدل بالسورة على أن المعاناة سببها ضعف إيمان المستخدم.",
    tafsirUrls: [tafsir("103:3")],
    intents: ["patience_and_support"],
  }),
  completeSurah({
    id: "ikhlas",
    title: "سورة الإخلاص",
    reference: "الإخلاص ١–٤",
    surah: 112,
    ayahEnd: 4,
    meaning: "توحيد الله وكماله، وأن الخلق يقصدونه في حوائجهم.",
    context:
      "تُعرض لمن يرغب في التذكير بالتوحيد والافتقار إلى الله، دون نسبة أثر علاجي محدد لهذه التلاوة أو تقييم إيمان المستمع.",
    tafsirUrls: [tafsir("112:1"), tafsir("112:2")],
    intents: ["faith_and_trust"],
  }),
  completeSurah({
    id: "falaq",
    title: "سورة الفلق",
    reference: "الفلق ١–٥",
    surah: 113,
    ayahEnd: 5,
    meaning: "الاستعاذة بالله من الشرور.",
    context:
      "تُعرض عند رغبة المستخدم في الاستعاذة. لا يُستنتج من خوفه أو أعراضه وجود حسد أو سحر، ولا تُؤكَّد معتقدات اضطهادية أو يُستبدل بها طلب الأمان والمساعدة.",
    tafsirUrls: [tafsir("113:1"), tafsir("113:5")],
    intents: ["seeking_refuge"],
  }),
  completeSurah({
    id: "nas",
    title: "سورة الناس",
    reference: "الناس ١–٦",
    surah: 114,
    ayahEnd: 6,
    meaning: "الالتجاء إلى الله والاستعاذة به من شر الوسواس.",
    context:
      "هذا وصف لمعنى السورة، وليس تشخيصًا لأفكار المستخدم. لا تُفسَّر الأعراض النفسية بأنها مسّ أو ضعف إيمان، ولا تُفرض تكرارات قد تتحول إلى سلوك قهري.",
    tafsirUrls: [tafsir("114:1"), tafsir("114:4")],
    intents: ["seeking_refuge"],
  }),
  originalVerse({
    id: "closeness",
    title: "القرب والدعاء — من سورة البقرة",
    reference: "البقرة ١٨٦",
    surah: 2,
    ayahStart: 186,
    ayahEnd: 186,
    playbackStartSeconds: 4071.84,
    playbackEndSeconds: 4098.02,
    meaning:
      "تذكير بقرب الله من عباده وإجابته للدعاء، ودعوة للإيمان والاستجابة له.",
    context:
      "مناسبة للتأمل في الدعاء عندما يصف المستخدم الوحدة أو حاجته إلى من يسمعه. لا تعني وعدًا بوصول شخص أو تحقق رغبة في موعد معين، ولا تغني عن الصحبة والدعم البشري.",
    tafsirUrls: [tafsir("2:186")],
    intents: ["loneliness"],
  }),
  originalVerse({
    id: "grief",
    title: "البوح بالحزن — من سورة يوسف",
    reference: "يوسف ٨٦",
    surah: 12,
    ayahStart: 86,
    ayahEnd: 86,
    playbackStartSeconds: 1653.96,
    playbackEndSeconds: 1667.66,
    meaning: "يعقوب عليه السلام يبوح لله بهمّه وحزنه مع رجائه في رحمة الله.",
    context:
      "سياقها حزن يعقوب على يوسف الغائب، وليست وعدًا بعودة ميت أو انتهاء الحزن. تُعرض لتفهّم الحزن والبوح، دون استعجال التعافي أو منع الحديث مع إنسان موثوق أو مختص.",
    tafsirUrls: [tafsir("12:84"), tafsir("12:86")],
    intents: ["grief"],
  }),
  originalVerse({
    id: "repentance",
    title: "الرجاء والتوبة — من سورة الزمر",
    reference: "الزمر ٥٣",
    surah: 39,
    ayahStart: 53,
    ayahEnd: 53,
    playbackStartSeconds: 940.36,
    playbackEndSeconds: 970.54,
    meaning:
      "دعوة من أثقلته ذنوبه إلى الرجاء في رحمة الله والتوبة والرجوع إليه.",
    context:
      "تُفهم مع الدعوة إلى الإنابة في الآية التالية. لا تُستخدم لإسقاط مسؤولية إصلاح الأذى أو حقوق الآخرين، ولا نؤكد بها أن شخصًا آخر سيقبل الاعتذار. الشعور بالذنب وحده لا يثبت وقوع ذنب.",
    tafsirUrls: [tafsir("39:53"), tafsir("39:54")],
    intents: ["guilt_and_repentance"],
  }),
  originalVerse({
    id: "injustice",
    title: "التعبير عن المظلمة — من سورة النساء",
    reference: "النساء ١٤٨",
    surah: 4,
    ayahStart: 148,
    ayahEnd: 148,
    playbackStartSeconds: 3754.18,
    playbackEndSeconds: 3767.7,
    meaning: "إباحة بيان المظلمة للمظلوم مع النهي العام عن الجهر بالسوء.",
    context:
      "مناسبة لمن يشعر أن عليه السكوت عن ظلم وقع عليه. لا تُحوَّل إلى دعوة للانتقام أو التشهير والكذب، ولا نفرض التسامح أو قبول الأذى؛ ويبقى طلب الأمان والمساندة وحفظ الحقوق مشروعًا.",
    tafsirUrls: [tafsir("4:148")],
    intents: ["injustice"],
  }),
  originalVerse({
    id: "reassurance",
    title: "الذكر والطمأنينة — من سورة الرعد",
    reference: "الرعد ٢٨",
    surah: 13,
    ayahStart: 28,
    ayahEnd: 28,
    playbackStartSeconds: 634.22,
    playbackEndSeconds: 650.18,
    meaning: "وصف للطمأنينة التي يجدها المؤمنون في ذكر الله والإيمان به.",
    context:
      "تُعرض عند رغبة المستخدم في التذكّر وسط القلق والانتظار. ليست تشخيصًا ولا وعدًا بزوال القلق، واستمرار الأعراض لا يعني ضعف الإيمان. لا نتنبأ بوظيفة أو رزق أو نتيجة معينة، ولا نترك الأسباب العملية والمساعدة المختصة.",
    tafsirUrls: [tafsir("13:28")],
    intents: ["uncertainty"],
  }),
  originalVerse({
    id: "gentleness",
    title: "الرفق والمشاورة — من سورة آل عمران",
    reference: "آل عمران ١٥٩",
    surah: 3,
    ayahStart: 159,
    ayahEnd: 159,
    playbackStartSeconds: 3408.54,
    playbackEndSeconds: 3437.78,
    meaning:
      "تذكير برفق النبي ﷺ بأصحابه، ودعوة إلى العفو والمشاورة والتوكل بعد العزم.",
    context:
      "خطاب للنبي ﷺ في التعامل مع أصحابه بعد أُحد، وليس نصًا خاصًا بتربية الأطفال. يمكن التأمل في الرفق والإصغاء عند رغبة الوالد في إصلاح تعامله؛ دون لوم أو ضمان تغيّر الأبناء، ودون مطالبة المتضرر بالعفو عن إساءة جارية.",
    tafsirUrls: [tafsir("3:159")],
    intents: ["parenting"],
  }),
]);

/** Resolve only allowlisted IDs; never accept model-supplied audio URLs. */
export function getRecitation(id: unknown): Recitation | undefined {
  if (typeof id !== "string") return undefined;
  const legacy = RECITATIONS.find((entry) => entry.id === id);
  if (legacy) return legacy;
  const range = quranRange(id);
  if (!range) return undefined;
  const { chapter, start, end, full } = range;
  const begins = chapter.timings[start - 1][0] / 1000;
  const ends = chapter.timings[end - 1][1] / 1000;
  return Object.freeze({
    id,
    title: full ? `سورة ${chapter.name}` : `من سورة ${chapter.name}`,
    reference: `${chapter.name} ${start}${end !== start ? `–${end}` : ""}`,
    surah: chapter.surah,
    ayahStart: start,
    ayahEnd: end,
    fullSurah: full,
    ...(full ? {} : { playbackStartSeconds: begins, playbackEndSeconds: ends }),
    durationSeconds: full ? ends : Math.round((ends - begins) * 1000) / 1000,
    timingSourceUrl: `https://www.mp3quran.net/api/v3/ayat_timing?surah=${chapter.surah}&read=92`,
    reciter: QURAN_CATALOG.reciter,
    riwayah: QURAN_CATALOG.riwayah,
    audioUrl: chapter.audioUrl,
    sourceUrl: QURAN_CATALOG.sourceUrl,
    meaning: "تسجيل أصلي؛ يُرجع في فهم المعنى والسياق إلى التفسير الموثق.",
    context:
      "لا يُنسب إلى المقطع وعد شخصي أو أثر علاجي مضمون. الاختيار الموضوعي يحتاج قراءة النص والتفسير وسياق الآيات قبل عرضه.",
    tafsirUrls: full
      ? [tafsir(`${chapter.surah}:1`)]
      : Array.from({ length: end - start + 1 }, (_, i) =>
          tafsir(`${chapter.surah}:${start + i}`),
        ),
    intents: ["explicit_request"] as const,
  });
}

export type RecitationSelectionInput = {
  intent: RecitationIntent;
  confidence: number;
  consent: boolean;
  safety: "ordinary" | "urgent" | "uncertain";
  requestedId?: string | null;
  recentIds?: readonly string[];
};

export type RecitationSelection =
  | { status: "selected"; recitation: Recitation }
  | {
      status: "clarify" | "declined" | "safety" | "unavailable";
      message: string;
    };

/**
 * Applies deterministic boundaries AFTER contextual dialogue understanding.
 * Confidence is the backend's self-report, not a measured relevance probability.
 * Do not infer these intents from isolated words or use this as a crisis detector.
 */
export function selectRecitation(
  input: RecitationSelectionInput,
): RecitationSelection {
  if (input.safety !== "ordinary") {
    return {
      status: "safety",
      message:
        "الأولوية الآن لفهم الأمان وتقديم المساندة المناسبة، دون تشغيل تلاوة تلقائيًا.",
    };
  }
  if (input.consent !== true) {
    return {
      status: "declined",
      message:
        "نُكمل الاستماع والحوار؛ لا تُشغَّل التلاوة دون موافقة المستخدم.",
    };
  }

  if (input.requestedId != null) {
    const requested = getRecitation(input.requestedId);
    if (!requested) {
      return {
        status: "unavailable",
        message:
          "هذه التلاوة غير متاحة في المكتبة الحالية. لا تستبدلها بتلاوة مولَّدة أو بسورة أخرى دون سؤال المستخدم.",
      };
    }
    if (input.intent === "explicit_request") {
      return { status: "selected", recitation: requested };
    }
  }

  // The backend uses explicit_request only for a named recording. A null ID
  // means that recording is outside this allowlist, not an unclear emotion.
  if (input.intent === "explicit_request") {
    return {
      status: "unavailable",
      message:
        "التلاوة المطلوبة غير متاحة في المكتبة الحالية. وضّح ذلك للمستخدم؛ لا تطلب منه توضيح طلبه المعروف، ولا تشغّل سورة أخرى أو تلاوة مولَّدة بدلًا منها. يمكنك عرض السور المتاحة فقط إذا أراد ذلك.",
    };
  }

  if (
    !Number.isFinite(input.confidence) ||
    input.confidence < 0.75 ||
    input.confidence > 1 ||
    input.intent === "unclear" ||
    !RECITATION_INTENTS.includes(input.intent)
  ) {
    return {
      status: "clarify",
      message:
        "اسأل سؤالًا قصيرًا لفهم ما يحتاجه المستخدم أو التلاوة التي يقصدها، دون فرض مناسبة قرآنية.",
    };
  }

  const candidates = RECITATIONS.filter((entry) =>
    entry.intents.includes(input.intent),
  );
  const requested = input.requestedId
    ? getRecitation(input.requestedId)
    : undefined;
  if (requested && !candidates.includes(requested)) {
    return {
      status: "clarify",
      message:
        "اختيار السورة لا يطابق المعنى المقترح. وضّح رغبة المستخدم قبل تشغيلها.",
    };
  }

  const eligible = requested ? [requested] : candidates;
  const selected = eligible.find(
    (entry) => !input.recentIds?.includes(entry.id),
  );
  if (!selected) {
    return {
      status: "unavailable",
      message:
        "لا توجد تلاوة جديدة مناسبة في المكتبة لهذا السياق. تابع الحوار، أو اسأل إن كان المستخدم يريد إعادة تلاوة بعينها.",
    };
  }
  return { status: "selected", recitation: selected };
}
