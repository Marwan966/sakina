export type RecordingRange = { start: number; end: number };

export function recordingRange(recording: {
  fullSurah?: boolean;
  playbackStartSeconds?: number;
  playbackEndSeconds?: number;
}): RecordingRange | null {
  const start = recording.playbackStartSeconds;
  const end = recording.playbackEndSeconds;
  if (start === undefined && end === undefined && recording.fullSurah !== false)
    return null;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    start < 0 ||
    end <= start ||
    end - start > 300
  )
    throw new Error("invalid_recording_range");
  return { start, end };
}

/** An original CDN recording, bounded by its publisher's verse timestamps.
 * The native element seeks/decodes the MP3. No generated audio or speed change.
 * A scheduled gain cutoff also silences it when background JS timers are late.
 * Browser seek/output timing is not a sample-accurate editorial extraction. */
export class BoundedRecording {
  private source: MediaElementAudioSourceNode;
  private gain: GainNode;
  private range: RecordingRange | null = null;
  private prepared = false;
  private operation = 0;
  private closed = false;
  private endpointTimer = 0;
  private frame = 0;
  private complete = () => {};
  private error = () => {};

  constructor(
    private context: AudioContext,
    private audio: HTMLAudioElement,
  ) {
    this.source = context.createMediaElementSource(audio);
    this.gain = context.createGain();
    this.gain.gain.value = 0;
    this.source.connect(this.gain);
    this.gain.connect(context.destination);
    audio.addEventListener("playing", this.playing);
    audio.addEventListener("pause", this.waiting);
    audio.addEventListener("waiting", this.waiting);
    audio.addEventListener("seeking", this.waiting);
    audio.addEventListener("timeupdate", this.check);
    audio.addEventListener("ended", this.ended);
    audio.addEventListener("error", this.failed);
  }

  private silence() {
    this.gain.gain.cancelScheduledValues(this.context.currentTime);
    this.gain.gain.setValueAtTime(0, this.context.currentTime);
    window.clearTimeout(this.endpointTimer);
    window.cancelAnimationFrame(this.frame);
  }

  private waiting = (event: Event) => {
    if (!this.range) return;
    this.silence();
    if (event.type === "waiting" && this.prepared && !this.audio.paused)
      this.endpointTimer = window.setTimeout(() => {
        if (this.prepared && !this.audio.paused) this.failed();
      }, 15000);
  };

  private finish() {
    if (!this.range || !this.prepared || this.closed) return;
    this.prepared = false;
    this.operation++;
    this.silence();
    this.audio.pause();
    this.complete();
  }

  private failed = () => {
    if (!this.range || this.closed) return;
    this.prepared = false;
    this.operation++;
    this.silence();
    this.audio.pause();
    this.error();
  };

  private ended = () => {
    if (!this.range || !this.prepared) return;
    if (this.audio.currentTime < this.range.end - 0.05) this.failed();
    else this.finish();
  };

  private check = () => {
    if (!this.range || !this.prepared || this.closed) return;
    if (this.audio.currentTime >= this.range.end) this.finish();
    else if (
      this.audio.currentTime < this.range.start - 0.03 &&
      !this.audio.seeking
    )
      this.failed();
  };

  private monitor = () => {
    this.check();
    if (this.prepared && !this.audio.paused && !this.closed)
      this.frame = window.requestAnimationFrame(this.monitor);
  };

  private playing = () => {
    if (!this.range) return;
    if (!this.prepared || this.closed) {
      this.audio.pause();
      return;
    }
    this.check();
    if (!this.prepared) return;
    const remaining = this.range.end - this.audio.currentTime;
    this.silence();
    // Schedule against the audio-render clock. A background-tab timeout can
    // be delayed; it must never leave the remainder of the chapter audible.
    const clock = this.context.currentTime;
    this.gain.gain.setValueAtTime(1, clock);
    this.gain.gain.setValueAtTime(0, clock + remaining);
    this.endpointTimer = window.setTimeout(() => {
      this.check();
      if (this.prepared && !this.audio.paused) this.playing();
    }, remaining * 1000);
    this.frame = window.requestAnimationFrame(this.monitor);
  };

  private waitFor(
    ready: () => boolean,
    events: string[],
    signal: AbortSignal,
    operation: number,
  ) {
    return new Promise<void>((resolve, reject) => {
      let timer = 0;
      const done = (error?: Error) => {
        window.clearTimeout(timer);
        for (const event of events)
          this.audio.removeEventListener(event, check);
        this.audio.removeEventListener("error", failed);
        signal.removeEventListener("abort", aborted);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (signal.aborted || operation !== this.operation || this.closed)
          done(new DOMException("Aborted", "AbortError"));
        else if (this.audio.error) done(new Error("recording_unavailable"));
        else if (ready()) done();
      };
      const aborted = () => done(new DOMException("Aborted", "AbortError"));
      const failed = () => done(new Error("recording_unavailable"));
      for (const event of events) this.audio.addEventListener(event, check);
      this.audio.addEventListener("error", failed, { once: true });
      signal.addEventListener("abort", aborted, { once: true });
      timer = window.setTimeout(
        () => done(new Error("recording_seek_timeout")),
        12000,
      );
      check();
    });
  }

  async prepare(
    range: RecordingRange,
    signal: AbortSignal,
    complete: () => void,
    error: () => void,
  ) {
    this.cancel();
    const operation = this.operation;
    this.range = range;
    this.complete = complete;
    this.error = error;
    await this.waitFor(
      () => this.audio.readyState >= 1,
      ["loadedmetadata"],
      signal,
      operation,
    );
    if (
      !Number.isFinite(this.audio.duration) ||
      this.audio.duration < range.end
    )
      throw new Error("recording_range_unavailable");
    this.audio.currentTime = range.start;
    await this.waitFor(
      () =>
        !this.audio.seeking &&
        this.audio.readyState >= 2 &&
        Math.abs(this.audio.currentTime - range.start) <= 0.03,
      ["seeked", "loadeddata", "canplay"],
      signal,
      operation,
    );
    if (signal.aborted || operation !== this.operation || this.closed)
      throw new DOMException("Aborted", "AbortError");
    this.prepared = true;
  }

  fullRecording() {
    this.cancel();
    this.range = null;
    this.gain.gain.setValueAtTime(1, this.context.currentTime);
  }

  restart(signal: AbortSignal) {
    if (!this.range)
      return Promise.reject(new Error("recording_range_missing"));
    return this.prepare(this.range, signal, this.complete, this.error);
  }

  cancel() {
    this.operation++;
    this.prepared = false;
    this.complete = () => {};
    this.error = () => {};
    this.silence();
    this.audio.pause();
  }

  close() {
    this.cancel();
    this.closed = true;
    for (const [name, listener] of [
      ["playing", this.playing],
      ["pause", this.waiting],
      ["waiting", this.waiting],
      ["seeking", this.waiting],
      ["timeupdate", this.check],
      ["ended", this.ended],
      ["error", this.failed],
    ] as const)
      this.audio.removeEventListener(name, listener);
    this.source.disconnect();
    this.gain.disconnect();
  }
}
