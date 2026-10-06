import test from "node:test";
import assert from "node:assert/strict";
import {
  executeLiveTool,
  executeQuranSearch,
  type VoiceToolState,
  type VoiceEvent,
} from "../apps/sakina/lib/live-session";
import { getRecitation } from "../apps/sakina/lib/recitations";
import type {
  QuranSearchResult,
  QuranSearchInput,
} from "../apps/sakina/lib/quran-search";
import { createLiveConfiguration } from "../apps/sakina/lib/live-config";

// Fixture evidence tests orchestration, not the accuracy of religious source content.
function candidate(id = "ayah-94-5") {
  const recitation = getRecitation(id)!;
  assert.ok(recitation);
  return {
    id,
    recitation,
    verses: [
      {
        key: `${recitation.surah}:${recitation.ayahStart}`,
        text: "fixture source text",
        tafsir: "fixture source commentary",
        tafsirSourceUrl: "https://api.quran.com/api/v4/tafsirs/16/by_ayah/94:5",
      },
    ],
    surroundingVerses: [{ key: "94:4", text: "fixture surrounding text" }],
    source: "test fixture",
  };
}
const found = (): QuranSearchResult => ({
  status: "ok",
  candidates: [candidate()],
});
function state(
  text = "تتراكم مسؤوليات العمل ولا أجد وقتا للراحة",
): VoiceToolState {
  return {
    recentIds: [],
    urgent: false,
    requireGroundedSelection: true,
    inputRevision: 1,
    inputFragments: [{ revision: 1, text }],
  };
}
function speech(s: VoiceToolState, text: string) {
  s.inputRevision = (s.inputRevision ?? 0) + 1;
  s.inputFragments!.push({ revision: s.inputRevision, text });
}
function call(s: VoiceToolState, name: string, args: unknown, id = "call") {
  return {
    call_id: id,
    name,
    arguments: JSON.stringify(args),
    inputRevision: s.inputRevision,
  };
}
const query = {
  query: "ضغوط العمل وتراكم المسؤوليات",
  concepts: ["حدود الطاقة", "التخفيف واليسر"],
  references: [],
  safety: "ordinary",
};
function prepare(s: VoiceToolState, overrides: Record<string, unknown> = {}) {
  return call(s, "prepare_relevant_recitation", {
    intent: "overwhelmed",
    fit: "supported",
    safety: "ordinary",
    userConcern: "تتراكم عليك مسؤوليات العمل دون وقت للراحة",
    searchId: s.searchSnapshot?.id ?? null,
    candidateId: "ayah-94-5",
    connection: "تذكير باليسر أثناء تراكم المسؤوليات دون وعد بنتيجة معينة",
    ...overrides,
  });
}
function named(
  s: VoiceToolState,
  id: string,
  evidence: string | null,
  extra: Record<string, unknown> = {},
) {
  return call(s, "recommend_recitation", {
    intent: "explicit_request",
    safety: "ordinary",
    consent: true,
    requestedId: id,
    proposalId: null,
    contextStillApplies: false,
    requestEvidence: evidence,
    repeatRequested: false,
    ...extra,
  });
}
const noop = () => {};

test("production tools search the full corpus and require source IDs plus a specific connection", () => {
  const config = createLiveConfiguration();
  for (const heading of [
    "Backchannel policy:",
    "Interruption policy:",
    "Delegation policy:",
    "Backend tools:",
    "Delegate to the backend when:",
    "Do not delegate to the backend when:",
  ])
    assert.ok(config.instructions.includes(heading));
  const names = config.delegation.responses.tools.map((tool) => tool.name);
  assert.ok(names.includes("search_quran"));
  const prepareTool = config.delegation.responses.tools.find(
    (tool) => tool.name === "prepare_relevant_recitation",
  )!;
  assert.ok(prepareTool.parameters.required.includes("searchId"));
  assert.ok(prepareTool.parameters.required.includes("candidateId"));
  assert.ok(prepareTool.parameters.required.includes("connection"));
  const s = state();
  assert.equal(executeLiveTool(prepare(s), s, noop).status, "search_required");
  assert.equal(s.proposal, undefined);
});

