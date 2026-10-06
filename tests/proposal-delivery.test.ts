import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { getRecitation } from "../apps/sakina/lib/recitations";
import { handleLiveSession } from "../apps/sakina/lib/live-session";
import {
  assistantSpokeProposal,
  hasMeaningfulPcm16,
  proposalDeliveryCommentary,
} from "../apps/sakina/lib/proposal-delivery";

const previousEnvironment = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_LIVE_ENABLED: process.env.OPENAI_LIVE_ENABLED,
  LIVE_SESSION_SECRET: process.env.LIVE_SESSION_SECRET,
};
const SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
const recitation = getRecitation("sharh")!;
const candidate = {
  id: "candidate-94-5",
  recitation,
  verses: [
    {
      key: "94:5",
      text: "source fixture",
      tafsir: "source commentary fixture",
      tafsirSourceUrl: "https://quran.com/94:5/tafsirs/ar-tafsir-muyassar",
    },
  ],
  surroundingVerses: [{ key: "94:4", text: "source context fixture" }],
  source: "test_fixture",
};

beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-api-credential";
  process.env.OPENAI_LIVE_ENABLED = "true";
  process.env.LIVE_SESSION_SECRET =
    "test-only-signing-secret-of-sufficient-length";
});

after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function request(signal?: AbortSignal) {
  return new Request("https://sakina.example/api/live/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://sakina.example",
    },
    body: JSON.stringify({ sdp: SDP, consent: true }),
    signal,
  });
}

class FakeProvider extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: Record<string, any>[] = [];
  autoAcknowledge = true;

  send(raw: string) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    if (event.type === "session.close") {
      queueMicrotask(() =>
        this.receive({
          type: "session.closed",
          reason: "close_requested",
          usage: { seconds: 1 },
        }),
      );
    }
    if (event.type === "session.commentary.append" && this.autoAcknowledge) {
      queueMicrotask(() =>
        this.receive({
          type: "session.commentary.appended",
          client_event_id: event.event_id,
        }),
      );
    }
  }

  receive(event: unknown) {
    this.emit("message", Buffer.from(JSON.stringify(event)));
  }

  close() {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  }

  asSocket() {
    return this as unknown as WebSocket;
  }
}

function dependencies(
  provider: FakeProvider,
  options: {
    durationSeconds?: number;
    initialGraceMs?: number;
    quietMs?: number;
  } = {},
) {
  return {
    fetch: (async () =>
      Response.json({
        session: { id: "proposal_delivery_test" },
        transport: { type: "webrtc", sdp: SDP },
      })) as typeof fetch,
    connect: async () => provider.asSocket(),
    reserve: async () => {},
    close: async () => true,
    search: async () => ({ status: "ok" as const, candidates: [candidate] }),
    durationSeconds: options.durationSeconds ?? 2,
    proposalInitialGraceMs: options.initialGraceMs ?? 8,
    proposalQuietMs: options.quietMs ?? 6,
  };
}

function nested(provider: FakeProvider, delegationId: string, event: unknown) {
  provider.receive({
    type: "response.event",
    delegation_id: delegationId,
    event,
  });
}

function completeTool(
  provider: FakeProvider,
  delegationId: string,
  responseId: string,
  toolName: string,
  args: unknown,
) {
  nested(provider, delegationId, {
    type: "response.created",
    response: { id: responseId },
  });
  nested(provider, delegationId, {
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: responseId,
      name: toolName,
      arguments: JSON.stringify(args),
    },
  });
  nested(provider, delegationId, {
    type: "response.completed",
    response: { id: responseId },
  });
}

const wait = (milliseconds = 0) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function toolResult(provider: FakeProvider, callId: string) {
  const event = provider.sent.find(
    (entry) =>
      entry.type === "response.item.create" && entry.item?.call_id === callId,
  );
  assert.ok(event, `missing tool result for ${callId}`);
  return JSON.parse(event.item.output);
}

async function createAcceptedProposal(
  options: Parameters<typeof dependencies>[1] = {},
) {
  const provider = new FakeProvider();
  const response = await handleLiveSession(
    request(),
    dependencies(provider, options),
  );
  const delegationId = "proposal_delivery";
  provider.receive({
    type: "session.input_transcript.delta",
    delta: "تراكم العمل يرهقني ولا أجد وقتًا للراحة",
    start_ms: 100,
    end_ms: 1_000,
  });
  provider.receive({
    type: "session.delegation.created",
    delegation: { id: delegationId },
  });
  completeTool(provider, delegationId, "search", "search_quran", {
    query: "ضغط العمل وكثرة المسؤوليات",
    concepts: ["حدود الطاقة البشرية", "التيسير ورفع الحرج"],
    references: ["94:5-6"],
    safety: "ordinary",
  });
  await wait();
  const search = toolResult(provider, "search");
  assert.equal(search.status, "candidates");
  completeTool(
    provider,
    delegationId,
    "prepare",
    "prepare_relevant_recitation",
    {
      intent: "overwhelmed",
      fit: "supported",
      safety: "ordinary",
      userConcern: "تراكم العمل يرهقني ولا أجد وقتًا للراحة",
      searchId: search.searchId,
      candidateId: candidate.id,
      connection:
        "معنى اليسر بعد العسر يتصل مباشرة بشعوره أن ضغط المسؤوليات يطول",
    },
  );
  await wait();
  const proposal = toolResult(provider, "prepare");
  assert.equal(proposal.status, "proposed");
  return { provider, response, delegationId, proposal };
}

