/**
 * The curated set of MCP tools this server exposes. Not a 1:1 mirror of
 * every agent/operation the Gateway supports - picked for what's most
 * useful to an AI client driving reverse-engineering work directly,
 * matching the granularity other MCP servers in this space use (one tool
 * per meaningful capability, with a real JSON Schema) rather than one
 * generic "dispatch a task" tool.
 *
 * Every workspace-scoped tool takes an optional `workspace` argument (a
 * name, not an id) defaulting to `"default"` if omitted - resolved
 * through the Gateway's get-or-create-by-name endpoint, so a caller never
 * needs to know or track a workspace id.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface AgentToolSpec extends ToolDefinition {
  agent: string;
  operation: string;
}

const workspaceProp = {
  type: "string",
  description: 'Workspace name (not id) - created automatically if it doesn\'t exist yet. Defaults to "default".',
};

export const AGENT_TOOLS: AgentToolSpec[] = [
  {
    name: "decompile_apk",
    description: "Decompile an APK to readable Java-like source with jadx. Requires jadx on PATH.",
    agent: "jadx",
    operation: "decompile",
    inputSchema: {
      type: "object",
      properties: { workspace: workspaceProp, apkPath: { type: "string", description: "Absolute path to the .apk file" } },
      required: ["apkPath"],
    },
  },
  {
    name: "decode_apk",
    description:
      "Decode an APK's resources to editable XML and disassemble code to smali with apktool (unlike jadx, the result can be rebuilt). Requires apktool on PATH.",
    agent: "apktool",
    operation: "decode",
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        apkPath: { type: "string", description: "Absolute path to the .apk file" },
        noSrc: { type: "boolean", description: "Skip disassembling code - resources only, faster" },
        noRes: { type: "boolean", description: "Skip decoding resources - smali only" },
      },
      required: ["apkPath"],
    },
  },
  {
    name: "build_apk",
    description:
      "Rebuild an APK from an apktool-decoded (and possibly edited) project directory. The result is unsigned - sign it separately before installing. Requires apktool on PATH.",
    agent: "apktool",
    operation: "build",
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        inputDir: { type: "string", description: "The decoded project directory (from decode_apk), possibly edited" },
        outputName: { type: "string", description: 'Output file name, e.g. "rebuilt.apk"' },
      },
      required: ["inputDir"],
    },
  },
  {
    name: "identify_packer",
    description:
      "Fingerprint the compiler, packer, obfuscator, and anti-debug/anti-VM techniques used in an APK, via APKiD's YARA rules. Requires apkid on PATH (pip install apkid).",
    agent: "apkid",
    operation: "identify",
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        apkPath: { type: "string", description: "Absolute path to the .apk (or .dex) file" },
        timeoutSeconds: { type: "number", description: "Per-file YARA scan timeout, default 30" },
      },
      required: ["apkPath"],
    },
  },
  {
    name: "scan_secrets",
    description:
      "Recursively scan a directory (e.g. jadx/apktool output) for likely hardcoded secrets - AWS/Google API keys, private key headers, Slack/GitHub tokens, JWTs. A curated high-precision starting set, not exhaustive - not a replacement for a maintained secret-scanner on anything that actually matters.",
    agent: "filesystem",
    operation: "scan-secrets",
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        dirPath: { type: "string", description: "Directory to scan, e.g. a jadx output directory" },
        extensions: { type: "array", items: { type: "string" }, description: 'File extensions to include, e.g. [".java", ".xml"]. Omit to scan all non-binary-looking files.' },
        maxResults: { type: "number", description: "Cap on results, default/max 200" },
      },
      required: ["dirPath"],
    },
  },
  {
    name: "search_code",
    description: "Search a directory tree for a regex pattern - e.g. permission strings in decompiled output.",
    agent: "filesystem",
    operation: "search",
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        dirPath: { type: "string", description: "Directory to search" },
        pattern: { type: "string", description: "A regular expression" },
        caseSensitive: { type: "boolean" },
        extensions: { type: "array", items: { type: "string" } },
        maxResults: { type: "number", description: "Cap on results, default/max 200" },
      },
      required: ["dirPath", "pattern"],
    },
  },
  {
    name: "read_file",
    description: "Read a file's contents.",
    agent: "filesystem",
    operation: "read",
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        filePath: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"], description: "Default utf8; use base64 for binary files." },
      },
      required: ["filePath"],
    },
  },
  {
    name: "list_files",
    description: "List a directory's contents.",
    agent: "filesystem",
    operation: "list",
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        dirPath: { type: "string" },
        recursive: { type: "boolean" },
        limit: { type: "number", description: "Default/max 500 entries" },
      },
      required: ["dirPath"],
    },
  },
  {
    name: "adb_devices",
    description: "List connected Android devices/emulators. Requires adb on PATH.",
    agent: "adb",
    operation: "devices",
    inputSchema: { type: "object", properties: { workspace: workspaceProp } },
  },
  {
    name: "adb_shell",
    description:
      "Run a shell command on a connected Android device via adb. As powerful as `adb shell` itself - only use against a device you control.",
    agent: "adb",
    operation: "shell",
    inputSchema: {
      type: "object",
      properties: { workspace: workspaceProp, command: { type: "string" }, deviceSerial: { type: "string", description: "Only needed with more than one device connected" } },
      required: ["command"],
    },
  },
  {
    name: "adb_install",
    description: "Install an APK on a connected device via adb.",
    agent: "adb",
    operation: "install",
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        apkPath: { type: "string" },
        reinstall: { type: "boolean", description: "Pass -r to allow reinstalling over an existing install" },
        deviceSerial: { type: "string" },
      },
      required: ["apkPath"],
    },
  },
  {
    name: "adb_logcat",
    description: "Dump and tail the current logcat buffer from a connected device (a snapshot, not a live stream).",
    agent: "adb",
    operation: "logcat",
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        filter: { type: "string", description: 'logcat filterspec, e.g. "MyTag:D *:S"' },
        lines: { type: "number", description: "How many lines to tail, default 200" },
        deviceSerial: { type: "string" },
      },
    },
  },
  {
    name: "frida_list_processes",
    description: "List running processes (or installed apps) on a device via Frida. Requires frida-tools on PATH and a matching frida-server on the device.",
    agent: "frida",
    operation: "list-processes",
    inputSchema: {
      type: "object",
      properties: { workspace: workspaceProp, includeApps: { type: "boolean", description: "List installed apps, not just running processes" }, deviceSerial: { type: "string" } },
    },
  },
  {
    name: "frida_trace",
    description:
      "Spawn or attach to a process, inject a Frida script, and capture whatever it emits within a bounded time window (this isn't a real interactive Frida session - it runs the script, waits, then stops it). Requires frida-tools + a matching frida-server on the device.",
    agent: "frida",
    operation: "trace",
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        target: { type: "string", description: "Package name (spawn mode) or PID/process name (attach mode)" },
        mode: { type: "string", enum: ["spawn", "attach"], description: "Default spawn" },
        script: { type: "string", description: "Raw Frida JavaScript to inject" },
        timeoutSeconds: { type: "number", description: "Default 15, capped at 60" },
        deviceSerial: { type: "string" },
      },
      required: ["target", "script"],
    },
  },
  {
    name: "summarize_text",
    description: "Summarize arbitrary text (e.g. tool output) using the Gateway's configured AI provider.",
    agent: "ai",
    operation: "summarize",
    inputSchema: {
      type: "object",
      properties: { workspace: workspaceProp, content: { type: "string" }, instructions: { type: "string", description: "Optional extra instructions for the summary" } },
      required: ["content"],
    },
  },
];

/** Tools with bespoke logic (workspace management, knowledge, chat) instead of a straight agent-job mapping. */
export const META_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_workspaces",
    description: "List every workspace that exists on the Gateway.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_or_create_workspace",
    description: "Get or create a workspace by name - idempotent, safe to call every time you start working on something.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, targetLabel: { type: "string", description: "Defaults to the workspace name" } },
      required: ["name"],
    },
  },
  {
    name: "list_knowledge",
    description: "List a workspace's knowledge base entries - reports (auto-generated from finished workflows), notes, summaries, chat history.",
    inputSchema: {
      type: "object",
      properties: { workspace: workspaceProp, type: { type: "string", enum: ["report", "note", "summary", "chat"] } },
    },
  },
  {
    name: "chat_with_workspace",
    description:
      "Send a message in a workspace's ongoing chat and get a reply, with real multi-turn history (not a one-shot completion) - useful for asking questions about accumulated findings without re-explaining context every time.",
    inputSchema: {
      type: "object",
      properties: { workspace: workspaceProp, message: { type: "string" } },
      required: ["message"],
    },
  },
];

export const ALL_TOOL_DEFINITIONS: ToolDefinition[] = [...META_TOOL_DEFINITIONS, ...AGENT_TOOLS];
