import { expect, test, type Page } from "@playwright/test";

const origin = process.env.SAKINA_BASE_URL || "http://localhost:3000";

type Mode = "normal" | "throw-close" | "late-resume";

async function install(page: Page, mode: Mode) {
  await page.addInitScript((mode: Mode) => {
    const nativeAudio = window.AudioContext;
    let contexts = 0;
    const probe = window as unknown as {
      emit?: (event: unknown) => void;
      commands: string[];
      plays: number;
      log: string[];
    };
    probe.commands = [];
    probe.plays = 0;
    probe.log = [];

    if (mode === "late-resume")
      window.AudioContext = class extends nativeAudio {
        readonly testNumber = ++contexts;
        resume() {
          if (this.testNumber === 1)
            return new Promise<void>((_resolve, reject) =>
              window.setTimeout(
                () => reject(new DOMException("late lock", "NotAllowedError")),
                2_600,
              ),
            );
          return super.resume();
        }
      } as unknown as typeof AudioContext;

    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (String(input) === "/api/live/session") {
        probe.log.push("session_fetch");
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            probe.emit = (event) =>
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
              );
            probe.log.push("session_stream");
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
      if (String(input) === "/api/live/control")
        return Response.json({ ok: true });
      return originalFetch(input, init);
    };

    navigator.mediaDevices.getUserMedia = async () =>
      new nativeAudio().createMediaStreamDestination().stream;

    window.RTCPeerConnection = class {
      iceGatheringState = "complete" as RTCIceGatheringState;
      localDescription: RTCSessionDescriptionInit | null = null;
      channel = {
        readyState: "open" as RTCDataChannelState,
        onmessage: null as ((event: MessageEvent<string>) => void) | null,
        onclose: null as (() => void) | null,
        onerror: null,
        send(data: string) {
          const event = JSON.parse(data);
          probe.commands.push(event.type);
          if (mode === "throw-close" && event.type === "session.close")
            throw new DOMException("closed", "InvalidStateError");
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
        return { type: "offer", sdp: "mock" } as RTCSessionDescriptionInit;
      }
      async setLocalDescription(description: RTCSessionDescriptionInit) {
        this.localDescription = description;
      }
      async setRemoteDescription() {
        probe.log.push("remote_description");
        queueMicrotask(() =>
          this.channel.onmessage?.({
            data: JSON.stringify({ type: "session.started" }),
          } as MessageEvent<string>),
        );
      }
      close() {}
    } as unknown as typeof RTCPeerConnection;

    window.Audio = class extends EventTarget {
      src = "";
      preload = "";
      crossOrigin: string | null = null;
      paused = true;
      error: MediaError | null = null;
      duration = 10;
      private time = 0;
      onplaying: (() => void) | null = null;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      ontimeupdate: (() => void) | null = null;
      get currentTime() {
        return this.time;
      }
      set currentTime(value) {
        this.time = value;
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
      removeAttribute() {}
    } as unknown as typeof Audio;
  }, mode);
}

function recitation() {
  return {
    id: "sharh",
    title: "سورة الشرح",
    surah: 94,
    ayahStart: 1,
    ayahEnd: 8,
    reference: "الشرح ١–٨",
    reciter: "ياسر الدوسري",
    audioUrl: "https://example.test/sharh.mp3",
    sourceUrl: "https://example.test",
    meaning: "",
    context: "",
  };
}

test("a recitation handoff survives a provider reset that supersedes its first resume", async ({
  page,
}) => {
  await install(page, "normal");
  await page.goto(origin);
  await page.getByRole("button", { name: "ابدأ الحديث", exact: true }).click();
  await page
    .getByRole("button", { name: "إنهاء الحديث", exact: true })
    .waitFor();
  await page.evaluate((item) => {
    const probe = window as unknown as { emit: (event: unknown) => void };
    probe.emit({ type: "recitation", recitation: item });
  }, recitation());
  await page.getByRole("region", { name: "التلاوة القرآنية" }).waitFor();
  await page.evaluate(() => {
    const probe = window as unknown as { emit: (event: unknown) => void };
    const pcm = new Int16Array(2400).fill(5000);
    probe.emit({
      type: "audio",
      delta: btoa(String.fromCharCode(...new Uint8Array(pcm.buffer))),
      startMs: 1_000,
      endMs: 1_100,
    });
  });
  await page.getByRole("button", { name: "العودة للحديث" }).click();
  await page.evaluate(() =>
    (window as unknown as { emit: (event: unknown) => void }).emit({
      type: "audio_reset",
      reason: "provider_error",
    }),
  );
  await page.waitForTimeout(900);
  await expect(page.locator(".call-error")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "إنهاء الحديث" }),
  ).toBeVisible();
});

test("a delayed audio-context rejection from an old call cannot lock a newer call", async ({
  page,
}) => {
  await install(page, "late-resume");
  await page.goto(origin);
  await page.getByRole("button", { name: "ابدأ الحديث", exact: true }).click();
  await page
    .getByRole("button", { name: "إنهاء الحديث", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "إنهاء الحديث", exact: true }).click();
  await page.getByRole("button", { name: "ابدأ حديثًا جديدًا" }).waitFor();
  await page.getByRole("button", { name: "ابدأ حديثًا جديدًا" }).click();
  await page
    .getByRole("button", { name: "إنهاء الحديث", exact: true })
    .waitFor();
  await page.waitForTimeout(1_100);
  await expect(
    page.getByRole("button", { name: "اضغط لتشغيل صوت سكينة" }),
  ).toHaveCount(0);
});

test("a simultaneous mute and recitation request leaves one live call and one recording", async ({
  page,
}) => {
  await install(page, "normal");
  await page.goto(origin);
  await page.getByRole("button", { name: "ابدأ الحديث", exact: true }).click();
  await page
    .getByRole("button", { name: "إنهاء الحديث", exact: true })
    .waitFor();
  await page.evaluate((item) => {
    document
      .querySelector<HTMLButtonElement>('[aria-label="كتم الميكروفون"]')!
      .click();
    (window as unknown as { emit: (event: unknown) => void }).emit({
      type: "recitation",
      recitation: item,
    });
  }, recitation());
  await page.getByRole("region", { name: "التلاوة القرآنية" }).waitFor();
  await expect(page.locator(".call-error")).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { plays: number }).plays),
    )
    .toBe(1);
});

test("an end-call data-channel race cannot throw or strand the call", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await install(page, "throw-close");
  await page.goto(origin);
  await page.getByRole("button", { name: "ابدأ الحديث", exact: true }).click();
  await page
    .getByRole("button", { name: "إنهاء الحديث", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "إنهاء الحديث", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "ابدأ حديثًا جديدًا" }),
  ).toBeVisible();
  expect(pageErrors).toEqual([]);
});
