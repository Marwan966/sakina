import test, { beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import WebSocket from "ws";
import {
  cookieHeader,
  readLiveBody,
  signGrant,
  verifyGrant,
  verifyOrigin,
} from "../apps/sakina/lib/live-security";
import {
  createLiveConfiguration,
  LIVE_MODEL,
} from "../apps/sakina/lib/live-config";
import {
  controlInstruction,
  handleLiveControl,
} from "../apps/sakina/lib/live-control";
import {
  executeLiveTool,
  handleLiveSession,
  sessionRequestSchema,
  type VoiceToolState,
  type VoiceEvent,
} from "../apps/sakina/lib/live-session";

const oldEnvironment = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_LIVE_ENABLED: process.env.OPENAI_LIVE_ENABLED,
  LIVE_SESSION_SECRET: process.env.LIVE_SESSION_SECRET,
};
const SECRET = "test-only-signing-secret-of-sufficient-length";
// Sakina has a CommonJS package boundary under tsx; use the same constructor as its routes.
const { HttpError } = createRequire(import.meta.url)(
  "@platform/core/http",
) as typeof import("@platform/core/http");
beforeEach(() => {
  process.env.OPENAI_API_KEY = "test-api-credential";
  process.env.OPENAI_LIVE_ENABLED = "true";
  process.env.LIVE_SESSION_SECRET = SECRET;
});
after(() => {
  for (const [name, value] of Object.entries(oldEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

import { getRecitation } from "../apps/sakina/lib/recitations";
import type { QuranSearchResult } from "../apps/sakina/lib/quran-search";
const testCandidate = {
  id: "ayah-94-5",
  recitation: getRecitation("sharh")!,
  verses: [
    {
      key: "94:5",
      text: "test source verse",
      tafsir: "test source commentary",
      tafsirSourceUrl: "https://quran.com/94:5/tafsirs/ar-tafsir-muyassar",
    },
  ],
  surroundingVerses: [{ key: "94:4", text: "test source context" }],
  source: "test_fixture",
};
const groundedFields = (searchId: string) => ({
  searchId,
  candidateId: testCandidate.id,
  connection: "تذكير باليسر في وقت تراكم مسؤوليات العمل دون وعد بزوال المشكلة",
});

const SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";
function request(
  payload: unknown = { sdp: SDP, consent: true },
  options: { origin?: string; cookie?: string; signal?: AbortSignal } = {},
) {
  return new Request("https://sakina.example/api/live/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: options.origin ?? "https://sakina.example",
      ...(options.cookie ? { Cookie: options.cookie } : {}),
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  });
}

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent: Record<string, any>[] = [];
  send(raw: string) {
    const event = JSON.parse(raw);
    this.sent.push(event);
    if (event.type === "session.close")
      queueMicrotask(() =>
        this.receive({
          type: "session.closed",
          reason: "close_requested",
          usage: { seconds: 1 },
        }),
      );
    if (
      event.type === "session.instructions.append" ||
      event.type === "session.commentary.append"
    )
      queueMicrotask(() =>
        this.receive({
          type: event.type.replace(/append$/, "appended"),
          client_event_id: event.event_id,
        }),
      );
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
  terminate() {
    this.close();
  }
  asSocket() {
    return this as unknown as WebSocket;
  }
}
function dependencies(socket = new FakeSocket()) {
  let requests = 0;
  let reserved = 0;
  const deps = {
    fetch: (async (_url, init) => {
      requests++;
      assert.equal(JSON.parse(String(init?.body)).session.model, LIVE_MODEL);
      return Response.json({
        session: { id: "live_test" },
        transport: { type: "webrtc", sdp: SDP },
      });
    }) as typeof fetch,
    connect: async () => socket.asSocket(),
    reserve: async () => {
      reserved++;
    },
    close: async () => true,
    search: async () => ({
      status: "ok" as const,
      candidates: [testCandidate],
    }),
  };
  return {
    socket,
    deps,
    get requests() {
      return requests;
    },
    get reserved() {
      return reserved;
    },
  };
}

test("live grants bind session, resist tampering, and expire with close-only grace", () => {
  const token = signGrant("live_one", 2000, SECRET);
  assert.equal(
    verifyGrant(token, "live_one", SECRET, 1000).sessionId,
    "live_one",
  );
  assert.throws(() => verifyGrant(token, "live_two", SECRET, 1000), HttpError);
  assert.throws(
    () => verifyGrant(token + "x", "live_one", SECRET, 1000),
    HttpError,
  );
  assert.throws(() => verifyGrant(token, "live_one", SECRET, 2000), HttpError);
  assert.equal(
    verifyGrant(token, "live_one", SECRET, 2001, true).sessionId,
    "live_one",
  );
  assert.throws(
    () => verifyGrant(token, "live_one", SECRET, 62000, true),
    HttpError,
  );
  assert.match(
    cookieHeader(token),
    /HttpOnly; SameSite=Strict; Path=\/api\/live/,
  );
});

test("live entrypoints require an exact origin including requests without Origin", () => {
  assert.throws(
    () => verifyOrigin(request(undefined, { origin: "https://evil.example" })),
    HttpError,
  );
  assert.throws(
    () => verifyOrigin(new Request("https://sakina.example/api/live/session")),
    HttpError,
  );
  assert.doesNotThrow(() => verifyOrigin(request()));
});

test("live body checks actual bytes and prohibits client-selected instructions or model", async () => {
  await assert.rejects(
    readLiveBody(
      request({ sdp: SDP, consent: true, model: "other" }),
      sessionRequestSchema,
    ),
    HttpError,
  );
  await assert.rejects(
    readLiveBody(
      request({ sdp: "x".repeat(40_000), consent: true }),
      sessionRequestSchema,
    ),
    HttpError,
  );
  await assert.rejects(
    readLiveBody(request({ sdp: SDP, consent: false }), sessionRequestSchema),
    HttpError,
  );
});

test("invalid and unconsented requests never call paid providers or reserve quotas", async () => {
  const context = dependencies();
  const response = await handleLiveSession(
    request({ sdp: SDP, consent: false }),
    context.deps,
  );
  assert.equal(response.status, 400);
  assert.equal(context.requests, 0);
  assert.equal(context.reserved, 0);
});

test("budget rejection fails closed before paid session creation", async () => {
  const context = dependencies();
  const response = await handleLiveSession(request(), {
    ...context.deps,
    reserve: async () => {
      throw new HttpError(429, "budget");
    },
  });
  assert.equal(response.status, 429);
  assert.equal(context.requests, 0);
});

test("disabled live feature does not contact provider", async () => {
  process.env.OPENAI_LIVE_ENABLED = "false";
  const context = dependencies();
  assert.equal((await handleLiveSession(request(), context.deps)).status, 503);
  assert.equal(context.requests, 0);
});

test("provider failure returns an authored message and never leaks provider body", async () => {
  const context = dependencies();
  const response = await handleLiveSession(request(), {
    ...context.deps,
    fetch: (async () =>
      Response.json(
        { error: "private-provider-detail test-api-credential" },
        { status: 401 },
      )) as typeof fetch,
  });
  assert.equal(response.status, 503);
  const output = await response.text();
  assert.doesNotMatch(output, /private-provider-detail|test-api-credential/);
});

test("session starts as one SSE stream, signs a cookie, and owns cancellation cleanup", async () => {
  const context = dependencies();
  const response = await handleLiveSession(request(), context.deps);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
  assert.match(response.headers.get("set-cookie")!, /HttpOnly/);
  const reader = response.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"type":"session"/);
  assert.match(first, /"model":"gpt-live-1"/);
  assert.doesNotMatch(first, /test-api-credential|test-only-signing/);
  await reader.cancel();
  assert.equal(
    context.socket.sent.filter((e) => e.type === "session.close").length,
    1,
  );
  assert.equal(context.socket.readyState, WebSocket.CLOSED);
});

test("server deadline closes provider without relying on browser timer or events", async () => {
  const context = dependencies();
  const response = await handleLiveSession(request(), {
    ...context.deps,
    durationSeconds: 0.03,
  });
  const output = await response.text();
  assert.match(output, /"reason":"expired"/);
  assert.match(output, /"finalized":true/);
  assert.equal(
    context.socket.sent.filter((e) => e.type === "session.close").length,
    1,
  );
});

test("thirty interrupted provider replies do not spend the tool-loop budget or close the call", async () => {
  const context = dependencies();
  const response = await handleLiveSession(request(), context.deps);
  for (let index = 0; index < 30; index++) {
    context.socket.receive({
      type: "response.event",
      delegation_id: "interrupted",
      event: { type: "response.created", response: { id: `reply_${index}` } },
    });
  }
  assert.equal(
    context.socket.sent.some((e) => e.type === "session.close"),
    false,
  );
  context.socket.receive({ type: "session.closed" });
  assert.doesNotMatch(await response.text(), /"fatal":true|usage_limit/);
});

test("malformed PCM is dropped and valid audio still streams in the same call", async () => {
  const context = dependencies();
  const response = await handleLiveSession(request(), context.deps);
  for (const delta of ["A", "AA=", "AAAA=", "AAAA", "", "!bad!"]) {
    context.socket.receive({
      type: "session.output_audio.delta",
      delta,
      start_ms: 0,
      end_ms: 100,
    });
  }
  const valid = Buffer.alloc(4800).toString("base64");
  context.socket.receive({
    type: "session.output_audio.delta",
    delta: valid,
    start_ms: 0,
    end_ms: 100,
  });
  context.socket.receive({ type: "session.closed" });
  const output = await response.text();
  assert.equal((output.match(/"type":"audio"/g) || []).length, 1);
  assert.ok(output.includes(valid));
  assert.doesNotMatch(output, /"fatal":true/);
});

test("a repeated tool chain pauses actions without ending voice and new speech permits a fresh chain", async () => {
  const context = dependencies();
  const response = await handleLiveSession(request(), context.deps);
  const speak = () =>
    context.socket.receive({
      type: "session.input_transcript.delta",
      delta: "مسؤوليات العمل لا تترك وقتًا للراحة",
      start_ms: 0,
      end_ms: 100,
    });
  const call = (index: number) => {
    const responseId = `tool_${index}`;
    const send = (event: unknown) =>
      context.socket.receive({
        type: "response.event",
        delegation_id: "tool_chain",
        event,
      });
    send({ type: "response.created", response: { id: responseId } });
    send({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: `call_${index}`,
        name: "prepare_relevant_recitation",
        arguments: JSON.stringify({
          intent: "overwhelmed",
          fit: "supported",
          safety: "ordinary",
          userConcern: "مسؤوليات العمل لا تترك وقتًا للراحة",
        }),
      },
    });
    send({ type: "response.completed", response: { id: responseId } });
  };
  speak();
  for (let index = 0; index < 14; index++) call(index);
  assert.equal(
    context.socket.sent.filter((e) => e.type === "response.create").length,
    12,
  );
  assert.ok(
    context.socket.sent.some((e) =>
      e.item?.output?.includes('"status":"input_required"'),
    ),
  );
  assert.equal(
    context.socket.sent.some((e) => e.type === "session.close"),
    false,
  );
  speak();
  call(14);
  assert.equal(
    context.socket.sent.filter((e) => e.type === "response.create").length,
    13,
  );
  context.socket.receive({ type: "session.closed" });
  assert.doesNotMatch(
    await response.text(),
    /"fatal":true|"type":"recitation"/,
  );
});

test("failed sideband startup closes already-created provider session", async () => {
  const context = dependencies();
  let closed = "";
  const response = await handleLiveSession(request(), {
    ...context.deps,
    connect: async () => {
      throw new Error("private transport detail");
    },
    close: async (id) => {
      closed = id;
      return true;
    },
  });
  assert.equal(response.status, 503);
  assert.equal(closed, "live_test");
});

test("malformed provider transport still closes a recoverable provider session ID", async () => {
  const context = dependencies();
  let closed = "";
  const response = await handleLiveSession(request(), {
    ...context.deps,
    fetch: (async () =>
      Response.json({
        session: { id: "live_incomplete" },
        transport: {},
      })) as typeof fetch,
    close: async (id) => {
      closed = id;
      return true;
    },
  });
  assert.equal(response.status, 503);
  assert.equal(closed, "live_incomplete");
});

test("sideband connection loss uses a fresh trusted close attempt", async () => {
  const context = dependencies();
  let closed = "";
  const response = await handleLiveSession(request(), {
    ...context.deps,
    close: async (id) => {
      closed = id;
      return true;
    },
  });
  context.socket.close();
  assert.match(await response.text(), /"finalized":true/);
  assert.equal(closed, "live_test");
});

test("reflected audio preserves provider timestamps and rejects malformed or oversized frames", async () => {
  const context = dependencies();
  const response = await handleLiveSession(request(), context.deps);
  context.socket.receive({
    type: "session.output_audio.delta",
    delta: "AAAAAA==",
    start_ms: 100,
    end_ms: 120,
  });
  context.socket.receive({
    type: "session.output_audio.delta",
    delta: "!bad!",
    start_ms: 120,
    end_ms: 140,
  });
  context.socket.receive({
    type: "session.output_audio.delta",
    delta: "AAAAAA==",
    start_ms: 120,
    end_ms: 110,
  });
  context.socket.receive({
    type: "session.output_audio.delta",
    delta: "A".repeat(262_145),
    start_ms: 120,
    end_ms: 140,
  });
  context.socket.receive({ type: "session.closed", reason: "close_requested" });
  const output = await response.text();
  assert.equal(output.match(/"type":"audio"/g)?.length, 1);
  assert.match(output, /"startMs":100,"endMs":120/);
  assert.match(output, /"type":"audio_reset"/);
});

test("tools demand present consent and safety instead of inventing scripture", () => {
  const events: unknown[] = [];
  const state: VoiceToolState = { recentIds: [], urgent: false };
  const call = {
    call_id: "call_1",
    name: "recommend_recitation",
    arguments: JSON.stringify({
      intent: "overwhelmed",
      consent: false,
      safety: "ordinary",
      requestedId: null,
    }),
  };
  assert.equal(
    executeLiveTool(call, state, (e) => events.push(e)).status,
    "awaiting_consent",
  );
  assert.equal(events.length, 0);
  call.arguments = JSON.stringify({
    intent: "explicit_request",
    consent: true,
    safety: "ordinary",
    requestedId: "sharh",
  });
  assert.equal(
    executeLiveTool(call, state, (e) => events.push(e)).status,
    "ready",
  );
  assert.equal(events.length, 1);
  assert.equal(state.recentIds.length, 1);
  state.urgent = true;
  assert.equal(
    executeLiveTool(call, state, (e) => events.push(e)).status,
    "safety",
  );
  assert.equal(events.length, 2);
});

function prepareProposal(
  state: VoiceToolState,
  emit: (event: any) => void = () => {},
) {
  return executeLiveTool(
    {
      call_id: "prepare",
      inputRevision: 10,
      name: "prepare_relevant_recitation",
      arguments: JSON.stringify({
        intent: "overwhelmed",
        fit: "supported",
        safety: "ordinary",
        userConcern: "تتراكم مسؤوليات العمل حتى لم يعد يجد وقتًا للراحة",
      }),
    },
    state,
    emit,
  );
}

function confirmation(
  state: VoiceToolState,
  overrides: Record<string, unknown> = {},
  revision = 11,
) {
  return {
    call_id: "confirm",
    inputRevision: revision,
    name: "recommend_recitation",
    arguments: JSON.stringify({
      intent: "overwhelmed",
      consent: true,
      safety: "ordinary",
      requestedId: null,
      proposalId: state.proposal?.id ?? null,
      contextStillApplies: true,
      ...overrides,
    }),
  };
}

test("thematic proposal returns source context without playback and requires a fresh consent turn", () => {
  const state: VoiceToolState = { recentIds: [], urgent: false };
  const events: unknown[] = [];
  const emit = (event: unknown) => events.push(event);
  const proposed = prepareProposal(state, emit);
  assert.equal(proposed.status, "proposed");
  assert.ok("context" in proposed && proposed.context);
  assert.ok(
    "userConcern" in proposed && proposed.userConcern.includes("العمل"),
  );
  assert.equal(events.length, 0);
  assert.deepEqual(state.recentIds, []);
  assert.equal(
    executeLiveTool(confirmation(state, {}, 10), state, emit).status,
    "awaiting_consent",
  );
  assert.equal(events.length, 0);
  assert.equal(
    executeLiveTool(
      confirmation(
        state,
        { intent: "explicit_request", requestedId: "sharh", proposalId: null },
        10,
      ),
      state,
      emit,
    ).status,
    "awaiting_consent",
  );
  assert.equal(events.length, 0);
  assert.equal(
    executeLiveTool(confirmation(state), state, emit).status,
    "ready",
  );
  assert.equal(events.length, 1);
  assert.deepEqual(state.recentIds, ["sharh"]);
  assert.equal(state.proposal, undefined);
  assert.equal(
    executeLiveTool(confirmation(state), state, emit).status,
    "clarify",
  );
  assert.equal(events.length, 1);
});

test("thematic playback fails closed without a held proposal or with changed, expired or substituted proposals", () => {
  for (const variant of [
    "missing",
    "wrong_id",
    "changed",
    "expired",
    "substituted",
    "wrong_theme",
  ]) {
    const state: VoiceToolState = { recentIds: [], urgent: false };
    const events: unknown[] = [];
    if (variant !== "missing") prepareProposal(state);
    if (variant === "expired") state.proposal!.expiresAt = Date.now() - 1;
    const overrides =
      variant === "wrong_id"
        ? { proposalId: "invented" }
        : variant === "changed"
          ? { contextStillApplies: false }
          : variant === "substituted"
            ? { requestedId: "duha" }
            : variant === "wrong_theme"
              ? { intent: "seeking_refuge" }
              : {};
    assert.equal(
      executeLiveTool(confirmation(state, overrides), state, (e) =>
        events.push(e),
      ).status,
      "clarify",
      variant,
    );
    assert.equal(events.length, 0, variant);
    // Rejected authorization cannot erase the canonical selection.
    assert.equal(Boolean(state.proposal), variant !== "missing", variant);
  }
});

test("refusal and topic change cancel proposals; a later stale confirmation cannot play them", () => {
  for (const reason of ["declined", "context_changed"]) {
    const state: VoiceToolState = { recentIds: [], urgent: false };
    prepareProposal(state);
    const heldConfirmation = confirmation(state);
    assert.equal(
      executeLiveTool(
        {
          call_id: "dismiss",
          name: "dismiss_recitation_proposal",
          arguments: JSON.stringify({ reason }),
        },
        state,
        () => {},
      ).status,
      "dismissed",
    );
    assert.equal(
      executeLiveTool(heldConfirmation, state, () => {
        throw new Error("unexpected playback");
      }).status,
      reason === "declined" ? "declined" : "clarify",
    );
  }
  const state: VoiceToolState = { recentIds: [], urgent: false };
  prepareProposal(state);
  assert.equal(
    executeLiveTool(confirmation(state, { consent: false }), state, () => {})
      .status,
    "awaiting_consent",
  );
  assert.ok(state.proposal);
});

test("explicit refusal or listen-only preference blocks later proactive lookup even without an existing proposal", () => {
  for (const withProposal of [false, true]) {
    const state: VoiceToolState = { recentIds: [], urgent: false };
    if (withProposal) prepareProposal(state);
    const events: VoiceEvent[] = [];
    executeLiveTool(
      {
        call_id: "decline",
        inputRevision: 11,
        name: "dismiss_recitation_proposal",
        arguments: JSON.stringify({ reason: "declined" }),
      },
      state,
      (event) => events.push(event),
    );
    assert.equal(state.proactiveSuppressed, true);
    assert.equal(state.suppressedAtRevision, 11);
    state.inputRevision = 12;
    assert.equal(
      prepareProposal(state, (event) => events.push(event)).status,
      "declined",
    );
    executeLiveTool(
      {
        call_id: "new_topic",
        inputRevision: 12,
        name: "dismiss_recitation_proposal",
        arguments: JSON.stringify({ reason: "context_changed" }),
      },
      state,
      () => {},
    );
    assert.equal(prepareProposal(state).status, "declined");
    assert.equal(state.proposal, undefined);
    assert.deepEqual(events, []);
  }
});

test("context change and missing playback consent do not invent an explicit refusal", () => {
  const state: VoiceToolState = { recentIds: [], urgent: false };
  prepareProposal(state);
  executeLiveTool(
    {
      call_id: "change",
      inputRevision: 11,
      name: "dismiss_recitation_proposal",
      arguments: JSON.stringify({ reason: "context_changed" }),
    },
    state,
    () => {},
  );
  assert.equal(state.proactiveSuppressed, undefined);
  assert.equal(prepareProposal(state).status, "proposed");
  assert.equal(
    executeLiveTool(confirmation(state, { consent: false }), state, () => {})
      .status,
    "awaiting_consent",
  );
  assert.equal(state.proactiveSuppressed, undefined);
  assert.equal(prepareProposal(state).status, "proposed");
});

test("only a newer valid exact named request can reopen recitation after an explicit refusal", () => {
  const state: VoiceToolState = { recentIds: [], urgent: false };
  const events: VoiceEvent[] = [];
  const emit = (event: VoiceEvent) => events.push(event);
  executeLiveTool(
    {
      call_id: "decline",
      inputRevision: 11,
      name: "dismiss_recitation_proposal",
      arguments: JSON.stringify({ reason: "declined" }),
    },
    state,
    emit,
  );
  const named = {
    intent: "explicit_request",
    requestedId: "sharh",
    proposalId: null,
  };
  assert.equal(
    executeLiveTool(confirmation(state, named, 11), state, emit).status,
    "declined",
  );
  assert.equal(
    executeLiveTool(confirmation(state, {}, 12), state, emit).status,
    "declined",
  );
  assert.equal(
    executeLiveTool(
      confirmation(state, { ...named, requestedId: null }, 12),
      state,
      emit,
    ).status,
    "unavailable",
  );
  assert.equal(state.proactiveSuppressed, true);
  assert.equal(events.length, 0);
  assert.equal(
    executeLiveTool(confirmation(state, named, 13), state, emit).status,
    "ready",
  );
  assert.equal(state.proactiveSuppressed, false);
  assert.equal(state.suppressedAtRevision, undefined);
  assert.equal(events.filter((event) => event.type === "recitation").length, 1);
});

test("minor or uncertain human-support paths block later ordinary preparation and named playback for the session", () => {
  const starts = [
    { name: "report_support_need", arguments: { urgency: "clarify" } },
    { name: "report_support_need", arguments: { urgency: "immediate" } },
    {
      name: "prepare_relevant_recitation",
      arguments: {
        intent: "overwhelmed",
        fit: "supported",
        safety: "uncertain",
        userConcern: "لديه مسؤوليات عمل كثيرة",
      },
    },
    {
      name: "recommend_recitation",
      arguments: {
        intent: "explicit_request",
        safety: "uncertain",
        consent: true,
        requestedId: "sharh",
      },
    },
  ];
  for (const start of starts) {
    const state: VoiceToolState = { recentIds: [], urgent: false };
    const events: VoiceEvent[] = [];
    const emit = (event: VoiceEvent) => events.push(event);
    executeLiveTool(
      {
        call_id: "support",
        inputRevision: 11,
        name: start.name,
        arguments: JSON.stringify(start.arguments),
      },
      state,
      emit,
    );
    assert.equal(state.supportRequired, true);
    assert.equal(prepareProposal(state, emit).status, "safety");
    assert.equal(
      executeLiveTool(
        confirmation(
          state,
          {
            intent: "explicit_request",
            requestedId: "sharh",
            proposalId: null,
          },
          12,
        ),
        state,
        emit,
      ).status,
      "safety",
    );
    assert.equal(state.supportRequired, true);
    assert.equal(state.proposal, undefined);
    assert.equal(
      events.filter((event) => event.type === "recitation").length,
      0,
    );
    assert.ok(events.some((event) => event.type === "support"));
  }
});

test("a new unsupported named request replaces the held candidate instead of leaving an old yes-target", () => {
  const state: VoiceToolState = { recentIds: [], urgent: false };
  prepareProposal(state);
  const oldConfirmation = confirmation(state, {}, 12);
  assert.equal(
    executeLiveTool(
      confirmation(
        state,
        { intent: "explicit_request", requestedId: null, proposalId: null },
        11,
      ),
      state,
      () => {
        throw new Error("unexpected playback");
      },
    ).status,
    "unavailable",
  );
  assert.equal(state.proposal, undefined);
  assert.equal(
    executeLiveTool(oldConfirmation, state, () => {
      throw new Error("unexpected playback");
    }).status,
    "clarify",
  );
});

test("unsafe or ambiguous preparation neither plays audio nor preserves an earlier candidate", () => {
  for (const overrides of [
    { safety: "urgent" },
    { safety: "uncertain" },
    { fit: "uncertain" },
    { fit: "unsupported" },
    { intent: "unclear" },
  ]) {
    const state: VoiceToolState = { recentIds: [], urgent: false };
    prepareProposal(state);
    const events: { type: string }[] = [];
    const result = executeLiveTool(
      {
        call_id: "new_prepare",
        inputRevision: 11,
        name: "prepare_relevant_recitation",
        arguments: JSON.stringify({
          intent: "overwhelmed",
          fit: "supported",
          safety: "ordinary",
          userConcern: "لديه مسؤوليات عمل كثيرة",
          ...overrides,
        }),
      },
      state,
      (e) => events.push(e),
    );
    assert.notEqual(result.status, "proposed");
    assert.equal(state.proposal, undefined);
    assert.equal(events.filter((e) => e.type === "recitation").length, 0);
    if (overrides.safety === "urgent") assert.equal(state.urgent, true);
  }
});

test("urgency from the recitation tool is sticky and surfaces human support before later ordinary requests", () => {
  const events: { type: string; [key: string]: unknown }[] = [];
  const state = { recentIds: [] as string[], urgent: false };
  const args = {
    intent: "explicit_request",
    consent: true,
    safety: "urgent",
    requestedId: "sharh",
  };
  const call = {
    call_id: "urgent",
    name: "recommend_recitation",
    arguments: JSON.stringify(args),
  };
  assert.equal(
    executeLiveTool(call, state, (e) => events.push(e)).status,
    "safety",
  );
  assert.equal(state.urgent, true);
  assert.equal(events[0].type, "support");
  assert.equal(events[0].urgent, true);
  call.arguments = JSON.stringify({ ...args, safety: "ordinary" });
  assert.equal(
    executeLiveTool(call, state, (e) => events.push(e)).status,
    "safety",
  );
  assert.equal(events.filter((e) => e.type === "recitation").length, 0);
  assert.deepEqual(state.recentIds, []);
});

test("unknown tool names and malformed arguments cannot dispatch arbitrary work", () => {
  const state = { recentIds: [] as string[], urgent: false };
  const emit = () => {
    throw new Error("unexpected event");
  };
  assert.equal(
    executeLiveTool(
      { call_id: "c", name: "shell", arguments: "{}" },
      state,
      emit,
    ).status,
    "unavailable",
  );
  assert.equal(
    executeLiveTool(
      { call_id: "c", name: "recommend_recitation", arguments: "{" },
      state,
      emit,
    ).status,
    "invalid",
  );
});

test("nested completed function calls execute once and resume Responses only after completion", async () => {
  const context = dependencies();
  const response = await handleLiveSession(request(), context.deps);
  context.socket.receive({
    type: "session.input_transcript.delta",
    delta: "شغل سورة الشرح الآن",
  });
  const nested = (event: unknown) =>
    context.socket.receive({
      type: "response.event",
      delegation_id: "delegation_1",
      event,
    });
  nested({ type: "response.created", response: { id: "resp_1" } });
  const item = {
    type: "function_call",
    call_id: "call_one",
    name: "recommend_recitation",
    arguments: JSON.stringify({
      intent: "explicit_request",
      consent: true,
      safety: "ordinary",
      requestedId: "sharh",
      requestEvidence: "شغل سورة الشرح الآن",
    }),
  };
  nested({ type: "response.output_item.done", item });
  nested({ type: "response.output_item.done", item });
  assert.equal(context.socket.sent.length, 0);
  nested({
    type: "response.completed",
    response: { id: "resp_1", output: [] },
  });
  nested({
    type: "response.completed",
    response: { id: "resp_1", output: [] },
  });
  assert.equal(
    context.socket.sent.filter((e) => e.type === "response.item.create").length,
    1,
  );
  assert.equal(
    context.socket.sent.filter((e) => e.type === "response.create").length,
    1,
  );
  context.socket.receive({
    type: "session.closed",
    reason: "close_requested",
    usage: { seconds: 2 },
  });
  const output = await response.text();
  assert.equal(output.match(/"type":"recitation"/g)?.length, 1);
  assert.match(output, /yasser-dosari/);
});

test("client capability allowlist blocks arbitrary instructions, tools, and backend updates", () => {
  const config = createLiveConfiguration();
  assert.deepEqual(config.client.data_channel.allowed_client_events, [
    "session.close",
    "session.input_audio.mute",
    "session.input_audio.unmute",
  ]);
  assert.equal(config.store, false);
  assert.equal(config.model, "gpt-live-1");
  assert.equal(config.delegation.responses.max_output_tokens, 900);
});

test("superseded response completion and stale consent cannot play a recitation", async () => {
  const context = dependencies();
  const response = await handleLiveSession(request(), context.deps);
  const nested = (event: unknown) =>
    context.socket.receive({
      type: "response.event",
      delegation_id: "delegation_1",
      event,
    });
  const item = {
    type: "function_call",
    call_id: "old_call",
    name: "recommend_recitation",
    arguments: JSON.stringify({
      intent: "explicit_request",
      consent: true,
      safety: "ordinary",
      requestedId: "sharh",
    }),
  };
  nested({ type: "response.created", response: { id: "old" } });
  nested({ type: "response.output_item.done", item });
  nested({ type: "response.created", response: { id: "new" } });
  nested({ type: "response.completed", response: { id: "old" } });
  assert.equal(context.socket.sent.length, 0);
  nested({
    type: "response.output_item.done",
    item: { ...item, call_id: "new_call" },
  });
  context.socket.receive({
    type: "session.input_transcript.delta",
    delta: "لا أريد الاستماع الآن",
    start_ms: 10,
    end_ms: 20,
  });
  nested({ type: "response.completed", response: { id: "new" } });
  const output = context.socket.sent.find(
    (e) => e.type === "response.item.create",
  )!.item.output;
  assert.equal(JSON.parse(output).status, "context_updated");
  context.socket.receive({ type: "session.closed", reason: "close_requested" });
  assert.doesNotMatch(await response.text(), /"type":"recitation"/);
});

test("revoked consent during backend generation stays revoked before the tool item arrives", async () => {
  const context = dependencies();
  const response = await handleLiveSession(request(), context.deps);
  const nested = (event: unknown) =>
    context.socket.receive({
      type: "response.event",
      delegation_id: "delegation_1",
      event,
    });
  nested({ type: "response.created", response: { id: "response_1" } });
  context.socket.receive({
    type: "session.input_transcript.delta",
    delta: "لا تشغلها",
    start_ms: 10,
    end_ms: 20,
  });
  nested({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: "call_1",
      name: "recommend_recitation",
      arguments: JSON.stringify({
        intent: "explicit_request",
        consent: true,
        safety: "ordinary",
        requestedId: "sharh",
      }),
    },
  });
  nested({ type: "response.completed", response: { id: "response_1" } });
  assert.equal(
    JSON.parse(
      context.socket.sent.find((e) => e.type === "response.item.create")!.item
        .output,
    ).status,
    "context_updated",
  );
  context.socket.receive({ type: "session.closed", reason: "close_requested" });
  assert.doesNotMatch(await response.text(), /"type":"recitation"/);
});

