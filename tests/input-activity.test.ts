import test from "node:test";
import assert from "node:assert/strict";
import { InputActivity } from "../apps/sakina/app/components/input-activity";

function samples(
  detector: InputActivity,
  level: number,
  start: number,
  duration: number,
) {
  let active = false;
  for (let time = start; time <= start + duration; time += 100)
    active = detector.sample(level, time);
  return active;
}

test("constant 0.025 background remains quiet before and after a real interruption", () => {
  const detector = new InputActivity();
  assert.equal(samples(detector, 0.025, 0, 2000), false);
  assert.equal(detector.lastSpeechAt, -Infinity);
  assert.equal(samples(detector, 0.1, 2100, 600), true);
  const lastSpeech = detector.lastSpeechAt;
  assert.equal(samples(detector, 0.025, 2800, 2000), false);
  assert.equal(detector.lastSpeechAt, lastSpeech);
  assert.ok(4800 - detector.lastSpeechAt >= 900);
});

test("soft speech below the old fixed 0.055 threshold is detected in a quiet room", () => {
  const detector = new InputActivity();
  samples(detector, 0.002, 0, 1500);
  assert.equal(samples(detector, 0.018, 1600, 400), true);
  assert.equal(samples(detector, 0.002, 2100, 500), false);
});

test("one brief spike is ignored and sustained varying speech is not learned as noise", () => {
  const detector = new InputActivity();
  samples(detector, 0.005, 0, 1000);
  assert.equal(detector.sample(0.2, 1100), false);
  assert.equal(detector.sample(0.005, 1200), false);
  assert.equal(detector.lastSpeechAt, -Infinity);
  const speech = [0.035, 0.09, 0.065, 0.12, 0.07, 0.1, 0.04];
  for (let time = 1300; time <= 11300; time += 100) {
    const active = detector.sample(speech[(time / 100) % speech.length], time);
    if (time >= 1500) assert.equal(active, true);
  }
  assert.equal(detector.lastSpeechAt, 11300);
});

test("muting preserves the learned floor without preserving active speech", () => {
  const detector = new InputActivity();
  samples(detector, 0.025, 0, 1000);
  samples(detector, 0.1, 1100, 400);
  detector.pause();
  assert.equal(samples(detector, 0.025, 10000, 500), false);
  assert.equal(samples(detector, 0.07, 10600, 400), true);
});

test("steady noise beginning after quiet startup cannot hold recovery indefinitely", () => {
  const detector = new InputActivity();
  samples(detector, 0.002, 0, 1500);
  assert.equal(samples(detector, 0.025, 1600, 400), true);
  assert.equal(samples(detector, 0.025, 2100, 29500), false);
  assert.ok(31600 - detector.lastSpeechAt >= 900);
  // A second step in ambient noise must also be learned without restarting.
  assert.equal(samples(detector, 0.05, 31700, 5000), false);
  assert.ok(36700 - detector.lastSpeechAt >= 900);
  assert.equal(samples(detector, 0.12, 36800, 500), true);
});

test("varying speech over new ambient noise is never quieted by elapsed duration", () => {
  const detector = new InputActivity();
  samples(detector, 0.002, 0, 1500);
  const speech = [0.045, 0.075, 0.055, 0.12, 0.06, 0.085, 0.11];
  for (let time = 1600; time <= 31600; time += 100) {
    const active = detector.sample(speech[(time / 100) % speech.length], time);
    if (time >= 1800) assert.equal(active, true);
  }
  assert.equal(detector.lastSpeechAt, 31600);
  assert.equal(samples(detector, 0.025, 31700, 5000), false);
});

test("recognized soft speech at startup overrides its learned amplitude floor", () => {
  const detector = new InputActivity();
  samples(detector, 0.018, 0, 500);
  for (let time = 600; time <= 10600; time += 100) {
    if (time % 500 === 100) detector.confirmSpeech(time);
    assert.equal(detector.sample(0.018, time), true);
  }
  assert.equal(detector.lastSpeechAt, 10600);
  assert.equal(samples(detector, 0.002, 10700, 1500), false);
});

test("a transcript received during quiet input cannot create speech activity", () => {
  const detector = new InputActivity();
  samples(detector, 0.002, 0, 1500);
  detector.confirmSpeech(5000);
  assert.equal(detector.sample(0.002, 5100), false);
  assert.equal(detector.lastSpeechAt, -Infinity);
  assert.equal(samples(detector, 0.002, 5200, 2000), false);
});
