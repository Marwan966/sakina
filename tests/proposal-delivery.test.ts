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
import { CONVERSATION_PROGRESS_INSTRUCTION } from "../apps/sakina/lib/conversation-progress";

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

test("live toolchain remembers two fragmented recall turns and dispatches the original recording only after fresh valid consent", async () => {
  const journey = await createAcceptedProposal();
  const { provider, response, proposal } = journey;
  const output = response.text();
  completeNativeReply(
    provider,
    journey.delegationId,
    "أقترح مقطعًا من سورة الشرح، هل نبدأ الاستماع؟",
  );
  const expected = {
    proposalId: proposal.proposalId,
    recitationId: recitation.id,
    title: recitation.title,
    reference: recitation.reference,
    chapterName: "الشرح",
    reciter: recitation.reciter,
    intent: "overwhelmed",
    userConcern: "تراكم العمل يرهقني ولا أجد وقتًا للراحة",
    connection:
      "معنى اليسر بعد العسر يتصل مباشرة بشعوره أن ضغط المسؤوليات يطول",
    state: "awaiting_consent",
  };
  let timestamp = 3_500;
  const caller = (delta: string) => {
    provider.receive({
      type: "session.input_transcript.delta",
      delta,
      start_ms: timestamp,
      end_ms: timestamp + 250,
    });
    timestamp += 300;
  };
  const begin = (id: string) =>
    provider.receive({
      type: "session.delegation.created",
      delegation: { id },
    });
  const assertMemory = (result: Record<string, any>) => {
    for (const [field, value] of Object.entries(expected))
      assert.equal(result.recommendation?.[field], value, field);
  };
  const canonicalThoughts = () =>
    provider.sent.filter(
      (event) =>
        event.type === "session.thinking.append" &&
        event.content.includes(recitation.title) &&
        event.content.includes(recitation.reference) &&
        event.content.includes("awaiting_consent"),
    );
  try {
    assert.equal(
      canonicalThoughts().length,
      1,
      "the accepted proposal reaches the live model's factual context",
    );
    for (const [index, fragments] of [
      ["أي ", "سورة اقترحتها؟"],
      ["ذكّرني ", "مرة أخرى باسم السورة والآيات"],
    ].entries()) {
      const id = `recall-${index}`;
      caller(fragments[0]);
      begin(id);
      // The final fragment arrives after delegation. Read-only recall must still
      // return current memory without confusing the question with new consent.
      caller(fragments[1]);
      completeTool(provider, id, id, "get_session_recitation", {});
      await wait();
      const result = toolResult(provider, id);
      assert.equal(result.status, "remembered");
      assertMemory(result);
      assert.equal(canonicalThoughts().length, index + 2);
    }

    caller("نعم أريد سماع المقطع نفسه");
    begin("wrong-confirmation");
    const consent = {
      intent: "overwhelmed",
      consent: true,
      safety: "ordinary",
      requestedId: null,
      proposalId: proposal.proposalId,
      contextStillApplies: true,
    };
    completeTool(
      provider,
      "wrong-confirmation",
      "wrong-confirmation",
      "recommend_recitation",
      {
        ...consent,
        proposalId: "unrelated-proposal",
      },
    );
    await wait();
    const rejected = toolResult(provider, "wrong-confirmation");
    assert.notEqual(rejected.status, "ready");
    assertMemory(rejected);
    completeTool(
      provider,
      "wrong-confirmation",
      "recall-after-rejection",
      "get_session_recitation",
      {},
    );
    await wait();
    assertMemory(toolResult(provider, "recall-after-rejection"));

    caller("نعم، ");
    caller("شغّل المقطع المقترح الآن");
    begin("fresh-consent");
    completeTool(
      provider,
      "fresh-consent",
      "fresh-consent",
      "recommend_recitation",
      consent,
    );
    await wait();
    const ready = toolResult(provider, "fresh-consent");
    assert.equal(ready.status, "ready");
    assert.equal(ready.recitationId, recitation.id);
    completeTool(
      provider,
      "fresh-consent",
      "duplicate-consent",
      "recommend_recitation",
      consent,
    );
    await wait();
    assert.equal(
      toolResult(provider, "duplicate-consent").status,
      "already_executed",
    );
    assert.equal(
      commentary(provider).length,
      0,
      "recall must not restart the unsolicited initial invitation",
    );

    provider.receive({ type: "session.closed", reason: "close_requested" });
    const events = (await output)
      .split("\n\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    const playbacks = events.filter((event) => event.type === "recitation");
    assert.equal(playbacks.length, 1);
    assert.equal(playbacks[0].playbackId, ready.playbackId);
    assert.deepEqual(playbacks[0].recitation, recitation);
    const consentIndex = events.findIndex(
      (event) =>
        event.type === "transcript" &&
        event.delta === "شغّل المقطع المقترح الآن",
    );
    const playbackIndex = events.findIndex(
      (event) => event.type === "recitation",
    );
    assert.ok(
      consentIndex >= 0 && playbackIndex > consentIndex,
      "no recording is dispatched during recall or rejected confirmation",
    );
  } finally {
    if (provider.readyState !== WebSocket.CLOSED)
      provider.receive({ type: "session.closed", reason: "close_requested" });
    await output;
  }
});

test("live transcript wiring sends one conditional progress reminder while native delegation cancels it", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: 1_800_000_000_000,
  });
  for (const nativeDelegation of [false, true]) {
    const provider = new FakeProvider();
    const response = await handleLiveSession(
      request(),
      dependencies(provider, { durationSeconds: 240 }),
    );
    const output = response.text();
    const reminders = () =>
      provider.sent.filter(
        (event) =>
          event.type === "session.instructions.append" &&
          event.content === CONVERSATION_PROGRESS_INSTRUCTION,
      );
    try {
      provider.receive({
        type: "session.input_transcript.delta",
        delta: "تراكم العمل يرهقني ولا أجد وقتًا للراحة بعد كثرة المسؤوليات",
        start_ms: 0,
        end_ms: 1_000,
      });
      provider.receive({
        type: "session.output_transcript.delta",
        delta:
          "أفهم أنك تواجه ضغطًا متواصلًا من مسؤوليات العمل وأنك تحتاج إلى مساحة من الراحة والإنصات الهادئ لما تمر به في هذه الفترة.",
        start_ms: 1_000,
        end_ms: 4_000,
      });
      t.mock.timers.tick(9_999);
      assert.equal(reminders().length, 0);
      if (nativeDelegation)
        provider.receive({
          type: "session.delegation.created",
          delegation: { id: "native-search" },
        });
      t.mock.timers.tick(1);
      assert.equal(reminders().length, nativeDelegation ? 0 : 1);
      provider.receive({
        type: "session.output_transcript.delta",
        delta:
          "يمكنك أن تواصل حديثك بهدوء، وسأحاول فهم التفصيل الذي تريد مشاركته دون استعجال.",
        start_ms: 12_000,
        end_ms: 14_000,
      });
      t.mock.timers.tick(10_000);
      assert.equal(
        reminders().length,
        nativeDelegation ? 0 : 1,
        "the reminder is optional and cannot loop",
      );
      assert.equal(
        provider.sent.filter((event) => event.type === "response.create")
          .length,
        0,
        "the progress hint does not itself select or play a recording",
      );
    } finally {
      provider.receive({ type: "session.closed", reason: "close_requested" });
    }
    const streamed = await output;
    assert.doesNotMatch(streamed, /"type":"recitation"/);
  }
});

