// 「この AI のきまり」（W13）。初めて使う人に見せる約束 1 行 = 守っている所の組。
// 守っていない約束は書かない: test/w13.test.ts が、各行に振る舞いの試験（{ test, name }）が在り今の tree で通る事（主）と、目印の字（{ file, has }）がちょうど 1 か所在る事（補助）を見る。
// 試験の名前を変えたら、ここも直す（直さないと w13 が 0 件一致で赤）。
// 言い回しは W12 に揃える（です・ます・「あなた」・専門語なし）。
export const RULES = [
  {
    id: "scope",
    text: "窓や tab を操作・読むのは、あなたが渡した物だけです（tab から読める頁は同じ site だけ）。agent が読めるファイルは、その agent の作業場所の中だけです（Claude と Gemini の場合。Codex は読む範囲を絞れませんが、外への通信は閉じています）。窓や tab を渡している間は、web の検索や任意の URL の取得も使えません（調べ物だけを頼んだ時は使います。ただし Gemini は常に使えません）。mod の API は、あなたが on にした宣言の物だけです",
    guard: [{ file: "src/lease.ts", has: "l.owner !== owner" }, { file: "src/lease.ts", has: "で読めるのは、渡された tab と同じ site" }, { file: "src/main.ts", has: "const reads = `Read(//" }, { file: "src/main.ts", has: "const web = lease || cwds.length ?" }, { file: "src/main.ts", has: "(deny file-read-data" }, { file: "src/main.ts", has: "export const GEMINI_NO_WEB" }, { file: "src/main.ts", has: "sandbox_workspace_write.network_access=false" }, { file: "src/main.ts", has: "const modCfg = f.cli" }, { test: "test/lease.test.ts", name: "AC-2: 1 つの面に持ち主は 1 人・2 人は互いの面に書けない" }, { test: "test/lease.test.ts", name: "W3c: fetch_url / render_url は同じ site の url だけ通り、url の省略は tab の今の頁・別 site / 別 scheme / 不正は拒否で 0 件実行" }, { test: "test/w4d.test.ts", name: "W11e-2 道具: 読めるのは作業場所と shots の中だけ（無印の Read / Glob / Grep なし）・面を持つ turn は WebSearch / WebFetch なし・持たない調べ物は残る" }, { test: "test/review14.test.ts", name: "W11e-2: 面を持つ turn は WebFetch も mcp__browser も無い・面の無い turn は両方ある" }, { test: "test/w11e3.test.ts", name: "W11e-3 gemini の読み: 人の home の鍵は OS が拒み、作業場所（home の下でも）・戻した実体の置き場は読める" }, { test: "test/w11e3.test.ts", name: "W11e-3 codex は network を明示で閉じる・gemini は web を policy で外し読みの囲いに入る" }, { test: "test/w6a.test.ts", name: "AC-3 手順は「人が置いた手順」の枠で渡る・枠を閉じる記号は中身から消える・MCP は別 file（作業場所の外）で渡り turn 後は消える・画面の文字の囲いは変えない" }, { test: "test/w6a.test.ts", name: "UC-m4 MCP を宣言しない mod / claude 以外の AI では「API は使えません」と枠が言う・宣言した mod は画面の操作より先に API を使う文" }],
  },
  {
    id: "ask",
    text: "送信・削除・購入、ログアウトや設定の変更のような、壊しうる操作・tab の外にも効く操作は、毎回あなたに聞きます",
    guard: [{ file: "src/lease.ts", has: "const danger = docsWrite ||" }, { file: "src/lease.ts", has: "askHuman(l, tool," }, { test: "test/lease.test.ts", name: "W4a AC-2: 先に聞く（既定）の操作は、許されるまで実行 0 件・許した 1 件だけ実行される" }, { test: "test/w8a.test.ts", name: "W8a UC-x1: 「この頼みの間」を許した後も、文字を入れるのは聞かず、「送信」を押すのは聞く（押せば実行）" }, { test: "test/w8a.test.ts", name: "W8a-2: ログアウト・アカウント設定は「この頼みの間」でも「許す」の app でも毎回 1 回聞く・文言は「他の tab や他の端末にも効きます」・普通の書き換えは今まで通り" }],
  },
  {
    id: "human-first",
    text: "あなたが見ている画面は、あなたが離れてから始めます。画面に触れば、その場で agent から取り戻せます",
    guard: [{ file: "src/lease.ts", has: "if (!READ_ONLY.includes(tool) && !human && l.hold)" }, { file: "src/lease.ts", has: "touch:" }, { file: "src/main.ts", has: "touchTab" }, { test: "test/w11d.test.ts", name: "UC-d1 相当: 前面の app を任せる → 書き換えは 0 件で待つ → 人が別の app へ移ると始まる" }, { test: "test/w11d.test.ts", name: "UC-d3 相当: 人が離れない → 書き換え 0 件のまま waiting（hold は残る・勝手に始めない）" }, { test: "test/w11d.test.ts", name: "hold 中の接触は取り戻さない・始めた後の接触は今まで通り取り戻す" }, { test: "test/lease.test.ts", name: "人がその app を触ったら取り戻す（別の app は触らない）" }, { test: "test/lease.test.ts", name: "W2e: 人が tab を触ったら取り戻す・tab が消えたら surface・app の窓と tab は別の持ち主で互いの面に書けない" }],
  },
  {
    id: "unsure",
    text: "実行されたか分からない時は、確かめるまで勝手にやり直しません",
    guard: [{ file: "src/lease.ts", has: "unsureOf.has(l)" }, { test: "test/w11f.test.ts", name: "窓: 送った後の時間切れは結果不明・書き換えは読むまで止まり、読むと解ける・読む act は止めない" }, { test: "test/w11f.test.ts", name: "web: 送った後の時間切れは結果不明・書き換えは読むまで止まり、読むと解ける・読む act は止めない" }],
  },
  {
    id: "human-only",
    text: "指紋・顔・passkey・認証コード・CAPTCHA が出たら、入力も押下もせずあなたを呼びます",
    guard: [{ file: "src/lease.ts", has: "!human && humanOf.has(l)" }, { test: "test/w8b2.test.ts", name: "見分け: web の gate・AX の secure 欄・label の語。ふつうの欄・見出しは止めない" }, { test: "test/w8b2.test.ts", name: "UC-h4: one-time-code の欄が出たら入れずに止まる・書き換え 0 件・hint が handoff を頼む" }, { test: "test/w8b2.test.ts", name: "UC-h5: 偽の captcha → 押した回数 0" }, { test: "test/w8b2.test.ts", name: "WebAuthn: 頁が credentials を呼んだ（読む前でも）→ 返事の gate で止まる" }, { test: "test/w8b2.test.ts", name: "推測で入れない: 人が済ませる前に別の欄経由・別 tool でも書けない（type_text / set_value / press_key / hotkey）" }],
  },
  {
    id: "carry",
    text: "ログイン状態・履歴・パスワードは、あなたが選んだ時だけ、値を見せずに運びます（履歴は別のチェックを入れた時だけ）。渡す先は、ブラウザ（この app の Chromium か Google Chrome）が自分で起こした拡張だけです。ただし、この Mac で同じユーザーとして動くソフトが、拡張やこの app のファイルを書き換えた時までは防げません",
    guard: [{ file: "src/carry.ts", has: "history === true" }, { file: "src/carry.ts", has: "export function listing" }, { file: "src/vault.ts", has: "値は見せていません" }, { file: "src/main.ts", has: "Promise.resolve().then(() => opts.isExtension?.(owner))" }, { file: "src/peer.ts", has: "runningSigner(me.ppid)" }, { test: "test/w8g.test.ts", name: "承諾 → 運ぶ。card は名前と件数だけ・値はどの出力にも出ない・IdP は外す・context に入る（default には 0）" }, { test: "test/w8g.test.ts", name: "承諾が無ければ運ばない: 断る / 時間切れ / 取り戻す(end) は同じ「何も運ばない」で、値を取りにも行かない" }, { test: "test/w8g.test.ts", name: "履歴: checkbox が無い承諾は履歴なし（拡張にも頼まない）・on なら host の分だけ・query と # は落ちる" }, { test: "test/w8g4.test.ts", name: "承諾（checkbox on）→ 金庫から欄へ入る。値は入れた 1 回の CDP 以外・返事・card・bw の log のどこにも出ない（わざと出すと赤）" }, { test: "test/review11.test.ts", name: "偽の口だけの時: webHello は断られ、web の依頼は誰にも送られない" }, { test: "test/w8g5.test.ts", name: "親が決まった browser でなければ断る（gemini が kangae chrome-extension://… を自分で起こした形）" }, { test: "test/w8g5.test.ts", name: "argv に拡張の origin が無い口（socket に直に繋いだ process）は断る" }, { test: "test/w8g5.test.ts", name: "本物の browser でも別の profile（--user-data-dir）で起こした物は断る・製品の profile なら通る" }, { test: "test/w8g5.test.ts", name: "常駐: この試験の bun が起こした host（偽の browser）は extensionPeer が断る" }, { test: "test/w8g5.test.ts", name: "gemini の seatbelt: 常駐の socket に繋げない・消せない（外すと繋がって赤）" }, { test: "test/w8g5.test.ts", name: "防げない物（W13 の但し書き）: 判定は browser の code と profile の場所だけ＝製品の profile の中の file を書き換えても通る" }],
  },
  {
    id: "command",
    text: "この agent が走らせられる command は、あなたが前もって登録した物だけです（agent は名前しか選べず、毎回あなたの承認が要ります）。起こせる app（GUI）も、あなたが前もって登録した物だけで、毎回あなたの承認が要ります（起動を許した間だけ、その窓の中の click と文字入力はまとめて 1 回の承認になります。「削除」「送信」などの語と Enter は毎回聞きます）。ただし、登録した folder の中の file（Makefile など）を書き換えた人は、その command で何でも走らせられます",
    guard: [{ file: "src/lease.ts", has: "overlaps(x.cwd, ctx.workDir)" }, { file: "src/cmds.ts", has: "...minimalEnv(), HOME: tmp, TMPDIR: tmp" }, { test: "test/w31a.test.ts", name: "AC-1 承認なしに起こさない: 答えが来ない間は 0 件・断り / 時間切れで 0 件・許しても「この頼みの間」の card は無い（毎回 danger）" }, { test: "test/w31a.test.ts", name: "AC-2 名前しか選べない・種類を取り違えない: 未登録 / command の名前を launch で / app の名前を run で は断る（起こさない・走らせない）" }, { test: "test/w31a.test.ts", name: "AC-5 sandbox の下で起こる: cwd には書け、cwd の外（home の下の別 folder・/private/tmp）には書けない・通信できない" }, { test: "test/w31a.test.ts", name: "W32 起動を許した turn の間だけ、その app の窓への click（押す先が分からない）はまとめて許す・送信 / Enter / 他の面は従来どおり聞く・turn の終わりで戻る" }, { test: "test/w17a.test.ts", name: "AC-1 承認なしに走らない: 答えが来ない間は 0 件・断り / 時間切れで 0 件・「この頼みの間」と答えても次の呼びで再び聞く（表が「許す」でも）" }, { test: "test/w17a.test.ts", name: "AC-2 名前しか選べない: 登録の無い名前・名前に混ぜた文字は走らない・登録の argv は shell を通らず文字のまま渡る・CLI は引数を足せない" }, { test: "test/w17a.test.ts", name: "AC-4 印: 登録の argv を書き換えると走らない" }, { test: "test/w17a.test.ts", name: "AC-5 場所が agent の作業場所・uiHome の中なら走らない（symlink 越しも）。card も出ない" }],
  },
  {
    id: "permission",
    text: "要る許可: ブラウザの拡張（tab を操作）・アクセシビリティ（別のデスクトップの窓を読む）・画面収録（窓の絵を見せる）。無ければ、その分だけ使えません",
    guard: [{ file: "src/first-run.ts", has: "ブラウザの拡張が入っていません" }, { file: "src/first-run.ts", has: "別の Space の窓を読む許可" }, { file: "src/peek.ts", has: "システム設定の「画面収録」で許可されていない" }, { test: "test/w7a.test.ts", name: "拡張が無い → install.sh の 1 行・拡張が無くても話せる" }, { test: "test/w7a.test.ts", name: "許可が無い → 読み取り .app の名前を出す。読み取り .app が無い(null)時は言わない" }, { test: "test/w8e.test.ts", name: "撮れない道は絵なしで理由 1 行（cua-driver 無し・許可なしで画像が返らない・裏の tab）" }],
  },
  {
    id: "stop",
    text: "止めるには、画面の一番上の「全部止める」を押します（agent に渡している物がある時に出ます）。全部の窓・tab が、すぐあなたに戻ります",
    guard: [{ file: "extension/panel.js", has: "全部止める" }, { file: "src/main.ts", has: 'case "stopAll"' }, { file: "src/lease.ts", has: "stopAll:" }, { test: "test/w14.test.ts", name: "stopAll: 3 つの面を一度に取り戻す・資源待ち（menu の順番）と承認待ちも消えて、後から何も実行されない" }, { test: "test/w14.test.ts", name: "panel: 「全部止める」は bar を開いた一番上（#app の最初の子）にあり、行の中（#approve の末尾）には無い" }, { test: "test/lease.test.ts", name: "W4a AC-2/F2: 全停止は承認待ちの操作も実行せず、以後の操作は gen で拒否される" }],
  },
];
