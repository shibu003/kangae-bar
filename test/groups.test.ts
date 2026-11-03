import { expect, test } from "bun:test";
import { advancedPages, failedRowId, isLive, liveRuns, scrollPlan, findGroup, groupTitle, isWeb, planAdd, planSwitch, planTitle } from "../extension/groups.js";

test("groupTitle: 先頭 12 字＋中点＋根 id（20 字は使わない）", () => {
  expect(groupTitle({ text: "課題", id: 3 })).toBe("課題 ·#3");
  expect(groupTitle({ text: "あいうえおかきくけこさしすせそ", id: 4 })).toBe("あいうえおかきくけこさし ·#4");
  expect(groupTitle({ text: "short", id: 1 })).toBe("short ·#1");
});

test("findGroup: title が ·#<rootId> で終わる物。contains しない", () => {
  const groups = [
    { id: 10, title: "課題 ·#1" },
    { id: 11, title: "研究 ·#11" },
    { id: 12, title: "メモ ·#1 extra" },
    { id: 13, title: "人が作った" },
  ];
  expect(findGroup(groups, 1)).toEqual({ id: 10, title: "課題 ·#1" });
  expect(findGroup(groups, 11)).toEqual({ id: 11, title: "研究 ·#11" });
  expect(findGroup(groups, 1)?.id).not.toBe(11);
  expect(findGroup([{ id: 11, title: "研究 ·#11" }], 1)).toBeNull();
  expect(findGroup(groups, 9)).toBeNull();
  expect(findGroup([], 1)).toBeNull();
});

test("isWeb: url || pendingUrl が http(s)。chrome:// と空は否", () => {
  expect(isWeb({ url: "https://lms.example" })).toBe(true);
  expect(isWeb({ url: "http://example.com" })).toBe(true);
  expect(isWeb({ url: "", pendingUrl: "https://lms.example" })).toBe(true);
  expect(isWeb({ url: "chrome://newtab/" })).toBe(false);
  expect(isWeb({ url: "chrome://newtab/", pendingUrl: "https://x" })).toBe(false);
  expect(isWeb({ url: "", pendingUrl: "chrome://newtab/" })).toBe(false);
  expect(isWeb({ url: "about:blank" })).toBe(false);
  expect(isWeb({})).toBe(false);
});

test("planAdd: 既存 group があれば groupId、無ければ newTitle", () => {
  const tab = { id: 99, url: "https://lms.example" };
  const groups = [{ id: 5, title: "課題 ·#3" }];
  expect(planAdd({ rootId: 3, rootText: "あいうえおかきくけこさしすせそ", tab, groups })).toEqual({
    tabId: 99,
    groupId: 5,
    newTitle: null,
  });
  expect(planAdd({ rootId: 3, rootText: "あいうえおかきくけこさしすせそ", tab, groups: [] })).toEqual({
    tabId: 99,
    groupId: null,
    newTitle: "あいうえおかきくけこさし ·#3",
  });
  expect(planAdd({ rootId: 8, rootText: "研究", tab, groups })).toEqual({
    tabId: 99,
    groupId: null,
    newTitle: "研究 ·#8",
  });
});

test("planSwitch: 保存 url が空なら全部空（他 group も畳まない）", () => {
  const groups = [
    { id: 1, title: "課題 ·#3" },
    { id: 2, title: "研究 ·#4" },
    { id: 9, title: "人が作った" },
  ];
  expect(planSwitch({
    rootId: 3,
    savedUrls: [],
    windowTabs: [{ id: 20, url: "https://lms.example" }],
    groups,
  })).toEqual({ activate: null, group: [], open: [], collapse: [], expand: null });
});

test("planSwitch: 窓の同じ url を group し最初を activate。窓に保存 url があれば何も開かない。人の group は畳まない", () => {
  const groups = [
    { id: 1, title: "課題 ·#3" },
    { id: 2, title: "研究 ·#4" },
    { id: 9, title: "人が作った" },
    { id: 8, title: "買い物" },
  ];
  const windowTabs = [
    { id: 20, url: "https://lms.example" },
    { id: 21, url: "https://lms.example" },
    { id: 22, url: "chrome://newtab/" },
    { id: 23, url: "", pendingUrl: "https://docs.example" },
  ];
  expect(planSwitch({
    rootId: 3,
    savedUrls: ["https://lms.example", "https://docs.example", "https://missing.example", "https://missing.example"],
    windowTabs,
    groups,
  })).toEqual({
    activate: 20,
    group: [20, 21, 23],
    open: [],
    collapse: [2],
    expand: 1,
  });
});

