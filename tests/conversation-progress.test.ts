import test from "node:test";
import assert from "node:assert/strict";
import {
  CONVERSATION_PROGRESS_INSTRUCTION,
  ConversationProgressController,
} from "../apps/sakina/lib/conversation-progress";

type TimerHandle = ReturnType<typeof setTimeout>;

class FakeClock {
  time = 0;
  nextId = 0;
  timers = new Map<number, { at: number; callback: () => void }>();

  setTimer = (callback: () => void, delayMs: number) => {
    const id = ++this.nextId;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id as unknown as TimerHandle;
  };

  clearTimer = (timer: TimerHandle) => {
    this.timers.delete(timer as unknown as number);
  };

  advance(milliseconds: number) {
    const end = this.time + milliseconds;
    for (;;) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = end;
  }
}

const concern = "أشعر بضغط كبير من مسؤوليات العمل والأسرة هذه الأيام";
const response =
  "أفهم أن المسؤوليات تراكمت عليك وأنك تحاول الموازنة بين العمل والأسرة مع قلة الوقت المتاح للراحة";

function setup(send?: (event: Record<string, unknown>) => void) {
  const clock = new FakeClock();
  const events: Record<string, unknown>[] = [];
  let eligible = true;
  const controller = new ConversationProgressController({
    now: () => clock.time,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    isEligible: () => eligible,
    send: (event) => {
      events.push(event);
      send?.(event);
    },
  });
  return {
    controller,
    clock,
    events,
    setEligible(value: boolean) {
      eligible = value;
    },
  };
}

test("caller silence and greeting never stand in for an assistant response", () => {
  const { controller, clock, events } = setup();
  controller.observeAssistantTranscript(response);
  controller.observeCallerTranscript(concern);
  clock.advance(60_000);
  assert.equal(events.length, 0);
  assert.equal(clock.timers.size, 0);

  controller.observeAssistantTranscript("أنا أستمع إليك");
  clock.advance(60_000);
  assert.equal(events.length, 0);
});

test("requires substantive caller letters and fifty assistant letters", () => {
  const { controller, clock, events } = setup();
  controller.observeCallerTranscript("أهلًا");
  controller.observeAssistantTranscript(response);
  clock.advance(60_000);
  assert.equal(events.length, 0);

  controller.observeCallerTranscript("ا".repeat(16));
  controller.observeAssistantTranscript("ب".repeat(49));
  clock.advance(10_000);
  assert.equal(events.length, 0);
  controller.observeAssistantTranscript("ب");
  clock.advance(0);
  assert.equal(events.length, 1);
});

test("steers once after ten seconds even while the assistant continues talking", () => {
  const { controller, clock, events } = setup();
  controller.observeCallerTranscript(concern);
  clock.advance(2_000);
  controller.observeAssistantTranscript(response);
  clock.advance(9_999);
  controller.observeAssistantTranscript(response);
  assert.equal(events.length, 0);
  clock.advance(1);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    type: "session.instructions.append",
    event_id: events[0].event_id,
    delegation_id: null,
    content: CONVERSATION_PROGRESS_INSTRUCTION,
  });
  assert.match(String(events[0].event_id), /^[a-f0-9-]{36}$/);
  assert.match(String(events[0].content), /إن كان المستخدم/);
  assert.match(String(events[0].content), /ليس إذنًا بالتشغيل/);
  assert.match(String(events[0].content), /موافقة جديدة/);

  controller.observeCallerTranscript(concern);
  controller.observeAssistantTranscript(response);
  controller.backendStarted();
  controller.revalidate();
  clock.advance(60_000);
  assert.equal(events.length, 1);
  assert.equal(clock.timers.size, 0);
});

test("new caller activity cancels the old response and requires a fresh response", () => {
  const { controller, clock, events } = setup();
  controller.observeCallerTranscript(concern);
  controller.observeAssistantTranscript(response);
  clock.advance(9_000);
  controller.observeCallerTranscript("ولدي تفاصيل أخرى أود أن أحكيها");
  clock.advance(60_000);
  assert.equal(events.length, 0);
  assert.equal(clock.timers.size, 0);

  controller.observeAssistantTranscript(response);
  clock.advance(9_999);
  assert.equal(events.length, 0);
  clock.advance(1);
  assert.equal(events.length, 1);
});

test("never steers during recent caller input even if the assistant is still talking", () => {
  const { controller, clock, events } = setup();
  controller.observeCallerTranscript(concern);
  controller.observeAssistantTranscript(response);
  clock.advance(9_000);
  controller.observeCallerTranscript("انتظر");
  controller.observeAssistantTranscript(response);
  clock.advance(3_999);
  assert.equal(events.length, 0);
  controller.observeCallerTranscript("لم أكمل بعد");
  clock.advance(20_000);
  assert.equal(events.length, 0);
});