test("search returns an immutable source snapshot without offering or playing", async () => {
  const s = state(),
    events: VoiceEvent[] = [],
    source = found();
  const result = await executeQuranSearch(
    call(s, "search_quran", query),
    s,
    (e) => events.push(e),
    async () => source,
  );
  assert.equal(result.status, "candidates");
  assert.ok(s.searchSnapshot?.id);
  assert.equal(s.searchSnapshot.inputRevision, 1);
  assert.ok(Object.isFrozen(s.searchSnapshot.candidates[0].verses[0]));
  assert.ok(
    Object.isFrozen(s.searchSnapshot.candidates[0].surroundingVerses[0]),
  );
  source.candidates[0].verses[0].tafsir = "mutated after retrieval";
  source.candidates[0].surroundingVerses[0].text = "mutated after retrieval";
  assert.equal(
    s.searchSnapshot.candidates[0].verses[0].tafsir,
    "fixture source commentary",
  );
  assert.equal(
    s.searchSnapshot.candidates[0].surroundingVerses[0].text,
    "fixture surrounding text",
  );
  assert.equal(s.proposal, undefined);
  assert.deepEqual(events, []);
});

test("unknown candidate, foreign snapshot, weak connection and changed input cannot prepare playback", async () => {
  for (const override of [
    { candidateId: "invented" },
    { searchId: "old" },
    { connection: "جميل" },
    { changedInput: true },
  ]) {
    const s = state();
    await executeQuranSearch(
      call(s, "search_quran", query),
      s,
      noop,
      async () => found(),
    );
    if ("changedInput" in override) speech(s, "المشكلة الآن في موضوع آخر");
    const result = executeLiveTool(
      prepare(s, "changedInput" in override ? {} : override),
      s,
      noop,
    );
    assert.notEqual(result.status, "proposed");
    assert.equal(s.proposal, undefined);
  }
});

test("selected source candidate is held exactly and duplicate preparation cannot replace it", async () => {
  const s = state();
  await executeQuranSearch(call(s, "search_quran", query), s, noop, async () =>
    found(),
  );
  const result = executeLiveTool(prepare(s), s, noop);
  assert.equal(result.status, "proposed");
  assert.equal(s.proposal?.recitationId, "ayah-94-5");
  const id = s.proposal?.id;
  const repeated = { ...prepare(s), call_id: "entirely_new_call_id" };
  assert.equal(executeLiveTool(repeated, s, noop).status, "input_required");
  assert.equal(s.proposal?.id, id);
  speech(s, "هل يمكنك توضيح المعنى");
  assert.equal(executeLiveTool(prepare(s), s, noop).status, "awaiting_consent");
  assert.equal(s.proposal?.id, id);
});

test("fresh thematic consent plays the exact candidate once and consumes its input revision", async () => {
  const s = state(),
    events: VoiceEvent[] = [];
  await executeQuranSearch(call(s, "search_quran", query), s, noop, async () =>
    found(),
  );
  executeLiveTool(prepare(s), s, noop);
  const args = {
    intent: "overwhelmed",
    consent: true,
    safety: "ordinary",
    requestedId: null,
    proposalId: s.proposal!.id,
    contextStillApplies: true,
  };
  assert.equal(
    executeLiveTool(call(s, "recommend_recitation", args), s, (e) =>
      events.push(e),
    ).status,
    "awaiting_consent",
  );
  speech(s, "نعم أريد سماع المقطع المقترح");
  assert.equal(
    executeLiveTool(call(s, "recommend_recitation", args), s, (e) =>
      events.push(e),
    ).status,
    "ready",
  );
  assert.equal(events.length, 1);
  assert.equal((events[0].recitation as { id: string }).id, "ayah-94-5");
  assert.match(String(events[0].playbackId), /^[0-9a-f-]{36}$/);
  assert.equal(
    executeLiveTool(
      call(s, "recommend_recitation", args, "new_duplicate"),
      s,
      (e) => events.push(e),
    ).status,
    "already_executed",
  );
  assert.equal(
    executeLiveTool(
      named(s, "surah-94", "نعم أريد سماع المقطع المقترح"),
      s,
      (e) => events.push(e),
    ).status,
    "already_executed",
  );
  assert.equal(events.length, 1);
});

