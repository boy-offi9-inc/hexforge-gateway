import { describe, expect, it } from "vitest";
import {
  createConsoleUi,
  createPrettyLogStream,
  detectConsoleCaps,
  formatDuration,
  formatRequestLine,
  listenAddresses,
  notice,
  packageVersion,
  renderBanner,
  visibleWidth,
} from "../src/core/console-ui.js";

// The Gateway's own console output (core/console-ui.ts). Everything here is
// a pure function of its inputs, so nothing is mocked: the stream is handed
// a capture function instead of stdout, and the environment is passed in.
// Note what is *not* here - Fastify itself accepting `logger.stream` - since
// that's Fastify's contract, not ours; core/server.ts only passes it in.

const caps = (columns, extra = {}) => ({
  pretty: true,
  color: false,
  depth: 24,
  unicode: true,
  columns,
  ...extra,
});
const nonAscii = (s) => [...s].some((c) => c.charCodeAt(0) > 127);
const widest = (lines) =>
  Math.max(...lines.flatMap((l) => l.split("\n")).map(visibleWidth));

const tty = { isTTY: true, columns: 60, getColorDepth: () => 24 };

describe("detectConsoleCaps", () => {
  it("is pretty on an interactive terminal and plain when piped", () => {
    expect(detectConsoleCaps({}, tty).pretty).toBe(true);
    expect(detectConsoleCaps({}, { isTTY: false }).pretty).toBe(false);
  });

  it("LOG_FORMAT=json never goes pretty, even on a terminal; LOG_FORMAT=pretty forces it on a pipe", () => {
    expect(detectConsoleCaps({ LOG_FORMAT: "json" }, tty).pretty).toBe(false);
    expect(
      detectConsoleCaps({ LOG_FORMAT: "pretty" }, { isTTY: false }).pretty,
    ).toBe(true);
    expect(detectConsoleCaps({ LOG_FORMAT: "JSON" }, tty).pretty).toBe(false);
  });

  it("TERM=dumb is never pretty, not even when forced", () => {
    expect(detectConsoleCaps({ TERM: "dumb" }, tty).pretty).toBe(false);
    expect(
      detectConsoleCaps({ TERM: "dumb", LOG_FORMAT: "pretty" }, tty).pretty,
    ).toBe(false);
  });

  it("NO_COLOR drops color but keeps the pretty layout; FORCE_COLOR adds color to a forced-pretty pipe", () => {
    const noColor = detectConsoleCaps({ NO_COLOR: "1" }, tty);
    expect(noColor.color).toBe(false);
    expect(noColor.pretty).toBe(true);
    expect(
      detectConsoleCaps({ LOG_FORMAT: "pretty" }, { isTTY: false }).color,
    ).toBe(false);
    expect(
      detectConsoleCaps(
        { LOG_FORMAT: "pretty", FORCE_COLOR: "1" },
        { isTTY: false },
      ).color,
    ).toBe(true);
  });

  it("falls back to ASCII for HF_ASCII, TERM=linux, or a non-UTF-8 locale", () => {
    expect(detectConsoleCaps({ HF_ASCII: "1" }, tty).unicode).toBe(false);
    expect(detectConsoleCaps({ TERM: "linux" }, tty).unicode).toBe(false);
    expect(detectConsoleCaps({ LANG: "en_US.ISO-8859-1" }, tty).unicode).toBe(
      false,
    );
    expect(detectConsoleCaps({ LANG: "en_US.UTF-8" }, tty).unicode).toBe(true);
  });

  it("reads the width from the stream, then COLUMNS, then defaults to 80", () => {
    expect(detectConsoleCaps({}, tty).columns).toBe(60);
    expect(detectConsoleCaps({ COLUMNS: "44" }, { isTTY: true }).columns).toBe(
      44,
    );
    expect(detectConsoleCaps({}, { isTTY: true }).columns).toBe(80);
  });
});

