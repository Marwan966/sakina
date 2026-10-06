import { expect, test, type Page } from "@playwright/test";

// Synthetic RMS/transport/media doubles drive the real browser hook. These
// regressions do not claim microphone acoustics, provider inference, or CDN QA.
const origin = process.env.SAKINA_BASE_URL || "http://localhost:3000";
type Probe = {
  emit: (event: unknown) => void;
  emitSpeech: (timestamp: number) => void;
  inputLevel: number;
  starts: number;
  stops: number;
  plays: number;
  closedPeers: number;
  sessionRequests: number;
  controls: string[];
  holdReturn: boolean;
  returnAborts: number;
  endWasAborted: boolean;
  dropUnmuteAcks: number;
  rejectUnmute: boolean;
  greetingAborts: number;
  finishGreeting: () => void;
  finishReturn: (status?: number) => void;
  commands: string[];
  microphone: MediaStreamTrack;
  audio: HTMLAudioElement;
  closeProvider: () => void;
};

async function install(
  page: Page,
  delayMuteAck = false,
  initialLevel = 0.025,
  holdGreeting = false,
) {
  await page.addInitScript(
    ({ delayMuteAck, initialLevel, holdGreeting }) => {
      const probe = window as unknown as Probe;
      Object.assign(probe, {
        inputLevel: initialLevel,
        starts: 0,
        stops: 0,
        plays: 0,
        sessionRequests: 0,
        closedPeers: 0,
        controls: [],
        holdReturn: false,
        returnAborts: 0,
        endWasAborted: false,
        dropUnmuteAcks: 0,
        rejectUnmute: false,
        greetingAborts: 0,
        commands: [],
      });
      let analyserCount = 0;
      const createAnalyser = AudioContext.prototype.createAnalyser;
      AudioContext.prototype.createAnalyser = function () {
        const analyser = createAnalyser.call(this);
        const isInput = analyserCount++ % 2 === 1;
        const sample = analyser.getByteTimeDomainData.bind(analyser);
        analyser.getByteTimeDomainData = ((data: Uint8Array) => {
          sample(data);
          if (isInput) data.fill(128 + Math.round(probe.inputLevel * 128));
        }) as AnalyserNode["getByteTimeDomainData"];
        return analyser;
      };
      const createBufferSource = AudioContext.prototype.createBufferSource;
      AudioContext.prototype.createBufferSource = function () {
        const node = createBufferSource.call(this);
        const start = node.start.bind(node),
          stop = node.stop.bind(node);
        node.start = ((...args: Parameters<AudioBufferSourceNode["start"]>) => {
          probe.starts++;
          return start(...args);
        }) as AudioBufferSourceNode["start"];
        node.stop = ((...args: Parameters<AudioBufferSourceNode["stop"]>) => {
          probe.stops++;
          return stop(...args);
        }) as AudioBufferSourceNode["stop"];
        return node;
      };
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        if (String(input) === "/api/live/session") {
          probe.sessionRequests++;
          const encoder = new TextEncoder();
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                let open = true;
                probe.emit = (event) => {
                  if (open)
                    controller.enqueue(
                      encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
                    );
                };
                init?.signal?.addEventListener(
                  "abort",
                  () => {
                    open = false;
                    controller.close();
                  },
                  { once: true },
                );
                probe.emit({
                  type: "session",
                  sessionId: "library_mock",
                  sdp: "mock",
                  expiresAt: Date.now() + 240_000,
                });
                probe.emit({ type: "ready" });
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        if (String(input) === "/api/live/control") {
          const action = JSON.parse(String(init?.body)).action;
          probe.controls.push(action);
          if (action === "end")
            probe.endWasAborted = Boolean(init?.signal?.aborted);
          if (holdGreeting && action === "greet")
            return new Promise<Response>((resolve, reject) => {
              const signal = init?.signal;
              const abort = () => {
                probe.greetingAborts++;
                signal?.removeEventListener("abort", abort);
                reject(new DOMException("Aborted", "AbortError"));
              };
              probe.finishGreeting = () => {
                signal?.removeEventListener("abort", abort);
                resolve(
                  Response.json({ ok: true, greetingCue: "unconfirmed" }),
                );
              };
              signal?.addEventListener("abort", abort, { once: true });
              if (signal?.aborted) abort();
            });
          if (
            probe.holdReturn &&
            (action === "recitation_ended" || action === "recitation_skipped")
          )
            return new Promise<Response>((resolve, reject) => {
              const signal = init?.signal;
              const abort = () => {
                probe.returnAborts++;
                signal?.removeEventListener("abort", abort);
                reject(new DOMException("Aborted", "AbortError"));
              };
              probe.finishReturn = (status = 200) => {
                signal?.removeEventListener("abort", abort);
                resolve(
                  Response.json(
                    { ok: status === 200, returnCue: "unconfirmed" },
                    { status },
                  ),
                );
              };
              signal?.addEventListener("abort", abort, { once: true });
              if (signal?.aborted) abort();
            });
          return Response.json({ ok: true });
        }
        return originalFetch(input, init);
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const context = new AudioContext();
        const stream = context.createMediaStreamDestination().stream;
        probe.microphone = stream.getAudioTracks()[0];
        return stream;
      };
      window.RTCPeerConnection = class {
        iceGatheringState = "complete" as RTCIceGatheringState;
        localDescription: RTCSessionDescriptionInit | null = null;
        channel = {
          readyState: "open" as RTCDataChannelState,
          onmessage: null as ((event: MessageEvent<string>) => void) | null,
          onclose: null as (() => void) | null,
          onerror: null,
          send(raw: string) {
            const event = JSON.parse(raw);
            probe.commands.push(event.type);
            if (event.type === "session.input_audio.unmute") {
              if (probe.rejectUnmute) {
                queueMicrotask(() =>
                  this.onmessage?.({
                    data: JSON.stringify({
                      type: "error",
                      error: { client_event_id: event.event_id },
                    }),
                  } as MessageEvent<string>),
                );
                return;
              }
              if (probe.dropUnmuteAcks > 0) {
                probe.dropUnmuteAcks--;
                return;
              }
            }
            if (
              event.event_id &&
              !(delayMuteAck && event.type === "session.input_audio.mute")
            )
              queueMicrotask(() =>
                this.onmessage?.({
                  data: JSON.stringify({
                    type:
                      event.type === "session.input_audio.mute"
                        ? "session.input_audio.muted"
                        : "session.input_audio.unmuted",
                    client_event_id: event.event_id,
                  }),
                } as MessageEvent<string>),
              );
          },
          close() {
            this.readyState = "closed";
          },
        };
        createDataChannel() {
          probe.closeProvider = () =>
            this.channel.onmessage?.({
              data: JSON.stringify({ type: "session.closed" }),
            } as MessageEvent<string>);
          return this.channel as unknown as RTCDataChannel;
        }
        addTrack() {}
        async createOffer() {
          return { type: "offer", sdp: "mock" };
        }
        async setLocalDescription(description: RTCSessionDescriptionInit) {
          this.localDescription = description;
        }
        async setRemoteDescription() {
          queueMicrotask(() =>
            this.channel.onmessage?.({
              data: JSON.stringify({ type: "session.started" }),
            } as MessageEvent<string>),
          );
        }
        close() {
          probe.closedPeers++;
        }
      } as unknown as typeof RTCPeerConnection;
      window.Audio = class extends EventTarget {
        src = "";
        preload = "";
        crossOrigin: string | null = null;
        paused = true;
        error: MediaError | null = null;
        duration = 1000;
        currentTime = 0;
        onplaying: (() => void) | null = null;
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        ontimeupdate: (() => void) | null = null;
        constructor() {
          super();
          probe.audio = this as unknown as HTMLAudioElement;
        }
        pause() {
          this.paused = true;
        }
        async play() {
          this.paused = false;
          probe.plays++;
          this.onplaying?.();
        }
        load() {}
        removeAttribute(name: string) {
          if (name === "src") this.src = "";
        }
      } as unknown as typeof Audio;

      probe.emitSpeech = (timestamp) => {
        const delta = btoa(
          String.fromCharCode(
            ...new Uint8Array(new Int16Array(2400).fill(6000).buffer),
          ),
        );
        const silence = btoa(String.fromCharCode(...new Uint8Array(4800)));
        probe.emit({
          type: "transcript",
          role: "assistant",
          delta: "أنا أستمع إليك، خذ وقتك في الحديث.",
          startMs: timestamp,
          endMs: timestamp + 600,
        });
        for (let offset = 0; offset < 800; offset += 100)
          probe.emit({
            type: "audio",
            delta: offset < 400 ? delta : silence,
            startMs: timestamp + offset,
            endMs: timestamp + offset + 100,
          });
      };
    },
    { delayMuteAck, initialLevel, holdGreeting },
  );
  await page.goto(origin);
  await page.getByRole("button", { name: "ابدأ الحديث", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "إنهاء الحديث", exact: true }),
  ).toBeVisible();
}