test("planSwitch: 窓に http(s) が無ければ開く列の 1 枚目だけ表。対象 group が無ければ expand は null", () => {
  const groups = [
    { id: 2, title: "研究 ·#4" },
    { id: 9, title: "人が作った" },
  ];
  expect(planSwitch({
    rootId: 3,
    savedUrls: ["https://lms.example"],
    windowTabs: [{ id: 22, url: "chrome://newtab/" }],
    groups,
  })).toEqual({
    activate: null,
    group: [],
    open: [{ url: "https://lms.example", active: true }],
    collapse: [2],
    expand: null,
  });
});

const twoGroups = [
  { id: 1, title: "課題 ·#3" },
  { id: 2, title: "研究 ·#4" },
];

test("planSwitch: 前面は窓の並びの最初。保存順・id・index では選ばない", () => {
  const savedUrls = ["https://b.example", "https://a.example"];
  expect(planSwitch({
    rootId: 3,
    savedUrls,
    windowTabs: [
      { id: 30, index: 9, url: "https://a.example" },
      { id: 10, index: 0, url: "https://b.example" },
    ],
    groups: twoGroups,
  })).toEqual({
    activate: 30,
    group: [30, 10],
    open: [],
    collapse: [2],
    expand: 1,
  });
  expect(planSwitch({
    rootId: 3,
    savedUrls,
    windowTabs: [
      { id: 10, index: 9, url: "https://a.example" },
      { id: 30, index: 0, url: "https://b.example" },
    ],
    groups: twoGroups,
  }).activate).toBe(10);
});

test("planSwitch: group に居る保存 url でも lastAccessed では選ばない", () => {
  expect(planSwitch({
    rootId: 3,
    savedUrls: ["https://lms.example"],
    windowTabs: [
      { id: 1, index: 5, groupId: 1, url: "https://lms.example", lastAccessed: 1 },
      { id: 2, index: 0, groupId: 1, url: "https://lms.example", lastAccessed: 999 },
    ],
    groups: twoGroups,
  })).toEqual({
    activate: 1,
    group: [1, 2],
    open: [],
    collapse: [2],
    expand: 1,
  });
});

test("planSwitch: matching が空で group に http(s) があれば保存 url は開かず lastAccessed 最大", () => {
  expect(planSwitch({
    rootId: 3,
    savedUrls: ["https://old.example/page"],
    windowTabs: [
      { id: 7, index: 0, groupId: 1, url: "https://lms.example/now", lastAccessed: 10 },
      { id: 8, index: 3, groupId: 1, url: "https://other.example", lastAccessed: 50 },
      { id: 9, index: 1, groupId: 2, url: "https://research.example", lastAccessed: 999 },
    ],
    groups: twoGroups,
  })).toEqual({
    activate: 8,
    group: [],
    open: [],
    collapse: [2],
    expand: 1,
  });
});

test("planSwitch: 同じ lastAccessed は窓の並びの最初。id でも index でもない", () => {
  const savedUrls = ["https://missing.example"];
  expect(planSwitch({
    rootId: 3,
    savedUrls,
    windowTabs: [
      { id: 20, index: 5, groupId: 1, url: "https://a.example", lastAccessed: 100 },
      { id: 3, index: 0, groupId: 1, url: "https://b.example", lastAccessed: 100 },
    ],
    groups: twoGroups,
  }).activate).toBe(20);
  expect(planSwitch({
    rootId: 3,
    savedUrls,
    windowTabs: [
      { id: 3, index: 0, groupId: 1, url: "https://a.example", lastAccessed: 100 },
      { id: 20, index: 5, groupId: 1, url: "https://b.example", lastAccessed: 100 },
    ],
    groups: twoGroups,
  }).activate).toBe(3);
});

test("planSwitch: lastAccessed の 0 と欠落は後ろ。正の値が前面", () => {
  expect(planSwitch({
    rootId: 3,
    savedUrls: ["https://old.example"],
    windowTabs: [
      { id: 1, index: 0, groupId: 1, url: "https://a.example", lastAccessed: 0 },
      { id: 2, index: 9, groupId: 1, url: "https://b.example", lastAccessed: 1 },
    ],
    groups: twoGroups,
  }).activate).toBe(2);
  expect(planSwitch({
    rootId: 3,
    savedUrls: ["https://old.example"],
    windowTabs: [
      { id: 1, index: 0, groupId: 1, url: "https://a.example" },
      { id: 2, index: 9, groupId: 1, url: "https://b.example", lastAccessed: 1 },
    ],
    groups: twoGroups,
  }).activate).toBe(2);
});

