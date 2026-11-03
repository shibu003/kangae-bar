// W48 の試験の物差し: ER_Triage_GUI（~/Downloads/ER_Triage_GUI/src/triage_core.hpp）の csv の形と priority の規則を、読んだ file:line どおりに TS で写した物。製品の code ではない（agent が自分で書く行の正解を測るだけ）
export const HEADER = "id,name,age,symptoms,painLevel,chestPain,breathingTrouble,heavyBleeding,unconsciousOrConfused,severePain,priority,arrivalOrder";
export type P = { name: string; age: number; symptoms: string; painLevel: number; chestPain?: boolean; breathingTrouble?: boolean; heavyBleeding?: boolean; unconsciousOrConfused?: boolean; severePain?: boolean };
export type Priority = "High" | "Medium" | "Low";

// triage_core.hpp:45-57
export const assignPriority = (p: P): Priority =>
  p.unconsciousOrConfused || p.breathingTrouble || p.chestPain || p.heavyBleeding || p.painLevel >= 9 ? "High"
  : p.severePain || p.painLevel >= 6 || p.age < 2 || p.age >= 75 ? "Medium" : "Low";

// triage_core.hpp:66-77
export const csvEscape = (v: string) => (/[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

// triage_core.hpp:79-107
export function parseCsvLine(line: string): string[] {
  const out: string[] = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

// triage_core.hpp:189-241 の loadCsv: 1 行目は header として読み飛ばす・12 欄でなければ全体が失敗・priority は csv の値のまま
export function loadCsv(text: string): { ok: true; patients: { id: number; name: string; age: number; priority: Priority; arrivalOrder: number }[]; nextId: number } | { ok: false; error: string } {
  const lines = text.split("\n"); lines.shift();
  const rows: { id: number; name: string; age: number; priority: Priority; arrivalOrder: number }[] = [];
  let n = 1;
  for (const line of lines) {
    n++;
    if (!line) continue;
    const f = parseCsvLine(line);
    if (f.length !== 12) return { ok: false, error: `CSV row ${n} does not have 12 fields.` };
    const num = (s: string) => { if (!/^\s*[+-]?\d+/.test(s)) throw new Error(); return parseInt(s, 10); };
    try { rows.push({ id: num(f[0]!), name: f[1]!, age: num(f[2]!), priority: f[10] === "High" ? "High" : f[10] === "Medium" ? "Medium" : "Low", arrivalOrder: num(f[11]!) }); for (const k of [4, 5, 6, 7, 8, 9]) num(f[k]!); } catch { return { ok: false, error: `CSV row ${n} contains invalid values.` }; }
  }
  const rank = { High: 3, Medium: 2, Low: 1 };
  rows.sort((a, b) => rank[b.priority] - rank[a.priority] || a.arrivalOrder - b.arrivalOrder); // :59-64・:239
  return { ok: true, patients: rows, nextId: Math.max(0, ...rows.map((r) => r.id)) + 1 };
}

// agent が data.csv に足すはずの行（id と arrivalOrder は今の最大 + 1 から続ける・priority は規則で計算）
export function rowsFor(existing: string, add: P[]): string {
  const cur = loadCsv(existing);
  if (!cur.ok) throw new Error(cur.error);
  let id = cur.nextId, arr = Math.max(0, ...cur.patients.map((p) => p.arrivalOrder)) + 1;
  const b = (x?: boolean) => (x ? 1 : 0);
  const body = existing.split("\n").slice(1).filter(Boolean);
  for (const p of add) body.push([id++, csvEscape(p.name), p.age, csvEscape(p.symptoms), p.painLevel, b(p.chestPain), b(p.breathingTrouble), b(p.heavyBleeding), b(p.unconsciousOrConfused), b(p.severePain), assignPriority(p), arr++].join(","));
  return [HEADER, ...body].join("\n") + "\n";
}
