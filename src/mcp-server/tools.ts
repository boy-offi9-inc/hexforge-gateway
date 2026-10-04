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

/**
 * MCP tool annotations (spec 2025-03-26) - hints a client can use to decide
 * whether to ask before running a tool. They describe the *analysis target*
 * (files on disk, the connected device), not the Gateway's own bookkeeping:
 * every workspace-scoped call also creates the workspace if it's missing and
 * records a job in its history, which the `workspace` parameter says out
 * loud. So "readOnlyHint: true" here means "doesn't modify the files/device
 * you're analyzing", not "writes nothing anywhere". destructiveHint and
 * idempotentHint are only meaningful when readOnlyHint is false.
 */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  annotations?: ToolAnnotations;
}

export interface AgentToolSpec extends ToolDefinition {
  agent: string;
  operation: string;
}

const workspaceProp = {
  type: "string",
  description:
    'Workspace name (not id). Created if it doesn\'t exist, and this call is recorded as a job in its history. Defaults to "default".',
};

const deviceSerialProp = {
  type: "string",
  description:
    'Device serial from adb_devices, e.g. "emulator-5554" or "R58M123ABC". Only needed when more than one device is connected; omit otherwise.',
};

// Every agent-backed tool below returns the agent job's result as compact
// JSON text; a failed job comes back as an error result carrying the agent's
// message (e.g. "jadx not found on PATH"). A call waits for its job to
// finish for up to 2 minutes - past that it errors, but the job keeps
// running in the Gateway.
export const AGENT_TOOLS: AgentToolSpec[] = [
  {
    name: "decompile_apk",
    description:
      "Decompile an APK (also .dex, .jar, .aar, .zip) to readable Java-like source with jadx, for reading and searching. The output is reference code that cannot be rebuilt into an APK - use decode_apk if you need to edit and rebuild. Writes into the workspace's jadx directory (a re-run writes into the same one) and returns { outputDir, fileCount, files, stdoutTail, stderrTail? }; files holds at most 200 relative paths, so use list_files or search_code to explore the rest. Waits up to 2 minutes for jadx; on a very large APK the call can time out with an error while the decompile keeps running in the Gateway. Requires jadx on PATH.",
    agent: "jadx",
    operation: "decompile",
    annotations: {
      title: "Decompile APK (jadx)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        apkPath: {
          type: "string",
          description:
            'Absolute path to the file to decompile, e.g. "/sdcard/Download/app.apk". Must exist; extension must be .apk, .dex, .jar, .aar or .zip. A path from get_inbox_apks works.',
        },
      },
      required: ["apkPath"],
    },
  },
  {
    name: "decode_apk",
    description:
      "Decode an APK's resources to editable XML and disassemble its code to smali with apktool, so the result can be edited and rebuilt with build_apk (unlike decompile_apk's read-only Java). Always writes to the workspace's single apktool/decode directory and replaces whatever was there, including any edits you made to a previous decode - copy it elsewhere first if you need to keep it. Returns { outputDir, fileCount, files, stdoutTail, stderrTail? }; files holds at most 200 relative paths. Requires apktool on PATH.",
    agent: "apktool",
    operation: "decode",
    annotations: {
      title: "Decode APK (apktool)",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        apkPath: {
          type: "string",
          description:
            "Absolute path to the file to decode. Must exist; extension must be .apk, .jar or .zip.",
        },
        noSrc: {
          type: "boolean",
          description:
            "Skip disassembling code to smali - decode resources only, which is faster. Default false.",
          default: false,
        },
        noRes: {
          type: "boolean",
          description: "Skip decoding resources - disassemble smali only. Default false.",
          default: false,
        },
      },
      required: ["apkPath"],
    },
  },
  {
    name: "build_apk",
    description:
      "Rebuild an APK from an apktool-decoded (and possibly edited) project directory. The result is unsigned, so it won't install until you sign it separately. Writes to the workspace's apktool/build directory (overwriting a previous build of the same name) and returns { outputPath, signed: false, stdoutTail, stderrTail? }. Fails if inputDir has no apktool.yml, i.e. isn't a decode_apk output. Requires apktool on PATH.",
    agent: "apktool",
    operation: "build",
    annotations: {
      title: "Build APK (apktool)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        inputDir: {
          type: "string",
          description:
            "Absolute path to the decoded project directory - the outputDir returned by decode_apk, possibly edited. Must contain apktool.yml.",
        },
        outputName: {
          type: "string",
          description: 'Output file name only, not a path (no "/" or ".."). Default "rebuilt.apk".',
          default: "rebuilt.apk",
        },
      },
      required: ["inputDir"],
    },
  },
  {
    name: "identify_packer",
    description:
      "Fingerprint the compiler, packer, obfuscator, and anti-debug/anti-VM techniques an APK uses, via APKiD's YARA rules - a good first look before deciding how to approach an APK. Only reads the file. Returns APKiD's own JSON report (for each scanned file, its matches grouped by category - compiler, obfuscator, packer, anti_vm and so on); if APKiD's output isn't valid JSON it returns { raw } instead. Requires apkid on PATH (pip install apkid).",
    agent: "apkid",
    operation: "identify",
    annotations: {
      title: "Identify packer/obfuscator (APKiD)",
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        apkPath: {
          type: "string",
          description: "Absolute path to the .apk (or .dex) file to scan. Must exist.",
        },
        timeoutSeconds: {
          type: "number",
          description: "Per-file YARA scan timeout in seconds. Default 30.",
          default: 30,
          minimum: 1,
        },
      },
      required: ["apkPath"],
    },
  },
  {
    name: "scan_secrets",
    description:
      "Recursively scan a directory (typically decompile_apk or decode_apk output) for likely hardcoded secrets: AWS access keys, Google API keys, private key headers, Slack/GitHub/Stripe tokens, JWTs, and Firebase Cloud Messaging keys. A curated high-precision starting set, not exhaustive, and not a replacement for a maintained secret scanner. Only reads files; skips files over 2 MB. Returns { dirPath, filesScanned, matchCount, matches: [{ file, line, text, name }], truncated } where name is the secret type, file is relative to dirPath, line is 1-based, and text is the trimmed line (max 300 chars). For your own patterns use search_code.",
    agent: "filesystem",
    operation: "scan-secrets",
    annotations: {
      title: "Scan for hardcoded secrets",
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        dirPath: {
          type: "string",
          description:
            "Absolute path of the directory to scan, e.g. the outputDir from decompile_apk. Must exist.",
        },
        extensions: {
          type: "array",
          items: { type: "string" },
          description:
            'Only scan files with these extensions - lowercase, with the leading dot, e.g. [".java", ".xml"]. Omit to scan every file except known binary types (.apk, .dex, .zip, .jar, .so, images, fonts).',
        },
        maxResults: {
          type: "number",
          description: "Stop after this many matches. Default and maximum 200.",
          default: 200,
          minimum: 1,
          maximum: 200,
        },
      },
      required: ["dirPath"],
    },
  },
  {
    name: "search_code",
    description:
      'Search a directory tree for a regular expression, line by line - e.g. a permission string or URL in decompiled output. Only reads files; skips files over 2 MB, and has a 10-second limit so a pathological regex errors instead of hanging. Returns { dirPath, filesScanned, matchCount, matches: [{ file, line, text, name }], truncated } where file is relative to dirPath, line is 1-based, text is the trimmed matching line (max 300 chars), and name is always "match". To look specifically for hardcoded credentials use scan_secrets instead.',
    agent: "filesystem",
    operation: "search",
    annotations: {
      title: "Search files for a regex",
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        dirPath: {
          type: "string",
          description: "Absolute path of the directory to search. Must exist.",
        },
        pattern: {
          type: "string",
          description:
            'A JavaScript regular expression tested against each line, e.g. "android\\\\.permission\\\\.[A-Z_]+". An invalid regex is rejected with an error.',
        },
        caseSensitive: {
          type: "boolean",
          description: "Default false (case-insensitive).",
          default: false,
        },
        extensions: {
          type: "array",
          items: { type: "string" },
          description:
            'Only search files with these extensions - lowercase, with the leading dot, e.g. [".java", ".xml"]. Omit to search every file except known binary types (.apk, .dex, .zip, .jar, .so, images, fonts).',
        },
        maxResults: {
          type: "number",
          description: "Stop after this many matches. Default and maximum 200.",
          default: 200,
          minimum: 1,
          maximum: 200,
        },
      },
      required: ["dirPath", "pattern"],
    },
  },
  {
    name: "read_file",
    description:
      "Read one file's contents by absolute path - e.g. a decompiled source file or an AndroidManifest.xml from decode_apk's output. Only reads. Content over 512 KB is cut off at 512 KB, signalled by truncated: true. Returns { filePath, size, truncated, encoding, content } where size is the full file size in bytes. Errors if the path doesn't exist or is a directory (use list_files to see what's in a directory first).",
    agent: "filesystem",
    operation: "read",
    annotations: {
      title: "Read a file",
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        filePath: {
          type: "string",
          description: "Absolute path to the file to read.",
        },
        encoding: {
          type: "string",
          enum: ["utf8", "base64"],
          description: "How content is returned. Default utf8; use base64 for binary files.",
          default: "utf8",
        },
      },
      required: ["filePath"],
    },
  },
  {
    name: "list_files",
    description:
      "List a directory's immediate children, or every file beneath it with recursive - e.g. to see what decompile_apk or decode_apk produced before reading individual files. Only reads. Returns { dirPath, count, entries: [{ path, isDirectory, size }], truncated } where path is relative to dirPath and size is in bytes (0 for directories); truncated is true if the limit cut the listing short. Errors if dirPath doesn't exist. To find files by content rather than name use search_code.",
    agent: "filesystem",
    operation: "list",
    annotations: {
      title: "List a directory",
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        dirPath: {
          type: "string",
          description: "Absolute path of the directory to list. Must exist.",
        },
        recursive: {
          type: "boolean",
          description:
            "List every entry under dirPath, not just its immediate children. Default false.",
          default: false,
        },
        limit: {
          type: "number",
          description: "Maximum entries to return. Default and maximum 500.",
          default: 500,
          minimum: 1,
          maximum: 500,
        },
      },
      required: ["dirPath"],
    },
  },
  {
    name: "adb_devices",
    description:
      'List Android devices and emulators visible to adb. Only reads, and the workspace parameter has no effect on the result - the listing is the same for any workspace. Call this first to confirm a device is connected and to get serials for the deviceSerial parameter of the other adb_* and frida_* tools. Returns { devices: [{ serial, state, extra }] } where state is e.g. "device", "unauthorized" or "offline" and extra is adb\'s remaining -l detail (model, transport). An empty list means nothing is connected. Requires adb on PATH.',
    agent: "adb",
    operation: "devices",
    annotations: {
      title: "List adb devices",
      readOnlyHint: true,
      openWorldHint: true,
    },
    inputSchema: { type: "object", properties: { workspace: workspaceProp } },
  },
  {
    name: "adb_shell",
    description:
      "Run one shell command on a connected Android device via `adb shell`. As powerful as adb shell itself and can change or delete anything the device's shell user can - only use against a device you control. Not interactive (a command that waits for input will hang). Returns { command, stdout, stderr? } with stdout cut to its last 4000 characters and stderr to its last 2000. For installing an APK use adb_install; for reading logs use adb_logcat. Requires adb on PATH and an authorized device.",
    agent: "adb",
    operation: "shell",
    annotations: {
      title: "Run adb shell command",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        command: {
          type: "string",
          description:
            'The command line to run on the device, as one string, e.g. "pm list packages -3" or "getprop ro.build.version.release".',
        },
        deviceSerial: deviceSerialProp,
      },
      required: ["command"],
    },
  },
  {
    name: "adb_install",
    description:
      'Install an APK from this machine onto a connected device via `adb install`. The APK must already be signed (build_apk output is unsigned and will be rejected). Without reinstall, installing a package that\'s already present fails; with reinstall it replaces the installed version and keeps its app data. Returns { apkPath, stdoutTail, stderrTail? } - adb prints "Success" on success and an error like INSTALL_FAILED_* otherwise. To remove an app or run other device commands use adb_shell. Requires adb on PATH and an authorized device.',
    agent: "adb",
    operation: "install",
    annotations: {
      title: "Install APK on device",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        apkPath: {
          type: "string",
          description: "Absolute path, on this machine, of the signed .apk to install. Must exist.",
        },
        reinstall: {
          type: "boolean",
          description:
            "Pass -r so an existing install is replaced (app data is kept). Default false.",
          default: false,
        },
        deviceSerial: deviceSerialProp,
      },
      required: ["apkPath"],
    },
  },
  {
    name: "adb_logcat",
    description:
      "Dump the device's current logcat buffer and return its most recent lines - a snapshot, not a live stream, and it doesn't clear the buffer. Only reads. Returns { lineCount, truncatedFrom, lines } where lines is an array of raw log lines, lineCount is how many are returned, and truncatedFrom is the total lines in the dump before trimming. Use filter to cut noise (e.g. one app's tag) before raising lines. Requires adb on PATH and an authorized device.",
    agent: "adb",
    operation: "logcat",
    annotations: {
      title: "Read logcat snapshot",
      readOnlyHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        filter: {
          type: "string",
          description:
            'Space-separated logcat filterspecs, e.g. "MyTag:D *:S" shows only MyTag at debug level and above and silences everything else. Omit for the whole buffer.',
        },
        lines: {
          type: "number",
          description: "How many of the most recent lines to return. Default 200.",
          default: 200,
          minimum: 1,
        },
        deviceSerial: deviceSerialProp,
      },
    },
  },
  {
    name: "frida_list_processes",
    description:
      "List running processes on a device via Frida, or with includeApps the installed apps too. Only reads. Use it to find the package name or PID to pass to frida_trace. Returns { processes: [...] } where each entry is { pid, name } or, with includeApps, { pid, name, identifier } - identifier is the package name, and an installed app that isn't running has no real PID. Requires frida-tools on PATH and a frida-server on the device whose version matches.",
    agent: "frida",
    operation: "list-processes",
    annotations: {
      title: "List Frida processes/apps",
      readOnlyHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        includeApps: {
          type: "boolean",
          description:
            "Also list installed apps with their package identifiers, not just running processes (frida-ps -a). Default false.",
          default: false,
        },
        deviceSerial: deviceSerialProp,
      },
    },
  },
  {
    name: "frida_trace",
    description:
      "Spawn or attach to a process on a device, inject a Frida script, and capture whatever it prints within a fixed time window - not an interactive Frida session: it runs the script, waits timeoutSeconds, then kills the session. Hitting the timeout is the normal way a trace ends (timedOut: true), not a failure. The script runs inside the target app and can modify its behavior and state, and spawn mode launches the app. Returns { target, mode, scriptPath, timedOut, stdout, stderr } where stdout is whatever the script printed (e.g. console.log output) and scriptPath is where the script was saved in the workspace. Find targets with frida_list_processes. Requires frida-tools and a matching frida-server on the device.",
    agent: "frida",
    operation: "trace",
    annotations: {
      title: "Trace a process with Frida",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        target: {
          type: "string",
          description:
            'In spawn mode, the package name to launch, e.g. "com.example.app". In attach mode, a PID (digits only) or a running process name.',
        },
        mode: {
          type: "string",
          enum: ["spawn", "attach"],
          description:
            "spawn starts the app fresh with the script loaded from the start; attach hooks an already-running process. Default spawn.",
          default: "spawn",
        },
        script: {
          type: "string",
          description:
            "Raw Frida JavaScript source to inject, e.g. an Interceptor.attach(...) hook that console.logs arguments.",
        },
        timeoutSeconds: {
          type: "number",
          description:
            "How long to let the script run before stopping it. Default 15, capped at 60.",
          default: 15,
          minimum: 1,
          maximum: 60,
        },
        deviceSerial: deviceSerialProp,
      },
      required: ["target", "script"],
    },
  },
  {
    name: "summarize_text",
    description:
      "Summarize text - e.g. long tool output - using the Gateway's configured AI provider, returning { summary } (up to about 512 tokens). The text and instructions are sent to that provider, which may be a remote API (Anthropic, OpenAI, Gemini, etc.) or a local model (Ollama), so don't pass anything you wouldn't send there. Errors if no provider is configured on the Gateway. Doesn't save anything to the knowledge base; to ask questions about a workspace's accumulated findings use chat_with_workspace instead.",
    agent: "ai",
    operation: "summarize",
    annotations: {
      title: "Summarize text with AI",
      readOnlyHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        content: {
          type: "string",
          description: "The text to summarize. Must not be empty.",
        },
        instructions: {
          type: "string",
          description:
            'Optional extra guidance for the summary, e.g. "focus on network endpoints" or "one paragraph".',
        },
      },
      required: ["content"],
    },
  },
];

