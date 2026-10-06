import { expect, test } from "@playwright/test";

// Real browser audio gate with mocked provider transport: no paid API call.
// The previous six-second quiet deadline ended the call during a longer
// discarded response instead of waiting for safe fresh audio.
const origin = process.env.SAKINA_BASE_URL || "http://localhost:3000";

test("provider reset holds continuous output, then resumes only fresh reviewed audio", async ({
  page,
}) => {
  await page.addInitScript(() => {
    type Probe = {
      emit?: (event: unknown) => void;
      input?: AudioContext;
      microphone?: MediaStreamTrack;
      sessionRequests: number;
      starts: number;
      stopFrames?: () => void;
    };
    const probe = window as unknown as Probe;
    probe.starts = 0;
    probe.sessionRequests = 0;
    const originalCreateBufferSource =
      AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const source = originalCreateBufferSource.call(this);
      const originalStart = source.start.bind(source);
      source.start = ((...args: Parameters<AudioBufferSourceNode["start"]>) => {
        probe.starts++;
        return originalStart(...args);
      }) as AudioBufferSourceNode["start"];
      return source;
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
              sessionId: "audio_reset_mock",
              sdp: "mock",
              expiresAt: Date.now() + 240_000,
              maxDurationSeconds: 240,
            });
            probe.emit({ type: "ready" });
          },
        });
        return new Response(body, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (String(input) === "/api/live/control")
        return Response.json({ ok: true });
      return originalFetch(input, init);
    };

    navigator.mediaDevices.getUserMedia = async () => {
      const context = new AudioContext();
      probe.input = context;
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
        send() {},
        close() {},
      };
      createDataChannel() {
        return this.channel as unknown as RTCDataChannel;
      }
      addTrack() {}
      async createOffer() {
        return { type: "offer", sdp: "mock" } as RTCSessionDescriptionInit;
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
      stopFrames?: () => void;
    };
    const emit = probe.emit;
    const samples = new Int16Array(2400).fill(6000); // 100ms PCM16LE at 24kHz
    const bytes = new Uint8Array(samples.buffer);
    const delta = btoa(String.fromCharCode(...bytes));
    let timestamp = 0;
    const frame = () => {
      emit({
        type: "audio",
        delta,
        startMs: timestamp,
        endMs: timestamp + 100,
      });
      timestamp += 100;
    };
    frame();
    emit({ type: "audio_reset", reason: "provider_error" });
    const interval = window.setInterval(frame, 100);
    probe.stopFrames = () => window.clearInterval(interval);
  });

  // More than the old 6s deadline: the session stays live but nothing from
  // the reset period can be rendered.
  await page.waitForTimeout(7_200);
  await expect(page.locator(".call-error")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "إنهاء الحديث" }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { starts: number }).starts),
  ).toBe(0);
  expect(
    await page.evaluate(() => {
      const probe = window as unknown as {
        microphone: MediaStreamTrack;
        sessionRequests: number;
      };
      return {
        microphone: probe.microphone.readyState,
        starts: probe.sessionRequests,
      };
    }),
  ).toEqual({ microphone: "live", starts: 1 });

  await page.evaluate(() => {
    const probe = window as unknown as {
      stopFrames?: () => void;
    };
    probe.stopFrames?.();
  });
  // GuardedAudio first observes 650ms of quiet before it opens its gate.
  await page.waitForTimeout(900);
  await page.evaluate(() => {
    const probe = window as unknown as {
      emit: (event: unknown) => void;
    };
    const samples = new Int16Array(2400).fill(6000);
    const delta = btoa(String.fromCharCode(...new Uint8Array(samples.buffer)));
    // A timestamp well after the held stream makes this a fresh utterance;
    // the matching transcript is deliberately non-scriptural.
    probe.emit({
      type: "transcript",
      role: "assistant",
      delta: "أنا أستمع إليك، خذ وقتك في الحديث.",
      startMs: 8_000,
      endMs: 8_100,
    });
    probe.emit({ type: "audio", delta, startMs: 8_000, endMs: 8_100 });
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { starts: number }).starts),
    )
    .toBe(1);

  // A close during another held interval must cancel everything, rather than
  // releasing delayed provider audio into a later call.
  await page.evaluate(() => {
    const probe = window as unknown as { emit: (event: unknown) => void };
    probe.emit({ type: "audio_reset", reason: "provider_error" });
    probe.emit({ type: "closed", reason: "close_requested" });
  });
  await expect(
    page.getByRole("button", { name: "ابدأ حديثًا جديدًا" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { microphone: MediaStreamTrack }).microphone
          .readyState,
    ),
  ).toBe("ended");
  await page.waitForTimeout(800);
  expect(
    await page.evaluate(() => (window as unknown as { starts: number }).starts),
  ).toBe(1);
  await page.evaluate(() =>
    (window as unknown as { input?: AudioContext }).input?.close(),
  );
});