function completeNativeReply(
  provider: FakeProvider,
  delegationId: string,
  transcript?: string,
  responseId = "native_reply",
) {
  nested(provider, delegationId, {
    type: "response.created",
    response: { id: responseId },
  });
  if (transcript)
    provider.receive({
      type: "session.output_transcript.delta",
      delta: transcript,
      start_ms: 2_000,
      end_ms: 3_000,
    });
  nested(provider, delegationId, {
    type: "response.completed",
    response: { id: responseId },
  });
}

function commentary(provider: FakeProvider) {
  return provider.sent.filter(
    (event) => event.type === "session.commentary.append",
  );
}

async function closeJourney(
  provider: FakeProvider,
  response: Response,
  reason = "close_requested",
) {
  if (provider.readyState !== WebSocket.CLOSED)
    provider.receive({ type: "session.closed", reason });
  return response.text();
}

test("native chapter offer wins and common consent phrasing is recognized", async () => {
  const journey = await createAcceptedProposal();
  completeNativeReply(
    journey.provider,
    journey.delegationId,
    "في سورة الشرح معنى قريب مما وصفته؛ هل ترغب أن نستمع إليها؟",
  );
  await wait(20);
  assert.equal(commentary(journey.provider).length, 0);
  await closeJourney(journey.provider, journey.response);
  for (const phrase of [
    "في سورة الشرح، هل تحب أن نسمع المقطع؟",
    "من سورة الشرح، هل تود سماع التسجيل؟",
    "سورة الشرح؛ هل نبدأ الاستماع؟",
    "في سورة الشرح، هل ترغب في الاستماع؟",
    "في سورة الشرح، هل تحب أن نبدأ الاستماع؟",
  ]) {
    assert.equal(assistantSpokeProposal(phrase, "الشرح"), true, phrase);
  }
  assert.equal(
    assistantSpokeProposal("ذكرت سورة الشرح، هل تريد أن تكمل الحديث؟", "الشرح"),
    false,
  );
});

test("generic native reply gets one grounded invitation despite repeated completions and silent PCM", async () => {
  const journey = await createAcceptedProposal();
  const responseCreatesBefore = journey.provider.sent.filter(
    (event) => event.type === "response.create",
  ).length;
  completeNativeReply(
    journey.provider,
    journey.delegationId,
    "أفهم أن المسؤوليات كثيرة. تفضّل، أنا أسمعك.",
  );
  for (let index = 0; index < 4; index++) {
    nested(journey.provider, journey.delegationId, {
      type: "response.completed",
      response: { id: "native_reply" },
    });
    journey.provider.receive({
      type: "session.output_audio.delta",
      delta: Buffer.alloc(4_800).toString("base64"),
      start_ms: 3_000 + index * 100,
      end_ms: 3_100 + index * 100,
    });
  }
  await wait(25);
  const authored = commentary(journey.provider);
  assert.equal(authored.length, 1);
  assert.match(authored[0].content, /مقطعًا من سورة الشرح/);
  assert.match(authored[0].content, /الشرح ١–٨/);
  assert.match(authored[0].content, /ياسر الدوسري/);
  assert.match(authored[0].content, /هل نبدأ الاستماع/);
  assert.equal(
    journey.provider.sent.filter((event) => event.type === "response.create")
      .length,
    responseCreatesBefore,
  );
  await wait(20);
  assert.equal(commentary(journey.provider).length, 1);
  await closeJourney(journey.provider, journey.response);
});

test("meaningful output audio delays fallback while silent PCM does not", async () => {
  const journey = await createAcceptedProposal({
    initialGraceMs: 3,
    quietMs: 15,
  });
  completeNativeReply(journey.provider, journey.delegationId, "أفهم شعورك.");
  const voice = Buffer.alloc(4_800);
  for (let offset = 0; offset < voice.length; offset += 2)
    voice.writeInt16LE(1_000, offset);
  assert.equal(hasMeaningfulPcm16(voice.toString("base64")), true);
  assert.equal(
    hasMeaningfulPcm16(Buffer.alloc(4_800).toString("base64")),
    false,
  );
  await wait(8);
  journey.provider.receive({
    type: "session.output_audio.delta",
    delta: voice.toString("base64"),
    start_ms: 3_000,
    end_ms: 3_100,
  });
  journey.provider.receive({
    type: "session.output_audio.delta",
    delta: Buffer.alloc(4_800).toString("base64"),
    start_ms: 3_100,
    end_ms: 3_200,
  });
  await wait(8);
  assert.equal(commentary(journey.provider).length, 0);
  await wait(15);
  assert.equal(commentary(journey.provider).length, 1);
  await closeJourney(journey.provider, journey.response);
});

