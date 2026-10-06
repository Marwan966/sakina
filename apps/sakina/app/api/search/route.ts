// The former text-search product was retired in the live voice release.
export function POST() {
  return Response.json({ error: "انتقلت سكينة إلى المحادثة الصوتية. افتح الصفحة الرئيسية لبدء مكالمة.", code: "voice_only" }, { status: 410, headers: { "Cache-Control": "no-store" } });
}