async function seedRuntimeSearch(socket: FakeSocket, id = "seed_search") {
  socket.receive({ type: "session.delegation.created", delegation: { id } });
  const nested = (event: unknown) =>
    socket.receive({ type: "response.event", delegation_id: id, event });
  nested({ type: "response.created", response: { id } });
  nested({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: id,
      name: "search_quran",
      arguments: JSON.stringify({
        query: "العمل وضغط المسؤوليات",
        concepts: ["حدود الطاقة", "التخفيف واليسر"],
        references: [],
        safety: "ordinary",
      }),
    },
  });
  nested({ type: "response.completed", response: { id } });
  await new Promise((resolve) => setImmediate(resolve));
  const result = JSON.parse(
    socket.sent.filter((event) => event.item?.call_id === id).at(-1)!.item
      .output,
  );
  assert.equal(result.status, "candidates");
  return groundedFields(result.searchId);
}

test("live stream proposes without audio, rejects stale preparation, then confirms only on a new consent delegation", async () => {
  const context = dependencies();
  const response = await handleLiveSession(request(), context.deps);
  const input = (delta: string) =>
    context.socket.receive({
      type: "session.input_transcript.delta",
      delta,
      start_ms: 10,
      end_ms: 20,
    });
  const run = (
    id: string,
    name: string,
    args: unknown,
    beforeComplete?: () => void,
  ) => {
    context.socket.receive({
      type: "session.delegation.created",
      delegation: { id },
    });
    const nested = (event: unknown) =>
      context.socket.receive({
        type: "response.event",
        delegation_id: id,
        event,
      });
    nested({ type: "response.created", response: { id } });
    nested({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: id,
        name,
        arguments: JSON.stringify(args),
      },
    });
    beforeComplete?.();
    nested({ type: "response.completed", response: { id } });
    return JSON.parse(
      context.socket.sent
        .filter((e) => e.type === "response.item.create")
        .at(-1)!.item.output,
    );
  };
  input("مسؤوليات العمل لا تترك لي وقتًا للراحة");
  const args = {
    intent: "overwhelmed",
    fit: "supported",
    safety: "ordinary",
    userConcern: "مسؤوليات العمل لا تترك وقتًا للراحة",
  };
  const stale = run("stale", "prepare_relevant_recitation", args, () =>
    input("لكن أريد توضيح شيء آخر"),
  );
  assert.equal(stale.status, "context_updated");
  Object.assign(args, await seedRuntimeSearch(context.socket));
  const proposed = run("proposal", "prepare_relevant_recitation", args);
  assert.equal(proposed.status, "proposed");
  const consent = {
    intent: "overwhelmed",
    consent: true,
    safety: "ordinary",
    requestedId: null,
    proposalId: proposed.proposalId,
    contextStillApplies: true,
  };
  assert.equal(
    run("premature", "recommend_recitation", consent).status,
    "awaiting_consent",
  );
  input("نعم، أريد سماع التسجيل المقترح الآن");
  assert.equal(
    run("confirmed", "recommend_recitation", consent).status,
    "ready",
  );
  context.socket.receive({ type: "session.closed", reason: "close_requested" });
  const output = await response.text();
  assert.equal(output.match(/"type":"recitation"/g)?.length, 1);
});

