/** Dostęp do sesji po stronie serwera (dla Server Components). */
import { cookies } from "next/headers";
import { getDb } from "@/db";
import { SESSION_COOKIE, lookupSession } from "./session";
import type { Role } from "./context";

export type SessionUser = {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  totpEnabled: boolean;
  mustChangePassword: boolean;
};

export async function getSessionUser(): Promise<SessionUser | null> {
  try {
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE)?.value;
    if (!token) return null;
    const db = getDb();
    const found = lookupSession(db, token);
    if (found.kind !== "active") return null;
    const user = db
      .prepare("SELECT id, username, display_name, role, totp_enabled, must_change_password, is_active FROM app_users WHERE id = ?")
      .get(found.session.user_id) as
      | {
          id: number;
          username: string;
          display_name: string;
          role: Role;
          totp_enabled: number;
          must_change_password: number;
          is_active: number;
        }
      | undefined;
    if (!user || !user.is_active) return null;
    return {
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      totpEnabled: user.totp_enabled === 1,
      mustChangePassword: user.must_change_password === 1,
    };
  } catch {
    return null;
  }
}
