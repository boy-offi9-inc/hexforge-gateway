/**
 * Terminal styling primitives for the `hf` CLI: colors, glyphs, boxes,
 * cards, word-wrapping, a small markdown renderer. Everything here is a
 * pure function of its inputs - no I/O, no global state, no reading
 * process.env - so the whole layer is unit-testable without a terminal
 * (tests/cli-ui.test.ts). cli.mjs decides *what* the terminal can do
 * (detectCaps) and passes the answer in through createTheme().
 *
 * Designed for a phone first: Termux is ~45-60 columns wide, so nothing
 * here assumes a wide screen. Lists are cards (a title line plus indented
 * detail lines) rather than multi-column tables, because cards stay
 * readable at any width while a table has to be cut off or wrap into
 * soup. Truncation and wrapping measure *visible* width - ANSI codes
 * count for nothing, CJK and emoji count for two - so a styled or
 * non-Latin string doesn't throw a box border out of line.
 */

// --- measuring ------------------------------------------------------------

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const RESET = "\x1b[0m";

export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, "");
}

/** Terminal cell width of one code point: 0 for combining/zero-width, 2 for East Asian wide + emoji, else 1. */
export function charWidth(cp) {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0xfe0f
  )
    return 0;
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

export function visibleWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

/** Splits a string into ANSI escape sequences and single visible characters, in order. */
function tokenize(s) {
  const out = [];
  let last = 0;
  const str = String(s);
  for (const m of str.matchAll(ANSI_RE)) {
    for (const ch of str.slice(last, m.index))
      out.push({
        ansi: false,
        s: ch,
      });
    out.push({
      ansi: true,
      s: m[0],
    });
    last = m.index + m[0].length;
  }
  for (const ch of str.slice(last))
    out.push({
      ansi: false,
      s: ch,
    });
  return out;
}

/** Cuts to at most `max` visible cells, ending with `ell` when it had to cut. ANSI sequences pass through untouched. */
export function truncate(s, max, ell = "…") {
  if (visibleWidth(s) <= max) return String(s);
  const budget = Math.max(0, max - visibleWidth(ell));
  let w = 0;
  let out = "";
  let sawAnsi = false;
  for (const tok of tokenize(s)) {
    if (tok.ansi) {
      out += tok.s;
      sawAnsi = true;
      continue;
    }
    const cw = charWidth(tok.s.codePointAt(0));
    if (w + cw > budget) break;
    out += tok.s;
    w += cw;
  }
  return out + (sawAnsi ? RESET : "") + ell;
}

/** Like truncate, but keeps the *end* - the useful part of a long path. Plain strings only. */
export function truncateStart(s, max, ell = "…") {
  const chars = [...String(s)];
  if (chars.length <= max) return String(s);
  return (
    ell +
    chars.slice(chars.length - Math.max(0, max - [...ell].length)).join("")
  );
}

export function padEnd(s, width) {
  return s + " ".repeat(Math.max(0, width - visibleWidth(s)));
}

// --- ANSI-aware word wrapping ---------------------------------------------

// Tracks which styles are "open" so a wrapped line can close them at its
// end and reopen them at the start of the next - otherwise a bold span
// that wraps leaves the rest of the screen bold.
function applySgr(state, seq) {
  const codes = seq.slice(2, -1).split(";");
  if (seq.at(-1) !== "m") return;
  if (codes.length === 1 && (codes[0] === "" || codes[0] === "0")) {
    state.clear();
    return;
  }
  const c = codes[0];
  if (c === "1") state.set("bold", seq);
  else if (c === "22") state.delete("bold");
  else if (c === "3") state.set("italic", seq);
  else if (c === "23") state.delete("italic");
  else if (c === "4") state.set("underline", seq);
  else if (c === "24") state.delete("underline");
  else if (c === "39") state.delete("fg");
  else if (
    c === "38" ||
    (Number(c) >= 30 && Number(c) <= 37) ||
    (Number(c) >= 90 && Number(c) <= 97)
  )
    state.set("fg", seq);
}

function activeCodes(state) {
  return [...state.values()].join("");
}

/**
 * Wraps `text` to `width` visible cells. `indent` prefixes the first line,
 * `hang` every later one. Words longer than a whole line are hard-broken.
 * Returns an array of lines, each self-contained (styles closed at the end
 * and reopened on the next line).
 */
