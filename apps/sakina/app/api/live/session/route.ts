import { after } from "next/server";
import { handleLiveSession } from "@/lib/live-session";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  return handleLiveSession(request, { hold: lifetime => after(() => lifetime) });
}