test("pending greeting keeps listening and allows its extended budget without duplicating the welcome", async ({
  page,
}) => {
  await install(page, false, 0.002, true);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).controls))
    .toContain("greet");
  expect(
    await page.evaluate(() => (window as unknown as Probe).microphone.enabled),
  ).toBe(true);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    (window as unknown as Probe).inputLevel = 0.13;
  });
  await expect(
    page.getByRole("heading", { name: "تكلّم، سكينة يستمع إليك" }),
  ).toBeVisible();
  // The old universal 10s fetch timeout would kill this otherwise live call.
  await page.waitForTimeout(10_000);
  expect(
    await page.evaluate(() => (window as unknown as Probe).greetingAborts),
  ).toBe(0);
  await expect(page.locator(".call-error")).toHaveCount(0);
  await page.evaluate(() => (window as unknown as Probe).finishGreeting());
  expect(
    await page.evaluate(
      () =>
        (window as unknown as Probe).controls.filter(
          (action) => action === "greet",
        ).length,
    ),
  ).toBe(1);
  expect(
    await page.evaluate(() => (window as unknown as Probe).sessionRequests),
  ).toBe(1);
  await page.getByRole("button", { name: "إنهاء الحديث", exact: true }).click();
});

test("ending during pending greeting cancels its optional welcome but preserves independent close", async ({
  page,
}) => {
  await install(page, false, 0.002, true);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).controls))
    .toContain("greet");
  await page.getByRole("button", { name: "إنهاء الحديث", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as Probe).greetingAborts),
    )
    .toBe(1);
  expect(
    await page.evaluate(() => (window as unknown as Probe).endWasAborted),
  ).toBe(false);
  await expect(
    page.getByRole("button", { name: "ابدأ حديثًا جديدًا", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".call-error")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as unknown as Probe).microphone.readyState,
    ),
  ).toBe("ended");
});

