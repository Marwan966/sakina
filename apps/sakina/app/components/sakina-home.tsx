"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import {
  ArrowLeft,
  AudioLines,
  BookOpen,
  Headphones,
  LoaderCircle,
  Mic,
  MicOff,
  Pause,
  PhoneOff,
  Play,
  RotateCcw,
  ShieldCheck,
  Volume2,
} from "lucide-react";
import { useLiveSession } from "./use-live-session";

export function SakinaHome() {
  const live = useLiveSession();
  const startButton = useRef<HTMLButtonElement>(null);
  const liveHeading = useRef<HTMLHeadingElement>(null);
  const active = live.phase === "connected";
  const busy = live.phase === "connecting" || live.phase === "closing";
  const ended = live.phase === "ended";
  const inSession = active || busy || Boolean(live.recitation);
  const recordingAvailable = active || live.voiceEnded;
  const status =
    live.phase === "connecting"
      ? "نجهّز مساحتك الصوتية…"
      : live.phase === "closing"
        ? "ننهي الاتصال…"
        : live.recitation
          ? live.clipState === "playing"
            ? "نستمع إلى التلاوة"
            : live.clipState === "paused"
              ? "التلاوة متوقفة مؤقتًا"
              : live.clipState === "error"
                ? "تعذّر تشغيل التلاوة"
                : "نجهّز التلاوة…"
          : active && live.muted
            ? "الميكروفون مكتوم"
            : live.activity === "user"
              ? "تكلّم، سكينة يستمع إليك"
              : live.activity === "assistant"
                ? "سكينة يتحدث إليك"
                : active
                  ? "خذ راحتك… نحن على اتصال"
                  : ended
                    ? "خذ معك لحظة من الهدوء"
                    : "مساحة لك، على مهل";

  useEffect(() => {
    if (live.phase === "connected")
      liveHeading.current?.focus({ preventScroll: true });
    if (live.phase === "ended" || live.phase === "error")
      startButton.current?.focus({ preventScroll: true });
  }, [live.phase, live.voiceEnded]);

  return (
    <main
      id="main"
      className={`voice-page ${inSession ? "is-in-session" : ""}`}
    >
      <section className="voice-room" aria-labelledby="voice-title">
        <div className="room-intro">
          <p className="eyebrow">
            <span /> مساحة صوتية للإنصات والطمأنينة
          </p>
          <h1 id="voice-title">
            بعض ما في القلب،
            <br />
            <span>يحتاج أن يُقال.</span>
          </h1>
          <p className="intro-copy">
            تحدّث مع سكينة عن يومك وما يشغلك.
            <br className="desktop-break" /> مساعد صوتي بالذكاء الاصطناعي يستمع
            إليك، ويشاركك تلاوات قرآنية بصوت قارئ حقيقي.
          </p>
        </div>
        <div
          className={`conversation-space ${live.recitation ? "has-recitation" : ""}`}
        >
          <div
            className={`voice-orb ${active ? "is-connected" : ""} ${busy ? "is-connecting" : ""} ${live.recitation ? "is-reciting" : ""}`}
            style={{ "--voice-level": live.level } as CSSProperties}
            aria-hidden="true"
          >
            <div className="orb-halo halo-outer" />
            <div className="orb-halo halo-inner" />
            <div className="orb-surface">
              <div className="orb-light" />
              <div className="orb-wave" />
              <div className="orb-mark">
                {live.recitation ? (
                  <BookOpen size={30} strokeWidth={1.2} />
                ) : (
                  <AudioLines size={32} strokeWidth={1.3} />
                )}
              </div>
            </div>
            <div className="orb-floor" />
          </div>
          <div className="session-status">
            <h2
              ref={liveHeading}
              tabIndex={-1}
              aria-live="polite"
              aria-atomic="true"
            >
              {status}
            </h2>
            {active ? (
              <p>
                {live.recitation
                  ? "الميكروفون متوقف أثناء التلاوة"
                  : "يمكنك مقاطعته أو التوقف متى أحببت"}
              </p>
            ) : (
              <p>
                {ended
                  ? live.voiceEnded
                    ? "انتهى الحديث. التلاوة مستمرة والميكروفون مغلق."
                    : "انتهت الجلسة وأُغلق الميكروفون."
                  : "ابدأ الحديث، اسمح بالميكروفون، وخذ وقتك."}
              </p>
            )}
          </div>
          {live.error ? (
            <div className="call-message call-error" role="alert">
              <p>{live.error}</p>
            </div>
          ) : null}
          {live.notice && !live.error ? (
            <p className="call-notice" role="status">
              {live.notice}
            </p>
          ) : null}
          {live.support ? (
            <div
              className="call-message support-card"
              role={live.support.urgent ? "alert" : "status"}
            >
              <p>{live.support.message}</p>
            </div>
          ) : null}
          {live.audioLocked ? (
            <button
              className="audio-unlock"
              onClick={() => void live.unlockAudio()}
            >
              <Volume2 size={17} />{" "}
              {live.voiceEnded
                ? "اضغط لتشغيل صوت التلاوة"
                : "اضغط لتشغيل صوت سكينة"}
            </button>
          ) : null}
          {live.recitation ? (
            <section className="recitation-card" aria-label="التلاوة القرآنية">
              <div className="recitation-heading">
                <span className="recitation-icon">
                  <BookOpen size={22} strokeWidth={1.5} />
                </span>
                <div>
                  <p className="recitation-eyebrow">تلاوة أصلية مسجّلة</p>
                  <h3>{live.recitation.title}</h3>
                  <p>{live.recitation.reciter}</p>
                </div>
              </div>
              <p className="recitation-reference">
                {live.recitation.reference}
                {live.recitation.fullSurah === false ? " · مقطع من السورة" : ""}
                {live.recitation.durationSeconds
                  ? ` · ${Math.round(live.recitation.durationSeconds).toLocaleString("ar")} ثانية`
                  : ""}
              </p>
              <div
                className="recitation-progress"
                role="progressbar"
                aria-label="تقدّم التلاوة"
                aria-valuenow={Math.round(live.clipProgress * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span style={{ width: `${live.clipProgress * 100}%` }} />
              </div>
              {live.clipState === "error" ? (
                <p className="recitation-error" role="alert">
                  {live.voiceEnded
                    ? "التسجيل غير متاح الآن. أعد المحاولة أو أنهِ التلاوة."
                    : "التسجيل غير متاح الآن. أعد المحاولة أو عُد إلى الحديث."}
                </p>
              ) : null}
              <div className="recitation-controls">
                <button
                  className="round-control"
                  disabled={!recordingAvailable || !live.clipReady}
                  aria-label={
                    live.clipState === "playing"
                      ? "إيقاف التلاوة مؤقتًا"
                      : "تشغيل التلاوة"
                  }
                  onClick={() => void live.toggleClip()}
                >
                  {live.clipState === "playing" ? (
                    <Pause size={20} />
                  ) : (
                    <Play size={20} />
                  )}
                </button>
                <button
                  className="round-control"
                  disabled={!recordingAvailable || !live.clipReady}
                  aria-label="إعادة التلاوة من البداية"
                  onClick={() => void live.replayClip()}
                >
                  <RotateCcw size={18} />
                </button>
                <button
                  className="back-to-talk"
                  onClick={() => void live.skipClip()}
                >
                  {live.voiceEnded ? "إنهاء التلاوة" : "العودة للحديث"}{" "}
                  <ArrowLeft size={16} />
                </button>
              </div>
              <a
                className="recording-source"
                href={live.recitation.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                مصدر التسجيل ↗
              </a>
            </section>
          ) : null}
          {active ? (
            <div className="active-controls">
              <div className="call-buttons">
                <button
                  className={`mic-control ${live.muted ? "is-muted" : ""}`}
                  disabled={Boolean(live.recitation) || live.mutePending}
                  aria-label={
                    live.muted ? "تشغيل الميكروفون" : "كتم الميكروفون"
                  }
                  aria-pressed={live.muted}
                  onClick={live.toggleMute}
                >
                  {live.muted ? <MicOff size={21} /> : <Mic size={21} />}
                </button>
                <button className="end-call" onClick={live.end}>
                  <PhoneOff size={19} /> إنهاء الحديث
                </button>
              </div>
              <p className="session-time">
                <span className="connected-dot" /> متصل{" "}
                <span className="time-divider">·</span> المتبقي{" "}
                <bdi>
                  {Math.floor(live.remaining / 60)}:
                  {String(live.remaining % 60).padStart(2, "0")}
                </bdi>
              </p>
            </div>
          ) : busy ? (
            <div className="start-controls">
              <button className="start-call is-busy" disabled>
                <LoaderCircle className="spin" size={20} />{" "}
                {live.phase === "closing" ? "إنهاء الاتصال" : "جارٍ الاتصال"}
              </button>
              {live.phase === "connecting" ? (
                <button className="cancel-call" onClick={live.end}>
                  إلغاء
                </button>
              ) : null}
            </div>
          ) : live.voiceEnded && live.recitation ? null : (
            <div className="start-controls">
              <button
                ref={startButton}
                className="start-call"
                onClick={() => void live.start()}
              >
                <Mic size={21} strokeWidth={1.7} />
                {ended
                  ? "ابدأ حديثًا جديدًا"
                  : live.phase === "error"
                    ? "حاول الاتصال مجددًا"
                    : "ابدأ الحديث"}
                <ArrowLeft size={18} strokeWidth={1.6} />
              </button>
              <p className="no-account">
                بلا حساب <span>·</span> جلسة صوتية قصيرة
              </p>
            </div>
          )}
        </div>
        {!inSession ? (
          <div className="session-consent">
            <ShieldCheck size={16} strokeWidth={1.5} />
            <p>
              بالبدء، تؤكد أن عمرك 18 عامًا أو أكثر وتوافق على معالجة صوتك
              بواسطة OpenAI لتشغيل المحادثة. <a href="#privacy">عن الخصوصية</a>
            </p>
          </div>
        ) : null}
      </section>
      <footer className="voice-footer">
        <p className="support-note">
          سكينة مساحة للمساندة النفسية والروحية، وليس علاجًا نفسيًا أو خدمة
          طوارئ.
        </p>
        <div className="quiet-details">
          <details id="privacy">
            <summary>خصوصيتك وحدود المساعدة</summary>
            <div>
              <p>
                لا نطلب اسمك أو حسابًا، ولا نحفظ تسجيل الجلسة أو نصّ حديثك في
                قاعدة بيانات سكينة. يُرسل صوتك إلى OpenAI لمعالجة المحادثة؛ وقد
                تحتفظ الخدمة ببيانات وفق سياستها. تُستخدم بيانات اتصال محدودة
                لحماية الخدمة من إساءة الاستخدام.
              </p>
              <p>
                عند تشغيل التلاوة، يتصل متصفحك بخادم التسجيلات في MP3Quran، الذي
                يستقبل بيانات الاتصال اللازمة لتقديم الصوت.
              </p>
              <p>
                ينتهي التقاط الميكروفون عند إنهاء الجلسة أو مغادرة الصفحة. تجنّب
                مشاركة معلومات حساسة لا تحتاجها المحادثة.
              </p>
              <p>
                إذا كنت في خطر مباشر أو تفكّر في إيذاء نفسك، اتصل بالطوارئ
                المحلية وتواصل مع شخص موثوق يبقى معك. سكينة لا يغني عن مساعدة
                مختص.
              </p>
              <a
                href="https://openai.com/policies/privacy-policy/"
                target="_blank"
                rel="noopener noreferrer"
              >
                سياسة خصوصية OpenAI ↗
              </a>
              {" · "}
              <a href="/privacy">تفاصيل الخصوصية</a>
              {" · "}
              <a href="/terms">الاستخدام وحدود المساعدة</a>
            </div>
          </details>
          <details id="method">
            <summary>عن التلاوات</summary>
            <div>
              <p>
                تُشغَّل التلاوات من تسجيلات أصلية بصوت الشيخ ياسر الدوسري عبر
                مكتبة MP3Quran. يظهر اسم السورة والقارئ ومصدر التسجيل عند
                الاستماع. يتوقف صوت المساعد والميكروفون أثناء التلاوة، ويمكنك
                إيقافها أو العودة للحديث.
              </p>
              <p>
                تتوفر السور الـ١١٤ كاملة، مع مقاطع محددة موثقة للربط بالموقف.
                يمكنك طلب سورة باسمها. إذا انتهى وقت الحديث أثناء التلاوة، يُغلق
                الميكروفون ويمكنك إكمال التسجيل أو إيقافه.
              </p>
              <p>
                المساعد قد يخطئ في فهم الموقف أو شرح المعنى؛ لا يقدّم فتاوى أو
                تشخيصًا. يمكنك طلب توضيح أو استشارة مختص.
              </p>
              <a
                href="https://www.mp3quran.net/ar/yasser"
                target="_blank"
                rel="noopener noreferrer"
              >
                مكتبة التلاوات ↗
              </a>
              {" · "}
              <a
                href="https://tanzil.net"
                target="_blank"
                rel="noopener noreferrer"
              >
                نص القرآن: مشروع تنزيل ↗
              </a>
              {" · "}
              <a
                href="https://quran.com"
                target="_blank"
                rel="noopener noreferrer"
              >
                التفسير الميسّر عبر Quran.com ↗
              </a>
            </div>
          </details>
        </div>
        <p className="headphone-note">
          <Headphones size={14} /> سماعات الأذن تجعل الحديث أوضح وأكثر خصوصية
        </p>
      </footer>
    </main>
  );
}
