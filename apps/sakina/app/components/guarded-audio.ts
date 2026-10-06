type Transcript = { text: string; start: number; end: number };
type Segment = {
  samples: Float32Array;
  start: number;
  end: number;
  queued: number;
  epoch: number;
};

const MAX_SEGMENT_MS = 2000;
// Keep the same source-to-playout delay for short and long phrases. Starting
// each approved VAD segment immediately makes the next, longer segment arrive
// too late and inserts unnatural pauses. This budget includes a full segment,
// the unchanged 650 ms review window and 150 ms of scheduling headroom.
const PLAYOUT_DELAY_SECONDS = 2.8;

export function hasTranscriptCoverage(
  parts: { start: number; end: number }[],
  start: number,
  end: number,
) {
  // Live transcript intervals describe approximate fragments, not complete
  // word durations: https://developers.openai.com/api/docs/guides/live-conversations#transcript-deltas
  // Observed Arabic tokens arrive on a 200 ms grid with ordinary 400–800 ms
  // gaps. Bounded interpolation associates those fragments with audio; it is
  // not a proof that every audible word has a matching transcript. Completely
  // absent/unrelated text and longer unexplained gaps still fail closed.
  if (
    !parts.length ||
    parts[0].start > start + 600 ||
    parts[0].end < start - 800
  )
    return false;
  let coveredTo = parts[0].end;
  for (const part of parts.slice(1)) {
    if (part.start - coveredTo > 1200) return false;
    coveredTo = Math.max(coveredTo, part.end);
  }
  return coveredTo >= end - 800;
}

/** Original PCM and transcript share the provider's session clock. Never use
 * packet arrival time to approve speech. The WebRTC downlink stays inaudible. */
export class GuardedAudio {
  private playing = new Set<AudioBufferSourceNode>();
  private frames: Float32Array[] = [];
  private transcripts: Transcript[] = [];
  private pending: Segment[] = [];
  private epoch = 0;
  private holdEpoch = 0;
  private firstSampleAt: number | null = null;
  private lastSpeechAt = 0;
  private lastAudioAt = 0;
  private lastRemoteSpeechAt = 0;
  private suspended = false;
  private closed = false;
  private nextPlaybackAt = 0;
  private playoutClock: number | null = null;
  private staleBefore = -1;
  private timer: number;
  readonly output: AnalyserNode;

  constructor(
    readonly context: AudioContext,
    private review: (text: string) => boolean,
    private onBlocked: (reason: "scripture" | "alignment") => void,
    private possiblePrefix: (text: string) => boolean = () => false,
  ) {
    this.output = context.createAnalyser();
    this.output.fftSize = 256;
    this.output.connect(context.destination);
    this.timer = window.setInterval(() => {
      if (
        this.firstSampleAt !== null &&
        performance.now() - this.lastRemoteSpeechAt > 380
      )
        this.flush();
      this.release();
    }, 100);
  }

  transcript(text: string, start: number, end: number) {
    if (
      this.closed ||
      this.suspended ||
      start < this.staleBefore ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start
    )
      return;
    this.transcripts.push({ text, start, end });
    this.transcripts.sort((a, b) => a.start - b.start);
    this.transcripts = this.transcripts.slice(-400);
  }

  audio(base64: string, start: number, end: number) {
    if (
      this.closed ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      start < this.lastAudioAt - 80
    )
      return;
    if (base64.length > 320_000) {
      this.block("alignment");
      return;
    }
    let binary: string;
    try {
      binary = atob(base64);
    } catch {
      this.block("alignment");
      return;
    }
    if (!binary.length || binary.length > 240_000 || binary.length % 2) {
      this.block("alignment");
      return;
    }
    const samples = new Float32Array(binary.length / 2);
    let power = 0;
    for (let i = 0; i < samples.length; i++) {
      const value =
        binary.charCodeAt(i * 2) | (binary.charCodeAt(i * 2 + 1) << 8);
      samples[i] = (value >= 0x8000 ? value - 0x10000 : value) / 32768;
      power += samples[i] * samples[i];
    }
    const duration = samples.length / 24;
    if (Math.abs(duration - (end - start)) > 150) {
      this.block("alignment");
      return;
    }
    const gap = start - this.lastAudioAt;
    if (this.firstSampleAt !== null && gap > 0) {
      // Reflected audio can omit dropped frames. Preserve short timestamp
      // gaps as silence rather than accelerating adjacent spoken words.
      if (gap > 1000) this.flush();
      else this.frames.push(new Float32Array(Math.round(gap * 24)));
    }
    this.lastAudioAt = end;
    const speech = Math.sqrt(power / Math.max(1, samples.length)) > 0.006;
    if (speech) this.lastRemoteSpeechAt = performance.now();
    if (this.suspended || start < this.staleBefore) return;
    if (speech && this.firstSampleAt === null) {
      this.firstSampleAt = start;
      if (this.playoutClock === null)
        this.playoutClock =
          this.context.currentTime + PLAYOUT_DELAY_SECONDS - start / 1000;
    }
    if (this.firstSampleAt === null) return;
    this.frames.push(samples);
    if (speech) this.lastSpeechAt = end;
    if (
      end - this.lastSpeechAt > 300 ||
      end - this.firstSampleAt >= MAX_SEGMENT_MS
    )
      this.flush();
  }

