import test from "node:test";
import assert from "node:assert/strict";
import {
  BoundedRecording,
  recordingRange,
} from "../apps/sakina/app/components/bounded-recording";

test("recording ranges require both exact finite ordered endpoints", () => {
  assert.equal(recordingRange({}), null);
  assert.deepEqual(
    recordingRange({
      playbackStartSeconds: 1653.96,
      playbackEndSeconds: 1667.66,
    }),
    { start: 1653.96, end: 1667.66 },
  );
  for (const value of [
    { fullSurah: false },
    { playbackStartSeconds: 100 },
    { playbackEndSeconds: 100 },
    { playbackStartSeconds: 100, playbackEndSeconds: 90 },
    { playbackStartSeconds: NaN, playbackEndSeconds: 100 },
  ])
    assert.throws(() => recordingRange(value), /invalid_recording_range/);
});

test("bounded original recording never exposes a chapter outside its prepared range", async (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  let nextId = 0;
  const timers = new Map<number, () => void>();
  const frames = new Map<number, () => void>();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      setTimeout(fn: () => void) {
        const id = ++nextId;
        timers.set(id, fn);
        return id;
      },
      clearTimeout(id: number) {
        timers.delete(id);
      },
      requestAnimationFrame(fn: () => void) {
        const id = ++nextId;
        frames.set(id, fn);
        return id;
      },
      cancelAnimationFrame(id: number) {
        frames.delete(id);
      },
    },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const make = () => {
    timers.clear();
    frames.clear();
    let clock = 10;
    let complete = 0,
      errors = 0;
    let schedule: { value: number; at: number }[] = [];
    const gain = {
      value: 0,
      cancelScheduledValues(at: number) {
        schedule = schedule.filter((s) => s.at < at);
      },
      setValueAtTime(value: number, at: number) {
        schedule.push({ value, at });
      },
    };
    const context = {
      get currentTime() {
        return clock;
      },
      destination: {},
      createMediaElementSource() {
        return { connect() {}, disconnect() {} };
      },
      createGain() {
        return { gain, connect() {}, disconnect() {} };
      },
    } as unknown as AudioContext;
    class Audio extends EventTarget {
      readyState = 1;
      duration = 7200;
      seeking = false;
      paused = true;
      time = 0;
      seekTo = 0;
      plays = 0;
      get currentTime() {
        return this.time;
      }
      set currentTime(value: number) {
        this.seekTo = value;
        this.seeking = true;
        this.dispatchEvent(new Event("seeking"));
      }
      seeked(time = this.seekTo) {
        this.time = time;
        this.seeking = false;
        this.readyState = 2;
        this.dispatchEvent(new Event("seeked"));
      }
      play() {
        this.plays++;
        this.paused = false;
        this.dispatchEvent(new Event("playing"));
      }
      pause() {
        this.paused = true;
        this.dispatchEvent(new Event("pause"));
      }
    }
    const audio = new Audio();
    const player = new BoundedRecording(
      context,
      audio as unknown as HTMLAudioElement,
    );
    const controller = new AbortController();
    const start = () =>
      player.prepare(
        { start: 1653.96, end: 1667.66 },
        controller.signal,
        () => complete++,
        () => errors++,
      );
    const ready = async () => {
      const prepared = start();
      await Promise.resolve();
      audio.seeked();
      await prepared;
    };
    return {
      audio,
      player,
      controller,
      start,
      ready,
      advanceClock(seconds: number) {
        clock += seconds;
      },
      outputAt(at: number) {
        return schedule.filter((s) => s.at <= at).at(-1)?.value ?? gain.value;
      },
      schedule: () => schedule,
      completions: () => complete,
      errors: () => errors,
      frame() {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((f) => f());
      },
    };
  };
  await t.test(
    "delayed seek stays silent even if playback is requested early",
    async () => {
      const h = make();
      const prepared = h.start();
      await Promise.resolve();
      assert.equal(h.audio.seekTo, 1653.96);
      h.audio.play();
      assert.equal(h.audio.paused, true);
      assert.equal(h.outputAt(10), 0);
      h.audio.seeked();
      await prepared;
      h.audio.play();
      assert.equal(h.outputAt(10), 1);
      assert.equal(h.completions(), 0);
      h.player.close();
    },
  );
  await t.test(
    "audio clock cuts off at the selected endpoint when all JS callbacks are delayed",
    async () => {
      const h = make();
      await h.ready();
      h.audio.play();
      assert.equal(h.outputAt(23.69), 1);
      assert.equal(h.outputAt(23.71), 0);
      // No timeout, animation-frame or media callback ran before this assertion.
      h.audio.time = 1668;
      h.frame();
      assert.equal(h.audio.paused, true);
      assert.equal(h.completions(), 1);
      h.audio.dispatchEvent(new Event("ended"));
      assert.equal(h.completions(), 1);
      h.player.close();
    },
  );
  await t.test(
    "a stall mutes output and re-arms only the remaining original media duration",
    async () => {
      const h = make();
      await h.ready();
      h.audio.play();
      h.advanceClock(4);
      h.audio.time += 4;
      h.audio.dispatchEvent(new Event("waiting"));
      assert.equal(h.outputAt(14), 0);
      h.advanceClock(20);
      h.audio.dispatchEvent(new Event("playing"));
      assert.equal(h.outputAt(34), 1);
      assert.equal(h.outputAt(43.71), 0);
      assert.equal(h.completions(), 0);
      h.player.close();
    },
  );
  await t.test(
    "a persistent network stall reports a recoverable error while staying silent",
    async () => {
      const h = make();
      await h.ready();
      h.audio.play();
      h.audio.dispatchEvent(new Event("waiting"));
      [...timers.values()][0]();
      assert.equal(h.errors(), 1);
      assert.equal(h.completions(), 0);
      assert.equal(h.audio.paused, true);
      assert.equal(h.outputAt(100), 0);
      h.player.close();
    },
  );
  await t.test(
    "metadata arriving after cancellation cannot start a new seek",
    async () => {
      const h = make();
      h.audio.readyState = 0;
      const pending = h.start();
      h.controller.abort();
      h.player.cancel();
      await assert.rejects(pending, { name: "AbortError" });
      h.audio.readyState = 1;
      h.audio.dispatchEvent(new Event("loadedmetadata"));
      assert.equal(h.audio.seekTo, 0);
      assert.equal(h.audio.plays, 0);
      h.player.close();
    },
  );
  await t.test(
    "abort during seek cannot become ready or audible after a late seek event",
    async () => {
      const h = make();
      const prepared = h.start();
      await Promise.resolve();
      h.controller.abort();
      h.player.cancel();
      await assert.rejects(prepared, { name: "AbortError" });
      h.audio.seeked();
      h.audio.play();
      assert.equal(h.audio.paused, true);
      assert.equal(h.outputAt(100), 0);
      assert.equal(h.completions(), 0);
      h.audio.dispatchEvent(new Event("error"));
      assert.equal(h.errors(), 0);
      h.player.close();
    },
  );
  await t.test(
    "a failed or wrong seek never falls back to the chapter beginning",
    async () => {
      const h = make();
      const prepared = h.start();
      await Promise.resolve();
      h.audio.seeked(0);
      const timeout = [...timers.values()][0];
      timeout();
      await assert.rejects(prepared, /recording_seek_timeout/);
      h.audio.play();
      assert.equal(h.audio.paused, true);
      assert.equal(h.outputAt(100), 0);
      h.player.close();
    },
  );
  await t.test(
    "a truncated file ending before the verse endpoint is an error, not successful recitation",
    async () => {
      const h = make();
      await h.ready();
      h.audio.play();
      h.audio.time = 1660;
      h.audio.dispatchEvent(new Event("ended"));
      assert.equal(h.errors(), 1);
      assert.equal(h.completions(), 0);
      assert.equal(h.outputAt(10), 0);
      h.player.close();
    },
  );
  await t.test(
    "replay must seek to the exact verse start again before becoming audible",
    async () => {
      const h = make();
      await h.ready();
      h.audio.play();
      h.audio.time = 1660;
      const replay = h.start();
      await Promise.resolve();
      h.audio.play();
      assert.equal(h.audio.paused, true);
      assert.equal(h.audio.seekTo, 1653.96);
      h.audio.seeked();
      await replay;
      h.audio.play();
      assert.equal(h.outputAt(10), 1);
      h.player.close();
    },
  );
});