test("named full surah request outside old catalog requires real current caller evidence", () => {
  const s = state("أريد سماع سورة البقرة الآن"),
    events: VoiceEvent[] = [];
  assert.equal(
    executeLiveTool(named(s, "surah-2", "أريد سماع سورة البقرة الآن"), s, (e) =>
      events.push(e),
    ).status,
    "ready",
  );
  assert.equal(
    (events[0].recitation as { fullSurah: boolean }).fullSurah,
    true,
  );
  const different = state("أشعر بالحزن اليوم");
  assert.equal(
    executeLiveTool(
      named(different, "surah-2", "أريد سماع سورة البقرة الآن"),
      different,
      noop,
    ).status,
    "request_required",
  );
});

test("new function IDs and replay flags cannot reuse a named request or old consent", () => {
  const s = state("شغل سورة الشرح الآن"),
    events: VoiceEvent[] = [];
  const run = (id: string, evidence: string, repeat = false) =>
    executeLiveTool(
      named(s, id, evidence, { repeatRequested: repeat }),
      s,
      (e) => events.push(e),
    );
  assert.equal(run("sharh", "شغل سورة الشرح الآن").status, "ready");
  assert.equal(
    run("surah-94", "شغل سورة الشرح الآن", true).status,
    "already_executed",
  );
  speech(s, "نعم نكمل الحديث عن العمل");
  assert.equal(
    run("surah-94", "شغل سورة الشرح الآن", true).status,
    "request_required",
  );
  assert.equal(
    run("surah-94", "نعم نكمل الحديث عن العمل", true).status,
    "request_required",
  );
  assert.equal(events.length, 1);
  speech(s, "أعد سورة الشرح مرة أخرى");
  assert.equal(
    run("surah-94", "أعد سورة الشرح مرة أخرى", true).status,
    "ready",
  );
  assert.equal(events.length, 2);
  assert.notEqual(events[0].playbackId, events[1].playbackId);
});

test("canonical overlap prevents replaying a verse after its full surah under an alias", () => {
  const s = state("شغل سورة الشرح الآن");
  assert.equal(
    executeLiveTool(named(s, "sharh", "شغل سورة الشرح الآن"), s, noop).status,
    "ready",
  );
  speech(s, "أريد سماع آية من الشرح");
  assert.equal(
    executeLiveTool(named(s, "ayah-94-5", "أريد سماع آية من الشرح"), s, noop)
      .status,
    "request_required",
  );
});

test("negated request cannot be made positive by quoting a substring", () => {
  const s = state("لا أريد سماع سورة الشرح الآن");
  assert.equal(
    executeLiveTool(named(s, "surah-94", "أريد سماع سورة الشرح الآن"), s, noop)
      .status,
    "request_required",
  );
});

test("named verse requests match the complete surah name rather than generic title words", () => {
  const wrong = state("أريد مقطعا من القرآن الآن");
  assert.equal(
    executeLiveTool(
      named(wrong, "ayah-94-5", "أريد مقطعا من القرآن الآن"),
      wrong,
      noop,
    ).status,
    "request_required",
  );
  const correct = state("أريد سماع الآية الخامسة من سورة الشرح الآن");
  assert.equal(
    executeLiveTool(
      named(correct, "ayah-94-5", "أريد سماع الآية الخامسة من سورة الشرح الآن"),
      correct,
      noop,
    ).status,
    "ready",
  );
  const whole = state("شغل سورة يوسف الآن");
  assert.equal(
    executeLiveTool(
      named(whole, "ayah-12-86", "شغل سورة يوسف الآن"),
      whole,
      noop,
    ).status,
    "request_required",
  );
  const verse = state("شغل آية من سورة يوسف الآن");
  assert.equal(
    executeLiveTool(
      named(verse, "surah-12", "شغل آية من سورة يوسف الآن"),
      verse,
      noop,
    ).status,
    "request_required",
  );
});

test("safety escalation overrides deduplication of a previously prepared concern", async () => {
  const s = state(),
    events: VoiceEvent[] = [];
  await executeQuranSearch(call(s, "search_quran", query), s, noop, async () =>
    found(),
  );
  executeLiveTool(prepare(s), s, noop);
  assert.equal(
    executeLiveTool(prepare(s, { safety: "urgent" }), s, (event) =>
      events.push(event),
    ).status,
    "safety",
  );
  assert.equal(s.proposal, undefined);
  assert.equal(s.urgent, true);
  assert.equal(events[0].type, "support");
});

