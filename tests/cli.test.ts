import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as ui from "../scripts/hf/ui.mjs";
import { createClient, describeErrorBody, GatewayError, readState, saveState } from "../scripts/hf/client.mjs";
import { formatBytes, parseArgs, parsePayload, resultRows, UsageError } from "../scripts/hf/cli.mjs";

// The hf CLI is plain .mjs (not type-checked, no build step), but its pure
// parts are tested here like everything else. What these can't cover - the
// live spinner, in-place workflow redraw, the readline chat REPL, Ctrl+C -
// needs a real terminal; those were exercised by hand against a fake Gateway
// inside a pseudo-terminal (see tests/README.md).

const unicode = ui.createTheme({ color: true, depth: 24, unicode: true, columns: 50 });
const plain = ui.createTheme({ color: false, unicode: true, columns: 50 });
const ascii = ui.createTheme({ color: false, unicode: false, columns: 40 });

const nonAscii = (s) => [...s].some((c) => c.charCodeAt(0) > 127);
const widest = (lines) => Math.max(...lines.map(ui.visibleWidth));

describe("ui: measuring", () => {
  it("ignores ANSI codes and counts CJK as two cells", () => {
    expect(ui.visibleWidth("\x1b[1mhello\x1b[22m")).toBe(5);
    expect(ui.visibleWidth("日本語")).toBe(6);
    expect(ui.visibleWidth("a⬢b")).toBe(3);
  });

  it("truncates to a visible width, keeping ANSI intact and ending with the ellipsis", () => {
    expect(ui.truncate("abcdefghij", 5)).toBe("abcd…");
    expect(ui.visibleWidth(ui.truncate("\x1b[31mabcdefghij\x1b[39m", 6))).toBe(6);
    expect(ui.truncate("short", 20)).toBe("short");
  });

  it("truncateStart keeps the useful tail of a long path", () => {
    expect(ui.truncateStart("/a/very/long/path/to/file", 10)).toBe("…h/to/file");
  });
});

describe("ui: wrapAnsi", () => {
  it("never exceeds the width, and reopens a bold span on each continuation line", () => {
    const wrapped = ui.wrapAnsi("one " + unicode.bold("two three four five six seven eight nine ten eleven twelve") + " end", 20, { indent: "  " });
    for (const line of wrapped) expect(ui.visibleWidth(line)).toBeLessThanOrEqual(20);
    expect(wrapped.length >= 3).toBe(true);
    expect(wrapped[1]).toContain("\x1b[1m");
    expect(wrapped[0].endsWith("\x1b[0m")).toBe(true); // a line never leaves a style open
  });

  it("hard-breaks a word longer than a whole line", () => {
    expect(ui.wrapAnsi("x".repeat(45), 20).map(ui.visibleWidth)).toEqual([20, 20, 5]);
  });

  it("uses the hanging indent on continuation lines", () => {
    const lines = ui.wrapAnsi("alpha beta gamma delta epsilon", 14, { indent: "> ", hang: "  " });
    expect(lines[0].startsWith("> ")).toBe(true);
    expect(lines[1].startsWith("  ")).toBe(true);
  });
});

