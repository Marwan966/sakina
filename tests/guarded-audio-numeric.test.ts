import test from "node:test";
import assert from "node:assert/strict";
import {
  GuardedAudio,
  hasTranscriptCoverage,
} from "../apps/sakina/app/components/guarded-audio";
import {
  hasQuranPrefix,
  isQuranRecitation,
} from "../apps/sakina/lib/quran-speech-guard";

// Source timing from a synthetic-input live journey. No captured PCM is kept:
// every waveform below is generated locally, without speech or Quran audio.
const verseNumberFragments = [
  { text: " الآية", start: 130400, end: 130600 },
  { text: " ٢", start: 131000, end: 131200 },
  { text: "٨٦", start: 131200, end: 131400 },
  { text: ".", start: 131600, end: 131800 },
];

test("short verse-number tokens allow only a bounded additional source tail", () => {
  assert.equal(
    hasTranscriptCoverage(verseNumberFragments, 131000, 132800),
    true,
  );
  assert.equal(
    hasTranscriptCoverage(verseNumberFragments, 131000, 133000),
    true,
  );
  assert.equal(
    hasTranscriptCoverage(verseNumberFragments, 131000, 133001),
    false,
  );
  assert.equal(
    hasTranscriptCoverage(
      verseNumberFragments.map(({ start, end }) => ({ start, end })),
      131000,
      132800,
    ),
    false,
    "the original interval-only rule cannot release this numeric tail",
  );
  for (const text of [" الآية 286.", " آية رقم ٢٨٦؟", " الايه 5،"]) {
    assert.equal(
      hasTranscriptCoverage(
        [{ text, start: 131000, end: 131800 }],
        131000,
        132800,
      ),
      true,
      text,
    );
  }
});

test("ordinary words, arbitrary numbers, and longer references keep the original limit", () => {
  for (const text of [
    " أنا أستمع إليك.",
    " العدد 286.",
    " ٢٨٦.",
    " الآية مئتان وست وثمانون.",
    " الآية 286 ثم أستمع.",
    " الآية 2860.",
    " الآية 2.86.",
    " الآية -286.",
    " الآية 286 و287.",
  ]) {
    assert.equal(
      hasTranscriptCoverage(
        [{ text, start: 131000, end: 131800 }],
        131000,
        132800,
      ),
      false,
      text,
    );
  }
});

test("numeric reference exceptions cannot bridge missing text, leading or middle gaps", () => {
  assert.equal(hasTranscriptCoverage([], 131000, 132800), false);
  assert.equal(
    hasTranscriptCoverage(
      [{ text: " الآية 286.", start: 131601, end: 131800 }],
      131000,
      132800,
    ),
    false,
  );
  assert.equal(
    hasTranscriptCoverage(
      [
        { text: " الآية ", start: 130200, end: 130400 },
        { text: "286.", start: 131601, end: 131800 },
      ],
      131000,
      132800,
    ),
    false,
  );
});

test("numeric-tail PCM still requires text review and fails closed on other gaps", async (t) => {
  let now = 0;
  let tick = () => {};
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval(callback: () => void) {
        tick = callback;
        return 1;
      },
      clearInterval() {},
    },
  });
  const clock = t.mock.method(performance, "now", () => now);
  t.after(() => {
    clock.mock.restore();
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  });

  const make = (possiblePrefix = hasQuranPrefix) => {
    now = 140000;
    const started: number[] = [];
    const blocked: string[] = [];
    const reviewed: string[] = [];
    const context = {
      get currentTime() {
        return now / 1000;
      },
      destination: {},
      createAnalyser: () => ({ connect() {}, disconnect() {} }),
      createBuffer: (_channels: number, length: number, rate: number) => ({
        duration: length / rate,
        copyToChannel() {},
      }),
      createBufferSource: () => ({
        buffer: null as { duration: number } | null,
        connect() {},
        disconnect() {},
        start() {
          started.push(this.buffer!.duration);
        },
        stop() {},
      }),
    } as unknown as AudioContext;
    const player = new GuardedAudio(
      context,
      (text) => {
        reviewed.push(text);
        return !isQuranRecitation(text);
      },
      (reason) => blocked.push(reason),
      possiblePrefix,
    );
    const frame = Buffer.alloc(9600);
    for (let i = 0; i < 4800; i++)
      frame.writeInt16LE(
        Math.round(1800 * Math.sin((i / 24000) * 440 * Math.PI * 2)),
        i * 2,
      );
    const pcm = frame.toString("base64");
    const speak = () => {
      for (let start = 131000; start < 132800; start += 200) {
        now += 200;
        player.audio(pcm, start, start + 200);
      }
      // The provider stops meaningful audio, then the existing quiet flush
      // queues the exact 131000–132800 segment from the observed failure.
      now += 400;
      tick();
    };
    return {
      player,
      started,
      blocked,
      reviewed,
      speak,
      advance(milliseconds: number) {
        now += milliseconds;
        tick();
      },
    };
  };

  await t.test(
    "the observed numeric segment releases unchanged PCM after review",
    () => {
      const h = make();
      for (const part of verseNumberFragments)
        h.player.transcript(part.text, part.start, part.end);
      h.speak();
      assert.deepEqual(h.started, []);
      h.advance(700);
      assert.deepEqual(h.started, [1.8]);
      assert.deepEqual(h.blocked, []);
      assert.deepEqual(h.reviewed, [" الآية ٢٨٦."]);
      h.player.close();
    },
  );

  await t.test(
    "missing or nonnumeric text still blocks the entire spoken segment",
    () => {
      for (const text of [null, " أستمع إليك الآن.", " العدد 286."]) {
        const h = make();
        if (text) h.player.transcript(text, 131000, 131800);
        h.speak();
        h.advance(3600);
        assert.deepEqual(h.started, []);
        assert.deepEqual(h.blocked, ["alignment"]);
        h.player.close();
      }
    },
  );

  await t.test(
    "a verse reference after Quran text never bypasses scripture review",
    () => {
      const h = make();
      h.player.transcript("فإن مع العسر يسرا،", 128000, 128400);
      for (const part of verseNumberFragments)
        h.player.transcript(part.text, part.start, part.end);
      h.speak();
      h.advance(700);
      assert.deepEqual(h.started, []);
      assert.deepEqual(h.blocked, ["scripture"]);
      h.player.close();
    },
  );

  await t.test(
    "a pending scripture-prefix decision still holds and blocks numeric tails",
    () => {
      let prefixReviews = 0;
      const h = make(() => {
        prefixReviews++;
        return true;
      });
      for (const part of verseNumberFragments)
        h.player.transcript(part.text, part.start, part.end);
      h.speak();
      h.advance(700);
      assert.equal(prefixReviews, 1);
      assert.deepEqual(h.started, []);
      assert.deepEqual(h.blocked, []);
      h.advance(3400);
      assert.deepEqual(h.started, []);
      assert.deepEqual(h.blocked, ["scripture"]);
      h.player.close();
    },
  );
});