async function emitRecording(page: Page, playbackId?: string) {
  await page.evaluate(
    (playbackId) =>
      (window as unknown as Probe).emit({
        type: "recitation",
        playbackId,
        recitation: {
          id: "surah-2",
          title: "سورة البقرة",
          surah: 2,
          ayahStart: 1,
          ayahEnd: 286,
          fullSurah: true,
          reference: "البقرة كاملة",
          reciter: "ياسر الدوسري",
          audioUrl: "https://example.test/002.mp3",
          sourceUrl: "https://example.test",
          meaning: "",
          context: "",
        },
      }),
    playbackId,
  );
}

for (const action of ["recitation_ended", "recitation_skipped"]) {
  test(`${action} lets the caller resume while its return control is pending and survives an unconfirmed optional cue`, async ({
    page,
  }) => {
    await install(page, false, 0.002);
    await emitRecording(page, "return-held");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Probe).plays))
      .toBe(1);
    expect(
      await page.evaluate(
        () => (window as unknown as Probe).microphone.enabled,
      ),
    ).toBe(false);
    await page.evaluate(() => {
      (window as unknown as Probe).holdReturn = true;
    });
    if (action === "recitation_ended")
      await page.evaluate(() => {
        const audio = (window as unknown as Probe).audio;
        audio.onended?.call(audio, new Event("ended"));
      });
    else await page.getByRole("button", { name: "العودة للحديث" }).click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Probe).controls))
      .toContain(action);
    expect(
      await page.evaluate(
        () => (window as unknown as Probe).microphone.enabled,
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => (window as unknown as Probe).commands),
    ).toContain("session.input_audio.unmute");
    await page.evaluate(() => {
      (window as unknown as Probe).inputLevel = 0.13;
    });
    await expect(
      page.getByRole("heading", { name: "تكلّم، سكينة يستمع إليك" }),
    ).toBeVisible();
    await emitRecording(page, "must-not-overlap-return");
    expect(await page.evaluate(() => (window as unknown as Probe).plays)).toBe(
      1,
    );
    await page.evaluate(() => (window as unknown as Probe).finishReturn());
    await expect(
      page.getByText("نعود إلى حديثنا…", { exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".call-error")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as unknown as Probe).sessionRequests),
    ).toBe(1);
    expect(
      await page.evaluate(
        () => (window as unknown as Probe).microphone.readyState,
      ),
    ).toBe("live");
    await page
      .getByRole("button", { name: "إنهاء الحديث", exact: true })
      .click();
  });
}

