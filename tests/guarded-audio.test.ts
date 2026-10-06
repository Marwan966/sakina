import test from "node:test";
import assert from "node:assert/strict";
import {
  GuardedAudio,
  hasTranscriptCoverage,
} from "../apps/sakina/app/components/guarded-audio";
import {
  isQuranRecitation,
  hasQuranPrefix,
} from "../apps/sakina/lib/quran-speech-guard";

test("approximate transcript association rejects long unexplained gaps and unrelated intervals", () => {
  assert.equal(
    hasTranscriptCoverage(
      [
        { start: 1000, end: 1200 },
        { start: 3000, end: 3200 },
      ],
      1000,
      3200,
    ),
    false,
  );
  assert.equal(
    hasTranscriptCoverage([{ start: 4000, end: 5000 }], 1000, 2000),
    false,
  );
  assert.equal(
    hasTranscriptCoverage(
      [
        { start: 1000, end: 1450 },
        { start: 1400, end: 2100 },
      ],
      1000,
      2100,
    ),
    true,
  );
  assert.equal(hasTranscriptCoverage([], 1000, 2000), false);
});

// These assistant timestamps came from the synthetic-input live-provider
// journey on 2026-10-04. They are fragment intervals, not word-duration labels.
const greetingFragments = [
  [17800, 18000, " أهلاً"],
  [18000, 18200, " فيك"],
  [18200, 18400, "،"],
  [18400, 18600, " أنا"],
  [18600, 18800, " مساعد"],
  [19000, 19200, " سكينة"],
  [19400, 19600, " الصوتي"],
  [19800, 20000, " بالذك"],
  [20000, 20200, "اء"],
  [20200, 20400, " الاصط"],
  [20400, 20600, "ناعي"],
  [20600, 20800, "."],
  [21000, 21200, " خذ"],
  [21200, 21400, " راحتك"],
  [21400, 21600, "."],
  [22000, 22200, " ما"],
  [22200, 22400, " أكثر"],
  [22400, 22600, " شيء"],
  [22600, 22800, " يشغ"],
  [22800, 23000, "لك"],
  [23000, 23200, " اليوم؟"],
] as const;

test("real provider Arabic greeting accepts approximate token intervals", () => {
  assert.equal(
    hasTranscriptCoverage(
      greetingFragments.map(([start, end]) => ({ start, end })),
      17800,
      23600,
    ),
    true,
  );
  assert.equal(
    hasTranscriptCoverage(
      [
        { start: 1000, end: 1200 },
        { start: 2000, end: 2200 },
      ],
      1000,
      2600,
    ),
    true,
  );
});

