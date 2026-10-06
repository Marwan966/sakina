import { test, expect } from "@playwright/test";

const origin = process.env.SAKINA_BASE_URL || "http://localhost:3000";

test("audio constructor failure offers retry instead of an endless connecting state", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/live/session", (route) => {
    requests++;
    return route.abort();
  });
  await page.addInitScript(() => {
    window.AudioContext = class {
      constructor() {
        throw new DOMException(
          "Audio devices unavailable",
          "NotSupportedError",
        );
      }
    } as unknown as typeof AudioContext;
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "ابدأ الحديث", exact: true }).click();
  await expect(page.locator(".call-error")).toContainText("تعذّر تجهيز الصوت");
  await expect(
    page.getByRole("button", { name: "حاول الاتصال مجددًا" }),
  ).toBeEnabled();
  expect(requests).toBe(0);
});

test("page restore resets an interrupted microphone request and releases late tracks", async ({
  page,
}) => {
  let requests = 0;
  await page.route("**/api/live/session", (route) => {
    requests++;
    return route.abort();
  });
  await page.addInitScript(() => {
    const probe = window as unknown as {
      micRequested: boolean;
      resolveMic?: () => void;
      testTrack?: MediaStreamTrack;
      testAudio?: AudioContext;
    };
    probe.micRequested = false;
    navigator.mediaDevices.getUserMedia = () =>
      new Promise<MediaStream>((resolve) => {
        probe.micRequested = true;
        probe.resolveMic = () => {
          const context = new AudioContext();
          probe.testAudio = context;
          const stream = context.createMediaStreamDestination().stream;
          probe.testTrack = stream.getAudioTracks()[0];
          resolve(stream);
        };
      });
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "ابدأ الحديث", exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { micRequested: boolean }).micRequested,
      ),
    )
    .toBe(true);
  await page.evaluate(() => {
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    );
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    (window as unknown as { resolveMic: () => void }).resolveMic();
  });
  await expect(
    page.getByRole("button", { name: "ابدأ حديثًا جديدًا" }),
  ).toBeEnabled();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { testTrack: MediaStreamTrack }).testTrack
            .readyState,
      ),
    )
    .toBe("ended");
  expect(requests).toBe(0);
  await page.evaluate(() =>
    (window as unknown as { testAudio: AudioContext }).testAudio.close(),
  );
});