test("ending a call aborts its pending return control without aborting End or harming the next call", async ({
  page,
}) => {
  await install(page);
  await emitRecording(page, "return-to-cancel");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).plays))
    .toBe(1);
  await page.evaluate(() => {
    (window as unknown as Probe).holdReturn = true;
  });
  await page.getByRole("button", { name: "العودة للحديث" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).controls))
    .toContain("recitation_skipped");
  await page.getByRole("button", { name: "إنهاء الحديث", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).returnAborts))
    .toBe(1);
  expect(
    await page.evaluate(() => (window as unknown as Probe).endWasAborted),
  ).toBe(false);
  await page
    .getByRole("button", { name: "ابدأ حديثًا جديدًا", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as Probe).sessionRequests),
    )
    .toBe(2);
  // A late mock completion cannot mutate the replacement call's UI.
  await page.evaluate(() => (window as unknown as Probe).finishReturn(503));
  await expect(page.locator(".call-error")).toHaveCount(0);
  await expect(page.getByText("نعود إلى حديثنا…", { exact: true })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(
      () => (window as unknown as Probe).microphone.readyState,
    ),
  ).toBe("live");
  await page.getByRole("button", { name: "إنهاء الحديث", exact: true }).click();
});

test("a failed required return lifecycle still closes a call whose provider state is unconfirmed", async ({
  page,
}) => {
  await install(page);
  await emitRecording(page, "required-return-failure");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).plays))
    .toBe(1);
  await page.evaluate(() => {
    (window as unknown as Probe).holdReturn = true;
  });
  await page.getByRole("button", { name: "العودة للحديث" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).controls))
    .toContain("recitation_skipped");
  await page.evaluate(() => (window as unknown as Probe).finishReturn(503));
  await expect(page.locator(".call-error")).toContainText(
    "تعذّر استئناف الحديث",
  );
  expect(
    await page.evaluate(
      () => (window as unknown as Probe).microphone.readyState,
    ),
  ).toBe("ended");
});

