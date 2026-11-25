/** POST /api/import/commit — wykonanie importu z .xlsx. */
import { handleCommit } from "@/lib/import-handler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handleCommit(request);
}