for (const finishAction of [
  "skip",
  "end",
  "no_ack",
  "ready_controls",
  "range_end",
  "range_skip",
  "range_error",
  "range_replay",
  "range_end_during_seek",
] as const)
  test(`a ${finishAction} recording cannot start after its delayed server acknowledgement`, async ({
    page,
  }) => {
    await page.addInitScript(
      ({
        shouldAcknowledgeInput,
        ranged,
      }: {
        shouldAcknowledgeInput: boolean;
        ranged: boolean;
      }) => {
        type Probe = {
          emit?: (event: unknown) => void;
          acknowledgeStart?: () => void;
          startedPending: boolean;
          skipped: boolean;
          clipPlays: number;
          inputContext?: AudioContext;
          closeTransport?: () => void;
          seekPending: boolean;
          finishSeek?: () => void;
          mediaError?: () => void;
          passageEnd?: () => void;
          completed: number;
          playPositions: number[];
        };
        const probe = window as unknown as Probe;
        probe.startedPending = false;
        probe.skipped = false;
        probe.clipPlays = 0;
        probe.seekPending = false;
        probe.completed = 0;
        probe.playPositions = [];
        if (ranged)
          AudioContext.prototype.createMediaElementSource = (() => ({
            connect() {},
            disconnect() {},
          })) as unknown as AudioContext["createMediaElementSource"];
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          if (String(input) === "/api/live/session") {
            const encoder = new TextEncoder();
            const body = new ReadableStream<Uint8Array>({
              start(controller) {
                probe.emit = (event) =>
                  controller.enqueue(
                    encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
                  );
                probe.emit({
                  type: "session",
                  sessionId: "live_mock",
                  sdp: "mock",
                  expiresAt: Date.now() + 240000,
                  maxDurationSeconds: 240,
                });
                probe.emit({ type: "ready" });
              },
            });
            return new Response(body, {
              headers: { "Content-Type": "text/event-stream" },
            });
          }
          if (String(input) === "/api/live/control") {
            const body = JSON.parse(String(init?.body));
            if (body.action === "recitation_started") {
              probe.startedPending = true;
              return new Promise<Response>((resolve) => {
                probe.acknowledgeStart = () =>
                  resolve(Response.json({ ok: true }));
              });
            }
            if (body.action === "recitation_skipped") probe.skipped = true;
            if (body.action === "recitation_ended") probe.completed++;
            return Response.json({ ok: true });
          }
          return originalFetch(input, init);
        };
        navigator.mediaDevices.getUserMedia = async () => {
          const context = new AudioContext();
          probe.inputContext = context;
          return context.createMediaStreamDestination().stream;
        };
        window.RTCPeerConnection = class {
          iceGatheringState = "complete";
          localDescription: { sdp: string } | null = null;
          channel = {
            readyState: "open",
            onmessage: null as null | ((event: { data: string }) => void),
            onclose: null as null | (() => void),
            onerror: null,
            send(data: string) {
              const event = JSON.parse(data);
              if (!shouldAcknowledgeInput) return;
              if (
                event.type === "session.input_audio.mute" ||
                event.type === "session.input_audio.unmute"
              ) {
                queueMicrotask(() =>
                  this.onmessage?.({
                    data: JSON.stringify({
                      type:
                        event.type === "session.input_audio.mute"
                          ? "session.input_audio.muted"
                          : "session.input_audio.unmuted",
                      client_event_id: event.event_id,
                    }),
                  }),
                );
              }
            },
            close() {},
          };
          createDataChannel() {
            probe.closeTransport = () => this.channel.onclose?.();
            return this.channel;
          }
          addTrack() {}
          async createOffer() {
            return { type: "offer", sdp: "mock" };
          }
          async setLocalDescription(description: { sdp: string }) {
            this.localDescription = description;
          }
          async setRemoteDescription() {
            queueMicrotask(() =>
              this.channel.onmessage?.({
                data: JSON.stringify({ type: "session.started" }),
              }),
            );
          }
          close() {}
        } as unknown as typeof RTCPeerConnection;
        window.Audio = class extends EventTarget {
          src = "";
          preload = "";
          paused = true;
          error = null;
          time = 0;
          target = 0;
          seeking = false;
          readyState = ranged ? 1 : 4;
          duration = ranged ? 7200 : 10;
          get currentTime() {
            return this.time;
          }
          set currentTime(value: number) {
            if (!ranged) {
              this.time = value;
              return;
            }
            this.target = value;
            this.seeking = true;
            probe.seekPending = true;
            this.dispatchEvent(new Event("seeking"));
          }
          constructor() {
            super();
            probe.finishSeek = () => {
              probe.seekPending = false;
              this.time = this.target;
              this.seeking = false;
              this.readyState = 2;
              this.dispatchEvent(new Event("seeked"));
            };
            probe.mediaError = () => {
              this.dispatchEvent(new Event("error"));
            };
            probe.passageEnd = () => {
              this.time = 1667.7;
              this.dispatchEvent(new Event("timeupdate"));
            };
          }
          onplaying: (() => void) | null = null;
          pause() {
            this.paused = true;
            this.dispatchEvent(new Event("pause"));
          }
          async play() {
            probe.clipPlays++;
            probe.playPositions.push(this.time);
            this.paused = false;
            this.onplaying?.();
            this.dispatchEvent(new Event("playing"));
          }
          load() {}
          removeAttribute() {}
        } as unknown as typeof Audio;
      },
      {
        shouldAcknowledgeInput: finishAction !== "no_ack",
        ranged: finishAction.startsWith("range_"),
      },
    );
    await page.goto(origin);
    await page
      .getByRole("button", { name: "ابدأ الحديث", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "إنهاء الحديث" }),
    ).toBeVisible();
    await page.evaluate((ranged) => {
      (window as unknown as { emit: (event: unknown) => void }).emit({
        type: "recitation",
        recitation: {
          id: "sharh",
          title: "سورة الشرح",
          surah: 94,
          ayahStart: 1,
          ayahEnd: 8,
          reference: "الشرح ١–٨",
          reciter: "ياسر الدوسري",
          audioUrl: "https://example.test/quran.mp3",
          sourceUrl: "https://example.test",
          meaning: "",
          context: "",
          ...(ranged
            ? {
                fullSurah: false,
                playbackStartSeconds: 1653.96,
                playbackEndSeconds: 1667.66,
                durationSeconds: 13.7,
              }
            : {}),
        },
      });
    }, finishAction.startsWith("range_"));
    await expect(
      page.getByRole("button", { name: "تشغيل التلاوة", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "إعادة التلاوة من البداية" }),
    ).toBeDisabled();
    if (finishAction === "no_ack") {
      await expect(page.locator(".call-error")).toContainText(
        "تعذّر تجهيز التلاوة",
        { timeout: 10000 },
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { clipPlays: number }).clipPlays,
        ),
      ).toBe(0);
      expect(
        await page.evaluate(
          () =>
            (window as unknown as { startedPending: boolean }).startedPending,
        ),
      ).toBe(false);
      await expect(
        page.getByRole("button", { name: "حاول الاتصال مجددًا" }),
      ).toBeVisible();
      await page.evaluate(() =>
        (
          window as unknown as { inputContext: AudioContext }
        ).inputContext.close(),
      );
      return;
    }
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { startedPending: boolean }).startedPending,
        ),
      )
      .toBe(true);
    if (finishAction.startsWith("range_")) {
      await page.evaluate(() =>
        (
          window as unknown as { acknowledgeStart: () => void }
        ).acknowledgeStart(),
      );
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { seekPending: boolean }).seekPending,
          ),
        )
        .toBe(true);
      expect(
        await page.evaluate(
          () => (window as unknown as { clipPlays: number }).clipPlays,
        ),
      ).toBe(0);
      await expect(
        page.getByRole("button", { name: "تشغيل التلاوة", exact: true }),
      ).toBeDisabled();
      if (
        finishAction === "range_skip" ||
        finishAction === "range_end_during_seek"
      ) {
        await page
          .getByRole("button", {
            name:
              finishAction === "range_skip" ? "العودة للحديث" : "إنهاء الحديث",
            exact: true,
          })
          .click();
        await page.evaluate(() =>
          (window as unknown as { finishSeek: () => void }).finishSeek(),
        );
        await page.waitForTimeout(200);
        expect(
          await page.evaluate(
            () => (window as unknown as { clipPlays: number }).clipPlays,
          ),
        ).toBe(0);
      } else if (finishAction === "range_error") {
        await page.evaluate(() =>
          (window as unknown as { mediaError: () => void }).mediaError(),
        );
        await expect(page.locator(".recitation-error")).toBeVisible();
        await page.getByRole("button", { name: "العودة للحديث" }).click();
        expect(
          await page.evaluate(
            () => (window as unknown as { clipPlays: number }).clipPlays,
          ),
        ).toBe(0);
      } else {
        await page.evaluate(() =>
          (window as unknown as { finishSeek: () => void }).finishSeek(),
        );
        await expect
          .poll(() =>
            page.evaluate(
              () => (window as unknown as { clipPlays: number }).clipPlays,
            ),
          )
          .toBe(1);
        if (finishAction === "range_replay") {
          await page
            .getByRole("button", { name: "إعادة التلاوة من البداية" })
            .click();
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  (window as unknown as { seekPending: boolean }).seekPending,
              ),
            )
            .toBe(true);
          await expect(page.locator(".round-control").nth(0)).toBeDisabled();
          expect(
            await page.evaluate(
              () => (window as unknown as { clipPlays: number }).clipPlays,
            ),
          ).toBe(1);
          await page.evaluate(() =>
            (window as unknown as { finishSeek: () => void }).finishSeek(),
          );
          await expect
            .poll(() =>
              page.evaluate(
                () => (window as unknown as { clipPlays: number }).clipPlays,
              ),
            )
            .toBe(2);
        }
        expect(
          await page.evaluate(
            () =>
              (window as unknown as { playPositions: number[] }).playPositions,
          ),
        ).toEqual(
          finishAction === "range_replay" ? [1653.96, 1653.96] : [1653.96],
        );
        await page.evaluate(() =>
          (window as unknown as { passageEnd: () => void }).passageEnd(),
        );
        await expect
          .poll(() =>
            page.evaluate(
              () => (window as unknown as { completed: number }).completed,
            ),
          )
          .toBe(1);
        await expect(
          page.getByRole("region", { name: "التلاوة القرآنية" }),
        ).toHaveCount(0);
      }
      if (finishAction !== "range_end_during_seek")
        await page.getByRole("button", { name: "إنهاء الحديث" }).click();
      await expect(
        page.getByRole("button", { name: "ابدأ حديثًا جديدًا" }),
      ).toBeVisible();
      await page.evaluate(() =>
        (
          window as unknown as { inputContext: AudioContext }
        ).inputContext.close(),
      );
      return;
    }
    if (finishAction === "ready_controls") {
      await page.evaluate(() =>
        (
          window as unknown as { acknowledgeStart: () => void }
        ).acknowledgeStart(),
      );
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { clipPlays: number }).clipPlays,
          ),
        )
        .toBe(1);
      await page.getByRole("button", { name: "إيقاف التلاوة مؤقتًا" }).click();
      await page
        .getByRole("button", { name: "تشغيل التلاوة", exact: true })
        .click();
      await page
        .getByRole("button", { name: "إعادة التلاوة من البداية" })
        .click();
      expect(
        await page.evaluate(
          () => (window as unknown as { clipPlays: number }).clipPlays,
        ),
      ).toBe(3);
      await page.getByRole("button", { name: "إنهاء الحديث" }).click();
      await expect(page.locator(".round-control").nth(0)).toBeDisabled();
      await expect(page.locator(".round-control").nth(1)).toBeDisabled();
    } else if (finishAction === "skip") {
      await page.getByRole("button", { name: "العودة للحديث" }).click();
      await expect
        .poll(() =>
          page.evaluate(
            () => (window as unknown as { skipped: boolean }).skipped,
          ),
        )
        .toBe(true);
    } else {
      await page.getByRole("button", { name: "إنهاء الحديث" }).click();
      await expect(page.locator(".round-control").nth(0)).toBeDisabled();
      await expect(page.locator(".round-control").nth(1)).toBeDisabled();
    }
    if (finishAction === "end" || finishAction === "ready_controls") {
      await page.evaluate(() =>
        (window as unknown as { closeTransport: () => void }).closeTransport(),
      );
      await expect(page.locator(".call-error")).toHaveCount(0);
    }
    await page.evaluate(() =>
      (
        window as unknown as { acknowledgeStart: () => void }
      ).acknowledgeStart(),
    );
    await page.waitForTimeout(250);
    expect(
      await page.evaluate(
        () => (window as unknown as { clipPlays: number }).clipPlays,
      ),
    ).toBe(finishAction === "ready_controls" ? 3 : 0);
    if (finishAction === "skip") {
      await expect(
        page.getByRole("region", { name: "التلاوة القرآنية" }),
      ).toHaveCount(0);
      await page.getByRole("button", { name: "إنهاء الحديث" }).click();
    }
    await expect(
      page.getByRole("button", { name: "ابدأ حديثًا جديدًا" }),
    ).toBeVisible();
    await page.evaluate(() =>
      (
        window as unknown as { inputContext: AudioContext }
      ).inputContext.close(),
    );
  });