test("a delayed dismissal cannot suppress or delete a newer proposal before a fresh decision", async () => {
  const context = dependencies();
  const response = await handleLiveSession(request(), context.deps);
  const input = (delta: string) =>
    context.socket.receive({
      type: "session.input_transcript.delta",
      delta,
      start_ms: 10,
      end_ms: 20,
    });
  const nested = (id: string, event: unknown) =>
    context.socket.receive({
      type: "response.event",
      delegation_id: id,
      event,
    });
  const begin = (id: string, name: string, args: unknown) => {
    context.socket.receive({
      type: "session.delegation.created",
      delegation: { id },
    });
    nested(id, { type: "response.created", response: { id } });
    nested(id, {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: id,
        name,
        arguments: JSON.stringify(args),
      },
    });
  };
  const finish = (id: string) => {
    nested(id, { type: "response.completed", response: { id } });
    return JSON.parse(
      context.socket.sent
        .filter(
          (event) =>
            event.type === "response.item.create" && event.item.call_id === id,
        )
        .at(-1)!.item.output,
    );
  };
  const args = {
    intent: "overwhelmed",
    fit: "supported",
    safety: "ordinary",
    userConcern: "مسؤوليات العمل لا تترك وقتًا للراحة",
  };
  input("لا أريد الاقتراح القديم");
  begin("old_dismiss", "dismiss_recitation_proposal", { reason: "declined" });
  input("غيّرت رأيي وأريد مقترحًا يناسب ضغط العمل");
  Object.assign(args, await seedRuntimeSearch(context.socket));
  begin("new_proposal", "prepare_relevant_recitation", args);
  const proposal = finish("new_proposal");
  assert.equal(proposal.status, "proposed");
  const stale = finish("old_dismiss");
  assert.equal(stale.status, "context_updated");
  assert.equal(stale.actionExecuted, false);
  input("نعم أريد سماع المقترح الآن");
  begin("new_confirmation", "recommend_recitation", {
    intent: "overwhelmed",
    safety: "ordinary",
    consent: true,
    requestedId: null,
    proposalId: proposal.proposalId,
    contextStillApplies: true,
  });
  assert.equal(finish("new_confirmation").status, "ready");
  context.socket.receive({ type: "session.closed", reason: "close_requested" });
  const output = await response.text();
  assert.equal(output.match(/"type":"recitation"/g)?.length, 1);
});

