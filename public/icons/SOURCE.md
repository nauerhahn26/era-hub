# App icons — where they came from

- `making-words`, `pencil`, `board`, `reader`, `eragaze`: Ellie's original i13 `.ico` files (dad 9/3), with `.png` twins for the home tiles.
- `music`, `movies`: drawn to match (9/3).
- `drawing`: drawn by `tools/drawing-icon.mjs` (9/30).
- `this-week` (spec 2026-10-12 §1): Microsoft Fluent Emoji "Calendar", 3D style, MIT
  (license text: `public/drawing/stickers/LICENSE`, same repo and commit).
  - source: https://raw.githubusercontent.com/microsoft/fluentui-emoji/1ffb34c752ecf5d402f04cfb4b392c77f57c54bc/assets/Calendar/3D/calendar_3d.png
  - sha256: `7c377466753d5c5062e60edec0258ac78c512df423add89b2dd359035592d8ef` (256×256; `this-week.png` is these bytes unchanged)
  - `this-week.ico`: PNG entries 256/48/32/16 — the 256 is the source bytes, the others resized with sharp
    (from `~/new-era/node_modules`, tool time only), packed the way `tools/drawing-icon.mjs` packs its ICO.
