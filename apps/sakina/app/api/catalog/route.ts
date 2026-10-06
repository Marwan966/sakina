export function GET() {
  return Response.json({ error: "انتقلت سكينة إلى المحادثة الصوتية.", code: "voice_only" }, { status: 410, headers: { "Cache-Control": "no-store" } });
}