for (const scenario of [
  "first ACK lost",
  "both ACKs lost",
  "rejected",
  "ended",
]) {
  test(`recitation unmute ${scenario}: only a missing ACK permits one bounded same-call retry`, async ({
    page,
  }) => {
    await install(page, false, 0.002);
    await emitRecording(page, "unmute-recovery");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Probe).plays))
      .toBe(1);
    await page.evaluate((scenario) => {
      const probe = window as unknown as Probe;
      probe.dropUnmuteAcks = scenario === "first ACK lost" ? 1 : 2;
      probe.rejectUnmute = scenario === "rejected";
    }, scenario);
    await page.getByRole("button", { name: "العودة للحديث" }).click();
    const unmuteCount = () =>
      page.evaluate(
        () =>
          (window as unknown as Probe).commands.filter(
            (command) => command === "session.input_audio.unmute",
          ).length,
      );
    await expect.poll(unmuteCount).toBe(1);
    expect(
      await page.evaluate(
        () => (window as unknown as Probe).microphone.enabled,
      ),
    ).toBe(false);
    if (scenario === "ended") {
      await page
        .getByRole("button", { name: "إنهاء الحديث", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "ابدأ حديثًا جديدًا", exact: true }),
      ).toBeVisible();
      await page.waitForTimeout(3500);
      expect(await unmuteCount()).toBe(1);
      await expect(page.locator(".call-error")).toHaveCount(0);
      return;
    }
    if (scenario === "rejected") {
      await expect(page.locator(".call-error")).toContainText(
        "تعذّر استئناف الحديث",
      );
      expect(await unmuteCount()).toBe(1);
    } else {
      await expect.poll(unmuteCount, { timeout: 7000 }).toBe(2);
      if (scenario === "first ACK lost") {
        await expect
          .poll(() =>
            page.evaluate(() => (window as unknown as Probe).controls),
          )
          .toContain("recitation_skipped");
        expect(
          await page.evaluate(
            () => (window as unknown as Probe).microphone.enabled,
          ),
        ).toBe(true);
        await expect(page.locator(".call-error")).toHaveCount(0);
        expect(
          await page.evaluate(
            () => (window as unknown as Probe).sessionRequests,
          ),
        ).toBe(1);
        await page
          .getByRole("button", { name: "إنهاء الحديث", exact: true })
          .click();
        return;
      }
      await expect(page.locator(".call-error")).toContainText(
        "تعذّر استئناف الحديث",
        {
          timeout: 7000,
        },
      );
      expect(await unmuteCount()).toBe(2);
    }
    expect(
      await page.evaluate(
        () => (window as unknown as Probe).microphone.readyState,
      ),
    ).toBe("ended");
    expect(
      await page.evaluate(() => (window as unknown as Probe).controls),
    ).not.toContain("recitation_skipped");
  });
}

test("background noise no longer strands recovery after an interruption", async ({
  page,
}) => {
  await install(page);
  await page.waitForTimeout(800);
  await page.evaluate(() => (window as unknown as Probe).emitSpeech(1000));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).starts))
    .toBe(1);
  expect(await page.evaluate(() => (window as unknown as Probe).stops)).toBe(0);
  await page.evaluate(() => {
    (window as unknown as Probe).inputLevel = 0.13;
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).stops))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    const probe = window as unknown as Probe;
    probe.emitSpeech(2000); // Late, fully reviewed old reply must stay discarded.
    probe.inputLevel = 0.025;
  });
  await page.waitForTimeout(1600);
  expect(await page.evaluate(() => (window as unknown as Probe).starts)).toBe(
    1,
  );
  await page.evaluate(() => (window as unknown as Probe).emitSpeech(5000));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).starts))
    .toBe(2);
  await expect(page.locator(".call-error")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as Probe).sessionRequests),
  ).toBe(1);
  await page.getByRole("button", { name: "إنهاء الحديث", exact: true }).click();
});

