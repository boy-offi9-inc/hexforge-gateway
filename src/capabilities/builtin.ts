import type { AdapterDescriptor } from "./types.js";

type Descriptor = Omit<AdapterDescriptor, "kind">;

/**
 * Descriptors for the built-in agents, keyed by the agent kind registered in
 * modules/mcp/orchestrator.ts. Operation names and payload keys mirror what
 * each handler actually accepts. `outputs` is only declared where the result
 * points at a file or directory the Gateway can track.
 */
export const builtinDescriptors = {
  jadx: {
    description: "Headless JADX decompiler (CLI).",
    backends: [{ tool: "jadx" }],
    permissions: ["fs:workspace"],
    operations: [
      {
        name: "decompile",
        capability: "java.decompile",
        inputs: { required: ["apkPath"] },
        outputs: ["java-sources"],
      },
    ],
  },
  apktool: {
    description: "APKTool decode/rebuild for smali and resources.",
    backends: [{ tool: "apktool" }],
    permissions: ["fs:workspace"],
    operations: [
      {
        name: "decode",
        capability: "android.decode",
        inputs: { required: ["apkPath"], optional: ["noSrc", "noRes"] },
        outputs: ["apktool-project"],
      },
      {
        name: "build",
        capability: "android.rebuild",
        inputs: { required: ["inputDir"], optional: ["outputName"] },
        outputs: ["apk"],
      },
    ],
  },
  apkid: {
    description: "APKiD packer/obfuscator/compiler identification.",
    backends: [{ tool: "apkid" }],
    permissions: ["fs:workspace"],
    operations: [
      {
        name: "identify",
        capability: "android.fingerprint",
        inputs: { required: ["apkPath"], optional: ["timeoutSeconds"] },
      },
    ],
  },
  adb: {
    description: "Android Debug Bridge device control.",
    backends: [{ tool: "adb" }],
    permissions: ["device:adb"],
    operations: [
      { name: "devices", capability: "device.list" },
      {
        name: "packages",
        capability: "device.packages",
        inputs: { optional: ["filter", "deviceSerial"] },
      },
      {
        name: "install",
        capability: "device.install",
        inputs: { required: ["apkPath"], optional: ["reinstall", "deviceSerial"] },
      },
      {
        name: "uninstall",
        capability: "device.uninstall",
        inputs: { required: ["packageName"], optional: ["keepData", "deviceSerial"] },
      },
      {
        name: "shell",
        capability: "device.shell",
        inputs: { required: ["command"], optional: ["deviceSerial"] },
      },
      {
        name: "logcat",
        capability: "device.logcat",
        inputs: { optional: ["lines", "filter", "deviceSerial"] },
      },
      {
        name: "pull",
        capability: "device.pull",
        inputs: { required: ["remotePath"], optional: ["fileName", "deviceSerial"] },
      },
      {
        name: "push",
        capability: "device.push",
        inputs: { required: ["localPath", "remotePath"], optional: ["deviceSerial"] },
      },
    ],
  },
  frida: {
    description: "Frida device/process listing, server control and bounded tracing.",
    backends: [{ tool: "frida" }, { tool: "frida-server" }],
    permissions: ["device:adb"],
    operations: [
      { name: "list-devices", capability: "instrument.devices" },
      {
        name: "list-processes",
        capability: "instrument.processes",
        inputs: { optional: ["includeApps", "deviceSerial"] },
      },
      {
        name: "push-server",
        capability: "instrument.server",
        inputs: { required: ["localServerPath"], optional: ["remotePath", "deviceSerial"] },
      },
      {
        name: "start-server",
        capability: "instrument.server",
        inputs: { optional: ["remotePath", "deviceSerial"] },
      },
      {
        name: "stop-server",
        capability: "instrument.server",
        inputs: { optional: ["deviceSerial"] },
      },
      {
        name: "trace",
        capability: "instrument.trace",
        inputs: {
          required: ["target", "script"],
          optional: ["mode", "timeoutSeconds", "deviceSerial"],
        },
        cancellable: false,
      },
    ],
  },
  apkmcp: {
    description: "Client for an external APK MCP server (APK browsing and search).",
    backends: [{ tool: "apk-mcp" }],
    permissions: ["network"],
    operations: [
      { name: "list_tools", capability: "mcp.list-tools" },
      {
        name: "call_tool",
        capability: "mcp.call-tool",
        inputs: { required: ["tool"], optional: ["arguments"] },
      },
      {
        name: "list_available_apks",
        capability: "apk.list",
        inputs: { optional: ["prefix", "limit"] },
      },
      {
        name: "open",
        capability: "java.browse",
        inputs: { required: ["path"], optional: ["temporary"] },
      },
      {
        name: "list",
        capability: "java.browse",
        inputs: { required: ["workspaceId"], optional: ["view", "prefix", "limit"] },
      },
      {
        name: "outline_class",
        capability: "java.browse",
        inputs: { required: ["workspaceId", "locator"], optional: ["limit"] },
      },
      {
        name: "read_text",
        capability: "java.browse",
        inputs: { required: ["workspaceId", "locator"], optional: ["limit"] },
      },
      {
        name: "search",
        capability: "java.search",
        inputs: {
          required: ["workspaceId", "query"],
          optional: ["target", "queryType", "caseSensitive", "matchMode", "prefix", "limit"],
        },
      },
      {
        name: "close",
        capability: "java.browse",
        inputs: { required: ["workspaceId"] },
      },
    ],
  },
  filesystem: {
    description: "File operations (writes sandboxed to the workspace) and secret scanning.",
    permissions: ["fs:read", "fs:workspace"],
    operations: [
      {
        name: "list",
        capability: "fs.read",
        inputs: { required: ["dirPath"], optional: ["recursive", "limit"] },
      },
      {
        name: "read",
        capability: "fs.read",
        inputs: { required: ["filePath"], optional: ["encoding"] },
      },
      { name: "stat", capability: "fs.read", inputs: { required: ["filePath"] } },
      {
        name: "search",
        capability: "fs.search",
        inputs: {
          required: ["dirPath", "pattern"],
          optional: ["caseSensitive", "extensions", "maxResults"],
        },
      },
      {
        name: "write",
        capability: "fs.write",
        inputs: { required: ["filePath", "content"], optional: ["encoding"] },
      },
      { name: "delete", capability: "fs.write", inputs: { required: ["filePath"] } },
      {
        name: "scan-secrets",
        capability: "secrets.scan",
        inputs: { required: ["dirPath"], optional: ["extensions", "maxResults"] },
      },
    ],
  },
  ai: {
    description: "LLM-backed summarization.",
    permissions: ["network"],
    operations: [
      {
        name: "summarize",
        capability: "ai.summarize",
        inputs: { required: ["content"], optional: ["instructions"] },
      },
    ],
  },
} satisfies Record<string, Descriptor>;
