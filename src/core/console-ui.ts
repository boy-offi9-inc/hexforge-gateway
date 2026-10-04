/**
 * How the Gateway process itself talks to the terminal it was started in:
 * the startup banner, one-line request logs, and styled startup notices -
 * the server-side counterpart of the `hf` CLI's look (scripts/hf/ui.mjs).
 *
 * That file can't be shared: scripts/ has no build step and src/ compiles,
 * so this is a deliberately small copy of just the parts the server needs
 * (palette, glyphs, a box, truncation). If you change the brand palette or
 * glyphs, change both.
 *
 * Everything is gated on `detectConsoleCaps().pretty`, which is true only
 * when stdout is an interactive terminal (or LOG_FORMAT=pretty). Under
 * systemd, Docker, a pipe, or `LOG_FORMAT=json` nothing here activates and
 * the Gateway logs exactly what it always did - structured JSON from pino
 * plus plain startup lines - because log aggregators want that, and a
 * pretty renderer in the way would only damage it.
 *
 * Depends on Node built-ins only (not config.ts) so nothing imported by
 * config can create a cycle, and so it's testable without a running server.
 */

import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { Writable } from "node:stream";

// --- capabilities ----------------------------------------------------------

export interface ConsoleCaps {
  pretty: boolean;
  color: boolean;
  /** Color depth in bits: 24 truecolor, 8 = 256 colors, 4 = 16 colors. */
  depth: number;
  unicode: boolean;
  columns: number;
}

interface OutLike {
  isTTY?: boolean;
  columns?: number;
  getColorDepth?: () => number;
}

/**
 * LOG_FORMAT: `auto` (default - pretty only on an interactive terminal),
 * `pretty` (force it, e.g. `npm run dev | tee log`), or `json` (never).
 * Read straight from the environment rather than config.ts, for the
 * no-cycles reason above.
 */
export function detectConsoleCaps(env: NodeJS.ProcessEnv = process.env, out: OutLike = process.stdout): ConsoleCaps {
  const tty = Boolean(out.isTTY);
  const dumb = env.TERM === "dumb";
  const format = (env.LOG_FORMAT ?? "auto").toLowerCase();
  const pretty = format === "json" ? false : format === "pretty" ? !dumb : tty && !dumb;

  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== "";
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "" && env.FORCE_COLOR !== "0";
  const color = pretty && !noColor && (tty || forced);

  let depth = 4;
  if (typeof out.getColorDepth === "function") depth = out.getColorDepth();
  else if (/^(truecolor|24bit)$/i.test(env.COLORTERM ?? "")) depth = 24;
  else if (/256/.test(env.TERM ?? "")) depth = 8;

  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  const nonUtf8 = locale !== "" && !/utf-?8/i.test(locale);
  const unicode = !env.HF_ASCII && !dumb && env.TERM !== "linux" && !nonUtf8;

  return { pretty, color, depth, unicode, columns: out.columns || Number(env.COLUMNS) || 80 };
}

// --- theme -----------------------------------------------------------------

const UNICODE = {
  hex: "⬢", ok: "✔", err: "✖", dot: "●", ring: "○", warn: "▲", right: "→", sep: "·", ellipsis: "…",
  dash: "─", vbar: "│", tl: "╭", tr: "╮", bl: "╰", br: "╯",
};
const ASCII: typeof UNICODE = {
  hex: "*", ok: "+", err: "x", dot: "*", ring: "o", warn: "!", right: "->", sep: "-", ellipsis: "...",
  dash: "-", vbar: "|", tl: "+", tr: "+", bl: "+", br: "+",
};

// [r, g, b, 256-color, 16-color] - same brand palette as scripts/hf/ui.mjs.
type Swatch = readonly [number, number, number, number, number];
const PALETTE: Record<"accent" | "ok" | "err" | "warn" | "info" | "mute", Swatch> = {
  accent: [255, 167, 38, 214, 33],
  ok: [74, 222, 128, 78, 32],
  err: [248, 113, 113, 203, 31],
  warn: [251, 191, 36, 220, 33],
  info: [56, 189, 248, 75, 36],
  mute: [139, 148, 158, 245, 90],
};

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

