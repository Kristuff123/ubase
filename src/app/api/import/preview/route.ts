/** POST /api/import/preview — podgląd importu z .xlsx (bez zapisu). */
import { handlePreview } from "@/lib/import-handler";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  return handlePreview(request);
}
