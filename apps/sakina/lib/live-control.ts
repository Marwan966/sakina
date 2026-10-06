import { randomUUID } from "node:crypto";
import { z } from "zod";
import WebSocket from "ws";
import { HttpError, failure, json } from "@platform/core/http";
import { getRecitation } from "./recitations";
import { grantFromRequest, readLiveBody } from "./live-security";
import {
  liveApiKey,
  openSideband,
  sendLive,
  closeOnSideband,
} from "./live-provider";

export const controlSchema = z
  .object({
    sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,180}$/),
    action: z.enum([
      "greet",
      "recitation_started",
      "recitation_ended",
      "recitation_failed",
      "recitation_skipped",
      "speech_blocked",
      "speech_interrupted",
      "end",
    ]),
    recitationId: z.string().max(40).optional(),
  })
  .strict();

export function controlInstruction(
  action: z.infer<typeof controlSchema>["action"],
  recitationId?: string,
) {
  if (action.startsWith("recitation_")) {
    const recitation = getRecitation(recitationId);
    if (!recitation) throw new HttpError(400, "هذه التلاوة غير متاحة.");
    if (action === "recitation_started")
      return `بدأ التطبيق تشغيل التسجيل الأصلي: ${recitation.title}. اصمت تمامًا ولا تتل ولا تتحدث حتى يخبرك التطبيق أن التشغيل انتهى أو توقف.`;
    if (action === "recitation_ended")
      return `انتهى تشغيل التسجيل الأصلي: ${recitation.title} فعليًا، وأعيد فتح الحوار وانتهى طلب الصمت. تحدث الآن دون انتظار كلام جديد، بفصحى طبيعية دافئة: قدّم ملاحظة داعمة واحدة مرتبطة بتفصيل حكاه قبل التسجيل، ثم اترك له المجال. لا تضف سؤالًا تلقائيًا ولا تستجوبه عن أثر التلاوة ولا تعرض تسجيلًا آخر فورًا. لا تفترض أنه تحسن ولا تقتبس آية. إذا بدأ يتكلم، توقف وأنصت.`;
    if (action === "recitation_failed")
      return "تعذّر تشغيل التسجيل الأصلي. لا تتل القرآن بديلًا عنه. أخبر المستخدم بالعربية الفصحى الطبيعية باختصار أنه يستطيع إعادة المحاولة أو مواصلة الحديث، ثم انتظر اختياره.";
    return "اختار المستخدم إيقاف التلاوة، وانتهى طلب الصمت أثناءها. تحدث الآن فورًا دون انتظار كلام جديد بالعربية الفصحى الطبيعية الدافئة: احترم اختياره وعد بجملة قصيرة إلى التفصيل الذي كان يحكيه ثم أنصت. لا تلحّ على إعادة التسجيل ولا تقتبس القرآن بصوتك.";
  }
  if (action === "greet")
    return "ابدأ الآن مرة واحدة بفصحى طبيعية دافئة: أهلًا بك، أنا مساعد سكينة الصوتي بالذكاء الاصطناعي. اسأل ما الذي يشغله اليوم ثم أنصت، دون انتظار أول صوت منه لبدء الترحيب. إذا بدأ يحكي بالفعل، لا تقاطعه أو تعِد الترحيب؛ انتظر اكتمال وصفه ثم اعكس تفصيله. إن اتضح موقف عادي، فوّض الخلفية إلى search_quran لفهم المعنى والبحث، ثم prepare_relevant_recitation بعد التحقق من النص والتفسير، قبل سؤال استكشافي آخر ودون انتظار طلب القرآن. احترم الرفض وطلب الإنصات فقط وقدّم الأمان. هذا استرجاع بلا تشغيل؛ لا تلاوة دون موافقة جديدة بعد عرض المقترح. لا تتل القرآن بصوتك.";
  if (action === "speech_blocked")
    return "توقف عن الكلام الحالي. منع التطبيق مقطعًا من الصوت. لا تقتبس القرآن أو تتلوه بصوتك إطلاقًا؛ القرآن من التسجيل الأصلي فقط. عد للاستماع بلطف بالعربية الفصحى الطبيعية دون تكرار المقطع المحجوب.";
  if (action === "speech_interrupted")
    return "أنا أستمع إليك، خذ وقتك في إكمال ما تريد قوله.";
  return null;
}

const buckets = new Map<string, { count: number; expiresAt: number }>();
export const RECITATION_RETURN_CUE =
  "يمكنك متابعة ما كنت تحكيه، أنا أستمع إليك.";
export const GREETING_CUE =
  "أهلًا بك، أنا مساعد سكينة الصوتي بالذكاء الاصطناعي. ما الذي يشغلك اليوم؟";

function appendAcknowledged(
  socket: WebSocket,
  kind: "instructions" | "commentary",
  content: string,
  deadline: number,
  signal: AbortSignal,
) {
  return new Promise<void>((resolve, reject) => {
    const eventId = randomUUID();
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onClose);
      signal.removeEventListener("abort", onClose);
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => finish(new HttpError(503, "انقطع الاتصال الصوتي."));
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        const event = JSON.parse(raw.toString());
        if (
          event.type === `session.${kind}.appended` &&
          event.client_event_id === eventId
        )
          finish();
        else if (
          event.type === "error" &&
          event.error?.client_event_id === eventId
        )
          finish(new HttpError(503, "تعذّر التحكم بالصوت. حاول مجددًا."));
      } catch {
        /* Never expose provider payloads. */
      }
    };
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onClose);
    signal.addEventListener("abort", onClose, { once: true });
    timer = setTimeout(
      () =>
        finish(new HttpError(503, "تعذّر تأكيد التحكم بالصوت. حاول مجددًا.")),
      Math.max(0, deadline - Date.now()),
    );
    if (signal.aborted || deadline <= Date.now()) {
      onClose();
      return;
    }
    try {
      sendLive(socket, {
        type: `session.${kind}.append`,
        event_id: eventId,
        delegation_id: null,
        content,
      });
    } catch {
      onClose();
    }
  });
}

