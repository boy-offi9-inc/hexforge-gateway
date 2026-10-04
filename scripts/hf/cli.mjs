#!/usr/bin/env node

/**
 * hf - the HexForge Gateway CLI. Remembers your current workspace, job and
 * workflow between commands (~/.hexforge/state.env), so most commands need
 * no ids typed. See docs/CLI.md.
 *
 * Two output modes, chosen automatically:
 *  - pretty: stdout is a terminal. Branded, colored, card-style output;
 *    `hf job` / `hf wf` follow the run live with a spinner; `hf chat` is a
 *    proper line-edited REPL with history and rendered markdown replies.
 *  - plain: stdout is a pipe/file, or --plain / --json / HF_PLAIN is set.
 *    Exactly what the original bash hf.sh printed (indented JSON on stdout,
 *    notices on stderr), so scripts that parse it keep working.
 *
 * Zero dependencies - Node 22's fetch and readline - and no jq: the Gateway
 * already requires Node, the original script's curl+jq did not need to be
 * installed on top of it.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createClient,
  GatewayError,
  readState,
  saveState,
  stateFile,
} from "./client.mjs";
import {
  createTheme,
  detectCaps,
  formatDuration,
  relativeTime,
  visibleWidth,
  wrapAnsi,
} from "./ui.mjs";

// --- arguments -------------------------------------------------------------

export class UsageError extends Error {}

/** Flags may appear anywhere (`hf job jadx decompile '{...}' --detach`); everything else is positional. */
export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        flags.json = true;
        break;
      case "--plain":
        flags.plain = true;
        break;
      case "--no-color":
        flags.noColor = true;
        break;
      case "--ascii":
        flags.ascii = true;
        break;
      case "--detach":
      case "-d":
        flags.detach = true;
        break;
      case "--wait":
      case "-w":
        flags.wait = true;
        break;
      case "--help":
      case "-h":
        flags.help = true;
        break;
      case "--version":
      case "-v":
        flags.version = true;
        break;
      case "--attempts":
        flags.attempts = Number(argv[++i]);
        break;
      default:
        if (a.startsWith("--attempts="))
          flags.attempts = Number(a.slice("--attempts=".length));
        else positionals.push(a);
    }
  }
  return {
    flags,
    positionals,
  };
}

/**
 * A job payload is either one JSON object, or HTTPie-style pairs:
 * `key=value` (always a string) and `key:=json` (any JSON value) - so
 * `hf job adb install apkPath=/x.apk reinstall:=true` works without
 * shell-quoting a JSON blob on a phone keyboard. Never guesses types from
 * the value ("123" stays a string unless you write `:=`), so a command that
 * happens to be numeric isn't silently turned into a number.
 */