test("planSwitch: 同じ host の別 path は一致にしない", () => {
  expect(planSwitch({
    rootId: 3,
    savedUrls: ["https://lms.example/old"],
    windowTabs: [
      { id: 1, url: "https://lms.example/new", lastAccessed: 999 },
      { id: 2, index: 9, groupId: 1, url: "https://other.example", lastAccessed: 1 },
    ],
    groups: twoGroups,
  })).toEqual({
    activate: 2,
    group: [],
    open: [],
    collapse: [2],
    expand: 1,
  });
});

test("planSwitch: group の pendingUrl が http(s) なら保存 url は開かない", () => {
  expect(planSwitch({
    rootId: 3,
    savedUrls: ["https://old.example"],
    windowTabs: [
      { id: 4, groupId: 1, url: "", pendingUrl: "https://progress.example", lastAccessed: 3 },
    ],
    groups: twoGroups,
  })).toEqual({
    activate: 4,
    group: [],
    open: [],
    collapse: [2],
    expand: 1,
  });
});

test("planSwitch: 窓に保存 url があっても group に http(s) があれば足りない url は開かない", () => {
  expect(planSwitch({
    rootId: 3,
    savedUrls: ["https://lms.example", "https://old.example"],
    windowTabs: [
      { id: 2, groupId: 1, url: "https://progress.example", lastAccessed: 500 },
      { id: 3, url: "https://lms.example", lastAccessed: 1 },
    ],
    groups: twoGroups,
  })).toEqual({
    activate: 3,
    group: [3],
    open: [],
    collapse: [2],
    expand: 1,
  });
});

test("planSwitch: group の chrome:// は進んだ頁に数えない。付いた順の 1 行目だけを表で開き expand へ", () => {
  expect(planSwitch({
    rootId: 3,
    savedUrls: ["https://lms.example", "https://docs.example"],
    windowTabs: [
      { id: 5, groupId: 1, url: "chrome://newtab/", lastAccessed: 9999 },
    ],
    groups: twoGroups,
  })).toEqual({
    activate: null,
    group: [],
    open: [{ url: "https://lms.example", active: true }],
    collapse: [2],
    expand: 1,
  });
});

test("planSwitch: 進んだ頁が無く窓に他の http(s) があれば 1 行目だけを裏で開く", () => {
  expect(planSwitch({
    rootId: 3,
    savedUrls: ["https://lms.example", "https://docs.example"],
    windowTabs: [
      { id: 4, url: "https://other.example", lastAccessed: 999, groupId: 99 },
    ],
    groups: twoGroups,
  })).toEqual({
    activate: null,
    group: [],
    open: [{ url: "https://lms.example", active: false }],
    collapse: [2],
    expand: 1,
  });
});

test("planSwitch: 開くのは savedUrls の先頭 1 枚だけ（付いた順）", () => {
  expect(planSwitch({
    rootId: 3,
    savedUrls: ["https://b.example", "https://a.example", "https://b.example"],
    windowTabs: [{ id: 1, url: "chrome://newtab/" }],
    groups: [],
  })).toEqual({
    activate: null,
    group: [],
    open: [{ url: "https://b.example", active: true }],
    collapse: [],
    expand: null,
  });
});

test("planTitle: 窓にあれば並びの最初だけ。lastAccessed・id・index では選ばない", () => {
  const groups = twoGroups;
  const url = "https://lms.example";
  expect(planTitle({
    rootId: 3,
    url,
    windowTabs: [
      { id: 30, index: 9, url, lastAccessed: 1 },
      { id: 10, index: 0, url, lastAccessed: 999 },
    ],
    groups,
  })).toEqual({ activate: 30, open: null, disabled: false });
  expect(planTitle({
    rootId: 3,
    url,
    windowTabs: [
      { id: 10, index: 9, url, lastAccessed: 1 },
      { id: 30, index: 0, url, lastAccessed: 999 },
    ],
    groups,
  }).activate).toBe(10);
});

test("planTitle: 窓にある url は、group に http(s) があっても disabled にしない", () => {
  expect(planTitle({
    rootId: 3,
    url: "https://lms.example",
    windowTabs: [
      { id: 2, groupId: 1, url: "https://progress.example", lastAccessed: 500 },
      { id: 3, index: 9, url: "https://lms.example", lastAccessed: 1 },
    ],
    groups: twoGroups,
  })).toEqual({ activate: 3, open: null, disabled: false });
});

