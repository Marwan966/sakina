import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import WebSocket from "ws";
import {
  handleLiveControl,
  controlInstruction,
  RECITATION_RETURN_CUE,
  GREETING_CUE,
} from "../apps/sakina/lib/live-control";
import { signGrant } from "../apps/sakina/lib/live-security";

const secret = "return-control-unit-signing-secret-long-enough";
const original = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_LIVE_ENABLED: process.env.OPENAI_LIVE_ENABLED,
  LIVE_SESSION_SECRET: process.env.LIVE_SESSION_SECRET,
};
beforeEach(() => {
  process.env.OPENAI_API_KEY = "unit-test-credential";
  process.env.OPENAI_LIVE_ENABLED = "true";
  process.env.LIVE_SESSION_SECRET = secret;
});
after(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

type Sent = {
  type: string;
  event_id: string;
  content: string;
  delegation_id: null;
};
class ReturnSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: Sent[] = [];
  onSend?: (event: Sent) => void;
  send(raw: string) {
    const event = JSON.parse(raw) as Sent;
    this.sent.push(event);
    if (this.onSend) this.onSend(event);
    else queueMicrotask(() => this.ack(event));
  }
  ack(event: Sent) {
    this.receive({
      type: event.type.replace(/append$/, "appended"),
      client_event_id: event.event_id,
    });
  }
  receive(event: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }
  close() {
    if (this.readyState !== WebSocket.CLOSED) {
      this.readyState = WebSocket.CLOSED;
      this.emit("close");
    }
  }
  asSocket() {
    return this as unknown as WebSocket;
  }
}
let serial = 0;
function request(
  action: "recitation_ended" | "recitation_skipped" | "greet",
  signal?: AbortSignal,
  grantMs = 10_000,
) {
  const sessionId = `return_control_${++serial}`;
  return new Request("https://sakina.example/api/live/control", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://sakina.example",
      Cookie: `sakina_live=${signGrant(sessionId, Date.now() + grantMs, secret)}`,
    },
    body: JSON.stringify({
      sessionId,
      action,
      ...(action === "greet" ? {} : { recitationId: "ayah-2-286" }),
    }),
    signal,
  });
}
function assertClean(socket: ReturnSocket, req: Request) {
  assert.equal(socket.readyState, WebSocket.CLOSED);
  for (const event of ["message", "close", "error"])
    assert.equal(socket.listenerCount(event), 0);
  assert.equal(getEventListeners(req.signal, "abort").length, 0);
}

test("a silent greeting gets exactly one authored AI welcome after the full four-second grace", async () => {
  const socket = new ReturnSocket();
  const req = request("greet");
  const started = Date.now();
  const result = await handleLiveControl(req, async () => socket.asSocket());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    ok: true,
    greetingCue: "acknowledged",
  });
  assert.ok(Date.now() - started >= 3950);
  assert.deepEqual(
    socket.sent.map((event) => event.type),
    ["session.instructions.append", "session.commentary.append"],
  );
  assert.equal(socket.sent[0].content, controlInstruction("greet"));
  assert.equal(socket.sent[1].content, GREETING_CUE);
  assert.match(GREETING_CUE, /بالذكاء الاصطناعي/);
  assert.equal(GREETING_CUE.match(/[؟?]/g)?.length, 1);
  assertClean(socket, req);
});

for (const delay of [1860, 3510]) {
  test(`a normal greeting beginning ${delay}ms after its ACK suppresses optional welcome`, async () => {
    const socket = new ReturnSocket();
    socket.onSend = (event) => {
      queueMicrotask(() => socket.ack(event));
      setTimeout(
        () =>
          socket.receive({
            type: "session.output_transcript.delta",
            delta: "أهلًا بك",
            start_ms: 1200,
            end_ms: 1400,
          }),
        delay,
      );
    };
    const req = request("greet");
    const result = await handleLiveControl(req, async () => socket.asSocket());
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      ok: true,
      greetingCue: "suppressed",
    });
    assert.equal(socket.sent.length, 1);
    assertClean(socket, req);
  });
}

