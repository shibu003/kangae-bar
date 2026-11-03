// W47: tab の面で使う「名前つきの読み」の表（手書き・学習は要らない）。agent が渡すのは op の名前と少数の欄だけ。
// 読む先は、その会話に貸した tab の origin の固定の path（GET だけ・同 origin の fetch・login は Chrome に残る）。agent は URL も path も渡せない。
export type WebOp = { name: string; what: string; params: Record<string, string[]>; build: (p: Record<string, string>, now: Date) => string; reduce: (json: unknown, now: Date) => unknown };

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
// 来週 = 今日の次の月曜 〜 その日曜（local 時刻）。week=this は今週の月曜〜日曜
export const weekOf = (now: Date, which: "this" | "next"): { start: string; end: string } => {
  const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) + (which === "next" ? 7 : 0));
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  return { start: ymd(mon), end: ymd(sun) };
};
const str = (v: unknown, n = 200) => (typeof v === "string" ? v.replace(/[\p{Cc}\p{Cf}]/gu, " ").trim().slice(0, n) : "");

// 出典（2026-10-13 に読んだ）: planner = https://developerdocs.instructure.com/services/canvas/resources/planner ・todo / upcoming = .../resources/users ・頁送り = .../basics/file.pagination
// 公式の例にある欄だけに頼らない: plannable_date・context_name・submissions.submitted は公式の例に無い（実機では来ると言われるが未測）ので、あれば使い、無ければ公式の欄（plannable.due_at / todo_date / start_at・course_id・planner_override.marked_complete）に落とす
const date = (it: any) => str(it?.plannable_date ?? it?.plannable?.due_at ?? it?.plannable?.todo_date ?? it?.plannable?.start_at, 40);
export const WEB_OPS: WebOp[] = [
  {
    name: "canvas-week", what: "Canvas の planner（課題・小テスト・予定）の 1 週間分を読む（GET /api/v1/planner/items・次の頁は Link の rel=next）",
    params: { week: ["next", "this"] },
    build: (p, now) => { const w = weekOf(now, p.week === "this" ? "this" : "next"); return `/api/v1/planner/items?start_date=${w.start}&end_date=${w.end}&per_page=50`; },
    reduce: (json) => (Array.isArray(json) ? json : []).map((it: any) => ({
      due: date(it),
      course: str(it?.context_name, 80) || (it?.course_id != null ? `course_${str(String(it.course_id), 20)}` : ""),
      type: str(it?.plannable_type, 30),
      title: str(it?.plannable?.title ?? it?.plannable?.name, 200),
      points: typeof it?.plannable?.points_possible === "number" ? it.plannable.points_possible : undefined,
      done: !!(it?.planner_override?.marked_complete || it?.submissions?.submitted),
      url: typeof it?.html_url === "string" && it.html_url.startsWith("/") ? str(it.html_url, 200) : undefined,
    })).sort((a, b) => a.due.localeCompare(b.due)),
  },
  {
    name: "canvas-todo", what: "Canvas の「やること」（提出がまだの課題）を読む（GET /api/v1/users/self/todo）",
    params: {},
    build: () => "/api/v1/users/self/todo",
    reduce: (json) => (Array.isArray(json) ? json : []).map((it: any) => ({ due: str(it?.assignment?.due_at, 40), course: it?.course_id != null ? `course_${str(String(it.course_id), 20)}` : "", type: str(it?.type, 30), title: str(it?.assignment?.name ?? it?.quiz?.title, 200), points: typeof it?.assignment?.points_possible === "number" ? it.assignment.points_possible : undefined, url: typeof it?.html_url === "string" && it.html_url.startsWith("/") ? str(it.html_url, 200) : undefined })).sort((a, b) => a.due.localeCompare(b.due)),
  },
];

// 頁送り（公式: Link の URL は opaque・rel=next が無くなるまで辿る・rel=last は無いことがある）。next は同 origin の /api/v1/ だけ・頁数と件数に上限
// W60f: 頁送りは最後まで辿る。止めるのは「時間」（WEBOP_BUDGET_MS・途中の結果も返す）が本命で、MAX_PAGES / MAX_ITEMS は next を永遠に返す site や巨大な返事から agent と常駐を守るだけの安全の上限（普通の 1 週間の planner には届かない）
export const MAX_PAGES = 400, MAX_ITEMS = 5000, WEBOP_BUDGET_MS = 30_000;
export const nextOf = (link: string | undefined, origin: string): string | null => {
  for (const m of String(link ?? "").matchAll(/<([^>]+)>\s*;\s*rel="?next"?/gi)) {
    try { const u = new URL(m[1]!); if (u.origin === origin && u.pathname.startsWith("/api/v1/")) return u.href; } catch {}
  }
  return null;
};

// Canvas は session の JSON の頭に `while(1);` を付けることがある（JSON hijacking 対策）。落としてから読む
export const parseBody = (body: string): unknown => { try { return JSON.parse(body.replace(/^\s*while\(1\);\s*/, "")); } catch { return undefined; } };

// 欄の検査: 表に無い欄・許さない値は断る（agent の文字を path に載せない）
export const checkParams = (op: WebOp, a: Record<string, unknown>): { ok: true; p: Record<string, string> } | { ok: false; hint: string } => {
  const p: Record<string, string> = {};
  for (const [k, allowed] of Object.entries(op.params)) {
    const v = a[k] == null ? allowed[0]! : String(a[k]);
    if (!allowed.includes(v)) return { ok: false, hint: `欄「${k}」は ${allowed.join(" / ")} のどれかです` };
    p[k] = v;
  }
  return { ok: true, p };
};
