// W107: 人が答える card は同時に 1 枚＋「あと N 件」。予約の文は deny。
// 描画は test/domshim.ts（本物のブラウザには触れない）。実機は未測。読む file を literal で名指す: "extension/panel.js" "extension/panel.css" "test/domshim.ts"
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { El, Plain } from "./domshim.ts";

const root = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");

class Box extends Plain {
  override append(...n: any[]) {
    const els: El[] = n.map((x): El => {
      if (x instanceof El) return x;
      const t = new Box("span");
      t.textContent = String(x ?? "");
      return t;
    });
    return super.append(...els);
  }
}

const g = globalThis as any;
const cardsOf = (box: El) => box.children.filter((n) => n.className.split(/\s+/).includes("card"));
const moreOf = (box: El) => box.children.find((n) => n.className.split(/\s+/).includes("more-cards")) as (Plain & { onclick?: () => void }) | undefined;

function harness() {
  g.document = { createElement: (t: string) => new Box(t) };
  const box = new Box("div");
  const $ = (id: string) => (id === "approve" ? box : new Box("div"));
  const mk = (tag: string, cls: string) => Object.assign(g.document.createElement(tag), { className: cls });
  const el = (tag: string, cls: string, html?: string) => { const x = mk(tag, cls); if (html != null) x.innerHTML = html; return x; };
  const txt = (tag: string, cls: string, text: string) => { const x = mk(tag, cls); x.textContent = text; return x; };
  const js = read("extension/panel.js");
  const src = js.slice(js.indexOf("function modePick"), js.indexOf("function showStopAll"));
  const roots: { id: number; text?: string; agent?: { name?: string } }[] = [];
  const renderApprove = new Function(
    "$", "mk", "txt", "el", "approveEl", "ICON", "roots", "plain", "call", "toast", "showStopAll", "peekEl", "showErr", "loadLeases", "window", "chrome",
    `let approveMemo = [[], [], [], []];\nlet approveOpen = false;\n${src}\nreturn renderApprove;`,
  )(
    $, mk, txt, el,
    () => mk("kg-approve", ""),
    { turn: "" },
    roots,
    (s: string) => s,
    async () => ({ ok: true }),
    () => {},
    () => {},
    () => mk("div", "peek"),
    () => {},
    () => {},
    {},
    { permissions: { request: async () => false, remove: async () => {} } },
  ) as (approvals: unknown[], leases?: unknown[], carries?: unknown[], routineCards?: unknown[], auth?: unknown[]) => void;
  const render = (approvals: unknown[] = [], leases: unknown[] = [], carries: unknown[] = [], routineCards: unknown[] = [], auth: unknown[] = []) => renderApprove(approvals, leases, carries, routineCards, auth);
  return { box, render, roots };
}

const ap = (id: string) => ({ id, what: "保存する", app: "Notes", title: "無題", tool: "click", danger: true });
const hint = { turnAllow: true, surface: { app: "Notes", title: "" } };

test("W107 承認 3 件は card 1 枚＋あと 2 件。押すと 3 枚、もう一度で 1 枚。描き直しても開閉は残る", () => {
  const { box, render } = harness();
  const three = [ap("a1"), ap("a2"), ap("a3")];
  render(three);
  expect(cardsOf(box).map((c) => c.dataset.id)).toEqual(["a1"]);
  expect(moreOf(box)?.textContent).toBe("あと 2 件");
  render(three);
  expect(cardsOf(box).map((c) => c.dataset.id)).toEqual(["a1"]);
  moreOf(box)!.onclick!();
  expect(cardsOf(box).map((c) => c.dataset.id)).toEqual(["a1", "a2", "a3"]);
  expect(moreOf(box)?.textContent).toBe("あと 2 件");
  render(three);
  expect(cardsOf(box).map((c) => c.dataset.id)).toEqual(["a1", "a2", "a3"]);
  moreOf(box)!.onclick!();
  expect(cardsOf(box).map((c) => c.dataset.id)).toEqual(["a1"]);
  render(three);
  expect(cardsOf(box).map((c) => c.dataset.id)).toEqual(["a1"]);
});

test("W107 1 件なら「あと」は出ない。turn-allow の hint は件数に入らない。先頭は auth", () => {
  const one = harness();
  one.render([ap("only")]);
  expect(cardsOf(one.box)).toHaveLength(1);
  expect(moreOf(one.box)).toBeUndefined();
  const hinted = harness();
  hinted.render([ap("a1"), ap("a2"), ap("a3")], [hint]);
  expect(cardsOf(hinted.box)).toHaveLength(1);
  expect(moreOf(hinted.box)?.textContent).toBe("あと 2 件");
  expect(hinted.box.textContent).toContain("書き込みを許しています");
  const ordered = harness();
  const auth = { id: "au", reason: "login", host: "shop.example", key: "k", options: [], fronted: false };
  ordered.render([ap("a1")], [hint], [{ id: "c1", host: "shop.example", groups: [], skipped: [], remember: false }], [{ id: "r1", agent: "a", label: "朝", internal: false }], [auth]);
  expect(cardsOf(ordered.box).map((c) => c.dataset.id)).toEqual(["au"]);
  expect(moreOf(ordered.box)?.textContent).toBe("あと 3 件");
  expect(ordered.box.textContent).not.toContain("書き込みを許しています");
  moreOf(ordered.box)!.onclick!();
  expect(cardsOf(ordered.box).map((c) => c.dataset.id)).toEqual(["au", "a1", "c1", "r1"]);
  expect(ordered.box.textContent).toContain("書き込みを許しています");
});

test("W107 予約 card の文は deny で、「断る」は無い", () => {
  const js = read("extension/panel.js");
  const render = js.slice(js.indexOf("function renderApprove"), js.indexOf("function showStopAll"));
  const routine = render.slice(render.indexOf("routineCards.map"), render.indexOf("const isCard"));
  expect(routine).toContain("心当たりが無ければ deny を押してください");
  expect(routine).not.toContain("断る");
  expect(js.slice(0, js.indexOf("function renderApprove"))).toContain("let approveOpen = false");
  const { box, render: go } = harness();
  go([], [], [], [{ id: "r1", agent: "a", label: "朝", internal: true }]);
  expect(box.textContent).toContain("心当たりが無ければ deny を押してください");
  expect(box.textContent).not.toContain("断る");
  expect(moreOf(box)).toBeUndefined();
  const css = read("extension/panel.css").slice(read("extension/panel.css").indexOf("/* W107"), read("extension/panel.css").indexOf("#stop-all"));
  expect(css).toContain("var(--fg)");
  expect(css).toContain("var(--hit)");
  expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/);
});
