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
# ERA_WT_SUFFIX (9/17): a multi-repo feature keeps sibling worktrees
# (<repo>--wt-<slug>); when set and that directory exists, source the
# sibling from there, else from the main checkout as before. Per repo — a
# feature that only branches era-core still gets master's pencil and board.
sib() { local d="$ROOT/$1${ERA_WT_SUFFIX:-}"; [ -d "$d" ] && echo "$d" || echo "$ROOT/$1"; }
# only the DIRECTORY NAME is taken: the links below stay relative to public/
# (../../<sibling>/…), because an absolute link works on this box and breaks
# the day the workspace moves or a payload is built from a copy.
CORE="$(basename "$(sib era-core)")"
WORDS="$(basename "$(sib era-making-words)")"
PENCIL="$(basename "$(sib era-pencil)")"
BOARD="$(basename "$(sib era-board)")"
cd "$HUB/public"

ln -sfn "../../$CORE/lib" lib
ln -sf "../../$CORE/dwell.js" dwell.js
ln -sf "../../$CORE/speech.js" speech.js
ln -sf "../../$WORDS/app/index.html" index.html
ln -sf "../../$WORDS/app/studio.js" studio.js
ln -sfn "../../$PENCIL/app" pencil
ln -sfn "../../$BOARD/app" board

mkdir -p "$DATA/content"
for f in lessons.json sentences.json runway.json; do
  [ -e "$DATA/content/$f" ] && ln -sf "$DATA/content/$f" "$f"
done
echo "assembled: $(ls | tr '\n' ' ')"
