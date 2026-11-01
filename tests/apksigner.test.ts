import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyFileSync, existsSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { McpTask } from "../src/core/types.js";

// The signer shells out to apksigner, zipalign and keytool. These tests replace
// node's execFile with a fake that stands in for those tools - recording every
// call and doing the file work the real ones would (copying the APK, creating the
// keystore) - so the sequence of commands and the results can be checked anywhere,
// without the Android SDK installed.
type Tool = (args: string[]) => string | void;
type Tools = Record<string, Tool>;

const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1] as string;

const VERIFY_OUTPUT = [
  "Verifies",
  "Verified using v1 scheme (JAR signing): true",
  "Verified using v2 scheme (APK Signature Scheme v2): true",
  "Verified using v3 scheme (APK Signature Scheme v3): false",
].join("\n");

/** The Android SDK's tools: apksigner answers --version, zipalign and keytool exist. */
function sdkTools(over: Tools = {}): Tools {
  return {
    apksigner: (args) => {
      if (args[0] === "--version") return "0.9\n";
      if (args[0] === "sign") {
        copyFileSync(args[args.length - 1] as string, flagValue(args, "--out"));
        return;
      }
      if (args[0] === "verify") return VERIFY_OUTPUT;
      throw Object.assign(new Error("usage"), { code: 2 });
    },
    zipalign: (args) => copyFileSync(args[3] as string, args[4] as string),
    keytool: (args) => writeFileSync(flagValue(args, "-keystore"), "keystore"),
    ...over,
  };
}

/** Termux's lightweight apksigner: no --version, and `apksigner [-p password] keystore in out`. */
function liteTools(): Tools {
  return {
    apksigner: (args) => {
      if (args[0] !== "-p") {
        throw Object.assign(new Error("usage: apksigner [-p password] ..."), { code: 1 });
      }
      writeFileSync(args[2] as string, "keystore");
      copyFileSync(args[3] as string, args[4] as string);
    },
  };
}

let root: string;
let apk: string;
let calls: { file: string; args: string[] }[];
let handler: (task: McpTask) => Promise<unknown>;

const fakeExecFile = (tools: Tools) =>
  vi.fn((file: string, args: string[], _options: unknown, callback: (...a: unknown[]) => void) => {
    calls.push({ file, args });
    const tool = tools[file];
    if (!tool) {
      callback(Object.assign(new Error(`spawn ${file} ENOENT`), { code: "ENOENT" }));
      return;
    }
    try {
      callback(null, { stdout: tool(args) ?? "", stderr: "" });
    } catch (err) {
      callback(err);
    }
  });

async function load(tools: Tools) {
  vi.resetModules();
  vi.stubEnv("DATA_DIR", path.join(root, "data"));
  vi.stubEnv("WORKSPACES_ROOT", path.join(root, "workspaces"));
  vi.doMock("node:child_process", () => ({ execFile: fakeExecFile(tools) }));
  const agent = await import("../src/modules/mcp/agents/apksigner.agent.js");
  agent.clearSignerCache();
  handler = agent.apksignerHandler;
}

const sign = (payload: Record<string, unknown> = {}, id = "t1") =>
  handler({
    id,
    workspaceId: "ws1",
    agent: "apksigner",
    operation: "sign",
    payload: { apkPath: apk, ...payload },
    status: "running",
    createdAt: "",
    updatedAt: "",
  } as McpTask) as Promise<Record<string, any>>;

const commands = () => calls.map((c) => `${c.file} ${c.args[0] ?? ""}`.trim());

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "hexforge-sign-"));
  apk = path.join(root, "rebuilt.apk");
  await writeFile(apk, "apk bytes");
  calls = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.doUnmock("node:child_process");
  await rm(root, { recursive: true, force: true });
});