test("later steady ambient noise is learned without releasing continuing stale PCM", async ({
  page,
}) => {
  await install(page, false, 0.002);
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as unknown as Probe).emitSpeech(1000));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).starts))
    .toBe(1);
  await page.evaluate(() => {
    (window as unknown as Probe).inputLevel = 0.025;
  });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).stops))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    const probe = window as unknown as Probe;
    let timestamp = 2000;
    const late = window.setInterval(() => {
      probe.emitSpeech(timestamp);
      timestamp += 800;
    }, 200);
    window.setTimeout(() => window.clearInterval(late), 4400);
  });
  await page.waitForTimeout(4500);
  expect(await page.evaluate(() => (window as unknown as Probe).starts)).toBe(
    1,
  );
  await page.waitForTimeout(1200);
  await page.evaluate(() => (window as unknown as Probe).emitSpeech(25000));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).starts))
    .toBe(2);
  await expect(page.locator(".call-error")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as Probe).sessionRequests),
  ).toBe(1);
  await page.getByRole("button", { name: "إنهاء الحديث", exact: true }).click();
});

test("recognized soft speech can interrupt after sharing the initial room amplitude", async ({
  page,
}) => {
  await install(page, false, 0.018);
  await page.waitForTimeout(800);
  await page.evaluate(() => (window as unknown as Probe).emitSpeech(1000));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).starts))
    .toBe(1);
  await page.evaluate(() =>
    (window as unknown as Probe).emit({
      type: "transcript",
      role: "user",
      delta: "أنا ما زلت أتكلم",
      startMs: 1600,
      endMs: 2000,
    }),
  );
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).stops))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    (window as unknown as Probe).inputLevel = 0.002;
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => (window as unknown as Probe).emitSpeech(5000));
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).starts))
    .toBe(2);
  await page.getByRole("button", { name: "إنهاء الحديث", exact: true }).click();
});

for (const ambient of [0.002, 0.025]) {
  test(`late and duplicate caller fragments cannot interrupt a fresh answer at ambient ${ambient}`, async ({
    page,
  }) => {
    await install(page, false, ambient);
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      const probe = window as unknown as Probe;
      probe.emit({
        type: "transcript",
        role: "user",
        delta: "حديث سابق",
        startMs: 1000,
        endMs: 1200,
      });
    });
    // Finish any valid earlier speech evidence before starting the new answer.
    await page.waitForTimeout(1600);
    await page.evaluate(() => (window as unknown as Probe).emitSpeech(5000));
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Probe).starts))
      .toBe(1);
    const stops = await page.evaluate(() => (window as unknown as Probe).stops);
    await page.evaluate((ambient) => {
      const probe = window as unknown as Probe;
      probe.emit({
        type: "transcript",
        role: "user",
        delta: "حديث سابق",
        startMs: 1000,
        endMs: 1200,
      });
      probe.emit({
        type: "transcript",
        role: "user",
        delta: "جزء قديم متأخر",
        startMs: 1300,
        endMs: 1400,
      });
      probe.emit({
        type: "transcript",
        role: "user",
        delta: "توقيت غير موجود",
      });
      if (ambient === 0.002)
        probe.emit({
          type: "transcript",
          role: "user",
          delta: "وصل النص بعد انتهاء الكلام",
          startMs: 5200,
          endMs: 5300,
        });
    }, ambient);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => (window as unknown as Probe).stops)).toBe(
      stops,
    );
    await page.evaluate(() => (window as unknown as Probe).emitSpeech(8000));
    await expect
      .poll(() => page.evaluate(() => (window as unknown as Probe).starts))
      .toBe(2);
    await expect(page.locator(".call-error")).toHaveCount(0);
    await page
      .getByRole("button", { name: "إنهاء الحديث", exact: true })
      .click();
  });
}

