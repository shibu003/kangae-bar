// 押す操作の一覧（W62・W108）。panel の #press に描く。文字は textContent だけ・人や頁の文字を HTML にしない・内部の語を出さない
// 口は call(op, …)。panel と同じ port.js の kangaeConnect（印は panel の meta）
(() => {
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const btn = (text, cls, onclick) => { const b = el("button", cls ? `btn ${cls}` : "btn", text); b.type = "button"; b.onclick = onclick; return b; };

  let port = null;
  const waiting = new Map();
  function connect() {
    port = kangaeConnect();
    port.onMessage.addListener((res) => { const w = res && waiting.get(res.id); if (w) { waiting.delete(res.id); w(res); } });
    port.onDisconnect.addListener(() => { port = null; for (const [id, w] of waiting) { waiting.delete(id); w({ ok: false, hint: "本体に繋がりません。アプリを開き直してから、もう一度押してください" }); } }); // 押す依頼は送り直さない（二重に押さない）
  }
  function call(op, extra = {}) {
    return new Promise((resolve) => {
      if (!port) connect();
      const msg = { id: crypto.randomUUID(), op, ...extra };
      waiting.set(msg.id, resolve);
      port.postMessage(msg);
    });
  }

  const RATE = (r) => (r.total ? `再現率 ${r.clean}/${r.total}` : "まだ押していません");
  const fieldLabel = (f) => f.label || f.name;
  const stagesOf = (p) => { const ol = el("ol"); for (const s of p.stages) ol.append(el("li", "", `${s.kind === "env" ? "準備" : "操作"}: ${s.goal}`)); return ol; };

  let pressTimer = null;
  let pressGen = 0;

  function mountPress(root) {
    const $ = (id) => root.querySelector("#" + id);
    const mine = ++pressGen;
    const conv = () => { const v = root.dataset.root || ""; return /^\d+$/.test(v) ? Number(v) : undefined; };
    const press = (action, extra = {}) => call("press", { action, rootId: conv(), ...extra });
    const note = (s) => { const n = $("note"); if (n) n.textContent = s || ""; };

    function fieldsForm(p) {
      const box = el("div"), get = {};
      for (const f of p.fields) {
        if ("fixed" in f) continue;
        const id = `f-${p.id}-${f.name}`;
        const lab = el("label", "", "range" in f ? `${fieldLabel(f)}（${f.range[0]} から ${f.range[1]}）` : fieldLabel(f));
        lab.htmlFor = id;
        let input;
        if ("choice" in f) { input = el("select"); for (const c of f.choice) input.append(Object.assign(el("option", "", c), { value: c })); }
        else input = el("input");
        input.id = id;
        get[f.name] = () => input.value;
        box.append(lab, input);
      }
      return { box, values: () => Object.fromEntries(Object.entries(get).map(([k, g]) => [k, g()])) };
    }

    function renderAsks(asks) {
      $("asks").replaceChildren(...asks.map((a) => {
        const c = el("div", "card stop");
        c.append(el("div", "", `「${a.name}」は段 ${a.n}（${a.goal}）で止まりました`), el("div", "why", `理由: ${a.why}。画面を直してから「続ける」を押すと、この段からやり直します（前の段はやり直しません）`));
        const acts = el("div", "btns");
        acts.append(
          btn("続ける", "p", async () => { const r = await press("answer", { run: a.run, yes: true }); note(r.ok ? "続けます" : r.hint); load(); }),
          btn("やめる", "", async () => { const r = await press("answer", { run: a.run, yes: false }); note(r.ok ? "やめました" : r.hint); load(); }),
        );
        c.append(acts);
        return c;
      }));
    }

    function renderOffer(o) {
      if (!o) { $("offer").replaceChildren(); return; }
      const c = el("div", "card");
      c.append(el("div", "", "この会話の仕事を押す操作にできます"), stagesOf(o));
      const nameId = "offer-name", lab = el("label", "", "名前");
      lab.htmlFor = nameId;
      const name = Object.assign(el("input"), { id: nameId, value: o.name, maxLength: 60 });
      c.append(lab, name);
      const fixed = {};
      for (const f of o.fields) {
        const id = `fix-${f.name}`, l = el("label", "", `${fieldLabel(f)}: 毎回同じ値にするなら入れる（空なら押す時に聞きます）`);
        l.htmlFor = id;
        const input = Object.assign(el("input"), { id });
        fixed[f.name] = () => input.value;
        c.append(l, input);
      }
      const acts = el("div", "btns");
      acts.append(btn("押す操作にする", "p", async (e) => {
        e.target.disabled = true;
        const r = await press("save", { name: name.value, fixed: Object.fromEntries(Object.entries(fixed).map(([k, g]) => [k, g()]).filter(([, v]) => v)) });
        note(r.ok ? "押す操作にしました" : r.hint);
        load();
      }));
      c.append(acts);
      $("offer").replaceChildren(c);
    }

    function renderList(ps, active) {
      if (!ps.length) { $("list").replaceChildren(el("p", "why", "押す操作はまだありません。仕事が終わった時に会話に出る「押す操作にしますか」から作ります")); return; }
      $("list").replaceChildren(...ps.map((p) => {
        const c = el("div", "card");
        c.append(el("div", "", p.name), el("div", "meta", `段 ${p.stages.length}・欄 ${p.fields.length}・${RATE(p.runs)}`), stagesOf(p));
        const form = fieldsForm(p);
        c.append(form.box);
        const acts = el("div", "btns");
        let sure = false;
        const rm = btn("消す", "", async () => {
          if (!sure) { sure = true; rm.textContent = "本当に消す"; return; }
          const r = await press("rm", { press: p.id });
          note(r.ok ? "消しました" : r.hint);
          load();
        });
        const go = btn("押す", "p", async () => {
          go.disabled = true;
          const r = await press("run", { press: p.id, fields: form.values() });
          note(r.ok ? `「${p.name}」を押しました。段ごとに進みます` : r.hint);
          load();
        });
        if (active) go.disabled = true;
        const give = btn("渡す", "", async () => { // file に書き出す（場所は本体が決める＝ダウンロード）。入れた値は入らない
          const r = await press("share", { press: p.id });
          note(r.ok ? `「ダウンロード」フォルダに書き出しました（${String(r.path).split("/").pop()}）。入れた値は入っていません。この file を相手に渡すと、相手は「受け取る」で読み込めます` : r.hint);
        });
        acts.append(go, give, rm);
        c.append(acts);
        return c;
      }));
    }

    function renderTake(r) {
      if (!r) { $("take-card").replaceChildren(); return; }
      const c = el("div", "card");
      const ul = el("ul");
      for (const l of r.card.lines) ul.append(el("li", "", l));
      c.append(el("div", "", r.card.title), ul);
      if (!r.cardOk) c.append(el("div", "why", "この押す操作の説明には、画面に出さない語が混じっていました。始める前に段を確かめてください"));
      const acts = el("div", "btns");
      acts.append(
        btn("始める", "p", async (e) => {
          e.target.disabled = true;
          const s = await press("import", { key: r.key });
          note(s.ok ? "受け取った押す操作を一覧に足しました。欄を入れて「押す」で使えます" : s.hint);
          renderTake(null);
          load();
        }),
        btn("やめる", "", () => { renderTake(null); note("受け取るのをやめました（一覧には足していません）"); }),
      );
      c.append(acts);
      $("take-card").replaceChildren(c);
    }

    $("take-go").onclick = async () => {
      const r = await press("import", { path: $("take-path").value });
      renderTake(r.ok ? r : null);
      note(r.ok ? "中身を確かめました。下の説明を読んでから「始める」を押してください" : r.hint);
    };

    async function load() {
      if (mine !== pressGen || root.hidden) return;
      const r = await press("list");
      if (mine !== pressGen || root.hidden) return;
      if (!r.ok) { note(r.hint || "一覧を読めませんでした"); return; }
      renderAsks(r.asks || []);
      renderOffer(r.offer);
      renderList(r.presses || [], (r.active || []).length > 0);
      clearTimeout(pressTimer);
      if (mine !== pressGen || root.hidden) return;
      if ((r.active || []).length) pressTimer = setTimeout(load, 2000); // 押している間だけ見直す（止まった段の問いと再現率）
    }
    load();
  }

  globalThis.mountPress = mountPress;
})();
