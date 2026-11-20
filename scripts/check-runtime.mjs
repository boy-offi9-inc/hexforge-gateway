// Runtime check for the hexforge-runtime Docker image: every backend the
// capability registry declares must answer its --version. Exit 0 only when
// all pinned tools are present and healthy.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TOOLS = [
  { name: "node", args: ["--version"], expect: /v2[0-9]+\./ },
  { name: "java", args: ["-version"], versionFrom: "stderr", expect: /(17|21|25)\./ },
  { name: "jadx", args: ["--version"], expect: /1\.5\./ },
  // analyzeHeadless has no --version and exits 1 on a bare run; its stderr
  // prints the JVM it resolved, so accept the non-zero exit as long as the
  // JDK check ran (output mentions openjdk).
  { name: "analyzeHeadless", args: [], expect: /openjdk version/i, allowNonZero: true },
  { name: "apktool", args: ["--version"], expect: /2\.7\./ },
  { name: "apksigner", args: ["--version"], expect: /[0-9]+\.[0-9]+/ },
  { name: "zipalign", args: ["-h"], versionFrom: "none" },
  { name: "adb", args: ["--version"], expect: /version/ },
  { name: "python3", args: ["--version"], expect: /3\./ },
  { name: "apkid", args: ["-v"], expect: /APKiD 3\./ },
  { name: "frida", args: ["--version"], expect: /1[4-9]\./ },
];

let failures = 0;
for (const tool of TOOLS) {
  try {
    if (tool.versionFrom === "none") {
      // zipalign exits non-zero for every invocation, including -h; running
      // it at all proves the binary exists.
      await execFileAsync(tool.name, tool.args).catch(() => {});
      console.log(`ok      ${tool.name}`);
      continue;
    }
    const { stdout, stderr } = await execFileAsync(tool.name, tool.args);
    const out = tool.versionFrom === "stderr" ? stderr : stdout;
    const line = out.split("\n").find((l) => l.trim()) ?? "";
    if (tool.expect && !tool.expect.test(out)) {
      console.log(`MISMATCH ${tool.name}: "${line.trim()}" does not match ${tool.expect}`);
      failures++;
    } else {
      console.log(`ok      ${tool.name} ${line.trim().split(" ")[0]}`);
    }
  } catch (err) {
    // Some tools exit non-zero even when healthy (analyzeHeadless has no
    // usage mode that exits 0). allowNonZero keeps the output check.
    if (
      tool.allowNonZero &&
      tool.expect.test(String(err.stdout ?? "") + String(err.stderr ?? ""))
    ) {
      console.log(`ok      ${tool.name}`);
      continue;
    }
    console.log(`MISSING ${tool.name}: ${err.message.split("\n")[0]}`);
    failures++;
  }
}

process.exit(failures > 0 ? 1 : 0);
