import { randomUUID } from "node:crypto";

type TimerHandle = ReturnType<typeof setTimeout>;

type ConversationProgressOptions = {
  isEligible: () => boolean;
  send: (event: Record<string, unknown>) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

export const CONVERSATION_PROGRESS_INSTRUCTION =
  "اختصر الرد الحالي. إن كان المستخدم قد أتمّ وصفًا واضحًا لمشكلة عادية ولم تُبحث بعد، فوّض الخلفية الآن إلى search_quran ثم prepare_relevant_recitation للتحقق من الصلة. إن كان لا يزال يحكي فاستمع؛ وإن كان المعنى أو الأمان غير واضح فاسأل التوضيح الضروري أو قدّم الدعم المناسب. هذا بحث فقط، وليس إذنًا بالتشغيل؛ لا تلاوة دون عرض موثّق وموافقة جديدة.";

const MIN_CALLER_LETTERS = 20;
const MIN_ASSISTANT_LETTERS = 50;
const CALLER_QUIET_MS = 4_000;
const ASSISTANT_RESPONSE_MS = 10_000;

function letterCount(text: string) {
  return text.match(/\p{L}/gu)?.length ?? 0;
}

/**
 * One conditional reminder can recover a missed initial delegation. Silence
 * alone never starts it: a substantive caller description and an actual
 * assistant response are both required. It grants no playback permission.
 */
export class ConversationProgressController {
  private readonly now: () => number;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private callerLetters = 0;
  private assistantLetters = 0;
  private lastCallerAt?: number;
  private assistantStartedAt?: number;
  private timer?: TimerHandle;
  private authoredEventId?: string;
  private steered = false;
  private closed = false;

  constructor(private readonly options: ConversationProgressOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  observeCallerTranscript(delta: string) {
    if (this.closed || this.steered || !/[\p{L}\p{N}]/u.test(delta)) return;
    if (!this.isEligible()) {
      this.resetAttempt();
      return;
    }
    this.callerLetters = Math.min(
      MIN_CALLER_LETTERS,
      this.callerLetters + letterCount(delta),
    );
    this.lastCallerAt = this.now();
    // An interruption can be a correction or an unfinished thought. Require a
    // new assistant response instead of reusing speech from before it.
    this.assistantLetters = 0;
    this.assistantStartedAt = undefined;
    this.cancelTimer();
  }

  observeAssistantTranscript(delta: string) {
    if (this.closed || this.steered) return;
    if (!this.isEligible()) {
      this.resetAttempt();
      return;
    }
    const letters = letterCount(delta);
    if (!letters || this.callerLetters < MIN_CALLER_LETTERS) return;
    this.assistantStartedAt ??= this.now();
    this.assistantLetters = Math.min(
      MIN_ASSISTANT_LETTERS,
      this.assistantLetters + letters,
    );
    this.schedule();
  }

  /** Native delegation wins; later caller input may start a fresh attempt. */
  backendStarted() {
    this.resetAttempt();
  }

  revalidate() {
    if (this.closed || this.steered || !this.isEligible()) {
      this.resetAttempt();
      return;
    }
    this.schedule();
  }

  /** Optional steering failures must not reset otherwise healthy call audio. */
  consumeProviderEvent(event: Record<string, unknown>) {
    const eventId =
      event.type === "session.instructions.appended"
        ? event.client_event_id
        : event.type === "error" &&
            event.error &&
            typeof event.error === "object" &&
            "client_event_id" in event.error
          ? event.error.client_event_id
          : undefined;
    return typeof eventId === "string" && eventId === this.authoredEventId;
  }

  close() {
    this.closed = true;
    this.resetAttempt();
    this.authoredEventId = undefined;
  }

  private isEligible() {
    try {
      return this.options.isEligible();
    } catch {
      return false;
    }
  }

  private cancelTimer() {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private resetAttempt() {
    this.cancelTimer();
    this.callerLetters = 0;
    this.assistantLetters = 0;
    this.lastCallerAt = undefined;
    this.assistantStartedAt = undefined;
  }

  private schedule() {
    if (
      this.closed ||
      this.steered ||
      this.callerLetters < MIN_CALLER_LETTERS ||
      this.assistantLetters < MIN_ASSISTANT_LETTERS ||
      this.lastCallerAt === undefined ||
      this.assistantStartedAt === undefined
    )
      return;
    this.cancelTimer();
    const dueAt = Math.max(
      this.lastCallerAt + CALLER_QUIET_MS,
      this.assistantStartedAt + ASSISTANT_RESPONSE_MS,
    );
    this.timer = this.setTimer(
      () => {
        this.timer = undefined;
        this.steerIfNeeded();
      },
      Math.max(0, dueAt - this.now()),
    );
  }

  private steerIfNeeded() {
    if (this.closed || this.steered || !this.isEligible()) {
      this.resetAttempt();
      return;
    }
    if (
      this.lastCallerAt === undefined ||
      this.assistantStartedAt === undefined ||
      this.callerLetters < MIN_CALLER_LETTERS ||
      this.assistantLetters < MIN_ASSISTANT_LETTERS
    )
      return;
    if (
      this.now() < this.lastCallerAt + CALLER_QUIET_MS ||
      this.now() < this.assistantStartedAt + ASSISTANT_RESPONSE_MS
    ) {
      this.schedule();
      return;
    }
    // Consume before sending: a rejected optional instruction must not retry.
    this.steered = true;
    this.resetAttempt();
    this.authoredEventId = randomUUID();
    try {
      this.options.send({
        type: "session.instructions.append",
        event_id: this.authoredEventId,
        delegation_id: null,
        content: CONVERSATION_PROGRESS_INSTRUCTION,
      });
    } catch {
      // Keep the live conversation available if optional steering fails.
    }
  }
}
