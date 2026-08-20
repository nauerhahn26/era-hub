#!/usr/bin/env bash
# assemble.sh — build era-hub's public/ from sibling module repos (dev workspace
# mode; the Windows installer copies instead of symlinking). Layout after:
#   public/lib -> era-core/lib          public/index.html -> era-making-words
#   public/dwell.js, speech.js -> era-core
#   public/pencil -> era-pencil/app     public/board -> era-board/app
#   public/lessons.json etc. -> $DATA/content/*  (family content, never in git)
set -euo pipefail
HUB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(dirname "$HUB")"
DATA="${ERA_DATA_DIR:-$ROOT/era-family/data}"
cd "$HUB/public"

ln -sfn ../../era-core/lib lib
ln -sf ../../era-core/dwell.js dwell.js
ln -sf ../../era-core/speech.js speech.js
ln -sf ../../era-making-words/app/index.html index.html
ln -sf ../../era-making-words/app/studio.js studio.js
ln -sfn ../../era-pencil/app pencil
ln -sfn ../../era-board/app board

mkdir -p "$DATA/content"
for f in lessons.json sentences.json runway.json; do
  [ -e "$DATA/content/$f" ] && ln -sf "$DATA/content/$f" "$f"
done
echo "assembled: $(ls | tr '\n' ' ')"