test("a caller beginning at the end of greeting grace suppresses the welcome", async () => {
  const socket = new ReturnSocket();
  socket.onSend = (event) => {
    queueMicrotask(() => socket.ack(event));
    setTimeout(
      () =>
        socket.receive({
          type: "session.input_transcript.delta",
          delta: "أريد أن أحكي",
          start_ms: 1600,
          end_ms: 2000,
        }),
      3900,
    );
  };
  const req = request("greet");
  const result = await handleLiveControl(req, async () => socket.asSocket());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    ok: true,
    greetingCue: "suppressed",
  });
  assert.equal(socket.sent.length, 1);
  assertClean(socket, req);
});

test("insufficient greeting deadline skips optional speech instead of shortening its grace", async () => {
  const socket = new ReturnSocket();
  const req = request("greet", undefined, 4500);
  const result = await handleLiveControl(req, async () => socket.asSocket());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    ok: true,
    greetingCue: "unconfirmed",
  });
  assert.equal(socket.sent.length, 1);
  assertClean(socket, req);
});

test("rejected optional greeting leaves the live call usable after accepted instructions", async () => {
  const socket = new ReturnSocket();
  socket.onSend = (event) =>
    queueMicrotask(() => {
      if (event.type === "session.instructions.append") socket.ack(event);
      else
        socket.receive({
          type: "error",
          error: { client_event_id: event.event_id },
        });
    });
  const req = request("greet");
  const result = await handleLiveControl(req, async () => socket.asSocket());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    ok: true,
    greetingCue: "unconfirmed",
  });
  assert.equal(socket.sent.length, 2);
  assertClean(socket, req);
});

test("ending during greeting grace cancels the welcome and releases its observer", async () => {
  const controller = new AbortController();
  const socket = new ReturnSocket();
  socket.onSend = (event) => {
    queueMicrotask(() => socket.ack(event));
    setTimeout(() => controller.abort(), 30);
  };
  const req = request("greet", controller.signal);
  const result = await handleLiveControl(req, async () => socket.asSocket());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), {
    ok: true,
    greetingCue: "unconfirmed",
  });
  assert.equal(socket.sent.length, 1);
  assertClean(socket, req);
});

for (const action of ["recitation_ended", "recitation_skipped"] as const) {
  test(`${action} preserves lifecycle context then requests one spoken transition when silent`, async () => {
    const socket = new ReturnSocket();
    const req = request(action);
    const started = Date.now();
    const result = await handleLiveControl(req, async () => socket.asSocket());
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      ok: true,
      returnCue: "acknowledged",
    });
    assert.ok(Date.now() - started >= 1400);
    assert.deepEqual(
      socket.sent.map((event) => event.type),
      ["session.instructions.append", "session.commentary.append"],
    );
    assert.equal(
      socket.sent[0].content,
      controlInstruction(action, "ayah-2-286"),
    );
    assert.equal(socket.sent[1].content, RECITATION_RETURN_CUE);
    assert.notEqual(socket.sent[0].event_id, socket.sent[1].event_id);
    assert.ok(socket.sent.every((event) => event.delegation_id === null));
    assert.doesNotMatch(RECITATION_RETURN_CUE, /[؟?]|تحسنت|أفضل|سورة|آية/);
    assertClean(socket, req);
  });
}

test("natural assistant reply arriving before the instruction ACK suppresses the extra cue", async () => {
  const socket = new ReturnSocket();
  socket.onSend = (event) =>
    queueMicrotask(() => {
      socket.receive({
        type: "session.output_transcript.delta",
        delta: "يمكننا العودة إلى مسؤولياتك خطوة خطوة.",
      });
      socket.ack(event);
    });
  const req = request("recitation_ended");
  assert.equal(
    (await handleLiveControl(req, async () => socket.asSocket())).status,
    200,
  );
  assert.equal(socket.sent.length, 1);
  assertClean(socket, req);
});

for (const role of ["input", "output"]) {
  test(`new ${role} speech during return grace suppresses fallback commentary`, async () => {
    const socket = new ReturnSocket();
    socket.onSend = (event) => {
      queueMicrotask(() => socket.ack(event));
      setTimeout(
        () =>
          socket.receive({
            type: `session.${role}_transcript.delta`,
            delta:
              role === "input"
                ? "أريد أن أكمل ما كنت أقوله"
                : "نعود إلى حديثك بهدوء",
            start_ms: 10_000,
            end_ms: 10_300,
          }),
        30,
      );
    };
    const req = request("recitation_skipped");
    assert.equal(
      (await handleLiveControl(req, async () => socket.asSocket())).status,
      200,
    );
    assert.equal(socket.sent.length, 1);
    assertClean(socket, req);
  });
}