describe("ui: theme layout", () => {
  it("draws a box whose rows are all exactly the terminal width, even with styled and CJK text", () => {
    const box = unicode.box(["plain", unicode.accent("styled line"), "日本語 mixed"], { title: unicode.bold("Title") });
    expect(new Set(box.map(ui.visibleWidth)).size).toBe(1);
    expect(ui.visibleWidth(box[0])).toBe(50);
  });

  it("truncates a box title that's wider than the terminal instead of overflowing the top border", () => {
    const tiny = ui.createTheme({ color: false, unicode: true, columns: 24 });
    const box = tiny.box(["x"], { title: "a title that is far too long for this box" });
    expect(widest(box)).toBeLessThanOrEqual(24);
    expect(new Set(box.map(ui.visibleWidth)).size).toBe(1);
  });

  it("fits a result card to the width, wraps spaced values under their key, and keeps the tail of long paths", () => {
    const card = plain.card({
      icon: "✔",
      title: "jadx · decompile",
      right: "12.4s",
      rows: [["outputDir", "/data/data/com.termux/files/home/hexforge/workspaces/ws_abc/jadx"], ["note", "this has several words in it so it wraps under its key nicely"]],
      hint: "a long follow-up hint that needs to wrap rather than run off the edge of the screen",
    });
    expect(widest(card)).toBeLessThanOrEqual(50);
    expect(card.join("\n")).toContain("ws_abc/jadx"); // tail of the path survives
    expect(card.length > 5).toBe(true);
  });

  it("works down to a 24-column terminal without overflowing", () => {
    const tiny = ui.createTheme({ color: false, unicode: true, columns: 24 });
    const out = [...tiny.card({ icon: "✔", title: "jadx · decompile", right: "2.9s", rows: [["warnings", "3 methods could not be decompiled"]], hint: "hf job-status --json" }), ...tiny.box(["hello world this is long"], { title: "T" })];
    expect(widest(out)).toBeLessThanOrEqual(24);
  });

  it("emits no color escapes when color is off, but keeps the layout", () => {
    const out = plain.card({ icon: plain.icon("completed"), title: plain.bold("x"), rows: [["k", plain.accent("v")]] }).join("\n");
    expect(/\x1b\[(?:38|[39]\d)[;m]/.test(out)).toBe(false);
    expect(out).toContain("x");
  });

  it("ASCII mode never emits a non-ASCII byte - boxes, cards, truncation, hints, definitions, markdown, errors, every status icon", () => {
    const parts = [
      ...ascii.box(["a fairly long line that must be truncated with an ellipsis"], { title: "T" }),
      ...ascii.card({ icon: ascii.icon("completed"), title: "a very long title that will certainly need truncating here", right: "1s", rows: [["path", "/very/long/unbroken/path/that/needs/its/tail/kept/ok"]], hint: "hf job-status --json" }),
      ...ascii.errorBlock("Something failed", "with some detail text", "try this"),
      ...ascii.definitions([["ws <name>", "get or create a workspace and make it current right now"]]),
      ascii.markdown("# Title\n- a bullet with `code` and **bold**\n1. numbered\n> quote\n```\ncode line\n```\n---\n[docs](https://x.io)"),
      ascii.rule("Section"),
      ascii.truncate("a long string that has to be cut", 10),
      ascii.truncateStart("/a/long/path/to/cut", 8),
      ...["completed", "ready", "failed", "error", "running", "analyzing", "created", "queued", "pending", "weird"].map((s) => ascii.icon(s, 3)),
      ascii.spinFrame(1),
    ];
    for (const part of parts) expect(nonAscii(part)).toBe(false);
  });

  it("renders status icons per status, with a spinner frame for the running states", () => {
    expect(ascii.icon("completed")).toBe("+");
    expect(plain.icon("failed")).toBe("✖");
    expect(plain.icon("running", 1)).not.toBe(plain.icon("running"));
  });
});

describe("ui: markdown", () => {
  const md = plain.markdown("# Title\nSome **bold** and `code` text that is long enough to wrap around the narrow fifty column terminal width.\n\n- item one\n- item two with a very long tail that needs to wrap onto the next line properly\n1. first\n\n```smali\nconst/4 v0, 0x1\n```\n> quoted\n[docs](https://x.io/a)");

  it("never exceeds the terminal width", () => {
    for (const line of md.split("\n")) expect(ui.visibleWidth(line)).toBeLessThanOrEqual(50);
  });

  it("renders bullets, numbering, links, and strips the markdown markers", () => {
    expect(md).toContain("• item one");
    expect(md).toContain("1. first");
    expect(md).toContain("docs (https://x.io/a)");
    expect(md).not.toContain("**");
    expect(md).not.toContain("`");
  });

  it("indents wrapped bullet text under the bullet", () => {
    const lines = md.split("\n");
    const i = lines.findIndex((l) => l.includes("item two"));
    expect(lines[i + 1].startsWith("    ")).toBe(true);
  });

  it("separates a code block from the block after it (they share a gutter glyph)", () => {
    const lines = md.split("\n");
    const quote = lines.findIndex((l) => l.includes("quoted"));
    expect(lines[quote - 1]).toBe("");
  });

  it("keeps a model's single line breaks rather than reflowing them", () => {
    expect(plain.markdown("line one\nline two")).toBe("  line one\n  line two");
  });

  it("leaves lone asterisks and snake_case alone", () => {
    expect(plain.markdown("a * b and snake_case_name")).toContain("a * b and snake_case_name");
  });
});

describe("ui: time and size formatting", () => {
  it("formats relative times", () => {
    const now = Date.parse("2026-10-01T02:00:00Z");
    expect(ui.relativeTime("2026-10-01T00:00:00Z", now)).toBe("2h ago");
    expect(ui.relativeTime("2026-10-01T01:59:58Z", now)).toBe("just now");
    expect(ui.relativeTime("2026-09-28T02:00:00Z", now)).toBe("3d ago");
    expect(ui.relativeTime("not a date", now)).toBe("");
  });

  it("formats durations and byte sizes", () => {
    expect(ui.formatDuration(2500)).toBe("2.5s");
    expect(ui.formatDuration(12400)).toBe("12s");
    expect(ui.formatDuration(75000)).toBe("1m 15s");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(8421376)).toBe("8.0 MB");
  });
});