async function fragmentedConsentSession() {
  const context = dependencies();
  const response = await handleLiveSession(request(), context.deps);
  const input = (delta: string) =>
    context.socket.receive({
      type: "session.input_transcript.delta",
      delta,
      start_ms: 10,
      end_ms: 20,
    });
  const nested = (delegation: string, event: unknown) =>
    context.socket.receive({
      type: "response.event",
      delegation_id: delegation,
      event,
    });
  const created = (delegation: string, id: string, fresh = false) => {
    if (fresh)
      context.socket.receive({
        type: "session.delegation.created",
        delegation: { id: delegation },
      });
    nested(delegation, { type: "response.created", response: { id } });
  };
  const completed = (
    delegation: string,
    id: string,
    name: string,
    args: unknown,
  ) => {
    nested(delegation, {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: id,
        name,
        arguments: JSON.stringify(args),
      },
    });
    nested(delegation, { type: "response.completed", response: { id } });
    return JSON.parse(
      context.socket.sent
        .filter((e) => e.type === "response.item.create")
        .at(-1)!.item.output,
    );
  };
  input("العمل يستهلك كل وقت الراحة وأريد معنى مناسبًا");
  const grounded = await seedRuntimeSearch(context.socket);
  created("proposal", "proposal_response", true);
  const proposal = completed(
    "proposal",
    "proposal_response",
    "prepare_relevant_recitation",
    {
      intent: "overwhelmed",
      fit: "supported",
      safety: "ordinary",
      userConcern: "العمل يستهلك وقت راحتك",
      ...grounded,
    },
  );
  assert.equal(proposal.status, "proposed");
  const args = {
    intent: "overwhelmed",
    consent: true,
    safety: "ordinary",
    requestedId: null,
    proposalId: proposal.proposalId,
    contextStillApplies: true,
  };
  const fragments = [
    " نعم،",
    " أريد",
    " أن",
    " أسمع",
    " هذا",
    " التسجيل",
    " المقترح",
    " بصوت",
    " القارئ",
    " الآن",
    " وبعد",
    " ذلك",
    " نكمل",
    " الحديث.",
  ];
  input(fragments[0]);
  created("consent", "consent_old", true);
  for (const fragment of fragments.slice(1)) input(fragment);
  const stale = completed(
    "consent",
    "consent_old",
    "recommend_recitation",
    args,
  );
  assert.equal(stale.status, "context_updated");
  assert.equal(stale.actionExecuted, false);
  assert.equal(stale.snapshotRevision, 15);
  assert.equal(stale.userSpeech.trust, "untrusted_user_transcript");
  assert.ok(stale.userSpeech.text.endsWith(fragments.join("")));
  assert.equal(stale.proposal.id, proposal.proposalId);
  const close = async () => {
    context.socket.receive({
      type: "session.closed",
      reason: "close_requested",
    });
    return response.text();
  };
  return { context, input, created, completed, args, close };
}

