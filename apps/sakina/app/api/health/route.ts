import { json } from "@platform/core/http";
export const dynamic = "force-dynamic";
export async function GET() {
  return json({
    status: "ok",
    service: "sakina",
    release: "live-voice-6",
    quranChapters: 114,
    quranVerses: 6236,
    experience: "voice",
    voiceModel: "gpt-live-1",
    voiceConfigured: process.env.OPENAI_LIVE_ENABLED === "true" && Boolean(process.env.OPENAI_API_KEY),
    quotaConfigured: Boolean(process.env.SUPABASE_URL && process.env.INTERNAL_API_TOKEN),
    sessionDurationSeconds: 240,
    accountRequired: false,
    // Configuration presence is not a live upstream availability check.
  });
}