/** Observe before the lifecycle append so a natural reply arriving just before
 * its injection ACK also wins. Transcript presence is not proof of playback;
 * the browser's original audio guard remains authoritative. */
function watchSpeech(socket: WebSocket) {
  let spoken = false;
  let wake: (() => void) | undefined;
  const onMessage = (raw: WebSocket.RawData) => {
    try {
      const event = JSON.parse(raw.toString());
      if (
        (event.type === "session.output_transcript.delta" ||
          event.type === "session.input_transcript.delta") &&
        typeof event.delta === "string" &&
        /[\p{L}\p{N}]/u.test(event.delta)
      ) {
        spoken = true;
        wake?.();
      }
    } catch {
      /* Ignore malformed observation events. */
    }
  };
  socket.on("message", onMessage);
  return {
    get spoken() {
      return spoken;
    },
    wait(milliseconds: number, signal: AbortSignal) {
      if (spoken) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout>;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.off("close", onClose);
          socket.off("error", onClose);
          signal.removeEventListener("abort", onClose);
          wake = undefined;
          if (error) reject(error);
          else resolve();
        };
        const onClose = () =>
          finish(new HttpError(503, "انقطع الاتصال الصوتي."));
        wake = () => finish();
        socket.once("close", onClose);
        socket.once("error", onClose);
        signal.addEventListener("abort", onClose, { once: true });
        timer = setTimeout(() => finish(), Math.max(0, milliseconds));
        if (signal.aborted || socket.readyState !== WebSocket.OPEN) onClose();
      });
    },
    dispose() {
      socket.off("message", onMessage);
    },
  };
}
function controlLimit(sessionId: string, expiresAt: number, action: string) {
  if (action === "end") return;
  for (const [id, entry] of buckets)
    if (entry.expiresAt < Date.now()) buckets.delete(id);
  const entry = buckets.get(sessionId) || { count: 0, expiresAt };
  if (++entry.count > 40)
    throw new HttpError(429, "طلبات كثيرة. انتظر قليلًا.");
  buckets.set(sessionId, entry);
}

export async function handleLiveControl(
  request: Request,
  connect = openSideband,
) {
  let socket: WebSocket | undefined;
  let speech: ReturnType<typeof watchSpeech> | undefined;
  const startedAt = Date.now();
  try {
    const input = await readLiveBody(request, controlSchema, 4096);
    const grant = grantFromRequest(
      request,
      input.sessionId,
      input.action === "end",
    );
    controlLimit(input.sessionId, grant.expiresAt, input.action);
    const instruction = controlInstruction(input.action, input.recitationId);
    socket = await connect(input.sessionId, liveApiKey());
    if (input.action === "end")
      return json({ ok: true, finalized: await closeOnSideband(socket) });
    const greeting = input.action === "greet";
    const deadline = Math.min(
      startedAt + (greeting ? 13_000 : 9000),
      grant.expiresAt,
    );
    if (
      greeting ||
      input.action === "recitation_ended" ||
      input.action === "recitation_skipped"
    )
      speech = watchSpeech(socket);
    // A discarded reply is still in the model's context. A spoken listening
    // cue uses commentary; an instruction ACK alone does not elicit speech.
    // This authored cue contains no user text, tool request or Quran consent.
    const append =
      input.action === "speech_interrupted" ? "commentary" : "instructions";
    await appendAcknowledged(
      socket,
      append,
      instruction!,
      deadline,
      request.signal,
    );
    if (speech) {
      const cueStatus = greeting ? "greetingCue" : "returnCue";
      // The required instruction keeps context intact. Its ACK only confirms
      // injection, so allow natural output/caller speech to win. Welcomes need
      // more grace: observed normal first transcripts arrived 1.86–3.51s after
      // their ACK. Only continued silence requests one optional spoken cue.
      try {
        // Never shorten the greeting grace to squeeze a cue into the deadline:
        // a slow required ACK must not turn a healthy welcome into a duplicate.
        if (greeting && deadline - Date.now() < 5000)
          return json({ ok: true, [cueStatus]: "unconfirmed" });
        await speech.wait(
          Math.min(
            greeting ? 4000 : 1500,
            Math.max(0, deadline - Date.now() - 1000),
          ),
          request.signal,
        );
        if (speech.spoken) return json({ ok: true, [cueStatus]: "suppressed" });
        await appendAcknowledged(
          socket,
          "commentary",
          greeting ? GREETING_CUE : RECITATION_RETURN_CUE,
          deadline,
          request.signal,
        );
        return json({ ok: true, [cueStatus]: "acknowledged" });
      } catch {
        // The required lifecycle injection already succeeded. An optional
        // transition's missing ACK must not destroy that viable conversation.
        // This status claims neither cue injection nor audible playback.
        return json({ ok: true, [cueStatus]: "unconfirmed" });
      }
    }
    return json({ ok: true });
  } catch (error) {
    return failure(error);
  } finally {
    speech?.dispose();
    socket?.close();
  }
}