function charWidth(cp: number): number {
  if (cp === 0 || cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f) return 0;
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
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

export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

export interface ConsoleUi {
  caps: ConsoleCaps;
  width: number;
  g: typeof UNICODE;
  accent: (s: string) => string;
  ok: (s: string) => string;
  err: (s: string) => string;
  warn: (s: string) => string;
  info: (s: string) => string;
  mute: (s: string) => string;
  bold: (s: string) => string;
  /** Cuts plain-or-styled text to a visible width, ending with the theme's ellipsis. */
  truncate: (s: string, max: number) => string;
  /** Word-wraps *plain* text (style the result per line) with a hanging indent. */
  wrap: (text: string, width: number, indent?: string, hang?: string) => string[];
  box: (lines: string[], title: string, border?: (s: string) => string) => string[];
}

export function createConsoleUi(caps: ConsoleCaps): ConsoleUi {
  const g = caps.unicode ? UNICODE : ASCII;
  const width = Math.max(24, Math.min(100, caps.columns));

  const fg = ([r, gr, b, c256, c16]: Swatch): string =>
    caps.depth >= 24 ? `\x1b[38;2;${r};${gr};${b}m` : caps.depth >= 8 ? `\x1b[38;5;${c256}m` : `\x1b[${c16}m`;
  const styler = (open: string, close: string) => (s: string): string => (caps.color ? `${open}${s}${close}` : s);
  const paint = (name: keyof typeof PALETTE) => styler(fg(PALETTE[name]), "\x1b[39m");

  const truncate = (s: string, max: number): string => {
    if (visibleWidth(s) <= max) return s;
    const budget = Math.max(0, max - visibleWidth(g.ellipsis));
    let out = "";
    let w = 0;
    let sawAnsi = false;
    let last = 0;
    const take = (text: string): boolean => {
      for (const ch of text) {
        const cw = charWidth(ch.codePointAt(0) ?? 0);
        if (w + cw > budget) return false;
        out += ch;
        w += cw;
      }
      return true;
    };
    for (const m of s.matchAll(ANSI_RE)) {
      if (!take(s.slice(last, m.index))) return out + (sawAnsi ? "\x1b[0m" : "") + g.ellipsis;
      out += m[0];
      sawAnsi = true;
      last = (m.index ?? 0) + m[0].length;
    }
    take(s.slice(last));
    return out + (sawAnsi ? "\x1b[0m" : "") + g.ellipsis;
  };

  const wrap = (text: string, max: number, indent = "", hang = indent): string[] => {
    const lines: string[] = [];
    let line = indent;
    let lineW = visibleWidth(indent);
    let hasWord = false;
    const newLine = () => {
      lines.push(line);
      line = hang;
      lineW = visibleWidth(hang);
      hasWord = false;
    };
    for (const word of text.split(/\s+/).filter(Boolean)) {
      const ww = visibleWidth(word);
      if (ww <= max - lineW - (hasWord ? 1 : 0)) {
        line += (hasWord ? " " : "") + word;
        lineW += (hasWord ? 1 : 0) + ww;
        hasWord = true;
        continue;
      }
      if (hasWord) newLine();
      if (ww <= max - lineW) {
        line += word;
        lineW += ww;
        hasWord = true;
        continue;
      }
      for (const ch of word) {
        const cw = charWidth(ch.codePointAt(0) ?? 0);
        if (lineW + cw > max) newLine();
        line += ch;
        lineW += cw;
        hasWord = true;
      }
    }
    if (hasWord || lines.length === 0) lines.push(line);
    return lines;
  };

  const mute = paint("mute");
  const box = (lines: string[], title: string, border: (s: string) => string = mute): string[] => {
    const inner = width - 4;
    // A title wider than the box would push the top border past the terminal.
    const shownTitle = truncate(title, width - 6);
    const tw = visibleWidth(shownTitle);
    const out = [border(g.tl + g.dash + " ") + shownTitle + border(" " + g.dash.repeat(Math.max(1, width - tw - 5)) + g.tr)];
    for (const raw of lines) {
      const line = truncate(raw, inner);
      out.push(border(g.vbar) + " " + line + " ".repeat(Math.max(0, inner - visibleWidth(line))) + " " + border(g.vbar));
    }
    out.push(border(g.bl + g.dash.repeat(width - 2) + g.br));
    return out;
  };

  return {
    caps, width, g,
    accent: paint("accent"), ok: paint("ok"), err: paint("err"), warn: paint("warn"), info: paint("info"), mute,
    bold: styler("\x1b[1m", "\x1b[22m"),
    truncate, wrap, box,
  };
}

/** Wraps plain `text` after a styled `lead` (an icon, a tag), with continuation lines hanging under the text. */
function leadWrap(u: ConsoleUi, lead: string, text: string): string[] {
  const leadW = visibleWidth(lead);
  const pad = " ".repeat(leadW);
  const [first = "", ...rest] = u.wrap(text, u.width, pad, pad);
  return [lead + first.slice(leadW), ...rest];
}

// --- notices ---------------------------------------------------------------

let sharedUi: ConsoleUi | undefined;
function ui(): ConsoleUi {
  sharedUi ??= createConsoleUi(detectConsoleCaps());
  return sharedUi;
}

export type NoticeLevel = "info" | "warn" | "error";

/**
 * A tagged status line from a subsystem (a plugin, the inbox watcher...).
 * Plain mode prints exactly `[tag] message`, as these call sites always
 * did, so existing logs and anything grepping them are unaffected; pretty
 * mode gives it an icon and wraps it to the terminal.
 */
export function notice(tag: string, level: NoticeLevel, message: string): void {
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  const u = ui();
  if (!u.caps.pretty) {
    sink(`[${tag}] ${message}`);
    return;
  }
  const icon = level === "error" ? u.err(u.g.err) : level === "warn" ? u.warn(u.g.warn) : u.accent(u.g.hex);
  const lead = ` ${icon} ${u.mute(tag)}  `;
  if (visibleWidth(lead) > u.width * 0.45) {
    // A long tag ("plugin:webhook-notifier") beside the message would leave
    // it a sliver of the line and break words mid-token - stack them instead.
    sink([` ${icon} ${u.mute(tag)}`, ...u.wrap(message, u.width, "   ", "   ")].join("\n"));
    return;
  }
  sink(leadWrap(u, lead, message).join("\n"));
}

// --- startup banner --------------------------------------------------------

export interface ListenAddress {
  label: "local" | "network";
  url: string;
}

const isLoopback = (host: string): boolean => host === "127.0.0.1" || host === "localhost" || host === "::1";

/**
 * Every URL the server is reachable on. A wildcard bind (0.0.0.0, the
 * default) is reachable on every interface, which Fastify logs once per
 * address as separate JSON lines - here it's one local URL plus the
 * non-internal IPv4 ones, so you can see which networks can reach it.
 */
export function listenAddresses(
  host: string,
  port: number,
  nets: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): ListenAddress[] {
  if (host !== "0.0.0.0" && host !== "::") {
    return [{ label: isLoopback(host) ? "local" : "network", url: `http://${host}:${port}` }];
  }
  const out: ListenAddress[] = [{ label: "local", url: `http://127.0.0.1:${port}` }];
  for (const addrs of Object.values(nets)) {
    for (const a of addrs ?? []) {
      const family = String(a.family);
      if (!a.internal && (family === "IPv4" || family === "4")) out.push({ label: "network", url: `http://${a.address}:${port}` });
    }
  }
  return out;
}

export interface BannerInfo {
  version: string;
  addresses: ListenAddress[];
  storage: string;
  ai: { provider: string; configured: boolean };
  auth: { enabled: boolean; requested: boolean };
  plugins: { name: string; version?: string }[];
  /** The resolved folder the inbox watcher is polling, or undefined when it's off. */
  inbox?: string;
  workspaces: { name: string }[];
}

export function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "dev";
  } catch {
    return "dev";
  }
}

