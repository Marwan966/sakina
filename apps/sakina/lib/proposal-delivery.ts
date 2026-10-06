import { randomUUID } from "node:crypto";
import { hasQuranPrefix, isQuranRecitation } from "./quran-speech-guard";

export type ProposalDeliverySnapshot = Readonly<{
  proposalId: string;
  inputRevision: number;
  delegationId: string;
  chapterName: string;
  reference: string;
  reciter: string;
  connection: string;
  expiresAt: number;
}>;

type DeliveryEvent = Readonly<{
  type: "session.commentary.append";
  event_id: string;
  delegation_id: null;
  content: string;
}>;

type TimerHandle = ReturnType<typeof setTimeout>;

type ProposalDeliveryOptions = {
  isCurrent: (snapshot: ProposalDeliverySnapshot) => boolean;
  send: (event: DeliveryEvent) => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  initialGraceMs?: number;
  quietMs?: number;
};

type PendingDelivery = {
  snapshot: ProposalDeliverySnapshot;
  assistantTranscript: string;
  armedAt: number;
  lastMeaningfulActivityAt: number;
  backendSettledAt?: number;
  backendResponseId?: string;
};

function normalizeArabic(text: string) {
  return text
    .normalize("NFKC")
    .replace(/[\p{M}\u0640]/gu, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsPhrase(text: string, phrase: string) {
  return ` ${text} `.includes(` ${phrase} `);
}

/** A chapter mention plus a direct invitation to listen is evidence of a native offer. */
export function assistantSpokeProposal(
  transcript: string,
  chapterName: string,
) {
  const text = normalizeArabic(transcript);
  const chapter = normalizeArabic(chapterName);
  if (!text || !chapter || !containsPhrase(text, chapter)) return false;
  return [
    /هل\s+(?:(?:تحب|ترغب|تود)\s+(?:(?:في|ان)\s+)?)?(?:تسمع|تستمع|نسمع|نستمع|سماع|الاستماع|نبدا\s+(?:الاستماع|بالاستماع|سماع))/,
    /(?:اتحب|اترغب|اتود)\s+(?:ان\s+)?(?:تسمع|تستمع|نسمع|نستمع|سماع|الاستماع)/,
    /هل\s+(?:نبدا|نبدأ)\s+(?:الاستماع|بالاستماع|سماع)/,
    /(?:ما\s+رايك|اذا\s+اردت|ان\s+شئت)\s+(?:ان\s+)?(?:تسمع|تستمع|نسمع|نستمع)/,
    /(?:يمكنني|بامكاني)\s+(?:ان\s+)?(?:اشغل|تشغيل)/,
    /هل\s+(?:اشغل|نشغل)\s+(?:لك\s+)?(?:التسجيل|التلاوه|المقطع|السوره|الايه)/,
  ].some((pattern) => pattern.test(text));
}

/** A narrow abstention detector; ordinary empathy such as "أنا أسمعك" is not refusal. */
export function assistantRefusedProposal(transcript: string) {
  const text = normalizeArabic(transcript);
  return [
    /(?:لن|لا)\s+(?:اقترح|اعرض)\s+(?:تلاوه|تسجيل|مقطع|ايه|سوره)/,
    /(?:لا\s+توجد|لم\s+اجد)\s+(?:صله|تلاوه|مقطع|ايه)\s+مناسب/,
    /(?:ساكتفي|اكتفي)\s+(?:بالاستماع|بان\s+اسمعك)/,
  ].some((pattern) => pattern.test(text));
}

/** Output audio contains silent PCM frames; only real signal extends the quiet window. */
export function hasMeaningfulPcm16(base64: string) {
  let pcm: Buffer;
  try {
    pcm = Buffer.from(base64, "base64");
  } catch {
    return false;
  }
  if (pcm.length < 2 || pcm.length % 2 !== 0) return false;
  let peak = 0;
  let absoluteTotal = 0;
  const samples = pcm.length / 2;
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const absolute = Math.abs(pcm.readInt16LE(offset));
    if (absolute > peak) peak = absolute;
    absoluteTotal += absolute;
  }
  return peak >= 256 && absoluteTotal / samples >= 24;
}

/**
 * Build a short source-specific invitation. A connection that overlaps Quran
 * source text is omitted so this fallback can never ask GPT-Live to recite it.
 */
export function proposalDeliveryCommentary(snapshot: ProposalDeliverySnapshot) {
  const connection = snapshot.connection.replace(/\s+/g, " ").trim();
  const safeConnection =
    connection && !isQuranRecitation(connection) && !hasQuranPrefix(connection)
      ? ` صلته بما وصفته: ${connection}.`
      : "";
  return `أقترح مقطعًا من سورة ${snapshot.chapterName} (${snapshot.reference}) بصوت القارئ ${snapshot.reciter}.${safeConnection} هل نبدأ الاستماع؟`;
}

/**
 * Owns one optional spoken delivery for each accepted proposal. It never plays
 * audio, calls another model, or retries a rejected commentary append.
 */
export class ProposalDeliveryController {
  private readonly now: () => number;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => TimerHandle;
  private readonly clearTimer: (timer: TimerHandle) => void;
  private readonly initialGraceMs: number;
  private readonly quietMs: number;
  private readonly handledProposalIds = new Set<string>();
  private readonly authoredEventIds = new Set<string>();
  private pending?: PendingDelivery;
  private timer?: TimerHandle;
  private closed = false;

  constructor(private readonly options: ProposalDeliveryOptions) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.initialGraceMs = Math.max(0, options.initialGraceMs ?? 2_500);
    this.quietMs = Math.max(0, options.quietMs ?? 1_200);
  }

  arm(snapshot: ProposalDeliverySnapshot) {
    if (this.closed || this.handledProposalIds.has(snapshot.proposalId)) return;
    this.cancelPending(false);
    const now = this.now();
    this.pending = {
      snapshot,
      assistantTranscript: "",
      armedAt: now,
      lastMeaningfulActivityAt: now,
    };
  }

  observeAssistantTranscript(delta: string) {
    const pending = this.pending;
    if (!pending || !delta.trim()) return;
    pending.assistantTranscript = (pending.assistantTranscript + delta).slice(
      -4_000,
    );
    pending.lastMeaningfulActivityAt = this.now();
    if (
      assistantSpokeProposal(
        pending.assistantTranscript,
        pending.snapshot.chapterName,
      ) ||
      assistantRefusedProposal(pending.assistantTranscript)
    ) {
      this.cancelPending(true);
      return;
    }
    this.schedule();
  }

  observeCallerTranscript(delta: string) {
    if (delta.trim()) this.cancelPending(true);
  }

  observeOutputAudio(base64: string) {
    if (!this.pending || !hasMeaningfulPcm16(base64)) return;
    this.pending.lastMeaningfulActivityAt = this.now();
    this.schedule();
  }

  backendCompleted(delegationId: string, responseId: string) {
    const pending = this.pending;
    if (
      !pending ||
      pending.snapshot.delegationId !== delegationId ||
      pending.backendSettledAt !== undefined
    )
      return;
    pending.backendSettledAt = this.now();
    pending.backendResponseId = responseId;
    this.schedule();
  }

  /** Cancel if safety, refusal, playback, expiry, or another state change won. */
  revalidate() {
    if (!this.pending) return;
    if (
      this.now() >= this.pending.snapshot.expiresAt ||
      !this.isCurrent(this.pending.snapshot)
    )
      this.cancelPending(true);
  }

  reset() {
    this.cancelPending(true);
  }

  backendFailed(delegationId: string) {
    if (this.pending?.snapshot.delegationId === delegationId)
      this.cancelPending(true);
  }

  /** ACK is delivery metadata, not proof that the commentary was spoken. */
  consumeProviderEvent(event: Record<string, any>) {
    const eventId =
      event.type === "session.commentary.appended"
        ? event.client_event_id
        : event.type === "error"
          ? event.error?.client_event_id
          : undefined;
    return typeof eventId === "string" && this.authoredEventIds.has(eventId);
  }

  close() {
    this.closed = true;
    this.cancelPending(false);
    this.authoredEventIds.clear();
  }

  private isCurrent(snapshot: ProposalDeliverySnapshot) {
    try {
      return this.options.isCurrent(snapshot);
    } catch {
      return false;
    }
  }

  private cancelPending(markHandled: boolean) {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (markHandled && this.pending)
      this.handledProposalIds.add(this.pending.snapshot.proposalId);
    this.pending = undefined;
  }

  private schedule() {
    const pending = this.pending;
    if (!pending || pending.backendSettledAt === undefined) return;
    if (this.timer) this.clearTimer(this.timer);
    const now = this.now();
    const dueAt = Math.max(
      pending.backendSettledAt + this.initialGraceMs,
      pending.lastMeaningfulActivityAt + this.quietMs,
    );
    this.timer = this.setTimer(
      () => {
        this.timer = undefined;
        this.deliverIfNeeded();
      },
      Math.max(0, dueAt - now),
    );
  }

  private deliverIfNeeded() {
    const pending = this.pending;
    if (!pending || pending.backendSettledAt === undefined || this.closed)
      return;
    const now = this.now();
    if (
      now >= pending.snapshot.expiresAt ||
      !this.isCurrent(pending.snapshot)
    ) {
      this.cancelPending(true);
      return;
    }
    const dueAt = Math.max(
      pending.backendSettledAt + this.initialGraceMs,
      pending.lastMeaningfulActivityAt + this.quietMs,
    );
    if (now < dueAt) {
      this.schedule();
      return;
    }
    if (
      assistantSpokeProposal(
        pending.assistantTranscript,
        pending.snapshot.chapterName,
      ) ||
      assistantRefusedProposal(pending.assistantTranscript)
    ) {
      this.cancelPending(true);
      return;
    }
    const eventId = randomUUID();
    const event: DeliveryEvent = {
      type: "session.commentary.append",
      event_id: eventId,
      delegation_id: null,
      content: proposalDeliveryCommentary(pending.snapshot),
    };
    this.authoredEventIds.add(eventId);
    this.handledProposalIds.add(pending.snapshot.proposalId);
    this.pending = undefined;
    try {
      this.options.send(event);
    } catch {
      // Optional delivery failed closed; do not retry or affect the live call.
    }
  }
}