test("caller fragments and assistant filler cannot steer an active backend delegation before its terminal event", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: 1_800_000_000_000,
  });
  for (const terminal of [
    "response.completed",
    "response.failed",
    "response.incomplete",
  ]) {
    const provider = new FakeProvider();
    const response = await handleLiveSession(
      request(),
      dependencies(provider, { durationSeconds: 240 }),
    );
    const output = response.text();
    const reminders = () =>
      provider.sent.filter(
        (event) =>
          event.type === "session.instructions.append" &&
          event.content === CONVERSATION_PROGRESS_INSTRUCTION,
      );
    const exchange = () => {
      provider.receive({
        type: "session.input_transcript.delta",
        delta: "وأريد أن أوضح أن المسؤوليات تتراكم كل يوم ولا أجد وقتًا لنفسي",
      });
      provider.receive({
        type: "session.output_transcript.delta",
        delta:
          "أفهم أنك تواجه ضغطًا متواصلًا من مسؤوليات العمل وأنك تحتاج إلى مساحة من الراحة والإنصات الهادئ لما تمر به في هذه الفترة.",
      });
    };
    try {
      provider.receive({
        type: "session.delegation.created",
        delegation: { id: "active-lookup" },
      });
      nested(provider, "active-lookup", {
        type: "response.created",
        response: { id: "active-response" },
      });
      exchange();
      t.mock.timers.tick(10_000);
      assert.equal(
        reminders().length,
        0,
        `${terminal}: ongoing delegation must remain ineligible after new caller speech`,
      );
      nested(provider, "active-lookup", {
        type: terminal,
        response: { id: "active-response" },
      });
      exchange();
      t.mock.timers.tick(10_000);
      assert.equal(
        reminders().length,
        1,
        `${terminal}: a later fresh exchange can progress once the backend finished`,
      );
    } finally {
      provider.receive({ type: "session.closed", reason: "close_requested" });
      await output;
    }
  }
});