test("planTitle: (d) 進んだ頁が 2 枚以上で窓に無ければ disabled。lastAccessed にはしない", () => {
  expect(planTitle({
    rootId: 3,
    url: "https://old.example",
    windowTabs: [
      { id: 8, index: 0, groupId: 1, url: "https://progress.example", lastAccessed: 500 },
      { id: 9, index: 1, groupId: 1, url: "https://other.example", lastAccessed: 1 },
    ],
    groups: twoGroups,
  })).toEqual({ activate: null, open: null, disabled: true });
});

test("planTitle: 別の根の group の http(s) では disabled にしない", () => {
  expect(planTitle({
    rootId: 1,
    url: "https://lms.example",
    windowTabs: [{ id: 2, groupId: 11, url: "https://other.example" }],
    groups: [
      { id: 11, title: "研究 ·#11" },
      { id: 1, title: "課題 ·#1" },
    ],
  })).toEqual({
    activate: null,
    open: { url: "https://lms.example", active: false },
    disabled: false,
  });
});

test("planTitle: pendingUrl が一致すればその tab。url が chrome でも pending を見ない", () => {
  expect(planTitle({
    rootId: 3,
    url: "https://docs.example",
    windowTabs: [{ id: 6, url: "", pendingUrl: "https://docs.example" }],
    groups: twoGroups,
  })).toEqual({ activate: 6, open: null, disabled: false });
  expect(planTitle({
    rootId: 3,
    url: "https://docs.example",
    windowTabs: [{ id: 7, url: "chrome://newtab/", pendingUrl: "https://docs.example" }],
    groups: twoGroups,
  }).activate).not.toBe(7);
});

test("planTitle: 同じ host の別 path は開く。窓の tab は前面にしない", () => {
  expect(planTitle({
    rootId: 3,
    url: "https://lms.example/old",
    windowTabs: [{ id: 1, url: "https://lms.example/new", lastAccessed: 999 }],
    groups: twoGroups,
  })).toEqual({
    activate: null,
    open: { url: "https://lms.example/old", active: false },
    disabled: false,
  });
});

test("planTitle: group に http(s) が無く窓に他の http(s) があれば 1 枚を裏で開く", () => {
  expect(planTitle({
    rootId: 3,
    url: "https://old.example",
    windowTabs: [{ id: 4, url: "https://other.example", lastAccessed: 999 }],
    groups: twoGroups,
  })).toEqual({
    activate: null,
    open: { url: "https://old.example", active: false },
    disabled: false,
  });
});

test("planTitle: 窓に http(s) が無ければその 1 枚は表。group の chrome:// は数えない", () => {
  expect(planTitle({
    rootId: 3,
    url: "https://lms.example",
    windowTabs: [{ id: 5, groupId: 1, url: "chrome://newtab/", lastAccessed: 9999 }],
    groups: twoGroups,
  })).toEqual({
    activate: null,
    open: { url: "https://lms.example", active: true },
    disabled: false,
  });
});

test("planTitle: group の pendingUrl が http(s) の 1 枚は進んだ頁で (c)", () => {
  expect(planTitle({
    rootId: 3,
    url: "https://old.example",
    windowTabs: [{ id: 4, groupId: 1, url: "", pendingUrl: "https://progress.example", lastAccessed: 9 }],
    groups: twoGroups,
  })).toEqual({ activate: 4, open: null, disabled: false });
});

const G = [{ id: 1, title: "課題 ·#3" }, { id: 2, title: "研究 ·#4" }];
const SAVED = ["https://a.example/1", "https://b.example/2", "https://c.example/3", "https://d.example/4"] as [string, string, string, string];

test("advancedPages: この根の group の http(s) で保存 url（4 件目も）に一致しない物。保存 url の tab と別の根の tab は数えない", () => {
  const tabs = [
    { id: 1, groupId: 1, url: "https://a.example/1" },
    { id: 2, groupId: 1, url: "https://d.example/4" },
    { id: 3, groupId: 1, url: "https://lms.example/home" },
    { id: 4, groupId: 2, url: "https://other.example" },
    { id: 5, groupId: 1, url: "chrome://newtab/" },
    { id: 6, groupId: 1, url: "https://lms.example/forward" },
  ];
  expect(advancedPages({ rootId: 3, savedUrls: SAVED, windowTabs: tabs, groups: G }).map((t: any) => t.id)).toEqual([3, 6]);
  expect(advancedPages({ rootId: 3, savedUrls: SAVED, windowTabs: tabs, groups: G, exclude: [6] }).map((t: any) => t.id)).toEqual([3]);
});