describe("ui: detectCaps", () => {
  const tty = { isTTY: true, columns: 60, getColorDepth: () => 24 };

  it("is pretty on a TTY, plain when piped", () => {
    expect(ui.detectCaps({ env: {}, stdout: tty, stderr: tty }).pretty).toBe(true);
    expect(ui.detectCaps({ env: {}, stdout: { isTTY: false }, stderr: tty }).pretty).toBe(false);
  });

  it("--json and --plain and HF_PLAIN force plain output even on a TTY", () => {
    expect(ui.detectCaps({ env: {}, stdout: tty, stderr: tty, flags: { json: true } }).pretty).toBe(false);
    expect(ui.detectCaps({ env: {}, stdout: tty, stderr: tty, flags: { plain: true } }).pretty).toBe(false);
    expect(ui.detectCaps({ env: { HF_PLAIN: "1" }, stdout: tty, stderr: tty }).pretty).toBe(false);
  });

  it("NO_COLOR drops color but keeps the pretty layout", () => {
    const caps = ui.detectCaps({ env: { NO_COLOR: "1" }, stdout: tty, stderr: tty });
    expect(caps.color).toBe(false);
    expect(caps.pretty).toBe(true);
  });

  it("FORCE_COLOR turns color on even when piped; TERM=dumb turns everything off", () => {
    expect(ui.detectCaps({ env: { FORCE_COLOR: "1" }, stdout: { isTTY: false }, stderr: {} }).color).toBe(true);
    const dumb = ui.detectCaps({ env: { TERM: "dumb" }, stdout: tty, stderr: tty });
    expect(dumb.pretty).toBe(false);
    expect(dumb.color).toBe(false);
  });

  it("falls back to ASCII for a non-UTF-8 locale, HF_ASCII, --ascii, or TERM=linux", () => {
    expect(ui.detectCaps({ env: { LANG: "en_US.ISO-8859-1" }, stdout: tty, stderr: tty }).unicode).toBe(false);
    expect(ui.detectCaps({ env: { HF_ASCII: "1" }, stdout: tty, stderr: tty }).unicode).toBe(false);
    expect(ui.detectCaps({ env: {}, stdout: tty, stderr: tty, flags: { ascii: true } }).unicode).toBe(false);
    expect(ui.detectCaps({ env: { TERM: "linux" }, stdout: tty, stderr: tty }).unicode).toBe(false);
    expect(ui.detectCaps({ env: { LANG: "en_US.UTF-8" }, stdout: tty, stderr: tty }).unicode).toBe(true);
  });

  it("only allows live (spinner) output on a real interactive stderr", () => {
    expect(ui.detectCaps({ env: {}, stdout: tty, stderr: tty }).live).toBe(true);
    expect(ui.detectCaps({ env: {}, stdout: tty, stderr: { isTTY: false } }).live).toBe(false);
  });
});