export function wrapAnsi(text, width, { indent = "", hang = indent } = {}) {
  const words = String(text)
    .split(/ +/)
    .filter((w) => w.length > 0);
  const lines = [];
  const state = new Map();
  let line = indent;
  let lineW = visibleWidth(indent);
  let lineHasWord = false;

  const flush = () => {
    lines.push(line + (state.size ? RESET : ""));
  };
  const startLine = () => {
    line = hang + activeCodes(state);
    lineW = visibleWidth(hang);
    lineHasWord = false;
  };
  const track = (word) => {
    for (const m of word.matchAll(ANSI_RE)) applySgr(state, m[0]);
  };

  for (const word of words) {
    const ww = visibleWidth(word);
    const room = width - lineW - (lineHasWord ? 1 : 0);
    if (ww <= room) {
      line += (lineHasWord ? " " : "") + word;
      lineW += (lineHasWord ? 1 : 0) + ww;
      lineHasWord = true;
      track(word);
      continue;
    }
    if (lineHasWord) {
      flush();
      startLine();
    }
    if (ww <= width - lineW) {
      line += word;
      lineW += ww;
      lineHasWord = true;
      track(word);
      continue;
    }
    // Longer than a full line: break it character by character.
    for (const tok of tokenize(word)) {
      if (tok.ansi) {
        line += tok.s;
        applySgr(state, tok.s);
        continue;
      }
      const cw = charWidth(tok.s.codePointAt(0));
      if (lineW + cw > width) {
        flush();
        startLine();
      }
      line += tok.s;
      lineW += cw;
      lineHasWord = true;
    }
  }
  if (lineHasWord || lines.length === 0) flush();
  return lines;
}

// --- relative time --------------------------------------------------------

