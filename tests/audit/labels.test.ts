/**
 * Etykiety akcji audytu — porównanie z listą `AuditAction`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ACTION_LABELS } from "@/lib/audit/labels";
import type { AuditAction } from "@/lib/audit/log";

/**
 * Regresja: siedem akcji (m.in. `auth.lockout`, `backup.created`, `audit.exported`)
 * nie miało polskiej etykiety i audytor widział w tabeli surowe sluga.
 * Ten test pilnuje, żeby każda akcja z unii `AuditAction` miała tłumaczenie.
 */
describe("etykiety akcji audytu", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/audit/log.ts"), "utf8");
  const union = /export type AuditAction =([\s\S]*?);/.exec(source)?.[1] ?? "";
  const actions = [...union.matchAll(/"([a-z0-9_.]+)"/g)].map((match) => match[1]) as AuditAction[];

  it("każda akcja audytu ma polską etykietę", () => {
    const missing = actions.filter((action) => !(action in ACTION_LABELS));
    expect(missing).toEqual([]);
  });

  it("nie ma etykiet dla nieistniejących akcji", () => {
    const extra = Object.keys(ACTION_LABELS).filter((action) => !actions.includes(action as AuditAction));
    expect(extra).toEqual([]);
  });

  it("etykiety są po polsku i nie zawierają kropek (czyli nie są surowym slugiem)", () => {
    for (const [action, label] of Object.entries(ACTION_LABELS)) {
      expect(label, action).not.toContain(".");
      expect(label.trim().length, action).toBeGreaterThan(2);
    }
  });

  it("akcje techniczne systemu mają zrozumiałe nazwy", () => {
    expect(ACTION_LABELS["audit.exported"]).toContain("Eksport");
    expect(ACTION_LABELS["auth.lockout"]).toMatch(/blokad|zablokow/i);
    expect(ACTION_LABELS["backup.created"]).toMatch(/kopi/i);
    expect(ACTION_LABELS["key.rotated"]).toMatch(/klucz/i);
  });
});