test("new caller speech cancels a pending announcement", async () => {
  const journey = await createAcceptedProposal();
  completeNativeReply(journey.provider, journey.delegationId, "أنا أسمعك.");
  journey.provider.receive({
    type: "session.input_transcript.delta",
    delta: "دعني أوضح أمرًا آخر",
    start_ms: 3_000,
    end_ms: 3_500,
  });
  await wait(25);
  assert.equal(commentary(journey.provider).length, 0);
  await closeJourney(journey.provider, journey.response);
});

test("assistant refusal and a later support tool each cancel delivery", async () => {
  {
    const journey = await createAcceptedProposal();
    completeNativeReply(
      journey.provider,
      journey.delegationId,
      "لن أقترح تلاوة مناسبة الآن، وسأكتفي بالاستماع.",
    );
    await wait(25);
    assert.equal(commentary(journey.provider).length, 0);
    await closeJourney(journey.provider, journey.response);
  }
  {
    const journey = await createAcceptedProposal();
    completeTool(
      journey.provider,
      journey.delegationId,
      "support",
      "report_support_need",
      { urgency: "clarify" },
    );
    await wait(25);
    assert.equal(toolResult(journey.provider, "support").status, "support");
    assert.equal(commentary(journey.provider).length, 0);
    await closeJourney(journey.provider, journey.response);
  }
});

test("closure and session expiry clear delivery timers", async () => {
  {
    const journey = await createAcceptedProposal({ initialGraceMs: 30 });
    completeNativeReply(journey.provider, journey.delegationId, "أنا أسمعك.");
    journey.provider.receive({
      type: "session.closed",
      reason: "close_requested",
    });
    await wait(40);
    assert.equal(commentary(journey.provider).length, 0);
    await journey.response.text();
  }
  {
    const journey = await createAcceptedProposal({
      durationSeconds: 0.04,
      initialGraceMs: 100,
    });
    completeNativeReply(journey.provider, journey.delegationId, "أنا أسمعك.");
    const output = await journey.response.text();
    assert.match(output, /"reason":"expired"/);
    assert.equal(commentary(journey.provider).length, 0);
  }
});

test("tool arguments without an accepted proposal never authorize commentary", async () => {
  const provider = new FakeProvider();
  const response = await handleLiveSession(request(), dependencies(provider));
  const delegationId = "no_evidence";
  provider.receive({
    type: "session.input_transcript.delta",
    delta: "أشعر بضغط العمل",
  });
  provider.receive({
    type: "session.delegation.created",
    delegation: { id: delegationId },
  });
  completeTool(
    provider,
    delegationId,
    "unsupported_prepare",
    "prepare_relevant_recitation",
    {
      intent: "overwhelmed",
      fit: "supported",
      safety: "ordinary",
      userConcern: "أشعر بضغط العمل",
      searchId: "invented",
      candidateId: candidate.id,
      connection: "صلة مزعومة لم تتحقق منها قاعدة المصدر",
    },
  );
  await wait();
  assert.equal(
    toolResult(provider, "unsupported_prepare").status,
    "search_required",
  );
  completeNativeReply(provider, delegationId, "أنا أسمعك.", "generic");
  await wait(25);
  assert.equal(commentary(provider).length, 0);
  await closeJourney(provider, response);
});

test("a matched optional commentary error is consumed without retry or audio reset", async () => {
  const journey = await createAcceptedProposal();
  journey.provider.autoAcknowledge = false;
  completeNativeReply(journey.provider, journey.delegationId, "أنا أسمعك.");
  await wait(25);
  const authored = commentary(journey.provider);
  assert.equal(authored.length, 1);
  journey.provider.receive({
    type: "error",
    error: {
      code: "optional_commentary_rejected",
      client_event_id: authored[0].event_id,
    },
  });
  await wait(15);
  assert.equal(commentary(journey.provider).length, 1);
  const output = await closeJourney(journey.provider, journey.response);
  assert.doesNotMatch(output, /provider_error|انقطاع مؤقت/);
});

test("a Quran quotation in the model connection is never copied into authored speech", () => {
  const content = proposalDeliveryCommentary({
    proposalId: "proposal",
    inputRevision: 1,
    delegationId: "delegation",
    chapterName: "البقرة",
    reference: "البقرة ٢٨٦",
    reciter: "ياسر الدوسري",
    connection: "لا يكلف الله نفسا الا وسعها وهذا يرتبط بكثرة المسؤوليات",
    expiresAt: Date.now() + 1_000,
  });
  assert.match(content, /سورة البقرة/);
  assert.match(content, /البقرة ٢٨٦/);
  assert.match(content, /هل نبدأ الاستماع/);
  assert.doesNotMatch(content, /لا يكلف الله نفسا الا وسعها/);
});