test("fourteen consent fragments require a fresh backend decision rather than replaying stale arguments", async () => {
  const flow = await fragmentedConsentSession();
  flow.created("consent", "consent_fresh");
  const confirmed = flow.completed(
    "consent",
    "consent_fresh",
    "recommend_recitation",
    flow.args,
  );
  assert.equal(confirmed.status, "ready");
  assert.equal(confirmed.recitationId, "sharh");
  assert.equal((await flow.close()).match(/"type":"recitation"/g)?.length, 1);
});

test("later revocation during revalidation invalidates the new snapshot and can dismiss the held proposal", async () => {
  const flow = await fragmentedConsentSession();
  flow.created("consent", "consent_fresh");
  flow.input(" لا، غيّرت رأيي، لا تشغّل التسجيل.");
  const stale = flow.completed(
    "consent",
    "consent_fresh",
    "recommend_recitation",
    flow.args,
  );
  assert.equal(stale.status, "context_updated");
  assert.match(stale.userSpeech.newFragments, /لا تشغّل التسجيل/);
  flow.created("consent", "revocation_review");
  assert.equal(
    flow.completed(
      "consent",
      "revocation_review",
      "dismiss_recitation_proposal",
      { reason: "declined" },
    ).status,
    "dismissed",
  );
  assert.doesNotMatch(await flow.close(), /"type":"recitation"/);
});