test("planTitle: 朝に 3 行を上から押すと 3 枚開く（開いた枚は保存 url なので進んだ頁に数えない）", () => {
  const saved = SAVED.slice(0, 3) as [string, string, string];
  const tabs: any[] = [{ id: 10, url: "chrome://newtab/" }];
  const p1 = planTitle({ rootId: 3, url: saved[0], savedUrls: saved, windowTabs: tabs, groups: G });
  expect(p1).toEqual({ activate: null, open: { url: saved[0], active: true }, disabled: false });
  tabs.push({ id: 11, groupId: 1, url: saved[0] });
  const p2 = planTitle({ rootId: 3, url: saved[1], savedUrls: saved, windowTabs: tabs, groups: G });
  expect(p2).toEqual({ activate: null, open: { url: saved[1], active: false }, disabled: false });
  tabs.push({ id: 12, groupId: 1, url: saved[1] });
  const p3 = planTitle({ rootId: 3, url: saved[2], savedUrls: saved, windowTabs: tabs, groups: G });
  expect(p3.open).toEqual({ url: saved[2], active: false });
});

test("planTitle: (b) mapTab があれば url が空の読み込み中でもその tab。(a) が先、(b) は (c)(d)(e) より先", () => {
  const tabs = [
    { id: 20, groupId: 1, url: "", pendingUrl: "" },
    { id: 21, groupId: 1, url: "https://lms.example/a" },
    { id: 22, groupId: 1, url: "https://lms.example/b" },
  ];
  expect(planTitle({ rootId: 3, url: SAVED[0], savedUrls: SAVED, windowTabs: tabs, groups: G, mapTab: 20 }))
    .toEqual({ activate: 20, open: null, disabled: false });
  const withA = [...tabs, { id: 23, url: SAVED[0] }];
  expect(planTitle({ rootId: 3, url: SAVED[0], savedUrls: SAVED, windowTabs: withA, groups: G, mapTab: 20 }).activate).toBe(23);
});

test("planTitle: (c) 進んだ頁が 1 枚だけなら開かずその 1 枚。mapValues の tab は数えない", () => {
  const tabs = [
    { id: 30, groupId: 1, url: "https://lms.example/login" },
    { id: 31, groupId: 1, url: "https://x.example/after-redirect" },
  ];
  expect(planTitle({ rootId: 3, url: SAVED[1], savedUrls: SAVED, windowTabs: tabs, groups: G, mapValues: [31] }))
    .toEqual({ activate: 30, open: null, disabled: false });
  expect(planTitle({ rootId: 3, url: SAVED[1], savedUrls: SAVED, windowTabs: tabs, groups: G, mapValues: [30, 31] }).open)
    .toEqual({ url: SAVED[1], active: false });
});

test("planTitle: Map の値を数えから除くのは題名行だけ。pill の数えは除かない（転送後の 1 枚を前面にする）", () => {
  const tabs = [{ id: 40, groupId: 1, url: "https://lms.example/login", lastAccessed: 5 }];
  expect(planSwitch({ rootId: 3, savedUrls: SAVED, windowTabs: tabs, groups: G })).toMatchObject({ activate: 40, open: [] });
});

test("planSwitch: 進んだ頁が 2 枚以上なら保存 url は開かず lastAccessed 最大。進んだ頁 0 なら 1 行目だけ", () => {
  const two = [
    { id: 1, groupId: 1, url: "https://x.example/1", lastAccessed: 3 },
    { id: 2, groupId: 1, url: "https://x.example/2", lastAccessed: 9 },
  ];
  expect(planSwitch({ rootId: 3, savedUrls: SAVED, windowTabs: two, groups: G })).toMatchObject({ activate: 2, open: [] });
  expect(planSwitch({ rootId: 3, savedUrls: SAVED, windowTabs: [], groups: [] }).open).toEqual([{ url: SAVED[0], active: true }]);
});

