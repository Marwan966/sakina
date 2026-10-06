import WebSocket from "ws";
import { HttpError } from "@platform/core/http";

export function liveApiKey() {
  const key = process.env.OPENAI_API_KEY;
  if (process.env.OPENAI_LIVE_ENABLED !== "true" || !key)
    throw new HttpError(503, "المحادثة الصوتية غير متاحة الآن. حاول لاحقًا.");
  return key;
}

export function providerFailure(status: number): HttpError {
  if (status === 429)
    return new HttpError(
      503,
      "المحادثات الصوتية مشغولة حاليًا. حاول بعد قليل.",
    );
  return new HttpError(503, "تعذّر بدء الاتصال الصوتي. حاول بعد قليل.");
}

export async function openSideband(
  sessionId: string,
  apiKey: string,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        handshakeTimeout: 8_000,
        maxPayload: 2 * 1024 * 1024,
      },
    );
    // Keep an error listener after connection so a transport error cannot crash the process.
    socket.on("error", () => {});
    socket.once("error", () =>
      reject(new HttpError(503, "تعذّر توصيل المحادثة بأمان. حاول مجددًا.")),
    );
    socket.once("open", () => resolve(socket));
  });
}

export function sendLive(socket: WebSocket, event: Record<string, unknown>) {
  if (socket.readyState !== WebSocket.OPEN)
    throw new HttpError(503, "انقطع الاتصال الصوتي.");
  socket.send(JSON.stringify(event));
}

export async function closeOnSideband(socket: WebSocket): Promise<boolean> {
  if (socket.readyState !== WebSocket.OPEN) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.close();
      resolve(confirmed);
    };
    const onClose = () => finish(false);
    const onMessage = (raw: WebSocket.RawData) => {
      try {
        if (JSON.parse(raw.toString()).type === "session.closed") finish(true);
      } catch {
        /* Ignore malformed provider events. */
      }
    };
    const timer = setTimeout(() => {
      socket.terminate();
      finish(false);
    }, 5_000);
    socket.on("message", onMessage);
    socket.once("close", onClose);
    try {
      sendLive(socket, { type: "session.close" });
    } catch {
      finish(false);
    }
  });
}

export async function closeProviderSession(
  sessionId: string,
  apiKey: string,
): Promise<boolean> {
  try {
    return await closeOnSideband(await openSideband(sessionId, apiKey));
  } catch {
    return false;
  }
}