describe("apksigner sign (Android SDK tools)", () => {
  it("aligns, signs with a generated debug key, verifies, and returns the signed APK", async () => {
    await load(sdkTools());

    const result = await sign();

    expect(commands()).toEqual([
      "apksigner --version",
      "keytool -genkeypair",
      "zipalign -f",
      "apksigner sign",
      "apksigner verify",
    ]);
    expect(result).toMatchObject({ signed: true, flavor: "sdk", aligned: true });
    expect(result.schemes).toEqual(["v1", "v2"]);
    expect(result.warnings).toBeUndefined();
    expect(result.apkPath).toBe(result.outputPath);
    expect(result.outputPath).toBe(
      path.join(root, "workspaces", "ws1", "apksigner", "signed", "rebuilt-signed.apk"),
    );
    expect(await readFile(result.outputPath, "utf8")).toBe("apk bytes");
  });

  it("signs the aligned copy with the debug key, then removes that temporary copy", async () => {
    await load(sdkTools());

    const result = await sign();

    const signCall = calls.find((c) => c.file === "apksigner" && c.args[0] === "sign");
    const args = signCall?.args ?? [];
    expect(args).toEqual(
      expect.arrayContaining(["--ks-pass", "pass:android", "--key-pass", "pass:android"]),
    );
    expect(flagValue(args, "--out")).toBe(result.outputPath);
    const aligned = args[args.length - 1] as string;
    expect(aligned).not.toBe(apk);
    expect(existsSync(aligned)).toBe(false);
  });

  it("creates the debug keystore once and reuses it", async () => {
    await load(sdkTools());

    await sign({ outputName: "one.apk" });
    calls.length = 0;
    await sign({ outputName: "two.apk" }, "t2");

    expect(commands()).not.toContain("keytool -genkeypair");
    expect(existsSync(path.join(root, "data", "signing", "debug.keystore"))).toBe(true);
  });

  it("signs unaligned, and says so, when zipalign isn't installed", async () => {
    const tools = sdkTools();
    delete tools.zipalign;
    await load(tools);

    const result = await sign();

    expect(result.aligned).toBe(false);
    expect(result.warnings?.[0]).toMatch(/zipalign was not found/);
    const signCall = calls.find((c) => c.file === "apksigner" && c.args[0] === "sign");
    expect(signCall?.args.at(-1)).toBe(apk);
  });

  it("removes the signed APK and fails when it doesn't verify", async () => {
    await load(
      sdkTools({
        apksigner: (args) => {
          if (args[0] === "--version") return "0.9\n";
          if (args[0] === "sign") {
            copyFileSync(args.at(-1) as string, flagValue(args, "--out"));
            return;
          }
          throw Object.assign(new Error("DOES NOT VERIFY"), { code: 1 });
        },
      }),
    );

    await expect(sign()).rejects.toThrow(/DOES NOT VERIFY/);
    const signedDir = path.join(root, "workspaces", "ws1", "apksigner", "signed");
    expect(existsSync(path.join(signedDir, "rebuilt-signed.apk"))).toBe(false);
  });
});

describe("apksigner sign (Termux's lightweight apksigner)", () => {
  it("is detected, and signs with its own command line, without keytool or zipalign", async () => {
    await load(liteTools());

    const result = await sign();

    expect(commands()).toEqual(["apksigner --version", "apksigner -p"]);
    const [, signCall] = calls;
    expect(signCall?.args).toEqual([
      "-p",
      "android",
      path.join(root, "data", "signing", "debug.keystore"),
      apk,
      result.outputPath,
    ]);
    expect(result).toMatchObject({ signed: true, flavor: "lite" });
    expect(result.warnings?.[0]).toMatch(/lightweight apksigner/);
    expect(await readFile(result.outputPath, "utf8")).toBe("apk bytes");
  });

  it("an explicit flavor skips the detection", async () => {
    await load(liteTools());

    const result = await sign({ flavor: "lite" });

    expect(commands()).toEqual(["apksigner -p"]);
    expect(result.flavor).toBe("lite");
  });
});

describe("apksigner sign input", () => {
  beforeEach(() => load(sdkTools()));

  it("takes the previous workflow step's outputPath when there is no apkPath", async () => {
    const result = await sign({ apkPath: undefined, outputPath: apk });

    expect(result.signed).toBe(true);
  });

  it("uses outputName for the signed file, and refuses anything that is a path", async () => {
    const result = await sign({ outputName: "mine.apk" });
    expect(path.basename(result.outputPath)).toBe("mine.apk");

    for (const outputName of ["a/b.apk", "..\\x.apk", "../x.apk"]) {
      await expect(sign({ outputName })).rejects.toThrow(/plain file name/);
    }
  });

  it("refuses a missing file, a non-APK, and no path at all", async () => {
    await expect(sign({ apkPath: path.join(root, "nope.apk") })).rejects.toThrow(/File not found/);
    await writeFile(path.join(root, "x.zip"), "z");
    await expect(sign({ apkPath: path.join(root, "x.zip") })).rejects.toThrow(/Expected an .apk/);
    await expect(sign({ apkPath: undefined })).rejects.toThrow(/requires "apkPath"/);
  });

  it("says how to install the tools when apksigner isn't there", async () => {
    await load({});

    await expect(sign()).rejects.toThrow(/pkg install apksigner/);
  });

  it("rejects an operation it doesn't have", async () => {
    await expect(
      handler({ id: "t", workspaceId: "ws1", operation: "verify", payload: {} } as McpTask),
    ).rejects.toThrow(/Supported: "sign"/);
  });
});