describe("listenAddresses", () => {
  const nets = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    wlan0: [
      { address: "10.245.38.1", family: "IPv4", internal: false },
      { address: "fe80::1", family: "IPv6", internal: false },
    ],
    rmnet0: [{ address: "10.142.61.29", family: "IPv4", internal: false }],
    gone: undefined,
  };

  it("a wildcard bind is one local URL plus every non-internal IPv4 address, once each", () => {
    expect(listenAddresses("0.0.0.0", 8080, nets)).toEqual([
      { label: "local", url: "http://127.0.0.1:8080" },
      { label: "network", url: "http://10.245.38.1:8080" },
      { label: "network", url: "http://10.142.61.29:8080" },
    ]);
  });

  it("a specific host is one address, labelled by whether it's loopback", () => {
    expect(listenAddresses("127.0.0.1", 9, nets)).toEqual([
      { label: "local", url: "http://127.0.0.1:9" },
    ]);
    expect(listenAddresses("localhost", 9, nets)).toEqual([
      { label: "local", url: "http://localhost:9" },
    ]);
    expect(listenAddresses("192.168.1.5", 9, nets)).toEqual([
      { label: "network", url: "http://192.168.1.5:9" },
    ]);
  });

  it("understands the numeric address family older Node 18 builds report", () => {
    const old = {
      wlan0: [
        { address: "10.0.0.2", family: 4, internal: false },
        { address: "fe80::1", family: 6, internal: false },
      ],
    };
    expect(listenAddresses("::", 80, old).map((a) => a.url)).toEqual([
      "http://127.0.0.1:80",
      "http://10.0.0.2:80",
    ]);
  });
});

describe("renderBanner", () => {
  const base = {
    version: "1.3.7",
    addresses: [
      { label: "local", url: "http://127.0.0.1:8080" },
      { label: "network", url: "http://10.245.38.1:8080" },
      { label: "network", url: "http://10.142.61.29:8080" },
      { label: "network", url: "http://10.15.126.117:8080" },
    ],
    storage: "local (./data)",
    ai: { provider: "ollama", configured: true },
    auth: { enabled: false, requested: true },
    plugins: [
      { name: "example-strings", version: "0.1.0" },
      { name: "webhook-notifier", version: "0.1.0" },
    ],
    inbox: undefined,
    workspaces: [],
  };

  it.each([24, 30, 45, 64, 100])(
    "never exceeds a %s-column terminal",
    (columns) => {
      expect(
        widest(renderBanner(base, createConsoleUi(caps(columns)))),
      ).toBeLessThanOrEqual(columns);
    },
  );

  it("warns specifically when AUTH_ENABLED is set but there are no API_KEYS (auth is NOT active)", () => {
    const text = renderBanner(base, createConsoleUi(caps(100))).join("\n");
    expect(text).toContain("AUTH_ENABLED=true but API_KEYS is empty");
    expect(text).toContain("NOT active");
  });

  it("warns when auth is off and the port is reachable from the network - but stays quiet on localhost only", () => {
    const exposed = renderBanner(
      { ...base, auth: { enabled: false, requested: false } },
      createConsoleUi(caps(100)),
    ).join("\n");
    expect(exposed).toContain("anyone on it has full access");
    const local = renderBanner(
      {
        ...base,
        addresses: [base.addresses[0]],
        auth: { enabled: false, requested: false },
      },
      createConsoleUi(caps(100)),
    ).join("\n");
    expect(local).not.toContain("full access");
    expect(local).toContain("off (localhost only)");
  });

  it("shows enabled auth cleanly, with no auth warning", () => {
    const text = renderBanner(
      { ...base, auth: { enabled: true, requested: true } },
      createConsoleUi(caps(100)),
    ).join("\n");
    expect(text).toContain("enabled");
    expect(text).not.toContain("NOT active");
    expect(text).not.toContain("full access");
  });

  it("warns that chat/summarize will 503 when the AI provider isn't configured", () => {
    const text = renderBanner(
      {
        ...base,
        ai: { provider: "anthropic", configured: false },
        auth: { enabled: true, requested: true },
      },
      createConsoleUi(caps(100)),
    ).join("\n");
    expect(text).toContain("not configured");
    expect(text).toContain("will return 503");
  });

  it("lists plugins with versions when they fit, names only when they don't", () => {
    expect(renderBanner(base, createConsoleUi(caps(100))).join("\n")).toContain(
      "example-strings v0.1.0, webhook-notifier v0.1.0",
    );
    const narrow = renderBanner(base, createConsoleUi(caps(45))).join("\n");
    expect(narrow).toContain("example-strings, webhook");
    expect(narrow).not.toContain("v0.1.0, webhook");
  });

  it("shows the inbox folder when watching and the workspace names with a +N overflow", () => {
    const text = renderBanner(
      {
        ...base,
        inbox: "/data/inbox",
        workspaces: [
          { name: "a" },
          { name: "b" },
          { name: "c" },
          { name: "d" },
          { name: "e" },
        ],
      },
      createConsoleUi(caps(100)),
    ).join("\n");
    expect(text).toContain("watching /data/inbox");
    expect(text).toContain("a, b, c +2");
  });

  it("drops the local/network tag rather than letting the box cut it to 'netwo...' on a narrow terminal", () => {
    const text = renderBanner(base, createConsoleUi(caps(45))).join("\n");
    expect(text).not.toContain("netwo…");
    expect(text).toContain("http://10.142.61.29:8080");
  });

  it("ASCII mode emits no non-ASCII character anywhere in the banner", () => {
    for (const line of renderBanner(
      base,
      createConsoleUi(caps(45, { unicode: false })),
    ))
      expect(nonAscii(line)).toBe(false);
  });
});