test("explicit single verse evidence binds exact Arabic ordinals and Western or Arabic digit bounds", () => {
  for (const wording of [
    "الآية الخامسة",
    "الآية رقم 5",
    "الآية ٥",
    "الآية ۵",
  ]) {
    const text = `أريد سماع ${wording} من سورة الشرح الآن`;
    for (const target of [1, 5, 8]) {
      const s = state(text);
      assert.equal(
        executeLiveTool(named(s, `ayah-94-${target}`, text), s, noop).status,
        target === 5 ? "ready" : "request_required",
        `${wording}: ${target}`,
      );
    }
  }
  for (const [text, id] of [
    ["أريد سماع الآية السادسة والثمانون من سورة يوسف", "ayah-12-86"],
    ["شغل الآية الحادية عشرة من سورة يوسف", "ayah-12-11"],
    ["شغل الآية الخامسة والعشرين من سورة البقرة", "ayah-2-25"],
    ["شغل الآية المائة والخامسة والعشرين من سورة البقرة", "ayah-2-125"],
  ]) {
    const s = state(text);
    assert.equal(
      executeLiveTool(named(s, id, text), s, noop).status,
      "ready",
      text,
    );
  }
});

test("explicit verse ranges cannot be replaced by another range or silently widened", () => {
  for (const wording of [
    "الآيات 5 إلى 6",
    "الآيات ٥ إلى ٦",
    "الآيات ۵ إلى ۶",
    "الآيات الخامسة إلى السادسة",
    "الآيات 5-6",
    "الآيات الخامسة والسادسة",
  ]) {
    const text = `شغل ${wording} من سورة الشرح`;
    for (const target of [
      "passage-94-1-3",
      "passage-94-5-6",
      "ayah-94-5",
      "passage-94-5-8",
    ]) {
      const s = state(text);
      assert.equal(
        executeLiveTool(named(s, target, text), s, noop).status,
        target === "passage-94-5-6" ? "ready" : "request_required",
        `${wording}: ${target}`,
      );
    }
  }
  for (const text of [
    "شغل آيات من سورة الشرح",
    "شغل الآيات 5 و8 من سورة الشرح",
    "شغل الآية غير المعروفة من سورة الشرح",
  ]) {
    const s = state(text);
    assert.equal(
      executeLiveTool(named(s, "passage-94-5-8", text), s, noop).status,
      "request_required",
    );
  }
});

test("incidental, negated, quoted and explanatory mentions do not authorize recitation", () => {
  const cases: [string, string][] = [
    [
      "أريد فهم سورة الشرح دون تشغيل أي صوت",
      "أريد فهم سورة الشرح دون تشغيل أي صوت",
    ],
    ["سورة الشرح أول مرة أسمع عنها", "سورة الشرح أول مرة أسمع عنها"],
    ["لا أحب أن أسمع سورة الشرح الآن", "لا أحب أن أسمع سورة الشرح الآن"],
    ["لا أحب أن أسمع سورة الشرح الآن", "أحب أن أسمع سورة الشرح الآن"],
    ["مش عايز أسمع سورة الشرح", "مش عايز أسمع سورة الشرح"],
    ["مش عايز أسمع سورة الشرح", "عايز أسمع سورة الشرح"],
    ["أريد سماع سورة الشرح لكن لا تشغل أي صوت", "أريد سماع سورة الشرح"],
    ["قال صديقي شغل سورة الشرح الآن", "شغل سورة الشرح الآن"],
    ["أعطني مثالا على عبارة شغل سورة الشرح", "شغل سورة الشرح"],
    ["أريد سماع تفسير سورة الشرح", "أريد سماع تفسير سورة الشرح"],
    ["أريد سماع جملة شغل سورة الشرح", "أريد سماع جملة شغل سورة الشرح"],
  ];
  for (const [text, evidence] of cases) {
    const s = state(text);
    assert.equal(
      executeLiveTool(named(s, "surah-94", evidence), s, noop).status,
      "request_required",
      `${text} / ${evidence}`,
    );
  }
});

test("named surahs require complete independent names and support one-letter chapter names", () => {
  for (const [text, id] of [
    ["شغل سورة ص الآن", "surah-38"],
    ["شغل سورة ق الآن", "surah-50"],
    ["من فضلك شغل سورة الملك", "surah-67"],
    ["هل يمكنك تشغيل سورة آل عمران", "surah-3"],
  ]) {
    const s = state(text);
    assert.equal(
      executeLiveTool(named(s, id, text), s, noop).status,
      "ready",
      text,
    );
  }
  for (const text of [
    "شغل تسجيل عبد الملك الآن",
    "شغل سورة الملكوت الآن",
    "شغل صوت ق الآن",
    "شغل سورة قصص الآن",
  ]) {
    const s = state(text);
    assert.equal(
      executeLiveTool(
        named(s, text.includes("الملك") ? "surah-67" : "surah-50", text),
        s,
        noop,
      ).status,
      "request_required",
      text,
    );
  }
});