test("native backend work cancels an attempt without using the lifetime reminder", () => {
  const { controller, clock, events } = setup();
  controller.observeCallerTranscript(concern);
  controller.observeAssistantTranscript(response);
  clock.advance(9_000);
  controller.backendStarted();
  controller.observeAssistantTranscript(response);
  clock.advance(20_000);
  assert.equal(events.length, 0);
  assert.equal(clock.timers.size, 0);

  controller.observeCallerTranscript(concern);
  controller.observeAssistantTranscript(response);
  clock.advance(10_000);
  assert.equal(events.length, 1);
});

test("eligibility changes cancel scheduled steering and discard stale evidence", () => {
  for (const explicitRevalidation of [false, true]) {
    const { controller, clock, events, setEligible } = setup();
    controller.observeCallerTranscript(concern);
    controller.observeAssistantTranscript(response);
    setEligible(false);
    if (explicitRevalidation) {
      controller.revalidate();
      assert.equal(clock.timers.size, 0);
    }
    clock.advance(10_000);
    assert.equal(events.length, 0);

    setEligible(true);
    controller.revalidate();
    controller.observeAssistantTranscript(response);
    clock.advance(20_000);
    assert.equal(events.length, 0);
    controller.observeCallerTranscript(concern);
    controller.observeAssistantTranscript(response);
    clock.advance(10_000);
    assert.equal(events.length, 1);
  }
});

test("close clears timers and later callbacks cannot revive steering", () => {
  const { controller, clock, events } = setup();
  controller.observeCallerTranscript(concern);
  controller.observeAssistantTranscript(response);
  assert.equal(clock.timers.size, 1);
  const staleCallback = [...clock.timers.values()][0].callback;
  controller.close();
  assert.equal(clock.timers.size, 0);
  clock.advance(60_000);
  staleCallback();
  controller.observeCallerTranscript(concern);
  controller.observeAssistantTranscript(response);
  controller.revalidate();
  assert.equal(events.length, 0);
});

test("a rejected optional instruction never retries or escapes the timer", () => {
  const { controller, clock, events } = setup(() => {
    throw new Error("send rejected");
  });
  controller.observeCallerTranscript(concern);
  controller.observeAssistantTranscript(response);
  assert.doesNotThrow(() => clock.advance(10_000));
  controller.observeCallerTranscript(concern);
  controller.observeAssistantTranscript(response);
  clock.advance(60_000);
  assert.equal(events.length, 1);
});

test("consumes only its own optional instruction acknowledgments and async errors", () => {
  const { controller, clock, events } = setup();
  assert.equal(
    controller.consumeProviderEvent({ type: "session.instructions.appended" }),
    false,
  );
  controller.observeCallerTranscript(concern);
  controller.observeAssistantTranscript(response);
  clock.advance(10_000);
  const eventId = events[0].event_id;
  assert.equal(
    controller.consumeProviderEvent({
      type: "session.instructions.appended",
      client_event_id: eventId,
    }),
    true,
  );
  assert.equal(
    controller.consumeProviderEvent({
      type: "error",
      error: { client_event_id: eventId, message: "optional append rejected" },
    }),
    true,
  );
  for (const event of [
    { type: "session.instructions.appended", client_event_id: "unrelated" },
    { type: "error", error: { client_event_id: "unrelated" } },
    { type: "error", client_event_id: eventId },
    { type: "error", error: null },
    { type: "error", error: "unavailable" },
    { type: "session.commentary.appended", client_event_id: eventId },
  ]) {
    assert.equal(controller.consumeProviderEvent(event), false);
  }
  controller.observeCallerTranscript(concern);
  controller.observeAssistantTranscript(response);
  controller.backendStarted();
  controller.revalidate();
  clock.advance(60_000);
  assert.equal(events.length, 1);
  assert.equal(clock.timers.size, 0);
  controller.close();
  assert.equal(
    controller.consumeProviderEvent({
      type: "session.instructions.appended",
      client_event_id: eventId,
    }),
    false,
  );
});

test("an eligibility callback failure fails closed", () => {
  const events: Record<string, unknown>[] = [];
  const controller = new ConversationProgressController({
    isEligible: () => {
      throw new Error("state unavailable");
    },
    send: (event) => events.push(event),
  });
  assert.doesNotThrow(() => {
    controller.observeCallerTranscript(concern);
    controller.observeAssistantTranscript(response);
    controller.revalidate();
    controller.close();
  });
  assert.equal(events.length, 0);
});
