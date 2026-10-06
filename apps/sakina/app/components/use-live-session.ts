"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { GuardedAudio } from "./guarded-audio";
import { BoundedRecording, recordingRange } from "./bounded-recording";
import { InputActivity } from "./input-activity";

export type Recitation = {
  id: string;
  title: string;
  surah: number;
  ayahStart: number;
  ayahEnd: number;
  reciter: string;
  audioUrl: string;
  sourceUrl: string;
  meaning: string;
  context: string;
  reference: string;
  fullSurah?: boolean;
  playbackStartSeconds?: number;
  playbackEndSeconds?: number;
  durationSeconds?: number;
  timingSourceUrl?: string;
};
type Phase =
  "idle" | "connecting" | "connected" | "closing" | "ended" | "error";
type ClipState = "loading" | "playing" | "paused" | "error";
type LiveEvent = {
  type: string;
  sessionId?: string;
  sdp?: string;
  expiresAt?: number | string;
  maxDurationSeconds?: number;
  role?: "user" | "assistant";
  delta?: string;
  startMs?: number;
  endMs?: number;
  recitation?: Recitation;
  playbackId?: string;
  error?: string;
  fatal?: boolean;
  reason?: string;
  message?: string;
  urgent?: boolean;
  remainingSeconds?: number;
};
type Connection = {
  id: string;
  peer: RTCPeerConnection;
  channel: RTCDataChannel;
  microphone: MediaStream | null;
  controller: AbortController;
  context: AudioContext;
  guard: GuardedAudio;
  analyser: AnalyserNode | null;
  clip: HTMLAudioElement;
  clipBoundary: BoundedRecording | null;
  clipAbort: AbortController | null;
  ended: boolean;
  voiceEnded: boolean;
  closing: boolean;
  ready: boolean;
  started: boolean;
  greeted: boolean;
  muted: boolean;
  held: boolean;
  currentClip: Recitation | null;
  clipTransition: boolean;
  clipReady: boolean;
  closeTimer: number;
  clipTimer: number;
  startupTimer: number;
  meterTimer: number;
  deadlineTimer: number;
  deadline: number;
  interrupted: boolean;
  recovery: Promise<boolean> | null;
  inputBusy: boolean;
  inputVersion: number;
  inputActivity: InputActivity;
  lastInputEvidenceEndMs: number;
  providerTimeMs: number;
  playedIds: Set<string>;
  lastInputSpeechAt: number;
  needsFreshReply: boolean;
  recoveredAt: number;
  contextHeld: boolean;
  inputWaiters: Map<
    string,
    {
      type: string;
      resolve: () => void;
      reject: (error: Error) => void;
      timer: number;
    }
  >;
};
const GENERIC_ERROR = "تعذّر الاتصال بسكينة الآن. حاول مرة أخرى بعد قليل.";

function microphoneError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError")
      return "اسمح باستخدام الميكروفون من إعدادات هذا الموقع، ثم حاول مرة أخرى.";
    if (error.name === "NotFoundError")
      return "لم نجد ميكروفونًا. وصّل ميكروفونًا ثم حاول مرة أخرى.";
    if (error.name === "NotReadableError")
      return "الميكروفون مشغول أو غير متاح. أغلق التطبيق الذي يستخدمه ثم حاول مجددًا.";
  }
  return error instanceof Error && /[ء-ي]/.test(error.message)
    ? error.message
    : GENERIC_ERROR;
}

async function waitForIce(peer: RTCPeerConnection, signal: AbortSignal) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", changed);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const changed = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const aborted = () => finish(new DOMException("Aborted", "AbortError"));
    const timeout = window.setTimeout(
      () =>
        finish(
          new Error("تعذّر تجهيز الاتصال الصوتي. تحقّق من اتصالك بالإنترنت."),
        ),
      12_000,
    );
    peer.addEventListener("icegatheringstatechange", changed);
    signal.addEventListener("abort", aborted, { once: true });
    changed();
  });
}

function createAudioConnection(
  review: (text: string) => boolean,
  onBlocked: (reason: "scripture" | "alignment") => void,
  possiblePrefix: (text: string) => boolean,
) {
  let context: AudioContext | null = null;
  let peer: RTCPeerConnection | null = null;
  let channel: RTCDataChannel | null = null;
  let guard: GuardedAudio | null = null;
  try {
    context = new AudioContext();
    peer = new RTCPeerConnection();
    channel = peer.createDataChannel("oai-events");
    guard = new GuardedAudio(context, review, onBlocked, possiblePrefix);
    return { context, peer, channel, guard };
  } catch (error) {
    guard?.close();
    channel?.close();
    peer?.close();
    void context?.close().catch(() => {});
    throw error;
  }
}