test("isLive / liveRuns: running と queue>0 が生きている。view に居ない送信直後は終了にしない。終了と返れば消す", () => {
  const runs = [
    { id: "a", nodeId: 1, rowId: 5, status: "running", queue: 0 },
    { id: "b", nodeId: 2, rowId: 6, status: "idle", queue: 1 },
    { id: "c", nodeId: 3, rowId: 7, status: "idle", queue: 0 },
    { id: "d", nodeId: 4, rowId: 8, status: "stopped", queue: 0 },
    { id: "e", nodeId: 5, rowId: 9, status: "failed", queue: 0 },
  ];
  expect(runs.map(isLive)).toEqual([true, true, false, false, false]);
  expect(liveRuns(runs, []).map((r: any) => r.id)).toEqual(["a", "b"]);
  expect(liveRuns(runs, [{ runId: "z", nodeId: 1, rowId: 10 }]).map((r: any) => r.id)).toEqual(["a", "b", "z"]);
  expect(liveRuns(runs, [{ runId: "d", nodeId: 4, rowId: 8 }]).map((r: any) => r.id)).toEqual(["a", "b"]);
  // 進み具合の card と上の 1 行は run の log を読む。view に居ない送信直後の物は log が空
  expect(liveRuns([{ ...runs[0]!, log: ["資料を読んでいます"] }], [{ runId: "z", nodeId: 1, rowId: 10 }]).map((r: any) => r.log)).toEqual([["資料を読んでいます"], []]);
});

test("failedRowId: その根の最新の run が failed の行だけ。stopped・過去の失敗・別の根は出ない", () => {
  const runs = [
    { id: "a", nodeId: 1, rowId: 5, status: "failed", startedAt: 1 },
    { id: "b", nodeId: 1, rowId: 6, status: "idle", startedAt: 2 },
    { id: "c", nodeId: 2, rowId: 7, status: "failed", startedAt: 1 },
    { id: "d", nodeId: 3, rowId: 8, status: "stopped", startedAt: 1 },
  ];
  expect(failedRowId(runs, 1)).toBeNull();
  expect(failedRowId(runs, 2)).toBe(7);
  expect(failedRowId(runs, 3)).toBeNull();
  expect(failedRowId(runs, 9)).toBeNull();
  expect(failedRowId([{ id: "f", nodeId: 4, rowId: null, status: "failed" }], 4)).toBeNull();
});

test("scrollPlan: 末尾へ寄せるのは (i)〜(v) だけ。返事の頭は open と reply の近い時だけ、高い 🤖 の時だけ", () => {
  const base = { near: false, lastIsBot: false, lastHeight: 50, viewHeight: 300 };
  const tall = { ...base, lastIsBot: true, lastHeight: 400 };
  expect(scrollPlan({ scene: "open", ...base })).toBe("end");
  expect(scrollPlan({ scene: "open", ...tall })).toBe("last-top");
  expect(scrollPlan({ scene: "open", ...base, lastIsBot: true })).toBe("end");
  expect(scrollPlan({ scene: "reply", ...tall, near: true })).toBe("last-top");
  expect(scrollPlan({ scene: "reply", ...base, near: true })).toBe("end");
  expect(scrollPlan({ scene: "reply", ...tall, near: false })).toBe("keep");
  expect(scrollPlan({ scene: "send", ...tall, near: false })).toBe("end");
  expect(scrollPlan({ scene: "fail", ...tall, near: false })).toBe("end");
  expect(scrollPlan({ scene: "toggle", ...tall, near: true })).toBe("end");
  expect(scrollPlan({ scene: "toggle", ...tall, near: false })).toBe("keep");
  expect(scrollPlan({ scene: "keep", ...tall, near: true })).toBe("keep");
});

import { readRetry } from "../extension/groups.js";
const ok = (b: unknown) => ({ ok: true, status: 200, json: async () => b });
test("w7g/w7h readRetry: 1 回落ちても 2 回目で読める・締切を越えたら理由・final は読み直さない", async () => {
  let n = 0;
  const slept: number[] = [];
  const sleep = async (ms: number) => { slept.push(ms); };
  const a = await readRetry(async () => (++n < 2 ? { ok: false, reason: "boom" } : { ok: true, needs: [1] }), { sleep });
  expect(a).toEqual({ ok: true, needs: [1] });
  expect(slept).toEqual([500]);
  slept.length = 0;
  const b = await readRetry(async () => ({ ok: false, reason: "常駐の返事が 503 でした" }), { sleep });
  expect(b.ok).toBe(false);
  expect(b.reason).toContain("503");
  expect(slept.reduce((x, y) => x + y, 0)).toBeLessThanOrEqual(60000);
  expect(slept.length).toBeGreaterThan(5);
  slept.length = 0;
  const c = await readRetry(async () => ({ ok: false, final: true, reason: "kangae-token" }), { sleep });
  expect(c.reason).toContain("kangae-token");
  expect(slept).toEqual([]);
});
