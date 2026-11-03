#!/bin/sh
# W64 probe（書くだけ・まだ走らせていない）。CEO の携帯が要る。
# 注意: これは「この Mac で今動いている adb server」に当たる。走らせる前に operator（ai-browser-dd）へ 1 行。
# 使い方: HOSTPORT=192.168.x.x:NNNNN CODE=123456 sh tools/adb-pair-probe.sh   （または CODE を stdin から: HOSTPORT=… sh tools/adb-pair-probe.sh < 番号の file）
# 番号は引数に書かない（ps に出る）。HOSTPORT と番号は携帯の「ワイヤレスデバッグ → ペア設定コードでデバイスをペア設定」に出る物。
set -eu
: "${HOSTPORT:?HOSTPORT=<携帯の IP:port（ペア設定の画面に出る物）> を付けてください}"
case "$HOSTPORT" in *[!0-9.:]*|"") echo "HOSTPORT の形が違います（例 192.168.1.23:37099）" >&2; exit 64;; esac
if [ -z "${CODE:-}" ]; then IFS= read -r CODE || true; fi
case "${CODE:-}" in [0-9][0-9][0-9][0-9][0-9][0-9]) ;; *) echo "番号は 6 桁です" >&2; exit 64;; esac
printf '%s\n' "$CODE" | adb pair "$HOSTPORT"
adb devices -l
