import test from "node:test";
import assert from "node:assert/strict";
import {
  executeLiveTool,
  executeQuranSearch,
  type VoiceEvent,
  type VoiceToolState,
} from "../apps/sakina/lib/live-session";
import { LIVE_DURATION_SECONDS } from "../apps/sakina/lib/live-security";
import { getRecitation } from "../apps/sakina/lib/recitations";

// Source fixtures test identity and consent orchestration, not interpretation.
const recording = getRecitation("ayah-94-5")!;
assert.ok(recording);
const concern = "تتراكم مسؤوليات العمل ولا أجد وقتًا للراحة";
const connection = "يتصل معنى اليسر بما وصفه من استمرار ضغط المسؤوليات";
const query = {
  query: "تراكم مسؤوليات العمل وغياب الراحة",
  concepts: ["حدود الطاقة", "التيسير ورفع الحرج"],
  references: ["94:5"],
  safety: "ordinary",
};

function initialState(sessionExpiresAt?: number) {
  const state: VoiceToolState & { sessionExpiresAt?: number } = {
    recentIds: [],
    urgent: false,
    requireGroundedSelection: true,
    inputRevision: 1,
    inputFragments: [{ revision: 1, text: concern }],
    ...(sessionExpiresAt === undefined ? {} : { sessionExpiresAt }),
  };
  return state;
}

function speech(state: VoiceToolState, ...fragments: string[]) {
  for (const text of fragments) {
    state.inputRevision = (state.inputRevision ?? 0) + 1;
    state.inputFragments!.push({ revision: state.inputRevision, text });
  }
}

function call(state: VoiceToolState, name: string, args: unknown) {
  return {
    call_id: `${name}-${state.inputRevision}`,
    name,
    arguments: JSON.stringify(args),
    inputRevision: state.inputRevision,
  };
}

function prepare(
  state: VoiceToolState,
  overrides: Record<string, unknown> = {},
) {
  return call(state, "prepare_relevant_recitation", {
    intent: "overwhelmed",
    fit: "supported",
    safety: "ordinary",
    userConcern: concern,
    searchId: state.searchSnapshot?.id,
    candidateId: "candidate-94-5",
    connection,
    ...overrides,
  });
}

function confirmation(
  state: VoiceToolState,
  proposalId: string,
  overrides: Record<string, unknown> = {},
) {
  return call(state, "recommend_recitation", {
    intent: "overwhelmed",
    consent: true,
    safety: "ordinary",
    requestedId: null,
    proposalId,
    contextStillApplies: true,
    ...overrides,
  });
}

function canonical(proposalId: string, state = "awaiting_consent") {
  return {
    proposalId,
    recitationId: recording.id,
    title: recording.title,
    reference: recording.reference,
    chapterName: "الشرح",
    reciter: recording.reciter,
    intent: "overwhelmed",
    userConcern: concern,
    connection,
    state,
  };
}

function assertRecommendation(
  result: unknown,
  expected: ReturnType<typeof canonical>,
) {
  assert.ok(result && typeof result === "object");
  assert.ok(
    "recommendation" in result,
    "tool result must return the canonical recommendation",
  );
  const recommendation = result.recommendation;
  assert.ok(recommendation && typeof recommendation === "object");
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(
      (recommendation as Record<string, unknown>)[key],
      value,
      `canonical recommendation field ${key}`,
    );
  }
}

async function proposed(sessionExpiresAt?: number) {
  const state = initialState(sessionExpiresAt);
  const events: VoiceEvent[] = [];
  const emit = (event: VoiceEvent) => events.push(event);
  let searches = 0;
  const search = async () => {
    searches++;
    return {
      status: "ok" as const,
      candidates: [
        {
          id: "candidate-94-5",
          recitation: recording,
          verses: [
            {
              key: "94:5",
              text: "fixture source text",
              tafsir: "fixture source commentary",
              tafsirSourceUrl:
                "https://quran.com/94:5/tafsirs/ar-tafsir-muyassar",
            },
          ],
          surroundingVerses: [
            { key: "94:4", text: "fixture surrounding text" },
          ],
          source: "test fixture",
        },
      ],
    };
  };
  assert.equal(
    (
      await executeQuranSearch(
        call(state, "search_quran", query),
        state,
        emit,
        search,
      )
    ).status,
    "candidates",
  );
  assert.equal(executeLiveTool(prepare(state), state, emit).status, "proposed");
  const proposal = state.proposal!;
  assert.ok(proposal);
  const recall = () =>
    executeLiveTool(call(state, "get_session_recitation", {}), state, emit);
  return {
    state,
    events,
    emit,
    search,
    searches: () => searches,
    proposal,
    recall,
  };
}

test("recall before any recommendation is empty and changes no session state", () => {
  const state = initialState();
  const before = structuredClone(state);
  const events: VoiceEvent[] = [];
  const result = executeLiveTool(
    call(state, "get_session_recitation", {}),
    state,
    (event) => events.push(event),
  );
  assert.equal(result.status, "empty");
  assert.deepEqual(state, before);
  assert.deepEqual(events, []);
});