test("guarded PCM audio admits aligned speech and discards uncertain or canceled speech", async (t) => {
  let now = 1000;
  let tick = () => {};
  const windowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setInterval(callback: () => void) {
        tick = callback;
        return 1;
      },
      clearInterval() {},
      setTimeout: globalThis.setTimeout,
    },
  });
  const clock = t.mock.method(performance, "now", () => now);
  t.after(() => {
    clock.mock.restore();
    if (windowDescriptor)
      Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });

  const make = () => {
    now = 1000;
    let started = 0,
      stopped = 0;
    const blocked: string[] = [];
    const durations: number[] = [];
    const scheduled: { at: number; duration: number; queued: number }[] = [];
    const context = {
      get currentTime() {
        return now / 1000;
      },
      destination: {},
      createAnalyser: () => ({ fftSize: 0, connect() {}, disconnect() {} }),
      createBuffer: (_channels: number, length: number, sampleRate: number) => {
        durations.push(length / sampleRate);
        return { duration: length / sampleRate, copyToChannel() {} };
      },
      createBufferSource: () => ({
        buffer: null as { duration: number } | null,
        onended: null,
        connect() {},
        disconnect() {},
        start(at: number) {
          started++;
          scheduled.push({
            at,
            duration: this.buffer!.duration,
            queued: now / 1000,
          });
        },
        stop() {
          stopped++;
        },
      }),
    } as unknown as AudioContext;
    const player = new GuardedAudio(
      context,
      (text) => !isQuranRecitation(text),
      (reason) => blocked.push(reason),
      hasQuranPrefix,
    );
    const pcm = (speech: boolean) => {
      const buffer = Buffer.alloc(4800);
      if (speech)
        for (let i = 0; i < 2400; i++)
          buffer.writeInt16LE(i % 2 ? 3000 : -3000, i * 2);
      return buffer.toString("base64");
    };
    const speak = (start = 1000, frames = 6) => {
      for (let n = 0; n < frames; n++) {
        now += 100;
        player.audio(pcm(true), start + n * 100, start + (n + 1) * 100);
      }
      for (let n = frames; n < frames + 4; n++) {
        now += 100;
        player.audio(pcm(false), start + n * 100, start + (n + 1) * 100);
      }
    };
    return {
      player,
      blocked,
      speak,
      pcm,
      durations,
      scheduled,
      starts: () => started,
      stops: () => stopped,
      advance: (ms: number) => {
        now += ms;
        tick();
      },
    };
  };

  await t.test(
    "normal speech releases original audio only after transcript review",
    () => {
      const h = make();
      h.player.transcript("أنا أستمع إليك، خذ وقتك في الحديث.", 1000, 1600);
      h.speak();
      assert.equal(h.starts(), 0);
      h.advance(700);
      assert.equal(h.starts(), 1);
      assert.deepEqual(h.blocked, []);
      h.player.close();
    },
  );
  await t.test(
    "missing transcript never releases and returns an alignment error",
    () => {
      const h = make();
      h.speak();
      h.advance(4000);
      assert.equal(h.starts(), 0);
      assert.deepEqual(h.blocked, ["alignment"]);
      h.player.close();
    },
  );
  await t.test(
    "long missing middle speech cannot be approved by matching endpoints",
    () => {
      const h = make();
      h.player.transcript("أهلًا ", 1000, 1100);
      h.player.transcript("نتابع الحديث.", 3500, 3800);
      h.speak(1000, 30);
      h.advance(4000);
      assert.equal(h.starts(), 0);
      assert.deepEqual(h.blocked, ["alignment"]);
      h.player.close();
    },
  );
  await t.test(
    "real greeting fragments allow bounded two-second speech buffers",
    () => {
      const h = make();
      for (const [start, end, text] of greetingFragments)
        h.player.transcript(text, start, end);
      h.speak(17800, 54);
      h.advance(700);
      h.advance(100);
      h.advance(100);
      assert.equal(h.starts(), 3);
      assert.ok(h.durations.every((duration) => duration <= 2));
      assert.deepEqual(h.blocked, []);
      h.player.close();
    },
  );
  await t.test(
    "source-clock scheduling keeps short then long reviewed phrases contiguous",
    () => {
      const h = make();
      h.player.transcript("أنا أستمع إليك. ", 1000, 1400);
      h.player.transcript("خذ وقتك في الحديث. ", 1800, 3800);
      // A short phrase with a natural 400 ms pause, followed immediately by
      // two seconds of speech: independent immediate release used to insert
      // an extra pause when approval of the second segment arrived later.
      for (let start = 1000; start < 3800; start += 100) {
        h.player.audio(
          h.pcm(start < 1400 || start >= 1800),
          start,
          start + 100,
        );
        h.advance(100);
      }
      h.advance(700);
      assert.equal(h.starts(), 2);
      assert.equal(h.scheduled[0].at, 3.8);
      assert.ok(
        Math.abs(h.scheduled[1].at - h.scheduled[0].at - 0.8) < 0.00001,
      );
      assert.deepEqual(h.blocked, []);
      h.player.close();
    },
  );
  await t.test(
    "source silence between reviewed segments is preserved rather than compressed",
    () => {
      const h = make();
      h.player.transcript("أنا أستمع إليك. ", 1000, 1400);
      h.player.transcript("خذ وقتك في الحديث. ", 2000, 2400);
      for (let start = 1000; start < 2800; start += 100) {
        h.player.audio(
          h.pcm(start < 1400 || (start >= 2000 && start < 2400)),
          start,
          start + 100,
        );
        h.advance(100);
      }
      h.advance(700);
      assert.equal(h.starts(), 2);
      assert.ok(Math.abs(h.scheduled[1].at - h.scheduled[0].at - 1) < 0.00001);
      h.player.close();
    },
  );
  await t.test(
    "continuous provider frames remain contiguous across different review arrival times",
    () => {
      const h = make();
      h.player.transcript("أنا أستمع إليك. ", 1000, 3000);
      for (let start = 1000; start < 5000; start += 100) {
        h.player.audio(h.pcm(true), start, start + 100);
        if (start === 4500)
          h.player.transcript("خذ وقتك في الحديث. ", 3000, 5000);
        h.advance(100);
      }
      h.advance(600);
      assert.equal(h.starts(), 2);
      assert.deepEqual(h.durations, [2, 2]);
      assert.ok(Math.abs(h.scheduled[1].at - h.scheduled[0].at - 2) < 0.00001);
      assert.deepEqual(h.blocked, []);
      h.player.close();
    },
  );
  await t.test(
    "late transcript review moves the remaining clock without compressing subsequent speech",
    () => {
      const h = make();
      for (let start = 1000; start < 5000; start += 100) {
        h.player.audio(h.pcm(true), start, start + 100);
        h.advance(100);
      }
      assert.equal(h.starts(), 0);
      h.player.transcript("أنا أستمع إليك، خذ وقتك في الحديث. ", 1000, 5000);
      h.advance(700);
      h.advance(100);
      assert.equal(h.starts(), 2);
      assert.ok(h.scheduled[0].at >= h.scheduled[0].queued);
      assert.ok(Math.abs(h.scheduled[1].at - h.scheduled[0].at - 2) < 0.00001);
      assert.deepEqual(h.blocked, []);
      h.player.close();
    },
  );
  await t.test(
    "interrupting during the prebuffer stops every scheduled sample immediately",
    () => {
      const h = make();
      h.player.transcript("أنا أستمع إليك. ", 1000, 1400);
      for (let start = 1000; start < 1800; start += 100) {
        h.player.audio(h.pcm(start < 1400), start, start + 100);
        h.advance(100);
      }
      h.advance(700);
      assert.equal(h.starts(), 1);
      assert.ok(h.scheduled[0].at > h.scheduled[0].queued);
      assert.equal(h.player.audible, true);
      h.player.hold();
      assert.equal(h.stops(), 1);
      assert.equal(h.player.audible, false);
      h.advance(5000);
      assert.equal(h.starts(), 1);
      h.player.close();
    },
  );
  for (const prefixStart of [1500, 1800, 2200, 2700]) {
    await t.test(
      `Quran prefix across the two-second boundary at ${prefixStart} never starts`,
      () => {
        const h = make();
        h.player.transcript("أنا أستمع إليك. ", 1000, prefixStart);
        h.player.transcript("فإن مع ", prefixStart, 3000);
        for (let start = 1000; start < 3800; start += 100) {
          h.player.audio(h.pcm(true), start, start + 100);
          h.advance(100);
        }
        assert.equal(h.starts(), 0);
        h.player.transcript("العسر يسرا", 3800, 4200);
        h.advance(100);
        assert.equal(h.starts(), 0);
        assert.deepEqual(h.blocked, ["scripture"]);
        h.player.close();
      },
    );
  }
  await t.test(
    "omitted PCM frames preserve the original timing as silence",
    () => {
      const h = make();
      h.player.transcript("أنا أستمع إليك،", 1000, 1200);
      h.player.transcript(" خذ وقتك في الحديث.", 1500, 1700);
      h.player.audio(h.pcm(true), 1000, 1100);
      h.player.audio(h.pcm(true), 1500, 1600);
      for (let start = 1600; start < 2000; start += 100)
        h.player.audio(h.pcm(false), start, start + 100);
      h.advance(700);
      assert.equal(h.starts(), 1);
      assert.equal(h.durations[0], 1);
      h.player.close();
    },
  );
  await t.test(
    "Quran quotation is discarded before the first audible sample",
    () => {
      const h = make();
      h.player.transcript("فإن مع العسر يسرا", 1000, 1600);
      h.speak();
      h.advance(700);
      assert.equal(h.starts(), 0);
      assert.deepEqual(h.blocked, ["scripture"]);
      h.player.close();
    },
  );
  await t.test(
    "split quotation stays held until lookahead identifies it",
    () => {
      const h = make();
      h.player.transcript("فإن مع ", 1000, 1600);
      h.speak();
      h.advance(700);
      assert.equal(h.starts(), 0);
      assert.deepEqual(h.blocked, []);
      h.player.transcript("العسر يسرا", 2100, 2500);
      h.advance(100);
      assert.equal(h.starts(), 0);
      assert.deepEqual(h.blocked, ["scripture"]);
      h.player.close();
    },
  );
  await t.test(
    "hold clears approved playback and pending audio; late old words cannot approve a new segment",
    async () => {
      const h = make();
      h.player.transcript("أنا أستمع إليك، خذ وقتك في الحديث.", 1000, 1600);
      h.speak();
      h.advance(700);
      assert.equal(h.starts(), 1);
      h.player.hold();
      assert.equal(h.stops(), 1);
      h.player.transcript("كلام قديم وصل متأخرًا", 1200, 1600);
      h.advance(800);
      await h.player.resume();
      h.speak(3000);
      h.advance(4000);
      assert.equal(h.starts(), 1);
      assert.deepEqual(h.blocked, ["alignment"]);
      h.player.close();
    },
  );
  await t.test("closed player cannot release late audio or transcripts", () => {
    const h = make();
    h.player.close();
    h.player.transcript("أنا أستمع إليك، خذ وقتك في الحديث.", 1000, 1600);
    h.speak();
    h.advance(4000);
    assert.equal(h.starts(), 0);
    assert.deepEqual(h.blocked, []);
  });
  await t.test(
    "a long interrupted response stays discarded until quiet, then fresh reviewed speech resumes",
    async (t) => {
      const h = make();
      t.after(() => h.player.close());
      h.player.audio(h.pcm(true), 1000, 1100);
      h.player.hold();
      let result: boolean | undefined;
      let failure: unknown;
      const recovery = h.player.resume().then(
        (value) => {
          result = value;
        },
        (error) => {
          failure = error;
        },
      );

      // The provider can keep sending a discarded answer after barge-in.
      // Cross the old six-second limit without making the stream quiet.
      h.advance(6200);
      h.player.audio(h.pcm(true), 7200, 7300);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(
        failure,
        undefined,
        "an ordinary long tail must not fail the call",
      );
      assert.equal(
        result,
        undefined,
        "recovery must wait for a quiet boundary",
      );
      assert.equal(h.starts(), 0, "discarded speech must never become audible");

      h.advance(800);
      await recovery;
      assert.equal(result, true);
      h.player.transcript("أنا أستمع إليك، خذ وقتك في الحديث.", 9000, 9600);
      h.speak(9000);
      h.advance(700);
      assert.equal(h.starts(), 1);
      assert.deepEqual(h.blocked, []);

      // Recovering must not weaken the original scripture guard.
      h.player.transcript("فإن مع العسر يسرا", 12000, 12600);
      h.speak(12000);
      h.advance(700);
      assert.equal(h.starts(), 1);
      assert.deepEqual(h.blocked, ["scripture"]);
    },
  );
  await t.test(
    "a newer hold cancels a pending resume and keeps subsequent speech muted",
    async () => {
      const h = make();
      h.player.audio(h.pcm(true), 1000, 1100);
      h.player.hold();
      const pendingResume = h.player.resume();
      h.player.hold();
      assert.equal(await pendingResume, false);
      h.player.transcript("أنا أستمع إليك، خذ وقتك في الحديث.", 2000, 2600);
      h.speak(2000);
      h.advance(4000);
      assert.equal(h.starts(), 0);
      h.player.close();
    },
  );
  await t.test(
    "closing while waiting to resume reports cancellation",
    async () => {
      const h = make();
      h.player.audio(h.pcm(true), 1000, 1100);
      h.player.hold();
      const pendingResume = h.player.resume();
      h.player.close();
      assert.equal(await pendingResume, false);
    },
  );
  await t.test(
    "malformed PCM during recovery cannot throw or orphan the hold",
    async () => {
      const h = make();
      h.player.audio(h.pcm(true), 1000, 1100);
      h.player.hold();
      const recovery = h.player.resume();
      assert.doesNotThrow(() => h.player.audio("A", 1200, 1300));
      h.advance(800);
      assert.equal(await recovery, true);
      h.player.transcript("أنا أستمع إليك، خذ وقتك في الحديث.", 3000, 3600);
      h.speak(3000);
      h.advance(700);
      assert.equal(h.starts(), 1);
      assert.deepEqual(h.blocked, ["alignment"]);
      h.player.close();
    },
  );
  await t.test(
    "recovery waits for caller silence as well as discarded output silence",
    async () => {
      const h = make();
      let quiet = false;
      let resumed = false;
      h.player.hold();
      const recovery = h.player
        .resume(() => quiet)
        .then((value) => {
          resumed = value;
        });
      h.advance(2000);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.equal(resumed, false);
      quiet = true;
      await recovery;
      assert.equal(resumed, true);
      h.player.close();
    },
  );
});