test("speech arriving before revalidation response.created cannot silently advance the reserved snapshot", async () => {
  const flow = await fragmentedConsentSession();
  flow.input(" انتظر، لا أريد سماعها.");
  flow.created("consent", "created_late");
  const result = flow.completed(
    "consent",
    "created_late",
    "recommend_recitation",
    flow.args,
  );
  assert.equal(result.status, "context_updated");
  assert.match(result.userSpeech.newFragments, /لا أريد/);
  assert.doesNotMatch(await flow.close(), /"type":"recitation"/);
});

test("continued fragments exhaust two revalidations without playback, loops or post-close work", async () => {
  const flow = await fragmentedConsentSession();
  flow.created("consent", "second_decision");
  flow.input(" وأريد أن أوضح شيئًا");
  assert.equal(
    flow.completed(
      "consent",
      "second_decision",
      "recommend_recitation",
      flow.args,
    ).status,
    "context_updated",
  );
  flow.created("consent", "third_decision");
  flow.input(" لا يزال لدي كلام");
  const before = flow.context.socket.sent.filter(
    (e) => e.type === "response.create",
  ).length;
  assert.equal(
    flow.completed(
      "consent",
      "third_decision",
      "recommend_recitation",
      flow.args,
    ).status,
    "input_unstable",
  );
  assert.equal(
    flow.context.socket.sent.filter((e) => e.type === "response.create").length,
    before,
  );
  assert.equal(
    flow.context.socket.sent.at(-1)!.type,
    "session.thinking.append",
  );
  assert.doesNotMatch(await flow.close(), /"type":"recitation"/);
  const count = flow.context.socket.sent.length;
  flow.input("نعم");
  flow.created("consent", "after_close");
  assert.equal(flow.context.socket.sent.length, count);
  assert.equal(flow.context.socket.listenerCount("message"), 0);
});

