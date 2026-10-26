// suite-source.mjs: read a suite's source the way the registry tools need it.
// Shared by tests/suite-ports.test.mjs (one fixed listener port per suite) and
// tools/testing/classify-suites.mjs (the registry's per-suite classes), so the
// two can never disagree about which ports a suite claims.
//
// blank(src) blanks comments, regular-expression literals and (unless
// keepStrings) string and template bodies, keeping every newline so line
// numbers survive. claims(src) lists every fixed listener port the source
// claims, in the forms the suites use:
//   const PORT = 8463;                const PORT = 8458, AI_PORT = 8459;
//   const PORT = Number(process.env.ERA_TEST_HUB_PORT) || 8469;
//   const PORT = Number(process.env.ERA_BOARD_ROUTE_PORT || 8390);
//   const PORT2 = PORT + 1;           (resolved within the same file)
//   const A = makeHub("a", 8473);     (a literal port as a call's last argument)
//   FEED2_PORT = 8412;                (a bare assignment)
// A claim is a declaration or assignment whose value is a port literal in
// BAND. Comments, strings and regular expressions are blanked first, so a
// header that documents a neighbour's port is not a claim.

export const BAND = [8300, 8599];               // the house band a claim is read from

// Blank comments and regular-expression literals, and string and template
// bodies unless keepStrings, keeping every newline so line numbers survive.
export function blank(src, { keepStrings = false } = {}) {
  const fill = (s) => s.replace(/[^\n]/g, " ");
  const REGEX_BEFORE = "(,=:[!&|?{};+-*%<>~^";
  let out = "", i = 0, prev = "";
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") {
      const nl = src.indexOf("\n", i), end = nl < 0 ? src.length : nl;
      out += fill(src.slice(i, end)); i = end; continue;
    }
    if (c === "/" && d === "*") {
      const close = src.indexOf("*/", i + 2), end = close < 0 ? src.length : close + 2;
      out += fill(src.slice(i, end)); i = end; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") j++;
        else if (c !== "`" && src[j] === "\n") break;
        j++;
      }
      const end = Math.min(j + 1, src.length), body = src.slice(i + 1, end - 1);
      out += keepStrings ? src.slice(i, end) : c + fill(body) + (end - 1 > i ? src[end - 1] : "");
      prev = c; i = end; continue;
    }
    if (c === "/" && (prev === "" || REGEX_BEFORE.includes(prev) ||
        /\b(?:return|typeof|case|of|in|void|yield|await)$/.test(out.slice(-12).trimEnd()))) {
      let j = i + 1, inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j++;
      }
      if (src[j] === "/") {
        j++;
        while (j < src.length && /[a-z]/i.test(src[j])) j++;
        out += fill(src.slice(i, j)); prev = ")"; i = j; continue;
      }
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

// Every fixed listener port the source claims: [{ port, name, line }].
export function claims(src) {
  const code = blank(src), found = [], named = new Map();
  const END = String.raw`\s*\)?\s*(?=[;,)\]}\n]|$)`;
  const forms = [
    // const PORT = 8463;   PORT = Number(process.env.X) || 8469;   Number(process.env.X || 8390)
    [new RegExp(String.raw`^\s*(?:(?:Number|parseInt)\s*\(\s*)?\+?\s*(?:process\.env\.[\w$]+\s*\)?\s*\|\|\s*)?(\d{4})` + END), (m) => Number(m[1])],
    // const PORT2 = PORT + 1;
    [new RegExp(String.raw`^\s*([A-Za-z_$][\w$]*)\s*\+\s*(\d{1,3})` + END), (m) => named.has(m[1]) ? named.get(m[1]) + Number(m[2]) : null],
    // const A = makeHub("a", 8473);
    [new RegExp(String.raw`^\s*(?:new\s+)?[A-Za-z_$][\w$.]*\s*\((?:[^()\n]*,)?\s*(\d{4})\s*\)\s*(?=[;,)\]}\n]|$)`), (m) => Number(m[1]), "call"],
  ];
  const target = /(?<![\w$])([A-Za-z_$][\w$]*)\s*=(?![=>])/g;
  for (const m of code.matchAll(target)) {
    const rest = code.slice(m.index + m[0].length, m.index + m[0].length + 200);
    for (const [re, value, kind] of forms) {
      const hit = rest.match(re);
      if (!hit) continue;
      const port = value(hit);
      if (port === null || port < BAND[0] || port > BAND[1]) break;
      if (kind !== "call") named.set(m[1], port);
      found.push({ port, name: m[1], line: code.slice(0, m.index).split("\n").length });
      break;
    }
  }
  return found;
}