/** Tools with bespoke logic (workspace management, knowledge, chat) instead of a straight agent-job mapping. */
export const META_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "list_workspaces",
    description:
      "List every workspace on the Gateway. Only reads, takes no arguments. Returns an array of { id, name, targetLabel, status, createdAt, updatedAt } where status is one of created, analyzing, ready, error and the timestamps are ISO 8601. Use it to see what already exists before choosing a workspace name; use get_or_create_workspace to make a new one.",
    annotations: {
      title: "List workspaces",
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_or_create_workspace",
    description:
      'Get a workspace by name, creating it first if it doesn\'t exist - idempotent, so safe to call every time you start work on something (calling it again never makes a duplicate or changes an existing workspace). Returns the workspace as { id, name, targetLabel, status, createdAt, updatedAt }; a new one starts with status "created". Most other tools create their workspace implicitly, so you only need this to set a targetLabel or to get the id.',
    annotations: {
      title: "Get or create a workspace",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            'Workspace name, e.g. "clite-dialer". Names are matched exactly, so reuse the same spelling to get the same workspace. Must not be empty.',
        },
        targetLabel: {
          type: "string",
          description:
            'A human-readable label for what\'s being analyzed, e.g. a package name like "com.example.app". Only used when the workspace is created; defaults to the name.',
        },
      },
      required: ["name"],
    },
  },
  {
    name: "list_knowledge",
    description:
      'List a workspace\'s knowledge base entries, newest first: reports (auto-generated when a workflow finishes), notes (including APKs claimed from the inbox), summaries, and chat history. Only reads, apart from creating the workspace if it doesn\'t exist. Returns an array of { id, workspaceId, type, title, content, source, createdAt, updatedAt, relatedEntryIds }. Without the type filter all four types are returned, chat turns included, which can be long - filter to "report" or "note" for findings. To ask a question about the findings rather than read them, use chat_with_workspace.',
    annotations: {
      title: "List knowledge entries",
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        type: {
          type: "string",
          enum: ["report", "note", "summary", "chat"],
          description: "Only return entries of this type. Omit to return every type.",
        },
      },
    },
  },
  {
    name: "get_inbox_apks",
    description:
      'List the .apk files that were dropped into the server\'s inbox folder (APK_INBOX_DIR) and automatically claimed into this workspace, newest first - use it to get a real apkPath for decompile_apk, decode_apk, identify_packer or adb_install without the user typing or pasting a path. Only reads. Returns an array of { fileName, path, sizeBytes, detectedAt }, where path is absolute. An empty array means nothing has been dropped for this workspace, or the inbox isn\'t enabled on the server. A dropped file lands in the workspace named after its filename ("MyApp-v2.apk" becomes workspace "myapp-v2"), so pass that name as workspace.',
    annotations: {
      title: "List dropped APKs",
      readOnlyHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: { workspace: workspaceProp },
    },
  },
  {
    name: "chat_with_workspace",
    description:
      "Send a message in a workspace's ongoing chat and get the assistant's reply as plain text. It's a real multi-turn conversation: earlier turns (up to 20, trimmed to roughly 12,000 characters) are sent along, and your message and the reply are both saved to the workspace's knowledge base as chat entries. The assistant sees only that chat history - not the workspace's reports, notes, job results, or files - so put the facts a question depends on in the message itself. The message and history go to the Gateway's configured AI provider (a remote API or a local model); errors if none is configured. For a one-off summary of some text use summarize_text; to read stored entries use list_knowledge.",
    annotations: {
      title: "Chat with a workspace",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        workspace: workspaceProp,
        message: {
          type: "string",
          description: "Your message or question. Must not be empty.",
        },
      },
      required: ["message"],
    },
  },
];

export const ALL_TOOL_DEFINITIONS: ToolDefinition[] = [...META_TOOL_DEFINITIONS, ...AGENT_TOOLS];