describe("cli: arguments", () => {
  it("accepts flags anywhere and leaves the rest as positionals", () => {
    const { flags, positionals } = parseArgs(["job", "jadx", "decompile", "-d", "--attempts", "3", "--json"]);
    expect(positionals).toEqual(["job", "jadx", "decompile"]);
    expect(flags.detach).toBe(true);
    expect(flags.attempts).toBe(3);
    expect(flags.json).toBe(true);
    expect(parseArgs(["job", "--attempts=5"]).flags.attempts).toBe(5);
  });

  it("parses a JSON object payload, or key=value / key:=json pairs", () => {
    expect(parsePayload(['{"apkPath":"/x.apk"}'])).toEqual({ apkPath: "/x.apk" });
    expect(parsePayload(["apkPath=/x.apk", "reinstall:=true", "n:=3", 'list:=["a","b"]'])).toEqual({ apkPath: "/x.apk", reinstall: true, n: 3, list: ["a", "b"] });
    expect(parsePayload([])).toEqual({});
  });

  it("never guesses types: a numeric-looking key=value stays a string", () => {
    expect(parsePayload(["command=123", "flag=true"])).toEqual({ command: "123", flag: "true" });
  });

  it("keeps = inside a value and splits on the first one", () => {
    expect(parsePayload(["command=pm list packages --user=0"])).toEqual({ command: "pm list packages --user=0" });
  });

  it.each([
    ["invalid JSON", ["{bad"]],
    ["a JSON array", ["[1,2]"]],
    ["JSON plus extra pairs", ['{"a":1}', "b=2"]],
    ["a bare word", ["oops"]],
    ["bad := JSON", ["x:={bad"]],
  ])("rejects %s with a UsageError", (_label, args) => {
    let error;
    try {
      parsePayload(args);
    } catch (e) {
      error = e;
    }
    expect(error instanceof UsageError).toBe(true);
  });

  it("summarizes a job result into card rows, hiding stdout/stderr noise and capping at 8 fields", () => {
    const rows = resultRows({ outputDir: "/x", fileCount: 200, files: new Array(200).fill("f"), stdoutTail: "noise", stderrTail: "noise" });
    expect(rows).toEqual([["outputDir", "/x"], ["fileCount", "200"], ["files", "[200 items]"]]);
    const many = resultRows(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i])));
    expect(many).toHaveLength(9);
    expect(many[8]).toEqual(["more", "4 more fields"]);
    expect(resultRows(undefined)).toEqual([["result", "(none)"]]);
  });
});