test("truncated changed-input context fails closed rather than authorizing from an incomplete tail", async () => {
  const flow = await fragmentedConsentSession();
  flow.created("consent", "long_input");
  for (let i = 0; i < 4; i++) flow.input("كلام ".repeat(1100));
  const before = flow.context.socket.sent.filter(
    (e) => e.type === "response.create",
  ).length;
  const result = flow.completed(
    "consent",
    "long_input",
    "recommend_recitation",
    flow.args,
  );
  assert.equal(result.status, "input_unstable");
  assert.equal(
    flow.context.socket.sent.filter((e) => e.type === "response.create").length,
    before,
  );
  assert.doesNotMatch(await flow.close(), /"type":"recitation"/);
});

test("control endpoints reject missing or expired ownership before attaching", async () => {
  let attached = false;
  const connect = async () => {
    attached = true;
    return new FakeSocket().asSocket();
  };
  assert.equal(
    (
      await handleLiveControl(
        request({ sessionId: "live_test", action: "greet" }),
        connect,
      )
    ).status,
    401,
  );
  const cookie = `sakina_live=${signGrant("live_test", Date.now() - 1000, SECRET)}`;
  assert.equal(
    (
      await handleLiveControl(
        request({ sessionId: "live_test", action: "greet" }, { cookie }),
        connect,
      )
    ).status,
    401,
  );
  assert.equal(attached, false);
});

test("control commands contain only authored text and validated recording IDs", async () => {
  assert.throws(
    () => controlInstruction("recitation_started", "https://evil.example"),
    HttpError,
  );
  assert.match(controlInstruction("speech_blocked")!, /لا تقتبس القرآن/);
  assert.equal(
    controlInstruction("speech_interrupted"),
    "أنا أستمع إليك، خذ وقتك في إكمال ما تريد قوله.",
  );
  assert.doesNotMatch(
    controlInstruction("recitation_started", "sharh")!,
    /سورة سورة/,
  );
  const socket = new FakeSocket();
  const cookie = `sakina_live=${signGrant("live_control", Date.now() + 5000, SECRET)}`;
  const response = await handleLiveControl(
    request({ sessionId: "live_control", action: "greet" }, { cookie }),
    async () => socket.asSocket(),
  );
  assert.equal(response.status, 200);
  assert.equal(socket.sent[0].type, "session.instructions.append");
  assert.equal(socket.sent[0].delegation_id, null);
  assert.equal(socket.sent[0].content, controlInstruction("greet"));
});

