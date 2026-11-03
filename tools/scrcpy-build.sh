#!/bin/sh
# W64 / SPEC-press §6: scrcpy を sudo なしで build する（UC-D の準備）。使い方: sh tools/scrcpy-build.sh <dir>
# <dir>/scrcpy に取り、<dir>/scrcpy/build-auto/app/scrcpy まで作る。2 回目は飛ばす（冪等）。ninja install はしない（./run build-auto で動かす）。
# SCRCPY_BUILD_DRY=1: command を打たず「+ <command>」を出すだけ（試験用）。brew の install は人（Homebrew が無ければ理由を言って exit 2）。
set -eu

VER=v5.0.1
SERVER_SHA256=764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536 # scrcpy repo の install_release.sh の pin（確認日 2026-10-14）
SERVER_URL="https://github.com/Genymobile/scrcpy/releases/download/$VER/scrcpy-server-$VER"

[ "$#" -eq 1 ] && [ -d "$1" ] || { echo "使い方: sh scrcpy-build.sh <作業フォルダ（在る folder）>" >&2; exit 64; }
DIR=$(cd "$1" && pwd)
SRC="$DIR/scrcpy"
BIN="$SRC/build-auto/app/scrcpy"

if [ -x "$BIN" ]; then echo "済: $BIN（作り直しません）"; exit 0; fi

run() { if [ "${SCRCPY_BUILD_DRY:-}" = 1 ]; then echo "+ $*"; else "$@"; fi; }

command -v brew >/dev/null 2>&1 || { echo "Homebrew が見つかりません。先に Homebrew を入れてください（https://brew.sh ・この script は入れません）" >&2; exit 2; }

[ -d "$SRC/.git" ] || run git clone --depth 1 --branch "$VER" https://github.com/Genymobile/scrcpy "$SRC"
run brew install sdl3 ffmpeg libusb pkg-config meson ninja

# 公式の prebuilt server。pin の sha256 と一致した時だけ使う（違えば消して止まる）
TMPSRV="$DIR/.scrcpy-server.part"
run curl -fL -o "$TMPSRV" "$SERVER_URL"
if [ "${SCRCPY_BUILD_DRY:-}" = 1 ]; then
  echo "+ shasum -a 256 $TMPSRV  (= $SERVER_SHA256)"
else
  GOT=$(shasum -a 256 "$TMPSRV" | cut -d' ' -f1)
  if [ "$GOT" != "$SERVER_SHA256" ]; then rm -f "$TMPSRV"; echo "scrcpy-server の sha256 が pin と違います。使いません（取り直すか、pin を見直してください）" >&2; exit 3; fi
fi
run mv "$TMPSRV" "$DIR/scrcpy-server"

run meson setup "$SRC/build-auto" "$SRC" --buildtype=release --strip -Db_lto=true "-Dprebuilt_server=$DIR/scrcpy-server"
run ninja -C "$SRC/build-auto"

echo "できました。動かすには: cd $SRC && ./run build-auto"
