import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Same approach as the other graph-indexer tests: the pure parsing
// functions are tested directly, and the event-subscription wiring is
// tested once against a temp-dir fixture decode (a real apktool output
// layout: AndroidManifest.xml + res/ + assets/), with the graph service
// and the event bus mocked so no storage is touched.

const indexBatch = vi.fn();
vi.mock("../src/graph/graph.service.js", () => ({
  indexBatch: (...args: unknown[]) => indexBatch(...args),
}));

const { parseManifestGraph, parseResourceFiles, indexManifestArtifact } =
  await import("../src/graph/manifest-indexer.js");

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.acme.app" android:versionCode="7" android:versionName="1.2">
    <uses-permission android:name="android.permission.INTERNET"/>
    <uses-permission android:name="android.permission.CAMERA"/>
    <application android:name=".App">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN"/>
                <category android:name="android.intent.category.LAUNCHER"/>
            </intent-filter>
            <intent-filter>
                <data android:scheme="https" android:host="acme.example"/>
            </intent-filter>
        </activity>
        <activity android:name="com.acme.app.DeepActivity" android:exported="false"/>
        <service android:name=".SyncService" android:exported="false"/>
        <receiver android:name=".BootReceiver" android:exported="true"/>
        <provider android:name=".ContentProvider" android:exported="false"/>
        <activity android:name="com.other.sdk.PayActivity"/>
    </application>