test("a completed playback ID cannot replay itself but a new ID and legacy event can", async ({
  page,
}) => {
  await install(page);
  await emitRecording(page, "play-one");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).plays))
    .toBe(1);
  await page.getByRole("button", { name: "العودة للحديث" }).click();
  await expect(
    page.getByRole("button", { name: "كتم الميكروفون", exact: true }),
  ).toBeEnabled();
  await emitRecording(page, "play-one");
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as unknown as Probe).plays)).toBe(1);
  await expect(
    page.getByRole("region", { name: "التلاوة القرآنية" }),
  ).toHaveCount(0);
  await emitRecording(page, "play-two");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).plays))
    .toBe(2);
  await page.getByRole("button", { name: "العودة للحديث" }).click();
  await expect(
    page.getByRole("button", { name: "كتم الميكروفون", exact: true }),
  ).toBeEnabled();
  await emitRecording(page);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).plays))
    .toBe(3);
  await page.getByRole("button", { name: "إنهاء الحديث", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).audio.paused))
    .toBe(true);
});

test("the 4-minute voice deadline closes capture and provider while a full recording continues", async ({
  page,
}) => {
  await page.clock.install();
  await install(page);
  await emitRecording(page, "long-recording");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).plays))
    .toBe(1);
  await page.clock.fastForward(240_000);
  await expect(
    page.getByText(
      "انتهى وقت الحديث وأُغلق الميكروفون. يمكنك إكمال التلاوة أو إيقافها.",
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as Probe).microphone.readyState,
    ),
  ).toBe("ended");
  expect(
    await page.evaluate(() => (window as unknown as Probe).closedPeers),
  ).toBe(1);
  expect(
    await page.evaluate(() => (window as unknown as Probe).audio.paused),
  ).toBe(false);
  expect(
    await page.evaluate(() => (window as unknown as Probe).controls),
  ).toContain("end");
  await expect(
    page.getByRole("button", { name: "كتم الميكروفون", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "ابدأ حديثًا جديدًا", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "إيقاف التلاوة مؤقتًا", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as unknown as Probe).audio.paused),
  ).toBe(true);
  await page
    .getByRole("button", { name: "تشغيل التلاوة", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as unknown as Probe).audio.paused),
  ).toBe(false);
  await page
    .getByRole("button", { name: "إعادة التلاوة من البداية", exact: true })
    .click();
  expect(
    await page.evaluate(() => (window as unknown as Probe).sessionRequests),
  ).toBe(1);
  await page
    .getByRole("button", { name: "إنهاء التلاوة", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "ابدأ حديثًا جديدًا", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as Probe).audio.paused),
  ).toBe(true);
});

test("provider expiry during mute acknowledgement leaves a usable original player", async ({
  page,
}) => {
  await install(page, true);
  await emitRecording(page, "pending-recording");
  await expect(
    page.getByRole("region", { name: "التلاوة القرآنية" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as unknown as Probe).emit({ type: "closed", reason: "expired" }),
  );
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).plays))
    .toBe(1);
  await expect(
    page.getByRole("button", { name: "إيقاف التلاوة مؤقتًا", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(
      () => (window as unknown as Probe).microphone.readyState,
    ),
  ).toBe("ended");
  await page.evaluate(() => {
    const audio = (window as unknown as Probe).audio;
    audio.onended?.call(audio, new Event("ended"));
  });
  await expect(
    page.getByRole("button", { name: "ابدأ حديثًا جديدًا", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as Probe).sessionRequests),
  ).toBe(1);
  await expect(page.locator(".call-error")).toHaveCount(0);
});

test("provider channel closure before its final stream event cannot cut the recording", async ({
  page,
}) => {
  await install(page);
  await emitRecording(page, "close-race");
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).plays))
    .toBe(1);
  await page.evaluate(() => (window as unknown as Probe).closeProvider());
  await expect(
    page.getByText(
      "انتهى الاتصال الصوتي وأُغلق الميكروفون. يمكنك إكمال التلاوة أو إيقافها.",
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as Probe).audio.paused),
  ).toBe(false);
  expect(
    await page.evaluate(
      () => (window as unknown as Probe).microphone.readyState,
    ),
  ).toBe("ended");
  await page
    .getByRole("button", { name: "إنهاء التلاوة", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "ابدأ حديثًا جديدًا", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as Probe).sessionRequests),
  ).toBe(1);
});