test("rejection of the optional progress instruction neither resets audio nor emits an error or retry", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: 1_800_000_000_000,
  });
  const provider = new FakeProvider();
  const response = await handleLiveSession(
    request(),
    dependencies(provider, { durationSeconds: 240 }),
  );
  const output = response.text();
  const reminders = () =>
    provider.sent.filter(
      (event) =>
        event.type === "session.instructions.append" &&
        event.content === CONVERSATION_PROGRESS_INSTRUCTION,
    );
  try {
    provider.receive({
      type: "session.input_transcript.delta",
      delta: "تراكم العمل يرهقني ولا أجد وقتًا للراحة بعد كثرة المسؤوليات",
    });
    provider.receive({
      type: "session.output_transcript.delta",
      delta:
        "أفهم أنك تواجه ضغطًا متواصلًا من مسؤوليات العمل وأنك تحتاج إلى مساحة من الراحة والإنصات الهادئ لما تمر به في هذه الفترة.",
    });
    t.mock.timers.tick(10_000);
    const authored = reminders();
    assert.equal(authored.length, 1);
    provider.receive({
      type: "error",
      error: {
        code: "optional_instruction_rejected",
        client_event_id: authored[0].event_id,
      },
    });
    provider.receive({
      type: "session.input_transcript.delta",
      delta: "دعني أكمل حديثي، ما زلت أرغب في وصف ما حدث اليوم",
    });
    provider.receive({
      type: "session.output_transcript.delta",
      delta: "تفضّل، أنا أسمعك ويمكنك أن تأخذ وقتك في وصف ما حدث اليوم بهدوء.",
    });
    t.mock.timers.tick(10_000);
    assert.equal(reminders().length, 1);
    assert.equal(provider.readyState, WebSocket.OPEN);
  } finally {
    provider.receive({ type: "session.closed", reason: "close_requested" });
  }
  const streamed = await output;
  assert.doesNotMatch(streamed, /"type":"(?:error|recitation)"/);
  const resets = streamed
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)))
    .filter((event) => event.type === "audio_reset");
  assert.deepEqual(resets, [{ type: "audio_reset", reason: "closed" }]);
  assert.match(streamed, /دعني أكمل حديثي/);
  assert.match(streamed, /تفضّل، أنا أسمعك/);
});

test("a superseded response failure cannot release progress steering while its replacement is active", async (t) => {
  t.mock.timers.enable({
    apis: ["Date", "setTimeout", "setInterval"],
    now: 1_800_000_000_000,
  });
  for (const staleTerminal of ["response.failed", "response.incomplete"]) {
    const provider = new FakeProvider();
    const response = await handleLiveSession(
      request(),
      dependencies(provider, { durationSeconds: 240 }),
    );
    const output = response.text();
    const reminders = () =>
      provider.sent.filter(
        (event) =>
          event.type === "session.instructions.append" &&
          event.content === CONVERSATION_PROGRESS_INSTRUCTION,
      );
    const exchange = () => {
      provider.receive({
        type: "session.input_transcript.delta",
        delta: "وأريد أن أوضح أن المسؤوليات تتراكم كل يوم ولا أجد وقتًا لنفسي",
      });
      provider.receive({
        type: "session.output_transcript.delta",
        delta:
          "أفهم أنك تواجه ضغطًا متواصلًا من مسؤوليات العمل وأنك تحتاج إلى مساحة من الراحة والإنصات الهادئ لما تمر به في هذه الفترة.",
      });
    };
    try {
      provider.receive({
        type: "session.delegation.created",
        delegation: { id: "replaced-lookup" },
      });
      nested(provider, "replaced-lookup", {
        type: "response.created",
        response: { id: "old-response" },
      });
      nested(provider, "replaced-lookup", {
        type: "response.created",
        response: { id: "current-response" },
      });
      nested(provider, "replaced-lookup", {
        type: staleTerminal,
        response: { id: "old-response" },
      });
      exchange();
      t.mock.timers.tick(10_000);
      assert.equal(
        reminders().length,
        0,
        `${staleTerminal}: the old terminal event cannot mark the replacement idle`,
      );
      nested(provider, "replaced-lookup", {
        type: "response.completed",
        response: { id: "current-response" },
      });
      exchange();
      t.mock.timers.tick(10_000);
      assert.equal(
        reminders().length,
        1,
        `${staleTerminal}: only the current response terminal releases the delegation`,
      );
    } finally {
      provider.receive({ type: "session.closed", reason: "close_requested" });
    }
    const streamed = await output;
    assert.doesNotMatch(streamed, /"type":"(?:error|recitation)"/);
  }
});