test("search excludes previously offered and played surahs even if retrieval ignores exclusions", async () => {
  const s = state();
  await executeQuranSearch(call(s, "search_quran", query), s, noop, async () =>
    found(),
  );
  executeLiveTool(prepare(s), s, noop);
  executeLiveTool(
    call(s, "dismiss_recitation_proposal", { reason: "context_changed" }),
    s,
    noop,
  );
  speech(s, "لدي مشكلة جديدة في انتظار نتيجة مهمة");
  let input: QuranSearchInput | undefined;
  const result = await executeQuranSearch(
    call(s, "search_quran", query),
    s,
    noop,
    async (value) => {
      input = value;
      return found();
    },
  );
  assert.ok(input?.excludeSurahs?.includes(94));
  assert.equal(result.status, "unavailable");
  assert.equal(s.searchSnapshot, undefined);
});

test("new speech, refusal, safety, teardown and replacement search invalidate an in-flight lookup", async () => {
  for (const change of [
    "speech",
    "refusal",
    "context_changed",
    "safety",
    "closed",
    "replacement",
  ]) {
    const s = state();
    let resolve: (result: QuranSearchResult) => void = () => {};
    const pending = executeQuranSearch(
      call(s, "search_quran", query),
      s,
      noop,
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    if (change === "speech") speech(s, "غيرت الموضوع");
    if (change === "refusal")
      executeLiveTool(
        call(s, "dismiss_recitation_proposal", { reason: "declined" }),
        s,
        noop,
      );
    if (change === "context_changed")
      executeLiveTool(
        call(s, "dismiss_recitation_proposal", { reason: "context_changed" }),
        s,
        noop,
      );
    if (change === "safety")
      executeLiveTool(
        call(s, "report_support_need", { urgency: "immediate" }),
        s,
        noop,
      );
    if (change === "closed") s.closed = true;
    if (change === "replacement")
      await executeQuranSearch(
        call(s, "search_quran", query, "new_search"),
        s,
        noop,
        async () => ({ status: "unavailable", candidates: [] }),
      );
    resolve(found());
    const result = await pending;
    assert.equal(result.status, "input_unstable", change);
    assert.equal(s.searchSnapshot, undefined, change);
    assert.equal(s.proposal, undefined, change);
  }
});

test("bounded search rejects untrusted parameters and never fetches after refusal or safety", async () => {
  let fetches = 0;
  const search = async () => {
    fetches++;
    return found();
  };
  for (const args of [
    { ...query, query: "س".repeat(181) },
    { ...query, references: ["https://attacker.example"] },
    { ...query, excludeSurahs: [1] },
    { ...query, references: Array(7).fill("1:1") },
    { ...query, concepts: [] },
    { ...query, concepts: ["عمل"] },
    { ...query, concepts: ["صبر", "س".repeat(41)] },
  ]) {
    const s = state();
    assert.equal(
      (await executeQuranSearch(call(s, "search_quran", args), s, noop, search))
        .status,
      "invalid",
    );
  }
  const refused = state();
  refused.proactiveSuppressed = true;
  assert.equal(
    (
      await executeQuranSearch(
        call(refused, "search_quran", query),
        refused,
        noop,
        search,
      )
    ).status,
    "declined",
  );
  const urgent = state();
  urgent.urgent = true;
  assert.equal(
    (
      await executeQuranSearch(
        call(urgent, "search_quran", query),
        urgent,
        noop,
        search,
      )
    ).status,
    "support",
  );
  assert.equal(fetches, 0);
});

test("unavailable lookup abstains without a category fallback", async () => {
  const s = state();
  assert.equal(
    (
      await executeQuranSearch(
        call(s, "search_quran", query),
        s,
        noop,
        async () => {
          throw new Error("source unavailable");
        },
      )
    ).status,
    "unavailable",
  );
  assert.equal(executeLiveTool(prepare(s), s, noop).status, "search_required");
  assert.equal(s.proposal, undefined);
});