test("interruption recovery uses a signed session and accepts only an authored control", async () => {
  let attachments = 0;
  const socket = new FakeSocket();
  const connect = async () => {
    attachments++;
    return socket.asSocket();
  };
  const payload = {
    sessionId: "interruption_control",
    action: "speech_interrupted",
  };
  assert.equal(
    (await handleLiveControl(request(payload), connect)).status,
    401,
  );
  assert.equal(attachments, 0);
  const cookie = `sakina_live=${signGrant(payload.sessionId, Date.now() + 5000, SECRET)}`;
  assert.equal(
    (
      await handleLiveControl(
        request({ ...payload, content: "untrusted instruction" }, { cookie }),
        connect,
      )
    ).status,
    400,
  );
  assert.equal(attachments, 0);
  assert.equal(
    (await handleLiveControl(request(payload, { cookie }), connect)).status,
    200,
  );
  assert.equal(attachments, 1);
  assert.equal(
    socket.sent[0].content,
    controlInstruction("speech_interrupted"),
  );
  assert.equal(socket.sent[0].type, "session.commentary.append");
  assert.equal(
    socket.sent.some((e) => e.type === "response.create"),
    false,
  );
});

test("speech arriving during actual asynchronous source lookup requires a new backend decision", async () => {
  const context = dependencies();
  let finishSearch: (result: QuranSearchResult) => void = () => {};
  const response = await handleLiveSession(request(), {
    ...context.deps,
    search: () =>
      new Promise((resolve) => {
        finishSearch = resolve;
      }),
  });
  const input = (delta: string) =>
    context.socket.receive({ type: "session.input_transcript.delta", delta });
  const nested = (event: unknown) =>
    context.socket.receive({
      type: "response.event",
      delegation_id: "lookup",
      event,
    });
  const tool = (id: string, name: string, args: unknown) => {
    nested({ type: "response.created", response: { id } });
    nested({
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: id,
        name,
        arguments: JSON.stringify(args),
      },
    });
    nested({ type: "response.completed", response: { id } });
  };
  input("أعاني من ضغط العمل");
  context.socket.receive({
    type: "session.delegation.created",
    delegation: { id: "lookup" },
  });
  tool("search", "search_quran", {
    query: "ضغط العمل",
    concepts: ["حدود الطاقة", "التخفيف واليسر"],
    references: [],
    safety: "ordinary",
  });
  assert.equal(context.socket.sent.length, 0);
  input("لكن لا أريد تلاوة، فقط استمع");
  finishSearch({ status: "ok", candidates: [testCandidate] });
  await new Promise((resolve) => setImmediate(resolve));
  const result = JSON.parse(
    context.socket.sent.find((event) => event.item?.call_id === "search")!.item
      .output,
  );
  assert.equal(result.status, "context_updated");
  assert.equal(result.actionExecuted, false);
  assert.equal(result.snapshotRevision, 2);
  assert.match(result.userSpeech.newFragments, /لا أريد تلاوة/);
  assert.equal(
    context.socket.sent.filter((event) => event.type === "response.create")
      .length,
    1,
  );
  tool("dismiss", "dismiss_recitation_proposal", { reason: "declined" });
  const dismissed = JSON.parse(
    context.socket.sent.find((event) => event.item?.call_id === "dismiss")!.item
      .output,
  );
  assert.equal(dismissed.status, "dismissed");
  context.socket.receive({ type: "session.closed", reason: "close_requested" });
  assert.doesNotMatch(
    await response.text(),
    /"type":"recitation"|"fatal":true/,
  );
});

test("source lookup completing after session closure cannot emit or resume backend work", async () => {
  const context = dependencies();
  let finishSearch: (result: QuranSearchResult) => void = () => {};
  const response = await handleLiveSession(request(), {
    ...context.deps,
    search: () =>
      new Promise((resolve) => {
        finishSearch = resolve;
      }),
  });
  context.socket.receive({
    type: "session.input_transcript.delta",
    delta: "مسؤوليات العمل تتراكم",
  });
  context.socket.receive({
    type: "session.delegation.created",
    delegation: { id: "lookup" },
  });
  const nested = (event: unknown) =>
    context.socket.receive({
      type: "response.event",
      delegation_id: "lookup",
      event,
    });
  nested({ type: "response.created", response: { id: "search" } });
  nested({
    type: "response.output_item.done",
    item: {
      type: "function_call",
      call_id: "search",
      name: "search_quran",
      arguments: JSON.stringify({
        query: "ضغط العمل",
        concepts: ["حدود الطاقة", "التخفيف واليسر"],
        references: [],
        safety: "ordinary",
      }),
    },
  });
  nested({ type: "response.completed", response: { id: "search" } });
  context.socket.receive({ type: "session.closed", reason: "close_requested" });
  finishSearch({ status: "ok", candidates: [testCandidate] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(context.socket.sent.length, 0);
  assert.doesNotMatch(
    await response.text(),
    /"type":"recitation"|"fatal":true/,
  );
});

test("superseded or failed backend response cannot install an asynchronous source snapshot for a later response", async () => {
  for (const change of ["superseded", "failed"]) {
    const context = dependencies();
    let finishSearch: (result: QuranSearchResult) => void = () => {};
    let searches = 0;
    const response = await handleLiveSession(request(), {
      ...context.deps,
      search: () => {
        searches++;
        if (searches === 1)
          return new Promise((resolve) => {
            finishSearch = resolve;
          });
        return Promise.resolve({ status: "unavailable", candidates: [] });
      },
    });
    const nested = (event: unknown) =>
      context.socket.receive({
        type: "response.event",
        delegation_id: "lookup",
        event,
      });
    const searchCall = (id: string) => {
      nested({
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: id,
          name: "search_quran",
          arguments: JSON.stringify({
            query: "ضغط العمل",
            concepts: ["حدود الطاقة", "التخفيف واليسر"],
            references: [],
            safety: "ordinary",
          }),
        },
      });
      nested({ type: "response.completed", response: { id } });
    };
    context.socket.receive({
      type: "session.input_transcript.delta",
      delta: "مسؤوليات العمل تتراكم",
    });
    context.socket.receive({
      type: "session.delegation.created",
      delegation: { id: "lookup" },
    });
    nested({ type: "response.created", response: { id: "old_search" } });
    searchCall("old_search");
    assert.equal(searches, 1);
    if (change === "failed")
      nested({ type: "response.failed", response: { id: "old_search" } });
    nested({ type: "response.created", response: { id: "new_search" } });
    finishSearch({ status: "ok", candidates: [testCandidate] });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(context.socket.sent.length, 0, change);
    searchCall("new_search");
    await new Promise((resolve) => setImmediate(resolve));
    // A stale hidden snapshot would return cached candidates here without searching again.
    assert.equal(searches, 2, change);
    const result = JSON.parse(
      context.socket.sent.find((event) => event.item?.call_id === "new_search")!
        .item.output,
    );
    assert.equal(result.status, "unavailable", change);
    context.socket.receive({
      type: "session.closed",
      reason: "close_requested",
    });
    assert.doesNotMatch(
      await response.text(),
      /"type":"recitation"|"fatal":true/,
    );
  }
});