describe("client: state file", () => {
  let dir;
  let env;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hf-state-"));
    env = { HF_STATE_DIR: dir };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips values and returns {} when there's no file yet", () => {
    expect(readState(env)).toEqual({});
    saveState("WORKSPACE_ID", "ws_abc", env);
    saveState("JOB_ID", "job_1", env);
    expect(readState(env)).toEqual({ WORKSPACE_ID: "ws_abc", JOB_ID: "job_1" });
  });

  it("overwrites one key without disturbing the others, and removes a key when given undefined", () => {
    saveState("A", "1", env);
    saveState("B", "2", env);
    saveState("A", "3", env);
    expect(readState(env)).toEqual({ A: "3", B: "2" });
    saveState("A", undefined, env);
    expect(readState(env)).toEqual({ B: "2" });
  });

  it("preserves lines it doesn't understand, and reads the unquoted form the old bash script could write", async () => {
    await writeFile(path.join(dir, "state.env"), 'WORKSPACE_ID=ws_old\nCUSTOM_THING="keep me"\n');
    saveState("JOB_ID", "j", env);
    expect(readState(env)).toEqual({ WORKSPACE_ID: "ws_old", CUSTOM_THING: "keep me", JOB_ID: "j" });
  });

  it("writes plain KEY=\"value\" lines that bash can source, escaping quotes and dollars", async () => {
    saveState("WORKSPACE_NAME", 'we"ird $name', env);
    const text = await readFile(path.join(dir, "state.env"), "utf8");
    expect(text).toBe('WORKSPACE_NAME="we\\"ird \\$name"\n');
  });
});

describe("client: requests", () => {
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)) });
  const failure = async (promise) => {
    try {
      await promise;
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it("sends the bearer token and a JSON body, and parses the JSON response", async () => {
    let seen;
    const client = createClient({
      baseUrl: "http://gw:8080/",
      apiKey: "secret",
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return res(201, { id: "ws1" });
      },
    });
    expect(await client.post("/workspaces", { name: "x" })).toEqual({ id: "ws1" });
    expect(seen.url).toBe("http://gw:8080/workspaces"); // trailing slash on the base URL doesn't double up
    expect(seen.init.headers.Authorization).toBe("Bearer secret");
    expect(seen.init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(seen.init.body)).toEqual({ name: "x" });
  });

  it("sends no auth header or body when there's nothing to send", async () => {
    let seen;
    const client = createClient({ baseUrl: "http://gw", fetchImpl: async (u, init) => ((seen = init), res(200, [])) });
    await client.get("/workspaces");
    expect(seen.headers.Authorization).toBeUndefined();
    expect(seen.body).toBeUndefined();
  });

  it("maps statuses to error kinds: 401 -> auth, other 4xx/5xx -> http (with the status)", async () => {
    const client = createClient({ baseUrl: "http://gw", fetchImpl: async (u) => (u.endsWith("/a") ? res(401, { error: "Missing or invalid API key." }) : res(404, { error: "Workspace not found" })) });
    const auth = await failure(client.get("/a"));
    expect(auth instanceof GatewayError).toBe(true);
    expect(auth.kind).toBe("auth");
    const missing = await failure(client.get("/b"));
    expect(missing.kind).toBe("http");
    expect(missing.status).toBe(404);
    expect(missing.message).toBe("Workspace not found");
  });

  it("turns a zod validation body into a readable message", async () => {
    const client = createClient({ baseUrl: "http://gw", fetchImpl: async () => res(400, { error: { formErrors: [], fieldErrors: { name: ["Required"], targetLabel: ["Too short", "Bad"] } } }) });
    const err = await failure(client.post("/workspaces", {}));
    expect(err.message).toBe("name: Required; targetLabel: Too short, Bad");
  });

  it("classifies a refused connection as network, and an abort as timeout", async () => {
    const refused = createClient({ baseUrl: "http://gw", fetchImpl: async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); } });
    const net = await failure(refused.get("/health"));
    expect(net.kind).toBe("network");
    expect(net.message).toContain("ECONNREFUSED");
    const slow = createClient({ baseUrl: "http://gw", fetchImpl: async () => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); } });
    expect((await failure(slow.get("/health"))).kind).toBe("timeout");
  });

  it("describeErrorBody handles strings, objects, nested error fields, and nothing", () => {
    expect(describeErrorBody(undefined)).toBe("");
    expect(describeErrorBody("plain text")).toBe("plain text");
    expect(describeErrorBody({ error: "boom" })).toBe("boom");
    expect(describeErrorBody({ error: { formErrors: ["bad body"], fieldErrors: {} } })).toBe("bad body");
  });
});