</manifest>`;

describe("parseManifestGraph", () => {
  const names = (entities: { type: string; name: string }[], type: string) =>
    entities.filter((e) => e.type === type).map((e) => e.name);

  it("creates a package entity for the app id", () => {
    const { entities } = parseManifestGraph(MANIFEST);
    expect(names(entities, "package")).toContain("com.acme.app");
  });

  it("turns each declared component into a class entity with component and exported attributes", () => {
    const { entities } = parseManifestGraph(MANIFEST);
    const classes = entities.filter((e) => e.type === "class");
    const main = classes.find((e) => e.name === "com.acme.app.MainActivity");
    expect(main).toEqual({
      type: "class",
      name: "com.acme.app.MainActivity",
      attributes: { component: "activity", exported: true },
    });
    // Relative names are resolved against the app package; fully-qualified
    // ones kept as written - so this component is the same entity the smali
    // and java indexers would make for that class.
    // Tag groups are processed activity -> service -> receiver -> provider,
    // so all activities (relative names resolved against the app package,
    // fully-qualified ones kept as written) come first.
    expect(names(entities, "class")).toEqual([
      "com.acme.app.MainActivity",
      "com.acme.app.DeepActivity",
      "com.other.sdk.PayActivity",
      "com.acme.app.SyncService",
      "com.acme.app.BootReceiver",
      "com.acme.app.ContentProvider",
    ]);
    const svc = classes.find((e) => e.name === "com.acme.app.SyncService");
    expect(svc?.attributes).toEqual({ component: "service", exported: false });
  });

  it("links components to their code package with contains edges", () => {
    const { edges } = parseManifestGraph(MANIFEST);
    expect(edges).toContainEqual({
      from: { type: "package", name: "com.acme.app" },
      to: { type: "class", name: "com.acme.app.MainActivity" },
      relation: "contains",
    });
    expect(edges).toContainEqual({
      from: { type: "package", name: "com.other.sdk" },
      to: { type: "class", name: "com.other.sdk.PayActivity" },
      relation: "contains",
    });
  });

  it("turns uses-permission entries into permission:<name> resources accessed by the app", () => {
    const { entities, edges } = parseManifestGraph(MANIFEST);
    expect(names(entities, "resource")).toContain("permission:android.permission.INTERNET");
    expect(edges).toContainEqual({
      from: { type: "package", name: "com.acme.app" },
      to: { type: "resource", name: "permission:android.permission.INTERNET" },
      relation: "accesses",
    });
    // No duplicates when a permission appears twice.
    expect(
      names(entities, "resource").filter((n) => n === "permission:android.permission.INTERNET"),
    ).toHaveLength(1);
  });

  it("turns intent-filter actions/categories into intent:<value> resources accessed by the component", () => {
    const { entities, edges } = parseManifestGraph(MANIFEST);
    expect(names(entities, "resource")).toContain("intent:android.intent.action.MAIN");
    expect(names(entities, "resource")).toContain("intent:android.intent.category.LAUNCHER");
    expect(edges).toContainEqual({
      from: { type: "class", name: "com.acme.app.MainActivity" },
      to: { type: "resource", name: "intent:android.intent.action.MAIN" },
      relation: "accesses",
    });
    // The second activity's intent filters must not leak into the first.
    expect(
      edges.filter((e) => e.relation === "accesses" && e.from.name === "com.acme.app.DeepActivity"),
    ).toHaveLength(0);
  });

  it("is safe when there is no package attribute", () => {
    const { entities, edges } = parseManifestGraph(
      '<manifest><application><activity android:name=".Main"/></application></manifest>',
    );
    expect(names(entities, "package")).toHaveLength(0);
    // A relative name with no package to resolve against produces no class.
    expect(names(entities, "class")).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it("respects the resource cap", () => {
    const many = Array.from(
      { length: 50 },
      (_, i) => `<uses-permission android:name="com.perm.P${i}"/>`,
    ).join("\n");
    const { entities, truncated } = parseManifestGraph(
      `<manifest package="p">${many}</manifest>`,
      10,
    );
    expect(entities.filter((e) => e.type === "resource")).toHaveLength(10);
    expect(truncated).toBe(true);
  });
});

describe("parseResourceFiles", () => {
  it("indexes res/ and assets/ files as resource entities with contains edges", () => {
    const { entities, edges, truncated } = parseResourceFiles(
      ["res/layout/main.xml", "assets/config.json", "smali/com/a/A.smali", "AndroidManifest.xml"],
      "com.acme.app",
    );
    expect(truncated).toBe(false);
    expect(entities).toEqual([
      {
        type: "resource",
        name: "res/layout/main.xml",
        attributes: { file: "res/layout/main.xml" },
      },
      { type: "resource", name: "assets/config.json", attributes: { file: "assets/config.json" } },
    ]);
    expect(edges).toContainEqual({
      from: { type: "package", name: "com.acme.app" },
      to: { type: "resource", name: "assets/config.json" },
      relation: "contains",
    });
  });

  it("adds no contains edges when the app package is unknown", () => {
    const { edges } = parseResourceFiles(["res/values/strings.xml"]);
    expect(edges).toHaveLength(0);
  });
});

describe("indexManifestArtifact", () => {
  let dir: string;

  beforeEach(async () => {
    indexBatch.mockReset();
    dir = await mkdtemp(path.join(tmpdir(), "manifest-fixture-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const artifact = (base: string) => ({
    id: "art1",
    workspaceId: "ws1",
    kind: "apktool-project",
    pathType: "directory" as const,
    path: base,
  });

  it("indexes a fixture decode output: manifest components + resource files in one batch", async () => {
    await writeFile(path.join(dir, "AndroidManifest.xml"), MANIFEST);
    await mkdir(path.join(dir, "res/layout"), { recursive: true });
    await mkdir(path.join(dir, "assets"), { recursive: true });
    await writeFile(path.join(dir, "res", "layout", "main.xml"), "<LinearLayout/>");
    await writeFile(path.join(dir, "assets", "config.json"), "{}");

    await indexManifestArtifact(artifact(dir) as never);

    expect(indexBatch).toHaveBeenCalledOnce();
    const batch = indexBatch.mock.calls[0][0] as {
      workspaceId: string;
      artifactId: string;
      entities: { type: string; name: string }[];
      edges: unknown[];
    };
    expect(batch.workspaceId).toBe("ws1");
    expect(batch.artifactId).toBe("art1");
    const names = batch.entities.map((e) => `${e.type}:${e.name}`);
    expect(names).toContain("package:com.acme.app");
    expect(names).toContain("class:com.acme.app.MainActivity");
    expect(names).toContain("resource:permission:android.permission.CAMERA");
    expect(names).toContain("resource:res/layout/main.xml");
    expect(names).toContain("resource:assets/config.json");
    expect(batch.edges.length).toBeGreaterThan(5);
  });

  it("returns null when the artifact has no AndroidManifest.xml", async () => {
    expect(await indexManifestArtifact(artifact(dir) as never)).toBeNull();
    expect(indexBatch).not.toHaveBeenCalled();
  });
});