export function renderBanner(info: BannerInfo, u: ConsoleUi): string[] {
  const LABEL = 11; // wide enough for "workspaces" plus a gap
  const row = (label: string, value: string): string => `${u.mute(label.padEnd(LABEL))}${value}`;
  const rows: string[] = [];

  // The local/network tag is a nicety: on a narrow terminal it's dropped
  // rather than letting the box cut it to "netwo...".
  const valueRoom = u.width - 4 - LABEL;
  const shown = info.addresses.slice(0, 4);
  shown.forEach((a, i) => {
    const tagged = `${a.url} ${u.mute(a.label)}`;
    rows.push(row(i === 0 ? "listening" : "", visibleWidth(tagged) <= valueRoom ? tagged : a.url));
  });
  if (info.addresses.length > shown.length) rows.push(row("", u.mute(`+${info.addresses.length - shown.length} more`)));

  const exposed = info.addresses.some((a) => a.label === "network");
  rows.push(row("storage", info.storage));
  rows.push(row("ai", info.ai.configured ? `${info.ai.provider} ${u.ok(u.g.ok)}` : `${info.ai.provider} ${u.warn("not configured")}`));
  rows.push(row("auth", info.auth.enabled ? u.ok("enabled") : exposed ? u.warn("OPEN") : u.mute("off (localhost only)")));
  const withVersions = info.plugins.map((p) => p.name + (p.version ? ` v${p.version}` : "")).join(", ");
  const namesOnly = info.plugins.map((p) => p.name).join(", ");
  rows.push(row("plugins", info.plugins.length ? (visibleWidth(withVersions) <= valueRoom ? withVersions : namesOnly) : u.mute("none")));
  rows.push(row("inbox", info.inbox ? `watching ${info.inbox}` : u.mute("off (set APK_INBOX_DIR)")));
  const names = info.workspaces.map((w) => w.name);
  rows.push(row("workspaces", names.length ? names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "") : u.mute("none yet")));

  const out = u.box(rows, u.bold(u.accent(`${u.g.hex} HexForge Gateway`)) + u.mute(` v${info.version}`), u.accent);

  const warnings: string[] = [];
  if (info.auth.requested && !info.auth.enabled) {
    warnings.push("AUTH_ENABLED=true but API_KEYS is empty, so auth is NOT active. Set API_KEYS in .env.");
  } else if (!info.auth.enabled && exposed) {
    warnings.push("Auth is off and this port is reachable from your network - anyone on it has full access. Set AUTH_ENABLED=true and API_KEYS in .env.");
  }
  if (!info.ai.configured) warnings.push(`AI provider "${info.ai.provider}" isn't configured, so chat and summarize will return 503. See docs/AI.md.`);
  for (const w of warnings) out.push("", ...leadWrap(u, ` ${u.warn(u.g.warn)} `, w));

  out.push(
    "",
    u.truncate(` ${u.mute("next")}  ${u.accent("hf ws my-project")}  ${u.mute("new workspace")}`, u.width),
    u.truncate(`       ${u.accent("hf")}  ${u.mute("all commands")}`, u.width),
    ""
  );
  return out;
}