export function parsePayload(args) {
  if (args.length === 0) return {};
  const first = args[0].trim();
  if (first.startsWith("{") || first.startsWith("[")) {
    if (args.length > 1)
      throw new UsageError(
        "Pass the payload as one JSON argument, or as key=value pairs - not both.",
      );
    let parsed;
    try {
      parsed = JSON.parse(first);
    } catch (err) {
      throw new UsageError(`The payload isn't valid JSON: ${err.message}`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
      throw new UsageError("The payload must be a JSON object.");
    return parsed;
  }
  const payload = {};
  for (const arg of args) {
    const typed = arg.indexOf(":=");
    const plain = arg.indexOf("=");
    if (typed > 0 && (plain < 0 || typed < plain)) {
      try {
        payload[arg.slice(0, typed)] = JSON.parse(arg.slice(typed + 2));
      } catch (err) {
        throw new UsageError(
          `"${arg}": the value after := must be valid JSON (${err.message}).`,
        );
      }
    } else if (plain > 0) {
      payload[arg.slice(0, plain)] = arg.slice(plain + 1);
    } else {
      throw new UsageError(`Expected key=value or key:=json, got "${arg}".`);
    }
  }
  return payload;
}

// --- small helpers ---------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = encodeURIComponent;

function packageVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return (
      JSON.parse(
        readFileSync(path.join(here, "..", "..", "package.json"), "utf8"),
      ).version ?? "dev"
    );
  } catch {
    return "dev";
  }
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function need(value, usage) {
  if (value === undefined || value === "")
    throw new UsageError(`usage: ${usage}`);
  return value;
}

function needWorkspace(ctx) {
  if (!ctx.state.WORKSPACE_ID)
    throw new UsageError("No current workspace set. Run: hf ws <name>");
  return ctx.state.WORKSPACE_ID;
}

/**
 * Writes lines to stdout. Flattens nested arrays on purpose: the layout
 * helpers (t.card, t.hint, entry...) return arrays of lines, and nesting one
 * inside another array literal would otherwise be stringified with commas
 * ("line one,line two") instead of failing loudly.
 */
const print = (ctx, lines = "") =>
  ctx.out.write(
    (Array.isArray(lines) ? lines.flat(Infinity).join("\n") : lines) + "\n",
  );
const printJson = (ctx, data) => print(ctx, JSON.stringify(data, null, 2));
/** Notices go to stderr, as the bash version did, so they never pollute piped stdout. */
const notice = (ctx, msg) => ctx.err.write(msg + "\n");

/** A two-line list entry: title (+ right-aligned text), then a muted detail line. */
function entry(ctx, { icon, title, right = "", detail = "" }) {
  const { t } = ctx;
  const lead = ` ${icon} `;
  const rightW = visibleWidth(right);
  const head = t.truncate(
    title,
    Math.max(8, t.width - 3 - (rightW ? rightW + 2 : 0)),
  );
  const gap = rightW
    ? Math.max(1, t.width - 3 - visibleWidth(head) - rightW)
    : 0;
  const lines = [lead + head + " ".repeat(gap) + right];
  if (detail) lines.push("   " + t.mute(t.truncate(detail, t.width - 3)));
  return lines;
}

// --- help ------------------------------------------------------------------

const HELP = [
  [
    "Workspaces",
    [
      ["ws <name> [label]", "get-or-create a workspace and make it current"],
      ["ws-list", "list every workspace on the server"],
      ["ws-show", "show the current workspace"],
      ["ws-id <id>", "switch to an existing workspace by id"],
      ["inbox", "APKs dropped into the server's inbox folder"],
    ],
  ],
  [
    "Run things",
    [
      [
        "job <agent> <op> [payload]",
        "run one agent operation and follow it live",
      ],
      ["job-status [id]", "show a job (default: the last one)"],
      ["jobs", "list this workspace's jobs"],
      ["wf <name> <steps-json>", "run a multi-step workflow and follow it"],
      ["wf-status [id]", "show a workflow (default: the last one)"],
      ["wfs", "list this workspace's workflows"],
    ],
  ],
  [
    "Knowledge & AI",
    [
      ["chat", "talk to the AI in this workspace"],
      ["chat-log", "print the workspace's chat transcript"],
      ["knowledge", "list the workspace's knowledge entries"],
      ["summarize <entryId>", "AI-summarize a knowledge entry"],
    ],
  ],
  [
    "Gateway",
    [
      ["health", "gateway status and configuration"],
      ["plugins", "loaded plugins"],
      ["current", "which workspace / job / workflow is selected"],
    ],
  ],
];

const HELP_FLAGS = [
  ["--json", "raw JSON, never styled (implies --plain)"],
  ["--plain", "the original unstyled output"],
  ["-d, --detach", "don't follow a job/workflow, just submit it"],
  ["-w, --wait", "follow even in plain mode; exit 1 if it fails"],
  ["--attempts N", "retry a job up to N times"],
  ["--no-color / --ascii", "monochrome / ASCII-only (also NO_COLOR, HF_ASCII)"],
];

const HELP_EXAMPLES = [
  "hf ws clite-analysis",
  "hf job jadx decompile apkPath=/sdcard/Download/app.apk",
  "hf job adb install apkPath=/x.apk reinstall:=true",
  'hf wf analyze \'[{"agent":"jadx","operation":"decompile","payload":{"apkPath":"/x.apk"}}]\'',
];

async function gatewayStatus(ctx) {
  try {
    const health = await ctx.client.get("/health", {
      timeout: 2500,
    });
    return {
      up: true,
      health,
    };
  } catch (err) {
    return {
      up: false,
      error: err,
    };
  }
}

async function cmdHelp(ctx) {
  const { t } = ctx;
  if (!ctx.caps.pretty) {
    const pad =
      Math.max(...HELP.flatMap(([, items]) => items.map(([u]) => u.length))) +
      2;
    const out = ["hf - HexForge Gateway CLI", ""];
    for (const [group, items] of HELP) {
      out.push(`${group}:`);
      for (const [usage, desc] of items)
        out.push(`  hf ${usage.padEnd(pad)}${desc}`);
      out.push("");
    }
    out.push(
      "Flags:",
      ...HELP_FLAGS.map(([f, d]) => `  ${f.padEnd(pad + 3)}${d}`),
      "",
      "Examples:",
      ...HELP_EXAMPLES.map((e) => `  ${e}`),
    );
    print(ctx, out);
    return 0;
  }

  const status = await gatewayStatus(ctx);
  const ws = ctx.state.WORKSPACE_ID
    ? `${ctx.state.WORKSPACE_NAME ?? ctx.state.WORKSPACE_ID} ${t.mute(t.g.sep + " " + ctx.state.WORKSPACE_ID)}`
    : t.mute("none yet - run: hf ws <name>");
  const gateway = status.up
    ? `${t.ok(t.g.dot)} ${ctx.client.baseUrl}`
    : `${t.err(t.g.err)} ${ctx.client.baseUrl} ${t.mute("(unreachable)")}`;

  print(
    ctx,
    t.box(
      [
        t.mute("AI-assisted APK reverse-engineering gateway"),
        "",
        `${t.mute("gateway".padEnd(10))}${gateway}`,
        `${t.mute("workspace".padEnd(10))}${ws}`,
      ],
      {
        title:
          t.bold(t.accent(`${t.g.hex} HexForge`)) +
          t.mute(` v${packageVersion()}`),
        border: t.accent,
      },
    ),
  );

  for (const [group, items] of HELP)
    print(ctx, ["", " " + t.bold(group), ...t.definitions(items)]);
  print(ctx, [
    "",
    " " + t.bold("Flags"),
    ...t.definitions(HELP_FLAGS, {
      color: t.info,
    }),
  ]);
  print(ctx, ["", " " + t.bold("Examples")]);
  for (const ex of HELP_EXAMPLES)
    print(
      ctx,
      wrapAnsi(ex, t.width, {
        indent: "  " + t.mute("$ "),
        hang: "    ",
      }),
    );

  if (status.up) {
    try {
      const list = await ctx.client.get("/workspaces");
      print(ctx, [
        "",
        " " + t.bold(`Workspaces on this server (${list.length})`),
      ]);
      if (list.length === 0)
        print(ctx, "   " + t.mute("none yet - create one with: hf ws <name>"));
      for (const ws of list.slice(0, 8))
        print(ctx, entry(ctx, workspaceEntry(ctx, ws)));
      if (list.length > 8)
        print(
          ctx,
          "   " +
            t.mute(`${t.g.ellipsis} and ${list.length - 8} more (hf ws-list)`),
        );
    } catch {
      /* the list is a courtesy - the help above is the point */
    }
  } else {
    print(ctx, [
      "",
      ...t.errorBlock(status.error.message, "", "start it with: npm run dev"),
    ]);
  }
  print(ctx, "");
  return 0;
}

// --- workspaces ------------------------------------------------------------

function workspaceEntry(ctx, ws) {
  const { t } = ctx;
  const current = ws.id === ctx.state.WORKSPACE_ID;
  return {
    icon: t.icon(ws.status),
    title: current ? t.bold(ws.name) : ws.name,
    right: t.statusText(ws.status),
    detail: `${ws.id} ${t.g.sep} ${relativeTime(ws.createdAt)}${current ? " " + t.g.sep + " " + t.accent("current") : ""}`,
  };
}

function rememberWorkspace(ctx, ws) {
  saveState("WORKSPACE_ID", ws.id, ctx.env);
  saveState("WORKSPACE_NAME", ws.name, ctx.env);
  ctx.state.WORKSPACE_ID = ws.id;
  ctx.state.WORKSPACE_NAME = ws.name;
}

async function cmdWs(ctx, [name, label]) {
  need(name, "hf ws <name> [targetLabel]");
  const ws = await ctx.client.put(`/workspaces/by-name/${enc(name)}`, {
    targetLabel: label ?? name,
  });
  rememberWorkspace(ctx, ws);
  if (!ctx.caps.pretty) {
    printJson(ctx, ws);
    notice(ctx, `Current workspace: ${ws.id} (${name})`);
    return 0;
  }
  const { t } = ctx;
  print(
    ctx,
    t.card({
      icon: t.icon("completed"),
      title: t.bold(`Workspace ${ws.name}`),
      right: t.statusText(ws.status),
      rows: [
        ["id", ws.id],
        ...(ws.targetLabel && ws.targetLabel !== ws.name
          ? [["target", ws.targetLabel]]
          : []),
      ],
      hint: "now current - next: hf job jadx decompile apkPath=<file.apk>",
    }),
  );
  return 0;
}

async function cmdWsId(ctx, [id]) {
  need(id, "hf ws-id <id>");
  let ws;
  try {
    ws = await ctx.client.get(`/workspaces/${enc(id)}`);
  } catch (err) {
    // Unreachable Gateway shouldn't stop you selecting a workspace you know exists.
    if (!(err instanceof GatewayError) || err.kind !== "network") throw err;
    saveState("WORKSPACE_ID", id, ctx.env);
    notice(
      ctx,
      `Current workspace: ${id} (couldn't verify it - ${err.message})`,
    );
    return 0;
  }
  rememberWorkspace(ctx, ws);
  if (!ctx.caps.pretty) notice(ctx, `Current workspace: ${ws.id}`);
  else
    print(
      ctx,
      ctx.t.card({
        icon: ctx.t.icon("completed"),
        title: ctx.t.bold(`Switched to ${ws.name}`),
        right: ctx.t.statusText(ws.status),
        rows: [["id", ws.id]],
      }),
    );
  return 0;
}

async function cmdWsShow(ctx) {
  const ws = await ctx.client.get(`/workspaces/${enc(needWorkspace(ctx))}`);
  if (!ctx.caps.pretty) return void printJson(ctx, ws);
  const { t } = ctx;
  print(
    ctx,
    t.card({
      icon: t.icon(ws.status),
      title: t.bold(ws.name),
      right: t.statusText(ws.status),
      rows: [
        ["id", ws.id],
        ["target", ws.targetLabel],
        ["created", relativeTime(ws.createdAt)],
        ["updated", relativeTime(ws.updatedAt)],
      ],
    }),
  );
  return 0;
}

async function cmdWsList(ctx) {
  const list = await ctx.client.get("/workspaces");
  if (ctx.flags.json) return void printJson(ctx, list);
  if (!ctx.caps.pretty) {
    if (list.length === 0)
      print(ctx, "No workspaces yet. Create one: hf ws <n>");
    else
      for (const ws of list) print(ctx, `${ws.id}  ${ws.name}  [${ws.status}]`);
    return 0;
  }
  if (list.length === 0) {
    print(
      ctx,
      ctx.t.card({
        icon: ctx.t.icon("created"),
        title: "No workspaces yet",
        hint: "create one: hf ws <name>",
      }),
    );
    return 0;
  }
  print(ctx, [ctx.t.rule(`Workspaces (${list.length})`)]);
  for (const ws of list) print(ctx, entry(ctx, workspaceEntry(ctx, ws)));
  return 0;
}

async function cmdInbox(ctx) {
  const id = needWorkspace(ctx);
  const { apks } = await ctx.client.get(`/workspaces/${enc(id)}/inbox`);
  if (!ctx.caps.pretty)
    return void printJson(ctx, {
      apks,
    });
  const { t } = ctx;
  if (apks.length === 0) {
    print(
      ctx,
      t.card({
        icon: t.icon("created"),
        title: "Nothing in this workspace's inbox",
        hint: "drop an .apk into the server's APK_INBOX_DIR (docs/INBOX.md)",
      }),
    );
    return 0;
  }
  print(ctx, [t.rule(`Inbox (${apks.length})`)]);
  for (const apk of apks) {
    print(
      ctx,
      entry(ctx, {
        icon: t.accent(t.g.hex),
        title: apk.fileName,
        right: t.mute(formatBytes(apk.sizeBytes)),
        detail: `${t.truncateStart(apk.path, t.width - 20)} ${t.g.sep} ${relativeTime(apk.detectedAt)}`,
      }),
    );
  }
  print(ctx, [
    "",
    ...t.hint("use these paths with: hf job jadx decompile apkPath=<path>"),
  ]);
  return 0;
}

// --- jobs ------------------------------------------------------------------

function summarizeValue(v) {
  if (v === null || v === undefined) return "-";
  if (typeof v === "string")
    return v.replace(/\s+/g, " ").trim().slice(0, 160) || '""';
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
  if (typeof v === "object")
    return `{${Object.keys(v).length} field${Object.keys(v).length === 1 ? "" : "s"}}`;
  return String(v);
}

/** Top-level fields of a job result as card rows - enough to see what happened, with the full thing one --json away. */
export function resultRows(result) {
  if (result === undefined || result === null) return [["result", "(none)"]];
  if (typeof result !== "object" || Array.isArray(result))
    return [["result", summarizeValue(result)]];
  const noisy = new Set(["stdoutTail", "stderrTail"]);
  const keys = Object.keys(result).filter((k) => !noisy.has(k));
  const rows = keys.slice(0, 8).map((k) => [k, summarizeValue(result[k])]);
  if (keys.length > 8) rows.push(["more", `${keys.length - 8} more fields`]);
  return rows;
}

function jobTitle(ctx, job) {
  return ctx.t.bold(`${job.agent} ${ctx.t.g.sep} ${job.operation}`);
}

function jobCard(ctx, job, elapsedMs) {
  const { t } = ctx;
  const right =
    elapsedMs === undefined
      ? t.mute(relativeTime(job.updatedAt ?? job.createdAt))
      : t.mute(formatDuration(elapsedMs));
  if (job.status === "failed") {
    return t.card({
      icon: t.icon("failed"),
      title: `${jobTitle(ctx, job)} ${t.err("failed")}`,
      right,
      rows: [
        ["error", job.error ?? "no error message"],
        ["attempts", `${job.attempts}/${job.maxAttempts}`],
        ["job", job.id],
      ],
      hint: "retry with --attempts 3, or inspect: hf job-status --json",
    });
  }
  if (job.status === "completed") {
    return t.card({
      icon: t.icon("completed"),
      title: jobTitle(ctx, job),
      right,
      rows: resultRows(job.result),
      hint: "full result: hf job-status --json",
    });
  }
  return t.card({
    icon: t.icon(job.status),
    title: `${jobTitle(ctx, job)} ${t.statusText(job.status)}`,
    right,
    rows: [
      ["job", job.id],
      ["attempt", `${job.attempts}/${job.maxAttempts}`],
    ],
    hint: "check on it: hf job-status",
  });
}

/**
 * Hides the cursor and installs a Ctrl+C handler for the duration of a live
 * view, restoring both however it ends. Ctrl+C here stops *watching*, not
 * the job - which keeps running in the Gateway - so the hint says how to
 * pick it back up.
 */
async function withLive(ctx, resumeHint, fn) {
  if (!ctx.caps.live) return fn();
  const show = () => ctx.err.write("\x1b[?25h");
  const onInt = () => {
    ctx.err.write("\r\x1b[2K");
    show();
    notice(
      ctx,
      ctx.t.mute(
        `stopped watching - it keeps running in the Gateway. Resume: ${resumeHint}`,
      ),
    );
    process.exit(130);
  };
  ctx.err.write("\x1b[?25l");
  process.once("SIGINT", onInt);
  process.once("exit", show);
  try {
    return await fn();
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("exit", show);
    show();
  }
}

const isDone = (status) => status === "completed" || status === "failed";

/** Polls until the job finishes, animating a one-line spinner on stderr when that's a real terminal. */
async function followJob(ctx, job) {
  const { t, client } = ctx;
  const started = Date.now();
  let current = job;
  let nextPoll = 0;
  let frame = 0;
  let misses = 0;

  await withLive(ctx, `hf job-status ${job.id}`, async () => {
    for (;;) {
      if (Date.now() >= nextPoll) {
        try {
          current = await client.get(`/jobs/${enc(job.id)}`);
          misses = 0;
        } catch (err) {
          if (
            err instanceof GatewayError &&
            (err.kind === "network" || err.kind === "timeout") &&
            ++misses <= 5
          ) {
            /* brief blip - keep trying */
          } else {
            throw err;
          }
        }
        nextPoll = Date.now() + 700;
      }
      if (isDone(current.status)) break;
      if (ctx.caps.live) {
        const retry =
          current.attempts > 1
            ? ` ${t.g.sep} attempt ${current.attempts}/${current.maxAttempts}`
            : "";
        const line = ` ${t.icon(current.status === "queued" ? "queued" : "running", frame)} ${jobTitle(ctx, current)}  ${t.statusText(current.status)}${t.mute(retry + " " + t.g.sep + " " + formatDuration(Date.now() - started))}`;
        ctx.err.write("\r\x1b[2K" + t.truncate(line, t.width - 1));
      }
      frame++;
      await sleep(90);
    }
    if (ctx.caps.live) ctx.err.write("\r\x1b[2K");
  });
  return {
    job: current,
    elapsedMs: Date.now() - started,
  };
}

async function cmdJob(ctx, [agent, operation, ...payloadArgs]) {
  need(agent, "hf job <agent> <operation> [json | key=value | key:=json ...]");
  need(
    operation,
    "hf job <agent> <operation> [json | key=value | key:=json ...]",
  );
  const wsId = needWorkspace(ctx);
  const body = {
    agent,
    operation,
    payload: parsePayload(payloadArgs),
  };
  if (ctx.flags.attempts !== undefined) {
    if (
      !Number.isInteger(ctx.flags.attempts) ||
      ctx.flags.attempts < 1 ||
      ctx.flags.attempts > 10
    )
      throw new UsageError("--attempts must be a whole number from 1 to 10.");
    body.maxAttempts = ctx.flags.attempts;
  }
  const job = await ctx.client.post(`/workspaces/${enc(wsId)}/jobs`, body);
  saveState("JOB_ID", job.id, ctx.env);
  ctx.state.JOB_ID = job.id;

  const follow = ctx.caps.pretty ? !ctx.flags.detach : Boolean(ctx.flags.wait);
  if (!follow) {
    if (ctx.caps.pretty) {
      print(
        ctx,
        ctx.t.card({
          icon: ctx.t.icon(job.status),
          title: `${jobTitle(ctx, job)} submitted`,
          rows: [["job", job.id]],
          hint: "follow it: hf job-status",
        }),
      );
    } else {
      printJson(ctx, job);
      notice(ctx, `Current job: ${job.id}`);
    }
    return 0;
  }

  const { job: done, elapsedMs } = await followJob(ctx, job);
  if (ctx.caps.pretty) print(ctx, jobCard(ctx, done, elapsedMs));
  else printJson(ctx, done);
  return done.status === "failed" ? 1 : 0;
}

async function cmdJobStatus(ctx, [id]) {
  const jobId = id ?? ctx.state.JOB_ID;
  if (!jobId) throw new UsageError("No job id given and no current job set.");
  const job = await ctx.client.get(`/jobs/${enc(jobId)}`);
  if (!ctx.caps.pretty) return void printJson(ctx, job);
  print(ctx, jobCard(ctx, job));
  return 0;
}

async function cmdJobs(ctx) {
  const list = await ctx.client.get(
    `/workspaces/${enc(needWorkspace(ctx))}/jobs`,
  );
  if (!ctx.caps.pretty) return void printJson(ctx, list);
  const { t } = ctx;
  if (list.length === 0) {
    print(
      ctx,
      t.card({
        icon: t.icon("created"),
        title: "No jobs in this workspace yet",
        hint: "run one: hf job <agent> <operation> ...",
      }),
    );
    return 0;
  }
  print(ctx, [t.rule(`Jobs (${list.length})`)]);
  for (const job of list) {
    const retry =
      job.maxAttempts > 1
        ? ` ${t.g.sep} attempt ${job.attempts}/${job.maxAttempts}`
        : "";
    const why =
      job.status === "failed" && job.error ? ` ${t.g.sep} ${job.error}` : "";
    print(
      ctx,
      entry(ctx, {
        icon: t.icon(job.status),
        title: `${job.agent} ${t.g.sep} ${job.operation}`,
        right: t.mute(relativeTime(job.updatedAt ?? job.createdAt)),
        detail: `${job.id}${retry}${why}`,
      }),
    );
  }
  return 0;
}

// --- workflows -------------------------------------------------------------

function workflowLines(ctx, wf, frame = 0) {
  const { t } = ctx;
  const done = wf.steps.filter((s) => s.status === "completed").length;
  const lines = [
    ` ${t.icon(wf.status, frame)} ${t.bold(wf.name)}  ${t.statusText(wf.status)} ${t.mute(`${done}/${wf.steps.length} steps`)}`,
  ];
  wf.steps.forEach((step, i) => {
    lines.push(
      `   ${t.mute(String(i + 1))} ${t.icon(step.status, frame)} ${step.agent} ${t.g.sep} ${step.operation}  ${t.mute(step.status)}`,
    );
    if (step.status === "failed" && step.error)
      lines.push("       " + t.err(step.error));
  });
  return lines.map((l) => t.truncate(l, t.width - 1));
}

async function followWorkflow(ctx, wf) {
  const { t, client } = ctx;
  const started = Date.now();
  let current = wf;
  let nextPoll = 0;
  let frame = 0;
  let drawn = 0;
  let misses = 0;

  await withLive(ctx, `hf wf-status ${wf.id}`, async () => {
    for (;;) {
      if (Date.now() >= nextPoll) {
        try {
          current = await client.get(`/workflows/${enc(wf.id)}`);
          misses = 0;
        } catch (err) {
          if (
            err instanceof GatewayError &&
            (err.kind === "network" || err.kind === "timeout") &&
            ++misses <= 5
          ) {
            /* brief blip - keep trying */
          } else {
            throw err;
          }
        }
        nextPoll = Date.now() + 700;
      }
      if (isDone(current.status)) break;
      if (ctx.caps.live) {
        if (drawn) ctx.err.write(`\x1b[${drawn}A\x1b[J`);
        const lines = workflowLines(ctx, current, frame);
        ctx.err.write(lines.join("\n") + "\n");
        drawn = lines.length;
      }
      frame++;
      await sleep(90);
    }
    if (ctx.caps.live && drawn) ctx.err.write(`\x1b[${drawn}A\x1b[J`);
  });
  return {
    wf: current,
    elapsedMs: Date.now() - started,
  };
}

async function cmdWf(ctx, [name, steps]) {
  need(name, "hf wf <name> <stepsJsonArray>");
  need(steps, "hf wf <name> <stepsJsonArray>");
  const wsId = needWorkspace(ctx);
  let parsed;
  try {
    parsed = JSON.parse(steps);
  } catch (err) {
    throw new UsageError(`The steps aren't valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed))
    throw new UsageError(
      "The steps must be a JSON array of { agent, operation, payload? } objects.",
    );

  const wf = await ctx.client.post(`/workspaces/${enc(wsId)}/workflows`, {
    name,
    steps: parsed,
  });
  saveState("WORKFLOW_ID", wf.id, ctx.env);
  ctx.state.WORKFLOW_ID = wf.id;

  const follow = ctx.caps.pretty ? !ctx.flags.detach : Boolean(ctx.flags.wait);
  if (!follow) {
    if (ctx.caps.pretty) {
      print(ctx, [
        ...workflowLines(ctx, wf),
        ...ctx.t.hint("follow it: hf wf-status"),
      ]);
    } else {
      printJson(ctx, wf);
      notice(ctx, `Current workflow: ${wf.id}`);
    }
    return 0;
  }

  const { wf: done, elapsedMs } = await followWorkflow(ctx, wf);
  if (!ctx.caps.pretty) {
    printJson(ctx, done);
  } else {
    print(ctx, [
      ...workflowLines(ctx, done),
      ...ctx.t.hint(
        `${formatDuration(elapsedMs)} ${ctx.t.g.sep} a report was saved to the knowledge base: hf knowledge`,
      ),
    ]);
  }
  return done.status === "failed" ? 1 : 0;
}

async function cmdWfStatus(ctx, [id]) {
  const wfId = id ?? ctx.state.WORKFLOW_ID;
  if (!wfId)
    throw new UsageError("No workflow id given and no current workflow set.");
  const wf = await ctx.client.get(`/workflows/${enc(wfId)}`);
  if (!ctx.caps.pretty) return void printJson(ctx, wf);
  print(ctx, workflowLines(ctx, wf));
  return 0;
}

async function cmdWfs(ctx) {
  const list = await ctx.client.get(
    `/workspaces/${enc(needWorkspace(ctx))}/workflows`,
  );
  if (!ctx.caps.pretty) return void printJson(ctx, list);
  const { t } = ctx;
  if (list.length === 0) {
    print(
      ctx,
      t.card({
        icon: t.icon("created"),
        title: "No workflows in this workspace yet",
        hint: "run one: hf wf <name> '<steps-json>'",
      }),
    );
    return 0;
  }
  print(ctx, [t.rule(`Workflows (${list.length})`)]);
  for (const wf of list) {
    const done = wf.steps.filter((s) => s.status === "completed").length;
    print(
      ctx,
      entry(ctx, {
        icon: t.icon(wf.status),
        title: wf.name,
        right: t.mute(`${done}/${wf.steps.length} steps`),
        detail: `${wf.id} ${t.g.sep} ${relativeTime(wf.updatedAt ?? wf.createdAt)}`,
      }),
    );
  }
  return 0;
}

// --- knowledge & AI --------------------------------------------------------

async function cmdKnowledge(ctx) {
  const list = await ctx.client.get(
    `/workspaces/${enc(needWorkspace(ctx))}/knowledge`,
  );
  if (!ctx.caps.pretty) return void printJson(ctx, list);
  const { t } = ctx;
  if (list.length === 0) {
    print(
      ctx,
      t.card({
        icon: t.icon("created"),
        title: "No knowledge entries yet",
        hint: "finished workflows add a report here automatically",
      }),
    );
    return 0;
  }
  print(ctx, [t.rule(`Knowledge (${list.length})`)]);
  for (const e of list) {
    print(
      ctx,
      entry(ctx, {
        icon: t.accent(t.g.bullet),
        title: e.title,
        right: t.info(e.type),
        detail: `${e.id} ${t.g.sep} ${e.source} ${t.g.sep} ${relativeTime(e.createdAt)}`,
      }),
    );
  }
  return 0;
}

async function cmdSummarize(ctx, [entryId]) {
  need(entryId, "hf summarize <entryId>");
  const summary = await withSpinner(ctx, "summarizing", () =>
    ctx.client.post(`/knowledge/${enc(entryId)}/summarize`, undefined, {
      timeout: 120_000,
    }),
  );
  if (!ctx.caps.pretty) return void printJson(ctx, summary);
  const { t } = ctx;
  print(ctx, [
    ...t.card({
      icon: t.icon("completed"),
      title: t.bold("Summary saved"),
      rows: [["entry", summary.id]],
    }),
    "",
    t.markdown(summary.content),
  ]);
  return 0;
}

async function cmdHealth(ctx) {
  const health = await ctx.client.get("/health");
  if (!ctx.caps.pretty) return void printJson(ctx, health);
  const { t } = ctx;
  print(
    ctx,
    t.card({
      icon: t.icon("ready"),
      title: t.bold("HexForge Gateway") + " " + t.ok(health.status),
      right: t.mute(ctx.client.baseUrl.replace(/^https?:\/\//, "")),
      rows: [
        [
          "storage",
          health.storageBackend +
            (health.storageBackend === "supabase"
              ? health.supabaseConfigured
                ? ""
                : " (not configured)"
              : ""),
        ],
        [
          "ai",
          `${health.aiProvider} ${t.g.sep} ${health.aiConfigured ? t.ok("configured") : t.warn("not configured - chat/summarize will fail")}`,
        ],
        ["auth", health.authEnabled ? t.ok("enabled") : t.mute("disabled")],
        ["time", health.time],
      ],
    }),
  );
  return 0;
}

async function cmdPlugins(ctx) {
  const list = await ctx.client.get("/plugins");
  if (!ctx.caps.pretty) return void printJson(ctx, list);
  const { t } = ctx;
  if (list.length === 0) {
    print(
      ctx,
      t.card({
        icon: t.icon("created"),
        title: "No plugins loaded",
        hint: "see docs/PLUGINS.md",
      }),
    );
    return 0;
  }
  print(ctx, [t.rule(`Plugins (${list.length})`)]);
  for (const p of list)
    print(
      ctx,
      entry(ctx, {
        icon: t.accent(t.g.hex),
        title: p.name,
        right: t.mute(p.version ? `v${p.version}` : ""),
        detail: p.description ?? "",
      }),
    );
  return 0;
}

function cmdCurrent(ctx) {
  const { state, t } = ctx;
  if (ctx.flags.json)
    return void printJson(ctx, {
      workspace: state.WORKSPACE_ID ?? null,
      job: state.JOB_ID ?? null,
      workflow: state.WORKFLOW_ID ?? null,
    });
  if (!ctx.caps.pretty) {
    print(ctx, [
      `workspace: ${state.WORKSPACE_ID ?? "<none>"}`,
      `job:       ${state.JOB_ID ?? "<none>"}`,
      `workflow:  ${state.WORKFLOW_ID ?? "<none>"}`,
    ]);
    return 0;
  }
  const none = t.mute("none");
  print(
    ctx,
    t.card({
      icon: t.accent(t.g.hex),
      title: t.bold("Current selection"),
      rows: [
        [
          "workspace",
          state.WORKSPACE_ID
            ? `${state.WORKSPACE_NAME ?? ""} ${state.WORKSPACE_ID}`.trim()
            : none,
        ],
        ["job", state.JOB_ID ?? none],
        ["workflow", state.WORKFLOW_ID ?? none],
      ],
    }),
  );
  return 0;
}

/** A transient one-line spinner around a single awaited call (pretty + interactive stderr only). */
async function withSpinner(ctx, label, fn) {
  if (!ctx.caps.live) return fn();
  const { t } = ctx;
  const started = Date.now();
  let frame = 0;
  const draw = () =>
    ctx.err.write(
      "\r\x1b[2K" +
        t.truncate(
          ` ${t.accent(t.spinFrame(frame++))} ${label}${t.mute(" " + t.g.sep + " " + formatDuration(Date.now() - started))}`,
          t.width - 1,
        ),
    );
  ctx.err.write("\x1b[?25l");
  draw();
  const timer = setInterval(draw, 90);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    ctx.err.write("\r\x1b[2K\x1b[?25h");
  }
}

// --- chat ------------------------------------------------------------------

function chatHistoryFile(ctx) {
  return path.join(path.dirname(stateFile(ctx.env)), "chat_history");
}

function loadChatHistory(ctx) {
  const file = chatHistoryFile(ctx);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-200)
    .reverse(); // readline wants newest first
}

function saveChatHistory(ctx, line) {
  try {
    mkdirSync(path.dirname(chatHistoryFile(ctx)), {
      recursive: true,
    });
    appendFileSync(chatHistoryFile(ctx), line.replace(/\n/g, " ") + "\n");
  } catch {
    /* history is a convenience */
  }
}

function renderReply(ctx, reply) {
  const { t } = ctx;
  const md = t.markdown(String(reply ?? "(empty reply)")).split("\n");
  md[0] = t.accent(t.g.hex) + " " + md[0].replace(/^ {2}/, "");
  return ["", ...md, ""];
}

async function cmdChat(ctx) {
  const wsId = needWorkspace(ctx);

  if (!ctx.caps.pretty) {
    // Plain mode keeps the original contract: prompts on stderr, replies on stdout, works with piped input.
    notice(
      ctx,
      `Chatting in workspace ${wsId}. Type 'exit' or press Ctrl+D to quit.\n`,
    );
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
      prompt: "you> ",
    });
    rl.prompt();
    for await (const raw of rl) {
      const line = raw.trim();
      if (line === "exit" || line === "quit") break;
      if (line !== "") {
        try {
          const { reply } = await ctx.client.post(
            `/workspaces/${enc(wsId)}/chat`,
            {
              message: line,
            },
            {
              timeout: 120_000,
            },
          );
          print(ctx, [`ai>  ${reply ?? "(no reply field in response)"}`, ""]);
        } catch (err) {
          notice(ctx, `(request failed - ${err.message})`);
        }
      }
      rl.prompt();
    }
    return 0;
  }

  const { t } = ctx;
  print(
    ctx,
    t.box(
      [
        `${t.mute("workspace".padEnd(10))}${ctx.state.WORKSPACE_NAME ?? wsId}`,
        t.mute("/help for commands " + t.g.sep + " Ctrl+D or /exit to quit"),
      ],
      {
        title: t.bold(t.accent(`${t.g.hex} HexForge chat`)),
        border: t.accent,
      },
    ),
  );
  print(ctx, "");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    history: loadChatHistory(ctx),
    historySize: 200,
    prompt: `${t.accent(t.g.prompt)} `,
  });

  let armed = 0;
  rl.on("SIGINT", () => {
    if (rl.line && rl.line.length > 0) {
      rl.write(null, {
        ctrl: true,
        name: "u",
      });
      return;
    }
    if (Date.now() - armed < 2000) {
      rl.close();
      return;
    }
    armed = Date.now();
    ctx.out.write(
      "\n" + t.mute("(press Ctrl+C again, or type /exit, to quit)") + "\n",
    );
    rl.prompt();
  });

  const showLog = async (count = 6) => {
    const log = await ctx.client.get(`/workspaces/${enc(wsId)}/chat`);
    if (log.length === 0) return print(ctx, [t.mute("  no messages yet"), ""]);
    for (const m of log.slice(-count)) {
      if (m.role === "user")
        print(ctx, ["", `${t.accent(t.g.prompt)} ${m.content}`]);
      else print(ctx, renderReply(ctx, m.content));
    }
  };

  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line !== "") saveChatHistory(ctx, line);

    if (line === "/exit" || line === "/quit" || line === "/q") break;
    if (line === "") {
      rl.prompt();
      continue;
    }
    if (line.startsWith("/")) {
      const [cmd, arg] = line.split(/\s+/);
      try {
        if (cmd === "/help") {
          print(ctx, [
            "",
            `  ${t.accent("/log [n]")}   ${t.mute("show the last n messages (default 6)")}`,
            `  ${t.accent("/clear")}     ${t.mute("clear the screen")}`,
            `  ${t.accent("/exit")}      ${t.mute("leave the chat")}`,
            "",
          ]);
        } else if (cmd === "/clear") {
          ctx.out.write("\x1b[2J\x1b[H");
        } else if (cmd === "/log") {
          await showLog(Number(arg) || 6);
        } else {
          print(ctx, [t.mute(`  unknown command ${cmd} - try /help`), ""]);
        }
      } catch (err) {
        print(ctx, errorLines(ctx, err));
      }
      rl.prompt();
      continue;
    }

    rl.pause();
    try {
      const { reply } = await withSpinner(ctx, "thinking", () =>
        ctx.client.post(
          `/workspaces/${enc(wsId)}/chat`,
          {
            message: line,
          },
          {
            timeout: 120_000,
          },
        ),
      );
      print(ctx, renderReply(ctx, reply));
    } catch (err) {
      print(ctx, ["", ...errorLines(ctx, err), ""]);
    }
    rl.resume();
    rl.prompt();
  }
  rl.close();
  print(ctx, [
    "",
    ...wrapAnsi(
      t.mute(
        "saved to the workspace " + t.g.sep + " hf chat-log to read it back",
      ),
      t.width,
      {
        indent: "  ",
      },
    ),
    "",
  ]);
  return 0;
}

async function cmdChatLog(ctx) {
  const log = await ctx.client.get(
    `/workspaces/${enc(needWorkspace(ctx))}/chat`,
  );
  if (!ctx.caps.pretty) return void printJson(ctx, log);
  const { t } = ctx;
  if (log.length === 0) {
    print(
      ctx,
      t.card({
        icon: t.icon("created"),
        title: "No chat messages yet",
        hint: "start one: hf chat",
      }),
    );
    return 0;
  }
  print(ctx, [t.rule(`Chat (${log.length} messages)`)]);
  for (const m of log) {
    if (m.role === "user")
      print(ctx, [
        "",
        `${t.accent(t.g.prompt)} ${t.bold(m.content)}  ${t.mute(relativeTime(m.createdAt))}`,
      ]);
    else print(ctx, renderReply(ctx, m.content));
  }
  return 0;
}

// --- errors ----------------------------------------------------------------

function errorLines(ctx, err) {
  const { t } = ctx;
  if (err instanceof UsageError) return t.errorBlock(err.message);
  if (err instanceof GatewayError) {
    switch (err.kind) {
      case "network":
        return t.errorBlock(
          err.message,
          "",
          "is it running? start it with: npm run dev (or set HEXFORGE_URL)",
        );
      case "timeout":
        return t.errorBlock(
          "The Gateway didn't answer in time",
          err.message,
          "a slow job keeps running - check with: hf job-status",
        );
      case "auth":
        return t.errorBlock(
          "Unauthorized",
          "The Gateway has auth enabled and didn't accept the request.",
          "set HEXFORGE_API_KEY to one of its API_KEYS",
        );
      default:
        if (err.status === 404)
          return t.errorBlock(
            err.message || "Not found",
            "",
            /workspace/i.test(err.message) ? "see what exists: hf ws-list" : "",
          );
        if (err.status === 503)
          return t.errorBlock(
            "Not available",
            err.message,
            "check provider settings: hf health",
          );
        return t.errorBlock(`The Gateway returned ${err.status}`, err.message);
    }
  }
  return t.errorBlock("Unexpected error", err?.message ?? String(err));
}

function reportError(ctx, err) {
  if (ctx.caps.pretty) ctx.err.write(errorLines(ctx, err).join("\n") + "\n");
  else ctx.err.write(`error: ${err?.message ?? err}\n`);
  if (process.env.HF_DEBUG && err?.stack) ctx.err.write(err.stack + "\n");
  return err instanceof UsageError ? 2 : 1;
}

// --- main ------------------------------------------------------------------

const COMMANDS = {
  ws: cmdWs,
  "ws-id": cmdWsId,
  "ws-show": cmdWsShow,
  "ws-list": cmdWsList,
  inbox: cmdInbox,
  job: cmdJob,
  "job-status": cmdJobStatus,
  jobs: cmdJobs,
  wf: cmdWf,
  "wf-status": cmdWfStatus,
  wfs: cmdWfs,
  knowledge: cmdKnowledge,
  summarize: cmdSummarize,
  chat: cmdChat,
  "chat-log": cmdChatLog,
  health: cmdHealth,
  plugins: cmdPlugins,
  current: cmdCurrent,
  help: cmdHelp,
};

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { flags, positionals } = parseArgs(argv);
  const [cmd, ...args] = positionals;

  const caps = detectCaps({
    env,
    stdout: process.stdout,
    stderr: process.stderr,
    flags,
  });
  const ctx = {
    env,
    flags,
    caps,
    t: createTheme(caps),
    out: process.stdout,
    err: process.stderr,
    client: createClient({
      baseUrl: env.HEXFORGE_URL || "http://localhost:8080",
      apiKey: env.HEXFORGE_API_KEY,
    }),
    state: readState(env),
  };

  if (flags.version) {
    print(ctx, `hf ${packageVersion()}`);
    return 0;
  }
  if (!cmd || flags.help) return cmdHelp(ctx);

  const handler = COMMANDS[cmd];
  if (!handler) {
    return reportError(
      ctx,
      new UsageError(`Unknown command "${cmd}". Run: hf help`),
    );
  }
  try {
    return (await handler(ctx, args)) ?? 0;
  } catch (err) {
    return reportError(ctx, err);
  }
}

// Only run when executed directly, so tests can import parseArgs/parsePayload/resultRows without side effects.
const invokedDirectly = (() => {
  try {
    return (
      process.argv[1] &&
      pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
    );
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // `hf ws-list | head` closes the pipe early; that's not an error.
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  process.exitCode = await main();
}
