/** An amplitude activity estimate, not a speech recognizer. Learn the ambient
 * floor before detecting barge-ins, then use the same hysteresis for both
 * interruption and recovery. Constant fan noise must not hold playback forever.
 * WebRTC echo cancellation/noise suppression still performs the primary cleanup.
 */
export class InputActivity {
  private floor = 0.004;
  private calibration: number[] = [];
  private calibrated = false;
  private startedAt: number | null = null;
  private candidateAt: number | null = null;
  private quietAt: number | null = null;
  private speaking = false;
  private recent: { time: number; level: number }[] = [];
  private confirmedAt = -Infinity;
  lastSpeechAt = -Infinity;

  /** The provider has recognized caller words. This is positive speech
   * evidence when a soft voice was indistinguishable from the startup floor.
   * No transcript text is stored here. */
  confirmSpeech(now: number) {
    if (!Number.isFinite(now)) return;
    this.confirmedAt = now;
    // Arrival is supporting evidence, never microphone activity by itself.
    // A delayed fragment must not interrupt an answer while the caller is quiet.
  }

  sample(level: number, now: number) {
    if (!Number.isFinite(level) || level < 0 || !Number.isFinite(now))
      return this.speaking;
    this.startedAt ??= now;
    if (!this.calibrated) {
      this.calibration.push(level);
      if (now - this.startedAt < 400) return this.speaking;
      // A brief spike during startup must not become the baseline. Cap the
      // initial estimate so ordinary speech during connection is not learned
      // as a very loud noise floor.
      const sorted = this.calibration.sort((a, b) => a - b);
      this.floor = Math.min(0.035, sorted[Math.floor(sorted.length * 0.2)]);
      this.calibrated = true;
      this.calibration = [];
    }
    this.recent.push({ time: now, level });
    this.recent = this.recent.filter((sample) => now - sample.time <= 1800);
    if (
      this.recent.length >= 12 &&
      now - this.recent[0].time >= 1700 &&
      now - this.confirmedAt >= 1800
    ) {
      const levels = this.recent
        .map((sample) => sample.level)
        .sort((a, b) => a - b);
      const low = levels[Math.floor(levels.length * 0.1)];
      const high = levels[Math.floor(levels.length * 0.9)];
      const median = levels[Math.floor(levels.length * 0.5)];
      const mean =
        levels.reduce((sum, value) => sum + value, 0) / levels.length;
      const variation = Math.sqrt(
        levels.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
          levels.length,
      );
      // An air conditioner may start after calibration. Relearn only measured
      // stationary input, never merely because a speaker has talked for a long
      // time. Modulated speech or recent recognized words block this path.
      if (
        median > this.floor &&
        variation <= Math.max(0.0008, mean * 0.055) &&
        high - low <= Math.max(0.002, median * 0.18)
      )
        this.floor = median;
    }
    const onset = Math.max(0.009, this.floor * 1.7, this.floor + 0.007);
    const offset = Math.max(0.006, this.floor * 1.3, this.floor + 0.003);
    const recognizedSpeech = now - this.confirmedAt < 1200 && level >= 0.006;
    if (!this.speaking) {
      if (level >= onset || recognizedSpeech) {
        this.candidateAt ??= now;
        if (recognizedSpeech || now - this.candidateAt >= 140)
          this.speaking = true;
      } else {
        this.candidateAt = null;
        // Unvoiced samples track gradual changes. The stationary-window path
        // above handles later step changes without learning varying speech.
        this.floor +=
          (level - this.floor) * (level < this.floor ? 0.12 : 0.025);
      }
    }
    if (this.speaking) {
      if (level >= offset || recognizedSpeech) {
        this.quietAt = null;
        this.lastSpeechAt = now;
      } else {
        this.quietAt ??= now;
        if (now - this.quietAt >= 240) {
          this.speaking = false;
          this.candidateAt = null;
          this.quietAt = null;
        }
      }
    }
    return this.speaking;
  }

  pause() {
    this.speaking = false;
    this.candidateAt = null;
    this.quietAt = null;
    this.recent = [];
    this.confirmedAt = -Infinity;
  }
}