describe("formatRequestLine", () => {
  it("fits the terminal at phone and wide widths, truncating the URL rather than the status", () => {
    const url = "/workspaces/ws_V1StGXR8_Z5jdHi6B-myT/jobs/job_0a1b2c3d4e5f";
    for (const columns of [24, 45, 64, 100]) {
      const line = formatRequestLine(
        createConsoleUi(caps(columns)),
        Date.now(),
        "POST",
        url,
        202,
        12.4,
      );
      expect(visibleWidth(line)).toBeLessThanOrEqual(columns);
      expect(line).toContain("202");
    }
  });

  it("only shows the clock on terminals wide enough for it", () => {
    expect(
      formatRequestLine(
        createConsoleUi(caps(100)),
        Date.now(),
        "GET",
        "/health",
        200,
        3,
      ),
    ).toMatch(/\d\d:\d\d:\d\d/);
    expect(
      /\d\d:\d\d:\d\d/.test(
        formatRequestLine(
          createConsoleUi(caps(45)),
          Date.now(),
          "GET",
          "/health",
          200,
          3,
        ),
      ),
    ).toBe(false);
  });

  it("formats durations from sub-10ms precision up to seconds", () => {
    expect(formatDuration(4.2)).toBe("4.2ms");
    expect(formatDuration(25.6)).toBe("26ms");
    expect(formatDuration(1850)).toBe("1.9s");
  });
});