// --- pretty request/log stream ---------------------------------------------

interface PinoLine {
  level?: number;
  time?: number;
  msg?: string;
  reqId?: string;
  req?: { method?: string; url?: string };
  res?: { statusCode?: number };
  responseTime?: number;
  err?: { message?: string; stack?: string };
  [key: string]: unknown;
}

const HIDDEN_KEYS = new Set(["level", "time", "pid", "hostname", "msg", "reqId", "req", "res", "responseTime", "err"]);

function clock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return ms < 10 ? `${ms.toFixed(1)}ms` : `${Math.round(ms)}ms`;
}

export function formatRequestLine(u: ConsoleUi, time: number, method: string, url: string, status: number, ms: number): string {
  const showTime = u.width >= 64;
  const lead = showTime ? `${u.mute(clock(time))}  ` : " ";
  const methodCol = (method === "GET" ? u.info : method === "DELETE" ? u.err : u.accent)(method.padEnd(6));
  const statusCol = (status >= 500 ? u.err : status >= 400 ? u.warn : status >= 300 ? u.info : u.ok)(String(status));
  const dur = ms >= 1000 ? u.warn(formatDuration(ms)) : u.mute(formatDuration(ms));
  const tail = `${statusCol}  ${dur}`;
  const room = u.width - visibleWidth(lead) - 7 - visibleWidth(tail) - 2;
  if (room < 8) return `${lead}${methodCol} ${u.truncate(url, Math.max(4, u.width - visibleWidth(lead) - 12))} ${statusCol}`;
  const shownUrl = u.truncate(url, room);
  return `${lead}${methodCol} ${shownUrl}${" ".repeat(Math.max(0, room - visibleWidth(shownUrl)))}  ${tail}`;
}