test("two fragmented recall turns retain the exact proposal and fresh consent dispatches it only once", async () => {
  const journey = await proposed();
  const { state, events, emit, proposal } = journey;
  for (const fragments of [
    ["أي ", "سورة اقترحت؟"],
    ["ذكّرني ", "باسم السورة ونطاق الآيات"],
  ]) {
    speech(state, ...fragments);
    const before = structuredClone(state);
    const result = journey.recall();
    assert.equal(result.status, "remembered");
    assertRecommendation(result, canonical(proposal.id));
    assert.deepEqual(
      state,
      before,
      "recall is read-only even across fragmented input revisions",
    );
    assert.equal(state.proposal, proposal);
    assert.deepEqual(events, []);
    assert.equal(journey.searches(), 1);
  }
  speech(state, "نعم، أريد سماع المقطع المقترح الآن");
  const consent = confirmation(state, proposal.id);
  assert.equal(executeLiveTool(consent, state, emit).status, "ready");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "recitation");
  assert.deepEqual(events[0].recitation, recording);
  assert.ok(events[0].playbackId);
  assert.equal(state.proposal, undefined);
  assert.notEqual(
    executeLiveTool({ ...consent, call_id: "duplicate-consent" }, state, emit)
      .status,
    "ready",
  );
  assert.equal(events.length, 1);
  assert.equal(journey.searches(), 1);
});

test("pending search and preparation return the held source instead of creating or hiding a replacement", async () => {
  const journey = await proposed();
  const { state, proposal, emit } = journey;
  speech(state, "ما السورة التي اقترحتها؟");
  const before = structuredClone(state);
  const blockedSearch = await executeQuranSearch(
    call(state, "search_quran", query),
    state,
    emit,
    journey.search,
  );
  assert.equal(blockedSearch.status, "awaiting_consent");
  assertRecommendation(blockedSearch, canonical(proposal.id));
  const blockedPreparation = executeLiveTool(
    prepare(state, { candidateId: "candidate-93-5", intent: "lonely" }),
    state,
    emit,
  );
  assert.equal(blockedPreparation.status, "awaiting_consent");
  assertRecommendation(blockedPreparation, canonical(proposal.id));
  assert.deepEqual(state, before);
  assert.equal(journey.searches(), 1);
  assert.deepEqual(journey.events, []);
});

for (const [label, overrides] of [
  ["wrong proposal ID", { proposalId: "unrelated-proposal" }],
  ["substituted chapter", { requestedId: "surah-93" }],
  ["full chapter substituted for held verse", { requestedId: "surah-94" }],
  ["changed inferred intent", { intent: "seeking_refuge" }],
  ["unconfirmed context", { contextStillApplies: false }],
  ["absence of consent", { consent: false }],
] as const) {
  test(`${label} cannot erase or replace the remembered recommendation`, async () => {
    const journey = await proposed();
    const { state, proposal, emit } = journey;
    speech(state, "أي سورة قلت لي؟");
    const result = executeLiveTool(
      confirmation(state, proposal.id, overrides),
      state,
      emit,
    );
    assert.notEqual(result.status, "ready");
    assert.equal(state.proposal, proposal);
    assertRecommendation(result, canonical(proposal.id));
    assertRecommendation(journey.recall(), canonical(proposal.id));
    assert.deepEqual(journey.events, []);
    assert.deepEqual(state.recentIds, []);
    speech(state, "نعم، أريد سماع المقطع المقترح");
    assert.equal(
      executeLiveTool(confirmation(state, proposal.id), state, emit).status,
      "ready",
    );
    assert.deepEqual(
      journey.events.map((event) => event.recitation),
      [recording],
    );
  });
}

test("an unsubstantiated explicit request cannot delete the held recommendation", async () => {
  const journey = await proposed();
  const { state, proposal, emit } = journey;
  speech(state, "هل تقصد سورة الضحى؟");
  const result = executeLiveTool(
    confirmation(state, proposal.id, {
      intent: "explicit_request",
      requestedId: "surah-93",
      proposalId: null,
      requestEvidence: "هل تقصد سورة الضحى؟",
    }),
    state,
    emit,
  );
  assert.notEqual(result.status, "ready");
  assert.equal(state.proposal, proposal);
  assertRecommendation(result, canonical(proposal.id));
  assertRecommendation(journey.recall(), canonical(proposal.id));
  assert.deepEqual(journey.events, []);
});

test("a valid named listening request can supersede the thematic proposal", async () => {
  const journey = await proposed();
  const { state, proposal, emit } = journey;
  speech(state, " أريد سماع سورة الضحى الآن");
  const result = executeLiveTool(
    confirmation(state, proposal.id, {
      intent: "explicit_request",
      requestedId: "surah-93",
      proposalId: null,
      requestEvidence: "أريد سماع سورة الضحى الآن",
    }),
    state,
    emit,
  );
  assert.equal(result.status, "ready");
  assert.equal(state.proposal, undefined);
  assert.equal(journey.events.length, 1);
  assert.equal((journey.events[0].recitation as { id: string }).id, "surah-93");
});