describe("createPrettyLogStream", () => {
  const T = 1791013911000;
  const pino = (o) =>
    JSON.stringify({
      level: 30,
      time: T,
      pid: 1,
      hostname: "localhost",
      ...o,
    }) + "\n";
  const req = (id, method, url, t = T) =>
    pino({
      time: t,
      reqId: id,
      req: {
        method,
        url,
        host: "localhost:8080",
        remoteAddress: "127.0.0.1",
        remotePort: 1,
      },
      msg: "incoming request",
    });
  const done = (id, status, ms, t = T) =>
    pino({
      time: t,
      reqId: id,
      res: { statusCode: status },
      responseTime: ms,
      msg: "request completed",
    });
  const make = (columns = 100, extra = {}) => {
    const out = [];
    const { stream, flush } = createPrettyLogStream(
      createConsoleUi(caps(columns, extra)),
      (t) => out.push(t),
    );
    return { stream, flush, text: () => out.join("") };
  };

  it("turns an incoming/completed pair into one line, and never shows the raw JSON", () => {
    const s = make();
    s.stream.write(req("r1", "GET", "/health") + done("r1", 200, 25.6));
    expect(s.text()).toContain("GET");
    expect(s.text()).toContain("/health");
    expect(s.text()).toContain("200");
    expect(s.text()).toContain("26ms");
    expect(s.text()).not.toContain("incoming request");
    expect(s.text()).not.toContain('"level"');
    expect(s.text().trim().split("\n")).toHaveLength(1);
  });

  it("drops Fastify's per-interface 'Server listening at' lines and our own listening line", () => {
    const s = make();
    for (const a of ["127.0.0.1", "10.0.0.2"])
      s.stream.write(pino({ msg: `Server listening at http://${a}:8080` }));
    s.stream.write(
      pino({ msg: "HexForge Gateway listening on http://0.0.0.0:8080" }),
    );
    expect(s.text()).toBe("");
  });

  it("collapses a polling burst of identical requests into one line plus a summary", () => {
    const s = make();
    for (let i = 0; i < 12; i++)
      s.stream.write(
        req(`p${i}`, "GET", "/jobs/job_1", T + i * 700) +
          done(`p${i}`, 200, 3, T + i * 700 + 3),
      );
    s.flush();
    expect((s.text().match(/\/jobs\/job_1/g) || []).length).toBe(1);
    expect(s.text()).toContain("same request ×11");
  });

  it("does not collapse requests that differ, or identical ones more than 2 seconds apart", () => {
    const s = make();
    s.stream.write(req("a", "GET", "/x", T) + done("a", 200, 1, T));
    s.stream.write(req("b", "GET", "/y", T + 100) + done("b", 200, 1, T + 100));
    s.stream.write(
      req("c", "GET", "/y", T + 5000) + done("c", 200, 1, T + 5000),
    );
    expect((s.text().match(/GET/g) || []).length).toBe(3);
    expect(s.text()).not.toContain("same request");
  });

  it("flushes a pending summary before printing any other line, so order is preserved", () => {
    const s = make();
    for (let i = 0; i < 3; i++)
      s.stream.write(
        req(`p${i}`, "GET", "/jobs/j", T + i * 100) +
          done(`p${i}`, 200, 2, T + i * 100),
      );
    s.stream.write(pino({ level: 40, time: T + 500, msg: "disk almost full" }));
    const text = s.text();
    expect(text.indexOf("same request")).toBeLessThan(
      text.indexOf("disk almost full"),
    );
  });

  it("renders warnings and errors with a badge, the error message, and a muted stack", () => {
    const s = make();
    s.stream.write(
      pino({
        level: 40,
        msg: "failed to persist job",
        err: { message: "ENOSPC" },
      }),
    );
    s.stream.write(
      pino({
        level: 50,
        msg: "indexer crashed",
        err: {
          message: "boom",
          stack: "Error: boom\n    at a (/x.ts:1:1)\n    at b (/y.ts:2:2)",
        },
      }),
    );
    const text = s.text();
    expect(text).toContain("warn");
    expect(text).toContain("failed to persist job - ENOSPC");
    expect(text).toContain("error");
    expect(text).toContain("at a (/x.ts:1:1)");
  });

  it("shows other structured fields as key=value, without pid/hostname noise", () => {
    const s = make();
    s.stream.write(pino({ msg: "job done", jobId: "job_1", attempts: 2 }));
    expect(s.text()).toContain("jobId=job_1");
    expect(s.text()).toContain("attempts=2");
    expect(s.text()).not.toContain("hostname");
  });

  it("reassembles a log line split across two writes", () => {
    const s = make();
    const line = req("r1", "GET", "/health") + done("r1", 200, 5);
    s.stream.write(line.slice(0, 40));
    expect(s.text()).toBe("");
    s.stream.write(line.slice(40));
    expect(s.text()).toContain("/health");
  });

  it("passes a line that isn't JSON through untouched instead of dropping it", () => {
    const s = make();
    s.stream.write("something wrote straight to the stream\n");
    expect(s.text()).toContain("something wrote straight to the stream");
  });

  it("tolerates a completed request whose 'incoming' line it never saw", () => {
    const s = make();
    s.stream.write(done("orphan", 500, 9));
    expect(s.text()).toContain("500");
  });

  it.each([24, 45, 100])(
    "never exceeds a %s-column terminal, including wrapped warnings and stack frames",
    (columns) => {
      const s = make(columns);
      s.stream.write(
        req("r1", "POST", "/workspaces/ws_V1StGXR8_Z5jdHi6B-myT/jobs") +
          done("r1", 502, 1850),
      );
      s.stream.write(
        pino({
          level: 40,
          msg: "a long warning message that has to wrap onto several lines on a narrow screen",
          err: { message: "ENOSPC: no space left on device" },
        }),
      );
      s.stream.write(
        pino({
          level: 50,
          msg: "crash",
          err: {
            message: "x",
            stack:
              "Error: x\n    at someVeryLongFunctionName (/src/modules/knowledge/knowledge-indexer.ts:41:9)",
          },
        }),
      );
      s.flush();
      expect(widest(s.text().split("\n"))).toBeLessThanOrEqual(columns);
    },
  );

  it("ASCII mode emits no non-ASCII character", () => {
    const s = make(45, { unicode: false });
    for (let i = 0; i < 3; i++)
      s.stream.write(
        req(`p${i}`, "GET", "/jobs/j", T + i * 100) +
          done(`p${i}`, 200, 2, T + i * 100),
      );
    s.stream.write(pino({ level: 40, msg: "warning" }));
    s.stream.write(pino({ level: 50, msg: "error", err: { message: "e" } }));
    s.flush();
    expect(nonAscii(s.text())).toBe(false);
  });
});

describe("notice (plain mode, which is what a non-terminal gets)", () => {
  it("prints exactly '[tag] message' to the console method for its level - the format these call sites always used", () => {
    const seen = [];
    const original = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    console.log = (m) => seen.push(["log", m]);
    console.warn = (m) => seen.push(["warn", m]);
    console.error = (m) => seen.push(["error", m]);
    try {
      notice("inbox-watcher", "info", "claimed app.apk");
      notice("plugin:x", "warn", "idle");
      notice("plugins", "error", "failed to load");
    } finally {
      Object.assign(console, original);
    }
    expect(seen).toEqual([
      ["log", "[inbox-watcher] claimed app.apk"],
      ["warn", "[plugin:x] idle"],
      ["error", "[plugins] failed to load"],
    ]);
  });
});

describe("packageVersion", () => {
  it("returns a version string (or 'dev' if package.json can't be read)", () => {
    expect(typeof packageVersion()).toBe("string");
    expect(packageVersion().length > 0).toBe(true);
  });
});
