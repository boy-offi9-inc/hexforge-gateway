import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apksignerHandler } from "../src/modules/mcp/agents/apksigner.agent.js";
import { clearSignerCache } from "../src/modules/mcp/agents/apksigner.agent.js";
import type { McpTask } from "../src/core/types.js";

vi.mock("../src/events/event-bus.js", () => ({ eventBus: { on: vi.fn(), emit: vi.fn() } }));

function makeTask(payload: Record<string, unknown>): McpTask {
  return {
    id: "t-" + Math.random().toString(36).slice(2),
    kind: "apksigner",
    operation: "sign",
    payload,
    workspaceId: "ws-sign-" + Math.random().toString(36).slice(2),
  } as unknown as McpTask;
}

// execFile mocks that record calls and let each test shape the outputs
let calls: { file: string; args: string[] }[] = [];
let verifyOutput = "Verified using v2 scheme (APK Signature Scheme v2): true\n";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(
    (
      file: string,
      args: string[],
      _o: unknown,
      cb: (e: unknown, o: { stdout: string; stderr: string }) => void,
    ) => {
      calls.push({ file, args });
      if (file === "apksigner" && args[0] === "verify") {
        cb(null, { stdout: verifyOutput, stderr: "" });
      } else {
        cb(null, { stdout: "ok", stderr: "" });
      }
    },
  ),
}));

describe("apksigner sign with an own keystore", () => {
  let dir: string;
  let apk: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "hexforge-sign-"));
    apk = path.join(dir, "app.apk");
    await writeFile(apk, "fake apk bytes");
    calls = [];
    verifyOutput = "Verified using v2 scheme (APK Signature Scheme v2): true\n";
    vi.resetModules();
    vi.stubEnv("WORKSPACES_ROOT", path.join(dir, "workspaces"));
    clearSignerCache();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("signs with the caller's keystore path, pass and alias (sdk flavor)", async () => {
    const keystore = path.join(dir, "release.jks");
    await writeFile(keystore, "fake keystore");
    const result = (await apksignerHandler(
      makeTask({
        apkPath: apk,
        flavor: "sdk",
        keystorePath: keystore,
        keystorePass: "hunter2",
        keystoreAlias: "release",
      }),
    )) as { signed: boolean; warnings?: string[] };

    expect(result.signed).toBe(true);
    const signCall = calls.find((c) => c.file === "apksigner" && c.args[0] === "sign");
    expect(signCall).toBeDefined();
    expect(signCall!.args).toContain(keystore);
    expect(signCall!.args).toContain("release");
    expect(signCall!.args).toContain("pass:hunter2");
    // the debug keystore was never used
    const debugKey = calls.find((c) => c.args.includes("debug.keystore"));
    expect(debugKey).toBeUndefined();
    expect(result.warnings?.join(" ")).toContain("caller-provided keystore");
  });

  it("refuses a keystorePath without keystorePass, and a missing keystore file", async () => {
    await expect(
      apksignerHandler(
        makeTask({ apkPath: apk, flavor: "sdk", keystorePath: path.join(dir, "x.jks") }),
      ),
    ).rejects.toThrow(/keystorePass/);
    await expect(
      apksignerHandler(
        makeTask({
          apkPath: apk,
          flavor: "sdk",
          keystorePath: path.join(dir, "nope.jks"),
          keystorePass: "p",
        }),
      ),
    ).rejects.toThrow(/Keystore not found/);
  });

  it("still works without keystore options (debug key path)", async () => {
    const result = (await apksignerHandler(makeTask({ apkPath: apk, flavor: "sdk" }))) as {
      signed: boolean;
    };
    expect(result.signed).toBe(true);
    const signCall = calls.find((c) => c.file === "apksigner" && c.args[0] === "sign");
    expect(signCall!.args).toContain("hexforge-debug");
  });

  it("surfaces which schemes verified", async () => {
    const result = (await apksignerHandler(makeTask({ apkPath: apk, flavor: "sdk" }))) as {
      schemes: string[];
    };
    expect(result.schemes).toEqual(["v2"]);
  });
});