export function relativeTime(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function formatDuration(ms) {
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// --- theme ----------------------------------------------------------------

const UNICODE = {
  hex: "⬢",
  ok: "✔",
  err: "✖",
  dot: "●",
  ring: "○",
  queued: "◌",
  run: "◐",
  arrow: "›",
  prompt: "❯",
  bullet: "•",
  ellipsis: "…",
  dash: "─",
  vbar: "│",
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  warn: "▲",
  right: "→",
  sep: "·",
  spin: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};
const ASCII = {
  hex: "*",
  ok: "+",
  err: "x",
  dot: "*",
  ring: "o",
  queued: "o",
  run: "~",
  arrow: ">",
  prompt: ">",
  bullet: "-",
  ellipsis: "...",
  dash: "-",
  vbar: "|",
  tl: "+",
  tr: "+",
  bl: "+",
  br: "+",
  warn: "!",
  right: "->",
  sep: "-",
  spin: ["-", "\\", "|", "/"],
};

// Brand palette: ember amber as the accent (a forge, not a terminal-green
// hacker cliche), with the usual semantic colors. [r, g, b, 256-color, 16-color]
const PALETTE = {
  accent: [255, 167, 38, 214, 33],
  ok: [74, 222, 128, 78, 32],
  err: [248, 113, 113, 203, 31],
  warn: [251, 191, 36, 220, 33],
  info: [56, 189, 248, 75, 36],
  mute: [139, 148, 158, 245, 90],
};

/**
 * @param {{ color?: boolean, depth?: number, unicode?: boolean, columns?: number }} caps
 * depth is the terminal's color depth in bits: 24 truecolor, 8 = 256 colors, 4 = 16 colors.
 */
export function createTheme({
  color = false,
  depth = 8,
  unicode = true,
  columns = 80,
} = {}) {
  const g = unicode ? UNICODE : ASCII;
  const width = Math.max(24, Math.min(100, columns));

  const fg = ([r, gr, b, c256, c16]) =>
    depth >= 24
      ? `\x1b[38;2;${r};${gr};${b}m`
      : depth >= 8
        ? `\x1b[38;5;${c256}m`
        : `\x1b[${c16}m`;
  const styler = (open, close) => (s) =>
    color ? `${open}${s}${close}` : String(s);
  const paint = (name) => styler(fg(PALETTE[name]), "\x1b[39m");

  const t = {
    color,
    unicode,
    width,
    g,
    accent: paint("accent"),
    ok: paint("ok"),
    err: paint("err"),
    warn: paint("warn"),
    info: paint("info"),
    mute: paint("mute"),
    bold: styler("\x1b[1m", "\x1b[22m"),
    italic: styler("\x1b[3m", "\x1b[23m"),
    underline: styler("\x1b[4m", "\x1b[24m"),
  };

  t.spinFrame = (i) => g.spin[i % g.spin.length];
  /** truncate()/truncateStart() with the theme's ellipsis, so ASCII mode never emits a non-ASCII "...". */
  t.truncate = (str, max) => truncate(str, max, g.ellipsis);
  t.truncateStart = (str, max) => truncateStart(str, max, g.ellipsis);

  /** Colored icon for a job/workflow/workspace/step status. `frame` animates the running states. */
  t.icon = (status, frame = 0) => {
    switch (status) {
      case "completed":
        return t.ok(g.ok);
      case "ready":
        return t.ok(g.dot);
      case "failed":
      case "error":
        return t.err(g.err);
      case "running":
        return t.accent(frame ? t.spinFrame(frame) : g.run);
      case "analyzing":
        return t.warn(frame ? t.spinFrame(frame) : g.run);
      case "created":
        return t.mute(g.ring);
      case "queued":
      case "pending":
        return t.mute(g.queued);
      default:
        return t.mute(g.bullet);
    }
  };

  t.statusText = (status) => {
    const word = status ?? "unknown";
    switch (status) {
      case "completed":
      case "ready":
        return t.ok(word);
      case "failed":
      case "error":
        return t.err(word);
      case "running":
        return t.accent(word);
      case "analyzing":
        return t.warn(word);
      default:
        return t.mute(word);
    }
  };

  /** A rounded box. Lines are truncated, not wrapped, so every row is exactly `width` cells. */
  t.box = (lines, { title = "", border = t.mute } = {}) => {
    const inner = width - 4;
    const out = [];
    // A title wider than the box would push the top border past the terminal.
    const shownTitle = title ? t.truncate(title, width - 6) : "";
    const tw = visibleWidth(shownTitle);
    if (title) {
      out.push(
        border(g.tl + g.dash + " ") +
          shownTitle +
          border(" " + g.dash.repeat(Math.max(1, width - tw - 5)) + g.tr),
      );
    } else {
      out.push(border(g.tl + g.dash.repeat(width - 2) + g.tr));
    }
    for (const raw of lines) {
      const line = t.truncate(raw, inner);
      out.push(
        border(g.vbar) + " " + padEnd(line, inner) + " " + border(g.vbar),
      );
    }
    out.push(border(g.bl + g.dash.repeat(width - 2) + g.br));
    return out;
  };

  /**
   * A result card: one title line (icon, title, optional right-aligned text),
   * then indented `key  value` rows and an optional hint. Values with spaces
   * wrap under their key; long unbroken values (paths, ids) keep their tail.
   */
  t.card = ({
    icon,
    title,
    right = "",
    rows = [],
    hint = "",
    indent = 3,
  } = {}) => {
    const out = [];
    const lead = ` ${icon ?? " "} `;
    const leadW = 3;
    const rightW = visibleWidth(right);
    const room = width - leadW - (rightW ? rightW + 2 : 0);
    const head = t.truncate(title ?? "", Math.max(8, room));
    const gap = rightW
      ? Math.max(1, width - leadW - visibleWidth(head) - rightW)
      : 0;
    out.push(lead + head + " ".repeat(gap) + right);

    const keyW = rows.reduce((m, [k]) => Math.max(m, visibleWidth(k)), 0);
    const pad = " ".repeat(indent);
    for (const [k, v] of rows) {
      const key = t.mute(padEnd(k, keyW));
      const valueRoom = width - indent - keyW - 2;
      const text = String(v ?? "");
      if (!/\s/.test(text.trim())) {
        out.push(pad + key + "  " + t.truncateStart(text, valueRoom));
      } else {
        const hang = pad + " ".repeat(keyW + 2);
        const wrapped = wrapAnsi(text.replace(/\s*\n\s*/g, " "), width, {
          indent: pad + key + "  ",
          hang,
        });
        out.push(...wrapped);
      }
    }
    if (hint) out.push(...t.hint(hint, indent));
    return out;
  };

  /** A muted "→ ..." follow-up line, wrapped to the terminal with a hanging indent so a long command never overflows. */
  t.hint = (text, indent = 3) =>
    wrapAnsi(t.mute(String(text)), width, {
      indent: " ".repeat(indent) + t.mute(g.right) + " ",
      hang: " ".repeat(indent + visibleWidth(g.right) + 1),
    });

  /**
   * Command-style rows: `usage  description`. Columnar when there's room for
   * the description beside the longest usage in the group, otherwise the
   * description wraps on its own lines under the usage - a truncated
   * description ("get-or-create a workspace an...") is worse than a taller list.
   */
  t.definitions = (items, { color = t.accent, indent = 2 } = {}) => {
    const out = [];
    const lead = " ".repeat(indent);
    const pad = Math.max(...items.map(([u]) => visibleWidth(u))) + 2;
    const room = width - indent - pad;
    for (const [usage, desc] of items) {
      if (room >= 24) {
        out.push(
          ...wrapAnsi(t.mute(desc), width, {
            indent: lead + color(padEnd(usage, pad)),
            hang: lead + " ".repeat(pad),
          }),
        );
      } else {
        out.push(
          lead + color(usage),
          ...wrapAnsi(t.mute(desc), width, {
            indent: lead + "  ",
            hang: lead + "  ",
          }),
        );
      }
    }
    return out;
  };

  t.errorBlock = (title, detail = "", hint = "") => {
    const out = wrapAnsi(t.bold(title), width, {
      indent: ` ${t.err(g.err)} `,
      hang: "   ",
    });
    if (detail)
      out.push(
        ...wrapAnsi(detail, width, {
          indent: "   ",
          hang: "   ",
        }),
      );
    if (hint) out.push(...t.hint(hint, 3));
    return out;
  };

  t.rule = (label = "") => {
    const w = width;
    if (!label) return t.mute(g.dash.repeat(w));
    return (
      t.mute(g.dash.repeat(2) + " ") +
      t.bold(label) +
      t.mute(" " + g.dash.repeat(Math.max(1, w - visibleWidth(label) - 4)))
    );
  };

  t.markdown = (src, opts = {}) => renderMarkdown(src, t, opts);
  return t;
}

// --- markdown-lite --------------------------------------------------------

/**
 * Renders the markdown an LLM actually produces (fences, headings, lists,
 * quotes, **bold**, `code`, links) as styled, width-aware terminal text.
 * Not a full CommonMark implementation on purpose: each source line is
 * wrapped on its own so a model's deliberate line breaks survive, and
 * *italics* are left alone because a lone asterisk or snake_case_name is
 * far more common in this tool's output than real emphasis.
 */
export function renderMarkdown(src, t, { indent = "  " } = {}) {
  const width = t.width;
  const out = [];
  let inFence = false;
  let blank = true; // collapse runs of blank lines, and don't open with one

  const inline = (text) =>
    String(text)
      .split("`")
      .map((seg, i) =>
        i % 2 === 1
          ? t.info(seg)
          : seg
              .replace(/\*\*([^*\n]+)\*\*/g, (_, x) => t.bold(x))
              .replace(/__([^_\n]+)__/g, (_, x) => t.bold(x))
              .replace(
                /\[([^\]\n]+)\]\((https?:[^)\s]+)\)/g,
                (_, label, url) => `${label} ${t.mute("(" + url + ")")}`,
              ),
      )
      .join("");

  const push = (lines) => {
    out.push(...lines);
    blank = false;
  };

  for (const raw of String(src).replace(/\r\n/g, "\n").split("\n")) {
    const fence = raw.match(/^\s*```(.*)$/);
    if (fence) {
      inFence = !inFence;
      if (inFence && fence[1].trim())
        push([indent + t.mute(t.g.vbar + " " + fence[1].trim())]);
      if (!inFence) {
        // Closing fence: a blank line, so a code block never runs straight
        // into the next block (a blockquote shares the same gutter glyph).
        out.push("");
        blank = true;
      }
      continue;
    }
    if (inFence) {
      const room = width - indent.length - 2;
      const chunks = [...raw.replace(/\t/g, "  ")];
      if (chunks.length === 0) push([indent + t.mute(t.g.vbar)]);
      for (let i = 0; i < chunks.length; i += room) {
        push([
          indent +
            t.mute(t.g.vbar + " ") +
            t.info(chunks.slice(i, i + room).join("")),
        ]);
      }
      continue;
    }

    if (raw.trim() === "") {
      if (!blank) out.push("");
      blank = true;
      continue;
    }

    let m;
    if ((m = raw.match(/^(#{1,6})\s+(.*)$/))) {
      const text = inline(m[2]);
      push(
        wrapAnsi(
          m[1].length <= 2 ? t.bold(t.accent(stripAnsi(text))) : t.bold(text),
          width,
          {
            indent,
            hang: indent,
          },
        ),
      );
    } else if (/^\s*([-*_])\1{2,}\s*$/.test(raw)) {
      push([
        indent + t.mute(t.g.dash.repeat(Math.min(24, width - indent.length))),
      ]);
    } else if ((m = raw.match(/^>\s?(.*)$/))) {
      push(
        wrapAnsi(t.mute(stripAnsi(inline(m[1]))), width, {
          indent: indent + t.mute(t.g.vbar) + " ",
          hang: indent + t.mute(t.g.vbar) + " ",
        }),
      );
    } else if ((m = raw.match(/^(\s*)([-*+])\s+(.*)$/))) {
      const nest = " ".repeat(Math.floor(m[1].length / 2) * 2);
      const marker = t.accent(t.g.bullet) + " ";
      push(
        wrapAnsi(inline(m[3]), width, {
          indent: indent + nest + marker,
          hang: indent + nest + "  ",
        }),
      );
    } else if ((m = raw.match(/^(\s*)(\d+[.)])\s+(.*)$/))) {
      const nest = " ".repeat(Math.floor(m[1].length / 2) * 2);
      const marker = t.accent(m[2]) + " ";
      push(
        wrapAnsi(inline(m[3]), width, {
          indent: indent + nest + marker,
          hang: indent + nest + " ".repeat(m[2].length + 1),
        }),
      );
    } else if (raw.trimStart().startsWith("|")) {
      push([indent + t.truncate(raw.trim(), width - indent.length)]);
    } else {
      push(
        wrapAnsi(inline(raw.trim()), width, {
          indent,
          hang: indent,
        }),
      );
    }
  }
  while (out.length && out.at(-1) === "") out.pop();
  return out.join("\n");
}

// --- capabilities ----------------------------------------------------------

/**
 * Works out what the terminal can do, from the environment and the two
 * output streams. Kept separate from createTheme() (which is told the answer)
 * so the rules - NO_COLOR, FORCE_COLOR, TERM=dumb, non-UTF-8 locales - are
 * testable with plain objects instead of a real TTY.
 */
export function detectCaps({
  env = {},
  stdout = {},
  stderr = {},
  flags = {},
} = {}) {
  const outTty = Boolean(stdout.isTTY);
  const errTty = Boolean(stderr.isTTY);
  const dumb = env.TERM === "dumb";

  const forced = env.FORCE_COLOR && env.FORCE_COLOR !== "0";
  const noColor =
    "NO_COLOR" in env && env.NO_COLOR !== "" ? true : Boolean(flags.noColor);
  const color = !noColor && !dumb && (forced || outTty);

  let depth = 4;
  if (typeof stdout.getColorDepth === "function")
    depth = stdout.getColorDepth();
  else if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) depth = 24;
  else if (/256/.test(env.TERM ?? "")) depth = 8;

  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  const nonUtf8Locale =
    locale !== "" && !/utf-?8/i.test(locale) && locale !== "C.UTF-8";
  const unicode =
    !flags.ascii &&
    !env.HF_ASCII &&
    !dumb &&
    env.TERM !== "linux" &&
    !nonUtf8Locale;

  const plain = Boolean(flags.plain || flags.json || env.HF_PLAIN);
  const pretty = outTty && !plain && !dumb;

  return {
    pretty,
    color,
    depth,
    unicode,
    columns: stdout.columns || Number(env.COLUMNS) || 80,
    /** Whether transient output (spinners, live redraws) is safe: only on a real, interactive stderr. */
    live: pretty && errTty,
  };
}