test("recall and consent after ninety seconds remain valid until the session deadline", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const sessionExpiresAt = now + LIVE_DURATION_SECONDS * 1000;
  const journey = await proposed(sessionExpiresAt);
  assert.equal(journey.proposal.expiresAt, sessionExpiresAt);
  now += 91_000;
  speech(journey.state, "ذكّرني بالسورة التي اقترحتها");
  assertRecommendation(journey.recall(), canonical(journey.proposal.id));
  speech(journey.state, "نعم شغّل المقطع المقترح");
  assert.equal(
    executeLiveTool(
      confirmation(journey.state, journey.proposal.id),
      journey.state,
      journey.emit,
    ).status,
    "ready",
  );
  assert.deepEqual(
    journey.events.map((event) => event.recitation),
    [recording],
  );
});

test("a proposal without an explicit session deadline uses the full voice duration", async (t) => {
  const now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const journey = await proposed();
  assert.equal(journey.proposal.expiresAt, now + LIVE_DURATION_SECONDS * 1000);
});

test("hard expiry refuses playback while retaining read-only source memory", async (t) => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, "now", () => now);
  const sessionExpiresAt = now + LIVE_DURATION_SECONDS * 1000;
  const journey = await proposed(sessionExpiresAt);
  now = sessionExpiresAt;
  speech(journey.state, "نعم شغّل التسجيل");
  const beforeRecall = structuredClone(journey.state);
  assertRecommendation(
    journey.recall(),
    canonical(journey.proposal.id, "expired"),
  );
  assert.deepEqual(journey.state, beforeRecall);
  assert.notEqual(
    executeLiveTool(
      confirmation(journey.state, journey.proposal.id),
      journey.state,
      journey.emit,
    ).status,
    "ready",
  );
  assertRecommendation(
    journey.recall(),
    canonical(journey.proposal.id, "expired"),
  );
  assert.deepEqual(journey.events, []);
});

test("postdispatch recall remembers playback requested without claiming it played or replaying it", async () => {
  const journey = await proposed();
  speech(journey.state, "نعم شغّل المقطع");
  assert.equal(
    executeLiveTool(
      confirmation(journey.state, journey.proposal.id),
      journey.state,
      journey.emit,
    ).status,
    "ready",
  );
  for (const text of ["أي سورة كانت؟", "ما اسم المقطع؟"]) {
    speech(journey.state, text);
    const before = structuredClone(journey.state);
    assertRecommendation(
      journey.recall(),
      canonical(journey.proposal.id, "playback_requested"),
    );
    assert.deepEqual(journey.state, before);
    assert.equal(journey.state.proposal, undefined);
    assert.equal(journey.events.length, 1);
    assert.equal(journey.searches(), 1);
  }
  assert.notEqual(
    executeLiveTool(
      confirmation(journey.state, journey.proposal.id),
      journey.state,
      journey.emit,
    ).status,
    "ready",
  );
  assert.equal(journey.events.length, 1);
});

for (const reason of ["declined", "context_changed"] as const) {
  test(`${reason} remains remembered and later recall cannot resurrect consent`, async () => {
    const journey = await proposed();
    speech(
      journey.state,
      reason === "declined"
        ? "لا أريد تلاوة، فقط استمع"
        : "أريد أن أحكي في موضوع آخر",
    );
    assert.equal(
      executeLiveTool(
        call(journey.state, "dismiss_recitation_proposal", { reason }),
        journey.state,
        journey.emit,
      ).status,
      "dismissed",
    );
    assert.equal(journey.state.proposal, undefined);
    speech(journey.state, "ما السورة التي اقترحتها سابقًا؟");
    const before = structuredClone(journey.state);
    assertRecommendation(
      journey.recall(),
      canonical(journey.proposal.id, "dismissed"),
    );
    assert.deepEqual(journey.state, before);
    assert.notEqual(
      executeLiveTool(
        confirmation(journey.state, journey.proposal.id),
        journey.state,
        journey.emit,
      ).status,
      "ready",
    );
    assert.equal(journey.state.proposal, undefined);
    assert.deepEqual(journey.events, []);
  });
}

test("support escalation preserves source memory without permitting old consent to resume playback", async () => {
  const journey = await proposed();
  speech(journey.state, "أحتاج مساعدة من شخص موثوق الآن");
  assert.equal(
    executeLiveTool(
      call(journey.state, "report_support_need", { urgency: "clarify" }),
      journey.state,
      journey.emit,
    ).status,
    "support",
  );
  assert.equal(journey.state.proposal, undefined);
  speech(journey.state, "ما السورة التي قلتها قبل قليل؟");
  const before = structuredClone(journey.state);
  assertRecommendation(
    journey.recall(),
    canonical(journey.proposal.id, "support"),
  );
  assert.deepEqual(journey.state, before);
  assert.notEqual(
    executeLiveTool(
      confirmation(journey.state, journey.proposal.id),
      journey.state,
      journey.emit,
    ).status,
    "ready",
  );
  assert.equal(journey.state.proposal, undefined);
  assert.equal(
    journey.events.filter((event) => event.type === "recitation").length,
    0,
  );
});
