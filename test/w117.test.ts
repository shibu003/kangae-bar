// W117: toast は aria-atomic・hover の間は消えない・操作は quiet。DOM は代役。実機の見た目は未測。
import { beforeAll, expect, test } from "bun:test";
import { installDom, mount } from "./domshim.ts";

beforeAll(installDom);

const ev = (type: string) => ({ type, bubbles: false, stopPropagation() {} });

test("W117 kg-toast は aria-atomic=true", () => {
  const t = mount("kg-toast") as any;
  expect(t.getAttribute("role")).toBe("status");
  expect(t.getAttribute("aria-live")).toBe("polite");
  expect(t.getAttribute("aria-atomic")).toBe("true");
});

test("W117 mouseenter の間は消えない。離すと残りから消える", () => {
  let now = 1000;
  const jobs: { fn: () => void; at: number; dead: boolean }[] = [];
  const prevNow = Date.now;
  const prevSet = globalThis.setTimeout;
  const prevClear = globalThis.clearTimeout;
  Date.now = () => now;
  // typeof setTimeout は __promisify__ を持つので、偽物は unknown を通して差す
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const job = { fn, at: now + (ms ?? 0), dead: false };
    jobs.push(job);
    return job as unknown as number;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = ((id?: number) => { const j = id as unknown as { dead?: boolean } | undefined; if (j) j.dead = true; }) as typeof clearTimeout;
  const run = (to: number) => {
    now = to;
    for (const j of [...jobs]) if (!j.dead && j.at <= now) { j.dead = true; j.fn(); }
  };
  try {
    const t = mount("kg-toast") as any;
    t.show("済んだ", { ms: 100 });
    expect(t.hidden).toBe(false);
    t.dispatchEvent(ev("mouseenter"));
    run(1800);
    expect(t.hidden).toBe(false);
    expect(t.textContent).toBe("済んだ");
    t.dispatchEvent(ev("mouseleave"));
    expect(t.hidden).toBe(false);
    run(1850);
    expect(t.hidden).toBe(false);
    run(1900);
    expect(t.hidden).toBe(true);
    expect(t.textContent).toBe("");
  } finally {
    Date.now = prevNow;
    globalThis.setTimeout = prevSet;
    globalThis.clearTimeout = prevClear;
  }
});

test("W117 操作は quiet の button 1 つ。toast は focus を取らない", () => {
  const t = mount("kg-toast") as any;
  let took = false;
  t.focus = () => { took = true; };
  t.show("送りました", { action: { id: "undo", label: "取り消し" }, ms: 1000 });
  const b = t.querySelectorAll("button[data-act]");
  expect(b.length).toBe(1);
  expect(b[0].className).toBe("btn quiet");
  expect(b[0].textContent).toBe("取り消し");
  expect(took).toBe(false);
  t.hide();
});