test("whitespace transcripts and silent audio are not mistaken for a natural spoken return", async () => {
  const socket = new ReturnSocket();
  socket.onSend = (event) =>
    queueMicrotask(() => {
      socket.ack(event);
      socket.receive({ type: "session.output_transcript.delta", delta: " ، " });
      socket.receive({ type: "session.output_audio.delta", delta: "AAAAAA==" });
    });
  const req = request("recitation_ended", undefined, 1600);
  assert.equal(
    (await handleLiveControl(req, async () => socket.asSocket())).status,
    200,
  );
  assert.equal(socket.sent.length, 2);
  assertClean(socket, req);
});

test("wrong ACK kind or ID leaves optional commentary unconfirmed without ending the viable call", async () => {
  const socket = new ReturnSocket();
  socket.onSend = (event) =>
    queueMicrotask(() => {
      if (event.type === "session.instructions.append") socket.ack(event);
      else {
        socket.receive({
          type: "session.instructions.appended",
          client_event_id: event.event_id,
        });
        socket.receive({
          type: "session.commentary.appended",
          client_event_id: "other-event",
        });
      }
    });
  const req = request("recitation_ended", undefined, 1200);
  const result = await handleLiveControl(req, async () => socket.asSocket());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, returnCue: "unconfirmed" });
  assert.equal(socket.sent.length, 2);
  assertClean(socket, req);
});

for (const failingStage of ["instructions", "commentary"]) {
  test(`provider rejection at ${failingStage} preserves the required-versus-optional boundary and cleans listeners`, async () => {
    const socket = new ReturnSocket();
    socket.onSend = (event) =>
      queueMicrotask(() => {
        if (event.type === `session.${failingStage}.append`)
          socket.receive({
            type: "error",
            error: {
              client_event_id: event.event_id,
              message: "private provider diagnostic",
            },
          });
        else socket.ack(event);
      });
    const req = request("recitation_ended", undefined, 1600);
    const result = await handleLiveControl(req, async () => socket.asSocket());
    assert.equal(result.status, failingStage === "instructions" ? 503 : 200);
    const body = await result.text();
    assert.doesNotMatch(body, /private provider diagnostic/);
    if (failingStage === "commentary")
      assert.deepEqual(JSON.parse(body), {
        ok: true,
        returnCue: "unconfirmed",
      });
    assert.equal(socket.sent.length, failingStage === "instructions" ? 1 : 2);
    assertClean(socket, req);
  });
}

test("request abort during grace prevents late commentary and releases its timers/listeners", async () => {
  const controller = new AbortController();
  const socket = new ReturnSocket();
  socket.onSend = (event) => {
    queueMicrotask(() => socket.ack(event));
    setTimeout(() => controller.abort(), 30);
  };
  const req = request("recitation_ended", controller.signal);
  const result = await handleLiveControl(req, async () => socket.asSocket());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, returnCue: "unconfirmed" });
  assert.equal(socket.sent.length, 1);
  assertClean(socket, req);
});

test("a synchronous transport send failure cannot orphan an ACK promise", async () => {
  const socket = new ReturnSocket();
  socket.onSend = () => {
    throw new Error("transport send failed");
  };
  const req = request("recitation_skipped");
  assert.equal(
    (await handleLiveControl(req, async () => socket.asSocket())).status,
    503,
  );
  assert.equal(socket.sent.length, 1);
  assertClean(socket, req);
});

test("closing while awaiting commentary ACK leaves its status unconfirmed and does not retry or end the call", async () => {
  const socket = new ReturnSocket();
  socket.onSend = (event) =>
    queueMicrotask(() => {
      if (event.type === "session.instructions.append") socket.ack(event);
      else socket.close();
    });
  const req = request("recitation_ended", undefined, 1600);
  const result = await handleLiveControl(req, async () => socket.asSocket());
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, returnCue: "unconfirmed" });
  assert.equal(socket.sent.length, 2);
  assertClean(socket, req);
});