export interface PrettyLogStream {
  stream: Writable;
  /** Prints the pending "same request x N" summary, if there is one. */
  flush: () => void;
}

/**
 * A pino destination that turns the JSON log lines Fastify emits into a
 * readable, phone-width terminal log. Handed to Fastify as `logger.stream`
 * (only in pretty mode), so every log call in the codebase - including
 * plugins' - goes through here without any of them changing.
 *
 *  - "incoming request" / "request completed" pairs become one line:
 *    `GET /health  200  25ms`.
 *  - A client polling the same endpoint (hf following a job hits GET
 *    /jobs/:id every 700ms) would flood the screen, so identical
 *    consecutive requests within 2s collapse into one line plus a
 *    "same request x N" summary after the burst ends.
 *  - Fastify's per-interface "Server listening at ..." lines are dropped;
 *    the banner lists the addresses once.
 *  - Everything else gets a time, a level badge, and a wrapped message,
 *    with error stacks muted underneath.
 */
export function createPrettyLogStream(
  u: ConsoleUi,
  write: (text: string) => void = (text) => {
    process.stdout.write(text);
  }
): PrettyLogStream {
  let buffer = "";
  const inflight = new Map<string, { method: string; url: string }>();
  let last: { key: string; time: number; extra: number; totalMs: number } | undefined;
  let timer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (last && last.extra > 0) {
      const avg = formatDuration(last.totalMs / last.extra);
      write(`   ${u.mute(`${u.g.right} same request ${u.caps.unicode ? "×" : "x"}${last.extra} (avg ${avg})`)}\n`);
    }
    last = undefined;
  };

  const handle = (line: PinoLine): void => {
    const msg = line.msg ?? "";
    const time = line.time ?? Date.now();

    if (msg === "incoming request" && line.reqId) {
      if (inflight.size > 500) inflight.delete(inflight.keys().next().value as string);
      inflight.set(line.reqId, { method: line.req?.method ?? "?", url: line.req?.url ?? "?" });
      return;
    }

    if (msg === "request completed") {
      const req = (line.reqId ? inflight.get(line.reqId) : undefined) ?? { method: "?", url: "?" };
      if (line.reqId) inflight.delete(line.reqId);
      const status = line.res?.statusCode ?? 0;
      const ms = line.responseTime ?? 0;
      const key = `${req.method} ${req.url} ${status}`;
      if (last && last.key === key && time - last.time < 2000) {
        last.extra += 1;
        last.totalMs += ms;
        last.time = time;
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, 1500);
        timer.unref();
        return;
      }
      flush();
      write(formatRequestLine(u, time, req.method, req.url, status, ms) + "\n");
      last = { key, time, extra: 0, totalMs: 0 };
      return;
    }

    if (msg.startsWith("Server listening at") || msg.startsWith("HexForge Gateway listening on")) return;

    flush();
    const level = line.level ?? 30;
    const badge = level >= 50 ? u.err(`${u.g.err} error`) : level >= 40 ? u.warn(`${u.g.warn} warn `) : u.mute(level <= 20 ? "debug " : "info  ");
    const extras = Object.entries(line)
      .filter(([k]) => !HIDDEN_KEYS.has(k))
      .slice(0, 4)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    const text = [msg, line.err?.message ? `- ${line.err.message}` : "", ...extras].filter(Boolean).join(" ");
    const showTime = u.width >= 64;
    const lead = `${showTime ? u.mute(clock(time)) + "  " : " "}${badge}  `;
    const leadW = visibleWidth(lead);
    write(leadWrap(u, lead, text).join("\n") + "\n");
    if (level >= 50 && line.err?.stack) {
      for (const frame of line.err.stack.split("\n").slice(1, 6)) write(`${" ".repeat(leadW)}${u.mute(u.truncate(frame.trim(), u.width - leadW))}\n`);
    }
  };

  const stream = new Writable({
    write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      buffer += chunk.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (raw.trim() === "") continue;
        try {
          handle(JSON.parse(raw) as PinoLine);
        } catch {
          // Not a pino line (something wrote straight to the stream) - show it as is.
          flush();
          write(raw + "\n");
        }
      }
      callback();
    },
  });

  return { stream, flush };
}
