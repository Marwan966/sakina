import { handleLiveControl } from "@/lib/live-control";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request: Request) {
  return handleLiveControl(request);
}
