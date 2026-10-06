import { expect, test } from "@playwright/test";

// This regression drives the actual browser hook with a
// mocked transport and injected analyser samples. This tests interruption
// state transitions, not physical microphone capture. No paid request is made.
const origin = process.env.SAKINA_BASE_URL || "http://localhost:3000";

test("rapid microphone barge-ins keep the call live and only release fresh PCM", async ({
  page,
}) => {
  await page.addInitScript(() => {
    type Probe = {
      emit?: (event: unknown) => void;
      starts: number;
      stops: number;
      sessionRequests: number;
      controls: string[];
      forceInput: boolean;
      input?: AudioContext;
      microphone?: MediaStreamTrack;
      emitSpeech?: (timestamp: number, text: string) => void;
      lateTail?: (timestamp: number, milliseconds: number) => void;
    };
    const probe = window as unknown as Probe;
    probe.starts = 0;
    probe.stops = 0;
    let analyserCount = 0;
    const createAnalyser = AudioContext.prototype.createAnalyser;
    AudioContext.prototype.createAnalyser = function () {
      const analyser = createAnalyser.call(this);
      const isInput = analyserCount++ % 2 === 1;
      const sample = analyser.getByteTimeDomainData.bind(analyser);
      analyser.getByteTimeDomainData = ((data: Uint8Array) => {
        sample(data);
        if (isInput && probe.forceInput) data.fill(160);
      }) as AnalyserNode["getByteTimeDomainData"];
      return analyser;
    };
    probe.sessionRequests = 0;
    probe.controls = [];
    probe.forceInput = false;

    const source = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const node = source.call(this);
      const start = node.start.bind(node);
      node.start = ((...args: Parameters<AudioBufferSourceNode["start"]>) => {
        if (this !== probe.input) probe.starts++;
        return start(...args);
      }) as AudioBufferSourceNode["start"];
      const stop = node.stop.bind(node);
      node.stop = ((...args: Parameters<AudioBufferSourceNode["stop"]>) => {
        if (this !== probe.input) probe.stops++;
        return stop(...args);
      }) as AudioBufferSourceNode["stop"];
      return node;
    };

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (String(input) === "/api/live/session") {
        probe.sessionRequests++;
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            probe.emit = (event) =>
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
              );
            probe.emit({
              type: "session",
              sessionId: "stress_mock",
              sdp: "mock",
              expiresAt: Date.now() + 240_000,
            });
            probe.emit({ type: "ready" });
          },
        });
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (String(input) === "/api/live/control") {
        probe.controls.push(JSON.parse(String(init?.body)).action);
        return Response.json({ ok: true });
      }
      return originalFetch(input, init);
    };
    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext({ sampleRate: 24_000 });
      await context.resume();
      probe.input = context;
      const destination = context.createMediaStreamDestination();
      const stream = destination.stream;
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
          if (event.event_id)
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
        close() {},
      };
      createDataChannel() {
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
      close() {}
    } as unknown as typeof RTCPeerConnection;
  });

  await page.goto(origin);
  await page.getByRole("button", { name: "ابدأ الحديث", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "إنهاء الحديث" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const probe = window as unknown as {
      emit: (event: unknown) => void;
      emitSpeech: (timestamp: number, text: string) => void;
      lateTail: (timestamp: number, milliseconds: number) => void;
    };
    const samples = new Int16Array(2400).fill(6000);
    const delta = btoa(String.fromCharCode(...new Uint8Array(samples.buffer)));
    const silence = btoa(String.fromCharCode(...new Uint8Array(4800)));
    probe.emitSpeech = (timestamp, text) => {
      probe.emit({
        type: "transcript",
        role: "assistant",
        delta: text,
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
    probe.lateTail = (timestamp, milliseconds) => {
      let at = timestamp;
      const interval = window.setInterval(() => {
        probe.emit({ type: "audio", delta, startMs: at, endMs: at + 100 });
        at += 100;
      }, 100);
      window.setTimeout(() => window.clearInterval(interval), milliseconds);
    };
  });

  const emitSpeech = (timestamp: number, text: string) =>
    page.evaluate(
      ([at, words]) =>
        (
          window as unknown as {
            emitSpeech: (timestamp: number, text: string) => void;
          }
        ).emitSpeech(at, words),
      [timestamp, text] as const,
    );
  const interruptWithMeterAndLateTail = async (timestamp: number) => {
    const before = await page.evaluate(
      () => (window as unknown as { stops: number }).stops,
    );
    await page.evaluate(() => {
      const probe = window as unknown as {
        forceInput: boolean;
        lateTail: (timestamp: number, milliseconds: number) => void;
      };
      probe.forceInput = true;
      window.setTimeout(() => (probe.forceInput = false), 340);
    });
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { stops: number }).stops),
      )
      .toBeGreaterThan(before);
    await page.evaluate((at) => {
      const probe = window as unknown as {
        emit: (event: unknown) => void;
        lateTail: (timestamp: number, milliseconds: number) => void;
        emitSpeech: (timestamp: number, text: string) => void;
      };
      probe.lateTail(at, 900);
      // This complete reply arrives while the output gate is held. It must be
      // discarded rather than appearing after the caller stops speaking.
      probe.emitSpeech(at + 1_000, "هذا رد قديم لم يسمعه المتحدث.");
      // A reset storm must not free the old output nor make recovery fatal.
      window.setTimeout(
        () => probe.emit({ type: "audio_reset", reason: "provider_error" }),
        140,
      );
      window.setTimeout(
        () => probe.emit({ type: "audio_reset", reason: "provider_error" }),
        260,
      );
    }, timestamp);
    await page.waitForTimeout(1_700);
  };

  // Brief mocked meter noise should not interrupt a reviewed answer.
  await emitSpeech(1_000, "أنا أستمع إليك، خذ وقتك في الحديث.");
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                starts: number;
              }
            ).starts,
        ),
      { timeout: 9_000 },
    )
    .toBe(1);
  const startsBeforeNoise = await page.evaluate(
    () => (window as unknown as { starts: number }).starts,
  );
  const stopsBeforeNoise = await page.evaluate(
    () => (window as unknown as { stops: number }).stops,
  );
  await page.evaluate(() => {
    const probe = window as unknown as { forceInput: boolean };
    probe.forceInput = true;
    window.setTimeout(() => (probe.forceInput = false), 70);
  });
  await page.waitForTimeout(450);
  expect(
    await page.evaluate(() => (window as unknown as { starts: number }).starts),
  ).toBe(startsBeforeNoise);
  expect(
    await page.evaluate(() => (window as unknown as { stops: number }).stops),
  ).toBe(stopsBeforeNoise);

  // Three separate mocked meter interruptions each arrive while an approved source
  // is playing. Old provider PCM and reset storms must remain inaudible; each
  // later, reviewed response must be allowed through once the inputs stop.
  await interruptWithMeterAndLateTail(1_800);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { controls: string[] }).controls.filter(
            (action) => action === "speech_interrupted",
          ).length,
      ),
    )
    .toBe(1);
  await emitSpeech(5_000, "تابع حديثك بهدوء، أنا أصغي إليك.");
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { starts: number }).starts),
    )
    .toBe(2);
  await interruptWithMeterAndLateTail(5_800);
  await page
    .getByRole("button", { name: "كتم الميكروفون", exact: true })
    .click();
  await page.waitForTimeout(1500);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { controls: string[] }).controls.filter(
          (x) => x === "speech_interrupted",
        ).length,
    ),
  ).toBe(1);
  await page
    .getByRole("button", { name: "تشغيل الميكروفون", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { controls: string[] }).controls.filter(
            (action) => action === "speech_interrupted",
          ).length,
      ),
    )
    .toBe(2);
  await emitSpeech(9_000, "أفهم ما تقوله، خذ وقتك في التعبير.");
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { starts: number }).starts),
    )
    .toBe(3);
  await interruptWithMeterAndLateTail(9_800);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { controls: string[] }).controls.filter(
            (action) => action === "speech_interrupted",
          ).length,
      ),
    )
    .toBe(3);
  await emitSpeech(13_000, "أنا حاضر للاستماع إليك بهدوء.");
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { starts: number }).starts),
    )
    .toBe(4);

  await expect(page.locator(".call-error")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "إنهاء الحديث" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { sessionRequests: number }).sessionRequests,
    ),
  ).toBe(1);
  await page.evaluate(() => {
    (window as unknown as { emit: (event: unknown) => void }).emit({
      type: "closed",
      reason: "close_requested",
    });
  });
  await expect(
    page.getByRole("button", { name: "ابدأ حديثًا جديدًا" }),
  ).toBeVisible();
  await page.waitForTimeout(700);
  expect(
    await page.evaluate(() => (window as unknown as { starts: number }).starts),
  ).toBe(4);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { microphone: MediaStreamTrack }).microphone
          .readyState,
    ),
  ).toBe("ended");
  await page.evaluate(() =>
    (window as unknown as { input?: AudioContext }).input?.close(),
  );
});