  private flush() {
    if (!this.frames.length || this.firstSampleAt === null) return;
    const samples = new Float32Array(
      this.frames.reduce((count, frame) => count + frame.length, 0),
    );
    let cursor = 0;
    for (const frame of this.frames) {
      samples.set(frame, cursor);
      cursor += frame.length;
    }
    this.pending.push({
      samples,
      start: this.firstSampleAt,
      end: this.lastSpeechAt,
      queued: performance.now(),
      epoch: this.epoch,
    });
    this.frames = [];
    this.firstSampleAt = null;
    if (this.pending.length > 4) this.block("alignment");
  }

  private release() {
    if (this.closed || this.suspended || !this.pending.length) return;
    const segment = this.pending[0];
    if (segment.epoch !== this.epoch) {
      this.pending.shift();
      return;
    }
    const age = performance.now() - segment.queued;
    if (age < 650) return;
    const relevant = this.transcripts.filter(
      (part) =>
        part.end >= segment.start - 600 && part.start <= segment.end + 600,
    );
    if (!hasTranscriptCoverage(relevant, segment.start, segment.end)) {
      if (age > 3500) this.block("alignment");
      return;
    }
    // Review available lookahead as well as previous words. A paused Quran
    // quotation must not pass as several individually harmless fragments.
    const text = this.transcripts
      .filter((part) => part.end >= segment.start - 5000)
      .map((part) => part.text)
      .join("");
    if (!this.review(text)) {
      this.block("scripture");
      return;
    }
    if (this.possiblePrefix(text)) {
      if (age > 4000) this.block("scripture");
      return;
    }
    this.pending.shift();
    const buffer = this.context.createBuffer(1, segment.samples.length, 24_000);
    buffer.copyToChannel(new Float32Array(segment.samples), 0);
    const player = this.context.createBufferSource();
    player.buffer = buffer;
    player.connect(this.output);
    this.playing.add(player);
    player.onended = () => {
      this.playing.delete(player);
      player.disconnect();
    };
    const intended =
      (this.playoutClock ?? this.context.currentTime) + segment.start / 1000;
    const begins = Math.max(
      this.context.currentTime + 0.02,
      this.nextPlaybackAt,
      intended,
    );
    // Network/review stalls must never bypass review or accelerate PCM to
    // catch up. Shift the remaining clock together when that budget is missed;
    // normal source pauses and all following frame durations stay intact.
    if (begins > intended)
      this.playoutClock = (this.playoutClock ?? 0) + begins - intended;
    player.start(begins);
    this.nextPlaybackAt = begins + buffer.duration;
  }

  private block(reason: "scripture" | "alignment") {
    this.clear();
    this.onBlocked(reason);
  }

  private clear() {
    this.epoch += 1;
    this.staleBefore = Math.max(
      this.staleBefore,
      this.lastAudioAt,
      ...this.transcripts.map((part) => part.end),
    );
    for (const player of this.playing) {
      try {
        player.stop();
      } catch {
        /* Already stopped. */
      }
      player.disconnect();
    }
    this.playing.clear();
    this.frames = [];
    this.pending = [];
    this.transcripts = [];
    this.firstSampleAt = null;
    this.nextPlaybackAt = 0;
    this.playoutClock = null;
  }

  hold() {
    this.holdEpoch += 1;
    this.suspended = true;
    this.clear();
  }

  async resume(inputQuiet: () => boolean = () => true): Promise<boolean> {
    const epoch = this.holdEpoch;
    // A discarded provider response may continue beyond six seconds after
    // interruption. Keep it inaudible until quiet, rather than failing the
    // call. The session deadline/cleanup closes this guard; any newer hold
    // cancels this recovery through its epoch, including Quran playback.
    while (
      !this.closed &&
      this.holdEpoch === epoch &&
      (performance.now() - this.lastRemoteSpeechAt < 650 || !inputQuiet())
    ) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    // A newer hold (recitation/reset/interruption) owns the audio gate now.
    // Report cancellation explicitly; callers must not unmute the microphone
    // or claim successful resumption after a superseded operation.
    if (this.closed || this.holdEpoch !== epoch) return false;
    this.clear();
    this.suspended = false;
    return true;
  }

  get audible() {
    return this.playing.size > 0;
  }

  get hasOutput() {
    return this.audible || this.pending.length > 0 || this.frames.length > 0;
  }

  close() {
    this.closed = true;
    window.clearInterval(this.timer);
    this.clear();
    this.output.disconnect();
  }
}