export function useLiveSession() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [muted, setMuted] = useState(false);
  const [mutePending, setMutePending] = useState(false);
  const [remaining, setRemaining] = useState(240);
  const [activity, setActivity] = useState<"quiet" | "user" | "assistant">(
    "quiet",
  );
  const [level, setLevel] = useState(0);
  const [recitation, setRecitation] = useState<Recitation | null>(null);
  const [clipState, setClipState] = useState<ClipState>("loading");
  const [clipReady, setClipReady] = useState(false);
  const [clipProgress, setClipProgress] = useState(0);
  const [audioLocked, setAudioLocked] = useState(false);
  const [voiceEnded, setVoiceEnded] = useState(false);
  const [support, setSupport] = useState<{
    message: string;
    urgent: boolean;
  } | null>(null);
  const connection = useRef<Connection | null>(null);
  const starting = useRef(false);
  const alive = useRef(true);
  const attempt = useRef(0);

  const sendControl = useCallback(
    async (current: Connection, action: string, recitationId?: string) => {
      if (!current.id) return;
      const response = await fetch("/api/live/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: current.id,
          action,
          ...(recitationId ? { recitationId } : {}),
        }),
        signal:
          action === "end"
            ? AbortSignal.timeout(10_000)
            : AbortSignal.any([
                current.controller.signal,
                AbortSignal.timeout(action === "greet" ? 14_000 : 10_000),
              ]),
        keepalive: action === "end",
      });
      if (!response.ok) throw new Error("control_failed");
    },
    [],
  );

  const setInputMuted = useCallback(
    (current: Connection, shouldMute: boolean) => {
      if (
        current.ended ||
        current.voiceEnded ||
        current.closing ||
        current.channel.readyState !== "open"
      )
        return Promise.reject(new Error("input_unavailable"));
      const id = crypto.randomUUID();
      return new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          current.inputWaiters.delete(id);
          reject(new Error("input_ack_timeout"));
        }, 5000);
        current.inputWaiters.set(id, {
          type: shouldMute
            ? "session.input_audio.muted"
            : "session.input_audio.unmuted",
          resolve,
          reject,
          timer,
        });
        try {
          current.channel.send(
            JSON.stringify({
              type: shouldMute
                ? "session.input_audio.mute"
                : "session.input_audio.unmute",
              event_id: id,
            }),
          );
        } catch {
          window.clearTimeout(timer);
          current.inputWaiters.delete(id);
          reject(new Error("input_send_failed"));
        }
      });
    },
    [],
  );

  const cleanup = useCallback((current: Connection) => {
    if (current.ended) return;
    current.ended = true;
    current.closing = true;
    current.clipReady = false;
    for (const waiter of current.inputWaiters.values()) {
      window.clearTimeout(waiter.timer);
      waiter.reject(new Error("session_closed"));
    }
    current.inputWaiters.clear();
    window.clearTimeout(current.closeTimer);
    window.clearTimeout(current.clipTimer);
    window.clearTimeout(current.startupTimer);
    window.clearTimeout(current.deadlineTimer);
    window.clearInterval(current.meterTimer);
    current.microphone?.getTracks().forEach((track) => track.stop());
    current.clipAbort?.abort();
    current.clipBoundary?.close();
    current.clip.pause();
    current.clip.removeAttribute("src");
    current.clip.load();
    current.clip.onended =
      current.clip.onerror =
      current.clip.onplaying =
      current.clip.ontimeupdate =
        null;
    current.guard.close();
    current.channel.onmessage =
      current.channel.onclose =
      current.channel.onerror =
        null;
    current.channel.close();
    current.peer.ontrack = current.peer.onconnectionstatechange = null;
    current.peer.close();
    current.controller.abort();
    void current.context.close().catch(() => {});
    const owned = connection.current === current;
    if (owned) {
      connection.current = null;
      starting.current = false;
    }
    if (alive.current && owned) {
      setLevel(0);
      setActivity("quiet");
      setRecitation(null);
      setAudioLocked(false);
      setMutePending(false);
      setClipReady(false);
      setVoiceEnded(false);
    }
  }, []);

  const fail = useCallback(
    (current: Connection, message: string) => {
      if (
        current.ended ||
        current.voiceEnded ||
        current.closing ||
        connection.current !== current
      )
        return;
      void sendControl(current, "end").catch(() => {});
      cleanup(current);
      if (alive.current) {
        setError(message);
        setPhase("error");
      }
    },
    [cleanup, sendControl],
  );

  // A reset supersedes a guard hold, not the conversation. Share one recovery
  // loop across interruption/reset/recitation exit and follow the latest hold.
  const recoverOutput = useCallback((current: Connection) => {
    if (current.recovery) return current.recovery;
    const ownsRecovery = () =>
      connection.current === current &&
      !current.ended &&
      !current.voiceEnded &&
      !current.closing &&
      (!current.held || current.clipTransition);
    const recovery = (async () => {
      while (ownsRecovery()) {
        const resumed = await current.guard.resume(
          () => performance.now() - current.lastInputSpeechAt >= 900,
        );
        if (!ownsRecovery()) return false;
        if (resumed) {
          current.recoveredAt = performance.now();
          return true;
        }
      }
      return false;
    })();
    current.recovery = recovery;
    void recovery
      .finally(() => {
        if (current.recovery === recovery) {
          current.recovery = null;
          current.interrupted = false;
        }
      })
      .catch(() => {});
    return recovery;
  }, []);

  const end = useCallback(() => {
    attempt.current += 1;
    const current = connection.current;
    if (!current) {
      starting.current = false;
      setPhase("ended");
      return;
    }
    if (current.ended || current.closing) return;
    if (current.voiceEnded) {
      cleanup(current);
      setNotice("");
      setPhase("ended");
      return;
    }
    setPhase("closing");
    current.closing = true;
    current.held = true;
    current.clipTransition = true;
    // Cancel pending ordinary controls (including a delayed return cue) as
    // soon as this call ends. Its explicit close request owns a separate signal.
    current.controller.abort();
    current.clipReady = false;
    setClipReady(false);
    current.microphone?.getTracks().forEach((track) => track.stop());
    current.guard.hold();
    current.clipAbort?.abort();
    current.clipBoundary?.cancel();
    current.clip.pause();
    try {
      if (current.channel.readyState === "open" && current.started)
        current.channel.send(JSON.stringify({ type: "session.close" }));
    } catch {
      // The transport may close between the state check and send. The server
      // control and local deadline must still release the microphone.
    }
    void sendControl(current, "end").catch(() => {});
    current.closeTimer = window.setTimeout(() => {
      cleanup(current);
      if (alive.current) setPhase("ended");
    }, 1800);
  }, [cleanup, sendControl]);

  const expireVoice = useCallback(
    (current: Connection, expired = true) => {
      if (
        connection.current !== current ||
        current.ended ||
        current.voiceEnded ||
        current.closing
      )
        return;
      if (!current.currentClip || current.clipTransition) {
        end();
        return;
      }
      // The paid conversation and microphone have a hard deadline. The original
      // recording is independent: keep its context/element and controls alive.
      current.voiceEnded = true;
      current.needsFreshReply = false;
      current.inputVersion++;
      current.inputBusy = false;
      current.context.onstatechange = () => {
        if (connection.current === current && !current.ended)
          setAudioLocked(current.context.state !== "running");
      };
      for (const waiter of current.inputWaiters.values()) {
        window.clearTimeout(waiter.timer);
        waiter.reject(new Error("voice_expired"));
      }
      current.inputWaiters.clear();
      window.clearTimeout(current.startupTimer);
      window.clearTimeout(current.deadlineTimer);
      window.clearInterval(current.meterTimer);
      current.microphone?.getTracks().forEach((track) => track.stop());
      current.guard.close();
      current.channel.onmessage =
        current.channel.onclose =
        current.channel.onerror =
          null;
      current.peer.ontrack = current.peer.onconnectionstatechange = null;
      try {
        if (current.channel.readyState === "open" && current.started)
          current.channel.send(JSON.stringify({ type: "session.close" }));
      } catch {
        /* The provider may already have finalized its deadline. */
      }
      void sendControl(current, "end").catch(() => {});
      current.channel.close();
      current.peer.close();
      current.controller.abort();
      starting.current = false;
      setVoiceEnded(true);
      setRemaining(0);
      setActivity("quiet");
      setLevel(0);
      setMutePending(false);
      setPhase("ended");
      setNotice(
        expired
          ? "انتهى وقت الحديث وأُغلق الميكروفون. يمكنك إكمال التلاوة أو إيقافها."
          : "انتهى الاتصال الصوتي وأُغلق الميكروفون. يمكنك إكمال التلاوة أو إيقافها.",
      );
    },
    [end, sendControl],
  );

  const completeClip = useCallback(
    async (action: "recitation_ended" | "recitation_skipped") => {
      const current = connection.current;
      if (
        !current ||
        !current.currentClip ||
        current.ended ||
        current.closing ||
        current.clipTransition
      )
        return;
      if (current.voiceEnded) {
        cleanup(current);
        setPhase("ended");
        setNotice(
          action === "recitation_ended"
            ? "انتهت التلاوة. يمكنك بدء حديث جديد متى أحببت."
            : "انتهت التلاوة وأُغلق الميكروفون.",
        );
        return;
      }
      const selected = current.currentClip;
      current.clipTransition = true;
      current.clipReady = false;
      setClipReady(false);
      window.clearTimeout(current.clipTimer);
      current.clipAbort?.abort();
      current.clipBoundary?.cancel();
      current.clip.pause();
      current.clip.removeAttribute("src");
      current.clip.load();
      setRecitation(null);
      setNotice("نعود إلى حديثنا…");
      try {
        const resumed = await recoverOutput(current);
        if (current.ended || current.closing || connection.current !== current)
          return;
        if (!resumed) return;
        if (!current.muted) {
          try {
            await setInputMuted(current, false);
          } catch (error) {
            // A missing ACK can be transient. Retry this idempotent unmute
            // once in the same call, with a fresh command ID and its own ACK.
            // Rejections, supersession and connection loss remain failures.
            if (
              !(error instanceof Error) ||
              error.message !== "input_ack_timeout" ||
              connection.current !== current ||
              current.ended ||
              current.voiceEnded ||
              current.closing ||
              current.muted ||
              current.currentClip !== selected ||
              !current.clipTransition ||
              current.channel.readyState !== "open"
            )
              throw error;
            await setInputMuted(current, false);
          }
        }
        if (current.ended || current.closing || connection.current !== current)
          return;
        // A reset can also arrive during the microphone ACK. Finish its owned
        // recovery before asking the provider to speak after the recording.
        if (current.recovery && !(await current.recovery)) return;
        if (current.ended || current.closing || connection.current !== current)
          return;
        // Original playback has stopped, the guard recovered, and the provider
        // accepted input again. Let the caller resume during the return cue's
        // grace; keep clipTransition/currentClip until its lifecycle ACK so a
        // second recording cannot overlap this handoff.
        current.held = false;
        current.microphone?.getAudioTracks().forEach((track) => {
          track.enabled = !current.muted;
        });
        await sendControl(current, action, selected.id);
        if (current.ended || current.closing || connection.current !== current)
          return;
        current.currentClip = null;
        current.clipTransition = false;
        setNotice("");
      } catch {
        if (!current.closing)
          fail(
            current,
            "تعذّر استئناف الحديث بعد التلاوة. يمكنك بدء جلسة جديدة.",
          );
      }
    },
    [cleanup, fail, recoverOutput, sendControl, setInputMuted],
  );

  const playClip = useCallback(
    async (current: Connection, selected: Recitation) => {
      if (
        current.ended ||
        current.closing ||
        current.currentClip ||
        current.clipTransition
      )
        return;
      current.held = true;
      current.needsFreshReply = false;
      current.inputVersion++;
      current.inputBusy = false;
      setMutePending(false);
      current.currentClip = selected;
      current.clipReady = false;
      current.clipAbort = new AbortController();
      setClipReady(false);
      const ownsClip = () =>
        connection.current === current &&
        !current.ended &&
        !current.closing &&
        current.currentClip === selected &&
        !current.clipTransition &&
        current.held;
      current.guard.hold();
      current.microphone?.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
      setRecitation(selected);
      setClipState("loading");
      setClipProgress(0);
      setNotice("");
      let range: ReturnType<typeof recordingRange>;
      try {
        range = recordingRange(selected);
        if (range) {
          current.clip.crossOrigin = "anonymous";
          current.clipBoundary ??= new BoundedRecording(
            current.context,
            current.clip,
          );
        } else current.clipBoundary?.fullRecording();
      } catch {
        fail(current, "تعذّر تجهيز مقطع التلاوة. يمكنك بدء جلسة جديدة.");
        return;
      }
      current.clip.src = selected.audioUrl;
      current.clip.preload = range ? "metadata" : "auto";
      current.clip.onplaying = () => {
        window.clearTimeout(current.clipTimer);
        if (ownsClip()) setClipState("playing");
      };
      current.clip.ontimeupdate = () => {
        if (!ownsClip()) return;
        const length = range ? range.end - range.start : current.clip.duration;
        if (Number.isFinite(length) && length > 0)
          setClipProgress(
            Math.max(
              0,
              Math.min(
                1,
                (current.clip.currentTime - (range?.start ?? 0)) / length,
              ),
            ),
          );
      };
      current.clip.onended = () => {
        if (ownsClip() && !range) void completeClip("recitation_ended");
      };
      let errorReported = false;
      const recordingFailed = () => {
        window.clearTimeout(current.clipTimer);
        if (!ownsClip()) return;
        current.clip.pause();
        setClipState("error");
        if (!errorReported && !current.voiceEnded) {
          errorReported = true;
          void sendControl(current, "recitation_failed", selected.id).catch(
            () => {},
          );
        }
      };
      current.clip.onerror = recordingFailed;
      try {
        await setInputMuted(current, true);
        if (!ownsClip()) return;
        if (!current.voiceEnded)
          await sendControl(current, "recitation_started", selected.id);
      } catch {
        if (ownsClip() && !current.voiceEnded)
          fail(current, "تعذّر تجهيز التلاوة. يمكنك بدء جلسة جديدة.");
        if (!current.voiceEnded) return;
      }
      if (!ownsClip()) return;
      if (range) {
        try {
          await current.clipBoundary!.prepare(
            range,
            current.clipAbort.signal,
            () => {
              if (ownsClip()) void completeClip("recitation_ended");
            },
            recordingFailed,
          );
        } catch {
          if (ownsClip()) {
            // ACKs succeeded; retry may seek again, but can never bypass it.
            current.clipReady = true;
            setClipReady(true);
            recordingFailed();
          }
          return;
        }
      }
      if (!ownsClip()) return;
      try {
        current.clipTimer = window.setTimeout(() => {
          if (!ownsClip()) return;
          current.clip.pause();
          setClipState("error");
          if (!current.voiceEnded)
            void sendControl(current, "recitation_failed", selected.id).catch(
              () => {},
            );
        }, 15_000);
        await current.clip.play();
      } catch {
        window.clearTimeout(current.clipTimer);
        if (ownsClip()) setClipState(current.clip.error ? "error" : "paused");
      } finally {
        if (ownsClip()) {
          current.clipReady = true;
          setClipReady(true);
        }
      }
    },
    [completeClip, fail, sendControl, setInputMuted],
  );

  const start = useCallback(async () => {
    if (starting.current || connection.current) return;
    setError("");
    setNotice("");
    setMuted(false);
    setMutePending(false);
    setRecitation(null);
    setAudioLocked(false);
    setVoiceEnded(false);
    setSupport(null);
    setClipReady(false);
    if (
      !window.isSecureContext ||
      !navigator.mediaDevices?.getUserMedia ||
      !window.RTCPeerConnection ||
      !window.AudioContext
    ) {
      setError(
        "المحادثة الصوتية تحتاج متصفحًا حديثًا واتصالًا آمنًا. افتح سكينة في Chrome أو Safari أو Edge المحدّث.",
      );
      setPhase("error");
      return;
    }
    if (!navigator.onLine) {
      setError("أنت غير متصل بالإنترنت. اتصل بالشبكة ثم حاول مرة أخرى.");
      setPhase("error");
      return;
    }
    starting.current = true;
    const version = ++attempt.current;
    setPhase("connecting");
    const controller = new AbortController();
    // The model's original audio remains inaudible until its transcript passes
    // the scripture check. No browser speech synthesizer is used for Quran.
    let speechReview: (text: string) => boolean = () => false;
    let possiblePrefix: (text: string) => boolean = () => true;
    let resources: ReturnType<typeof createAudioConnection>;
    try {
      resources = createAudioConnection(
        (text) => speechReview(text),
        (reason) => {
          const current = connection.current;
          if (
            !current ||
            current.ended ||
            current.closing ||
            attempt.current !== version
          )
            return;
          setNotice(
            reason === "scripture"
              ? "التلاوة بصوت القارئ فقط. يمكنك طلب الاستماع إليها."
              : "لم يصل الصوت بوضوح. خذ لحظة ثم تابع الحديث.",
          );
          void sendControl(current, "speech_blocked").catch(() => {});
        },
        (text) => possiblePrefix(text),
      );
    } catch {
      starting.current = false;
      setError(
        "تعذّر تجهيز الصوت في هذا المتصفح. أغلق التطبيقات الصوتية الأخرى ثم حاول مرة أخرى.",
      );
      setPhase("error");
      return;
    }
    const { context, peer, channel, guard } = resources;
    const current: Connection = {
      id: "",
      peer,
      controller,
      channel,
      context,
      guard,
      microphone: null,
      analyser: null,
      clip: new Audio(),
      clipBoundary: null,
      clipAbort: null,
      ended: false,
      voiceEnded: false,
      closing: false,
      ready: false,
      started: false,
      greeted: false,
      muted: false,
      held: false,
      currentClip: null,
      clipTransition: false,
      clipReady: false,
      closeTimer: 0,
      clipTimer: 0,
      startupTimer: 0,
      meterTimer: 0,
      deadlineTimer: 0,
      deadline: 0,
      interrupted: false,
      recovery: null,
      inputBusy: false,
      inputVersion: 0,
      inputActivity: new InputActivity(),
      lastInputEvidenceEndMs: -Infinity,
      providerTimeMs: 0,
      playedIds: new Set(),
      lastInputSpeechAt: -Infinity,
      needsFreshReply: false,
      recoveredAt: 0,
      contextHeld: false,
      inputWaiters: new Map(),
    };
    connection.current = current;
    void context.resume().catch(() => {
      if (
        alive.current &&
        connection.current === current &&
        !current.ended &&
        !current.closing
      )
        setAudioLocked(true);
    });
    context.onstatechange = () => {
      if (connection.current !== current || current.ended || current.closing)
        return;
      if (context.state !== "running") {
        current.contextHeld = true;
        guard.hold();
      } else if (current.contextHeld) {
        current.contextHeld = false;
        void recoverOutput(current).catch(() => {
          if (
            connection.current === current &&
            !current.ended &&
            !current.closing
          )
            setAudioLocked(true);
        });
      }
      setAudioLocked(context.state !== "running");
    };
    const greet = () => {
      if (
        !current.ready ||
        !current.started ||
        current.greeted ||
        current.ended ||
        current.closing
      )
        return;
      current.greeted = true;
      starting.current = false;
      window.clearTimeout(current.startupTimer);
      setPhase("connected");
      void sendControl(current, "greet").catch(() =>
        fail(current, GENERIC_ERROR),
      );
    };
    const handleEvent = async (event: LiveEvent) => {
      if (current.ended || current.voiceEnded) return;
      const timedEvent =
        typeof event.startMs === "number" &&
        typeof event.endMs === "number" &&
        Number.isFinite(event.startMs) &&
        Number.isFinite(event.endMs) &&
        event.startMs >= 0 &&
        event.endMs >= event.startMs &&
        event.endMs - event.startMs <= 30_000;
      if (event.type === "session" && event.sessionId && event.sdp) {
        current.id = event.sessionId;
        const expiry =
          typeof event.expiresAt === "number"
            ? event.expiresAt
            : Date.parse(event.expiresAt ?? "");
        current.deadline = Number.isFinite(expiry)
          ? expiry
          : Date.now() + (event.maxDurationSeconds ?? 240) * 1000;
        const millisecondsLeft = Math.max(0, current.deadline - Date.now());
        setRemaining(Math.ceil(millisecondsLeft / 1000));
        current.deadlineTimer = window.setTimeout(
          () => expireVoice(current),
          millisecondsLeft,
        );
        await peer.setRemoteDescription({ type: "answer", sdp: event.sdp });
      } else if (event.type === "ready") {
        current.ready = true;
        greet();
      } else if (
        event.type === "transcript" &&
        event.role === "user" &&
        event.delta?.trim() &&
        !current.muted &&
        !current.held
      ) {
        // Live input/output use the provider's session clock. Ignore duplicate,
        // malformed, and old fragments; receive time is not speaking time.
        if (timedEvent && event.endMs! > current.lastInputEvidenceEndMs) {
          current.lastInputEvidenceEndMs = event.endMs!;
          if (event.endMs! >= current.providerTimeMs - 1500)
            current.inputActivity.confirmSpeech(performance.now());
          current.providerTimeMs = Math.max(
            current.providerTimeMs,
            event.endMs!,
          );
        }
      } else if (
        event.type === "transcript" &&
        event.role === "assistant" &&
        typeof event.delta === "string"
      ) {
        if (timedEvent)
          current.providerTimeMs = Math.max(
            current.providerTimeMs,
            event.endMs!,
          );
        guard.transcript(event.delta, event.startMs ?? NaN, event.endMs ?? NaN);
      } else if (event.type === "audio" && typeof event.delta === "string") {
        if (timedEvent)
          current.providerTimeMs = Math.max(
            current.providerTimeMs,
            event.endMs!,
          );
        guard.audio(event.delta, event.startMs ?? NaN, event.endMs ?? NaN);
      } else if (event.type === "audio_reset") {
        guard.hold();
        if (
          event.reason === "provider_error" &&
          (!current.held || current.clipTransition)
        )
          void recoverOutput(current).catch(() =>
            fail(current, "تعذّر استعادة الصوت. يمكنك بدء جلسة جديدة."),
          );
      } else if (event.type === "support" && event.message) {
        setSupport({ message: event.message, urgent: Boolean(event.urgent) });
      } else if (event.type === "ending") {
        setNotice(
          "بقيت نصف دقيقة لهذه الجلسة. يمكنك إنهاء حديثك بهدوء ثم البدء من جديد متى أحببت.",
        );
      } else if (event.type === "recitation" && event.recitation) {
        if (event.playbackId) {
          if (current.playedIds.has(event.playbackId)) return;
          current.playedIds.add(event.playbackId);
        }
        void playClip(current, event.recitation);
      } else if (event.type === "closed") {
        if (current.currentClip && !current.closing) {
          expireVoice(current, event.reason === "expired");
          return;
        }
        cleanup(current);
        if (alive.current) {
          setPhase("ended");
          setNotice(
            event.reason === "expired"
              ? "انتهى وقت هذه الجلسة. يمكنك بدء حديث جديد متى أحببت."
              : "",
          );
        }
      } else if (event.type === "error") {
        if (event.fatal) fail(current, event.error || GENERIC_ERROR);
        else setNotice(event.error || "حدث انقطاع بسيط. يمكنك متابعة الحديث.");
      }
    };
    channel.onmessage = ({ data }) => {
      if (current.ended) return;
      try {
        const event = JSON.parse(data);
        const eventId =
          typeof event.client_event_id === "string"
            ? event.client_event_id
            : event.error?.client_event_id;
        const waiter =
          typeof eventId === "string"
            ? current.inputWaiters.get(eventId)
            : undefined;
        if (waiter && (event.type === waiter.type || event.type === "error")) {
          current.inputWaiters.delete(eventId);
          window.clearTimeout(waiter.timer);
          if (event.type === "error")
            waiter.reject(new Error("input_rejected"));
          else waiter.resolve();
          return;
        }
        if (event.type === "session.started") {
          current.started = true;
          greet();
        } else if (event.type === "session.closed") {
          if (current.currentClip && !current.closing) {
            expireVoice(
              current,
              event.reason === "expired" ||
                Date.now() >= current.deadline - 1000,
            );
            return;
          }
          cleanup(current);
          if (alive.current) setPhase("ended");
        }
      } catch {
        /* Ignore malformed transport events; server remains authoritative. */
      }
    };
    channel.onclose = () => {
      if (current.currentClip && !current.closing) {
        expireVoice(current, Date.now() >= current.deadline - 1000);
        return;
      }
      if (!current.ended)
        fail(current, "انقطع الاتصال الصوتي. يمكنك بدء جلسة جديدة.");
    };
    channel.onerror = () => {
      if (current.currentClip && !current.closing) {
        expireVoice(current, false);
        return;
      }
      if (!current.ended)
        fail(current, "تعذّر الحفاظ على الاتصال الصوتي. حاول مرة أخرى.");
    };
    // Never attach the WebRTC downlink to an audible element. Timestamped PCM
    // from the authenticated server stream goes through GuardedAudio instead.
    peer.ontrack = () => {};
    peer.onconnectionstatechange = () => {
      if (
        peer.connectionState === "failed" &&
        current.currentClip &&
        !current.closing
      ) {
        expireVoice(current, false);
        return;
      }
      if (peer.connectionState === "failed")
        fail(current, "انقطع الاتصال. تحقّق من الإنترنت وابدأ جلسة جديدة.");
    };
    current.startupTimer = window.setTimeout(
      () => fail(current, "تعذّر بدء الاتصال في الوقت المحدد. حاول مرة أخرى."),
      45_000,
    );
    try {
      const guardModule = await import("../../lib/quran-speech-guard");
      speechReview = (text) => !guardModule.isQuranRecitation(text);
      possiblePrefix = guardModule.hasQuranPrefix;
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
      if (current.ended || current.closing || attempt.current !== version) {
        const wasCurrent = connection.current === current;
        microphone.getTracks().forEach((track) => track.stop());
        cleanup(current);
        if (alive.current && wasCurrent) setPhase("ended");
        return;
      }
      current.microphone = microphone;
      microphone.getAudioTracks().forEach((track) => {
        peer.addTrack(track, microphone);
        track.onended = () => {
          if (!current.ended && !current.voiceEnded && current.started)
            fail(current, "توقف الميكروفون. أعد توصيله ثم ابدأ جلسة جديدة.");
        };
      });
      const input = context.createMediaStreamSource(microphone);
      current.analyser = context.createAnalyser();
      // A longer RMS window reduces random per-frame variation in stationary
      // room noise while keeping the activity poll and speech latency bounded.
      current.analyser.fftSize = 1024;
      input.connect(current.analyser);
      const inputData = new Uint8Array(current.analyser.fftSize),
        outputData = new Uint8Array(256);
      current.meterTimer = window.setInterval(() => {
        if (current.ended) return;
        if (current.deadline)
          setRemaining(
            Math.max(0, Math.ceil((current.deadline - Date.now()) / 1000)),
          );
        current.analyser?.getByteTimeDomainData(inputData);
        guard.output.getByteTimeDomainData(outputData);
        const rms = (data: Uint8Array) =>
          Math.sqrt(
            data.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) /
              data.length,
          );
        const inputLevel = current.muted || current.held ? 0 : rms(inputData);
        const outputLevel = current.held ? 0 : rms(outputData);
        const now = performance.now();
        if (current.muted || current.held) current.inputActivity.pause();
        const inputActive =
          !current.muted &&
          !current.held &&
          current.inputActivity.sample(inputLevel, now);
        current.lastInputSpeechAt = current.inputActivity.lastSpeechAt;
        if (inputActive && guard.hasOutput && !current.interrupted) {
          current.interrupted = true;
          current.needsFreshReply = true;
          guard.hold();
          void recoverOutput(current).catch(() =>
            fail(current, "تعذّر استعادة الصوت. يمكنك بدء جلسة جديدة."),
          );
        }
        if (
          current.needsFreshReply &&
          !current.interrupted &&
          !current.recovery &&
          !current.held &&
          !current.muted &&
          !current.inputBusy &&
          !current.closing &&
          !current.contextHeld
        ) {
          // Let a natural fresh response win. A cue is only a fallback when
          // the provider finished its discarded turn and has fallen silent.
          if (guard.hasOutput) current.needsFreshReply = false;
          else if (
            performance.now() - current.lastInputSpeechAt >= 1600 &&
            performance.now() - current.recoveredAt >= 1000
          ) {
            current.needsFreshReply = false;
            void sendControl(current, "speech_interrupted").catch(() => {
              if (
                connection.current === current &&
                !current.ended &&
                !current.closing &&
                !current.held
              )
                setNotice("يمكنك متابعة الحديث، أنا أستمع إليك.");
            });
          }
        }
        setLevel(
          Math.min(1, Math.max(inputActive ? inputLevel : 0, outputLevel) * 6),
        );
        setActivity(
          inputActive ? "user" : outputLevel > 0.008 ? "assistant" : "quiet",
        );
      }, 100);
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIce(peer, controller.signal);
      if (current.ended) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error(GENERIC_ERROR);
      const response = await fetch("/api/live/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sdp, consent: true }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(
          typeof data.error === "string" ? data.error : GENERIC_ERROR,
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!current.ended && !current.voiceEnded) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder
          .decode(value, { stream: true })
          .replace(/\r\n/g, "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const payload = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (payload) await handleEvent(JSON.parse(payload) as LiveEvent);
        }
        if (buffer.length > 100_000) throw new Error(GENERIC_ERROR);
      }
      if (!current.ended && !current.voiceEnded)
        fail(current, "انتهى الاتصال الصوتي. يمكنك بدء جلسة جديدة.");
    } catch (caught) {
      if (
        !current.ended &&
        !current.voiceEnded &&
        !(caught instanceof DOMException && caught.name === "AbortError")
      )
        fail(current, microphoneError(caught));
    }
  }, [cleanup, expireVoice, fail, playClip, recoverOutput, sendControl]);

  const toggleMute = useCallback(async () => {
    const current = connection.current;
    if (
      !current ||
      current.held ||
      current.ended ||
      current.closing ||
      current.inputBusy
    )
      return;
    current.inputBusy = true;
    const version = ++current.inputVersion;
    current.muted = !current.muted;
    setMuted(current.muted);
    current.microphone?.getAudioTracks().forEach((track) => {
      track.enabled = !current.muted;
    });
    setMutePending(true);
    try {
      await setInputMuted(current, current.muted);
    } catch {
      if (
        !current.ended &&
        !current.closing &&
        current.inputVersion === version
      )
        fail(
          current,
          "تعذّر تغيير حالة الميكروفون. أغلقنا الاتصال ويمكنك البدء مجددًا.",
        );
    } finally {
      if (current.inputVersion === version) {
        current.inputBusy = false;
        if (alive.current && connection.current === current)
          setMutePending(false);
      }
    }
  }, [fail, setInputMuted]);

  const resumeClip = useCallback(
    async (replay: boolean) => {
      const current = connection.current;
      if (
        !current?.currentClip ||
        !current.clipReady ||
        current.ended ||
        current.closing ||
        current.clipTransition ||
        !current.held
      )
        return;
      const selected = current.currentClip;
      const ownsClip = () =>
        connection.current === current &&
        current.currentClip === selected &&
        !current.ended &&
        !current.closing &&
        !current.clipTransition &&
        current.held;
      const retry = clipState === "error" || Boolean(current.clip.error);
      current.clipReady = false;
      setClipReady(false);
      setClipState("loading");
      try {
        if (retry) current.clip.load();
        if (recordingRange(selected) && (replay || retry)) {
          await current.clipBoundary!.restart(current.clipAbort!.signal);
        } else if (replay) current.clip.currentTime = 0;
        if (!ownsClip()) return;
        if (replay) setClipProgress(0);
        await current.clip.play();
        if (ownsClip()) {
          current.clipReady = true;
          setClipReady(true);
        }
      } catch {
        if (ownsClip()) {
          current.clipReady = true;
          setClipReady(true);
          setClipState("error");
        }
      }
    },
    [clipState],
  );
  const toggleClip = useCallback(async () => {
    const current = connection.current;
    if (
      !current?.currentClip ||
      !current.clipReady ||
      current.ended ||
      current.closing ||
      current.clipTransition ||
      !current.held
    )
      return;
    if (!current.clip.paused) {
      current.clip.pause();
      setClipState("paused");
      return;
    }
    await resumeClip(false);
  }, [resumeClip]);
  const replayClip = useCallback(() => resumeClip(true), [resumeClip]);
  const unlockAudio = useCallback(async () => {
    const current = connection.current;
    if (!current || current.ended || current.closing) return;
    try {
      await current.context.resume();
      if (connection.current !== current || current.ended || current.closing)
        return;
      setAudioLocked(current.context.state !== "running");
      if (
        !current.voiceEnded &&
        current.context.state === "running" &&
        current.contextHeld
      ) {
        current.contextHeld = false;
        await recoverOutput(current);
      }
    } catch {
      if (connection.current === current && !current.ended && !current.closing)
        setAudioLocked(true);
    }
  }, [recoverOutput]);

  useEffect(() => {
    alive.current = true;
    const restorePage = () => {
      if (connection.current) return;
      starting.current = false;
      // Fast Refresh and the back/forward cache can preserve React state after
      // cleanup has stopped all devices and timers. Never preserve a live UI
      // without an actual connection behind it.
      setPhase((previous) =>
        previous === "connecting" ||
        previous === "connected" ||
        previous === "closing"
          ? "ended"
          : previous,
      );
    };
    restorePage();
    const leave = () => {
      attempt.current += 1;
      const current = connection.current;
      if (!current) return;
      if (current.id)
        navigator.sendBeacon(
          "/api/live/control",
          new Blob([JSON.stringify({ sessionId: current.id, action: "end" })], {
            type: "application/json",
          }),
        );
      cleanup(current);
    };
    const offline = () => {
      const current = connection.current;
      if (current)
        fail(
          current,
          "انقطع الإنترنت، وأغلقنا الميكروفون. اتصل بالشبكة ثم ابدأ مجددًا.",
        );
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", restorePage);
    window.addEventListener("offline", offline);
    return () => {
      alive.current = false;
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", restorePage);
      window.removeEventListener("offline", offline);
      leave();
    };
  }, [cleanup, fail]);

  return {
    phase,
    error,
    notice,
    muted,
    mutePending,
    remaining,
    activity,
    level,
    recitation,
    clipState,
    clipReady,
    clipProgress,
    audioLocked,
    voiceEnded,
    support,
    start,
    end,
    toggleMute,
    toggleClip,
    replayClip,
    skipClip: () => completeClip("recitation_skipped"),
    unlockAudio,
  };
}
