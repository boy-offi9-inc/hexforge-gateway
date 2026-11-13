import { describe, it, expect } from "vitest";
import { parseManifest } from "../src/modules/mcp/agents/triage.agent.js";

const MANIFEST = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    android:versionCode="42"
    android:versionName="1.2.3"
    package="com.acme.app">
    <uses-sdk android:minSdkVersion="24" android:targetSdkVersion="34" />
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.CAMERA" />
    <application android:name="com.acme.app.MainApplication" android:label="Acme">
        <activity android:name="com.acme.app.MainActivity" android:exported="true">
            <intent-filter><action android:name="android.intent.action.MAIN" /></intent-filter>
        </activity>
        <activity android:name="com.acme.app.SettingsActivity" android:exported="false" />
        <service android:name="com.acme.app.SyncService" android:exported="true" />
        <receiver android:name="com.acme.app.BootReceiver" android:exported="true" />
    </application>
</manifest>`;

describe("parseManifest", () => {
  it("extracts identity and sdk levels", () => {
    const m = parseManifest(MANIFEST);
    expect(m.packageName).toBe("com.acme.app");
    expect(m.versionName).toBe("1.2.3");
    expect(m.versionCode).toBe("42");
    expect(m.minSdk).toBe("24");
    expect(m.targetSdk).toBe("34");
    expect(m.applicationClass).toBe("com.acme.app.MainApplication");
  });

  it("collects uses-permission entries", () => {
    const m = parseManifest(MANIFEST);
    expect(m.permissions).toContain("android.permission.INTERNET");
    expect(m.permissions).toContain("android.permission.CAMERA");
  });

  it("lists only exported components", () => {
    const m = parseManifest(MANIFEST);
    expect(m.exportedComponents).toEqual([
      { type: "activity", name: "com.acme.app.MainActivity" },
      { type: "service", name: "com.acme.app.SyncService" },
      { type: "receiver", name: "com.acme.app.BootReceiver" },
    ]);
  });

  it("handles a manifest with no application class or permissions", () => {
    const m = parseManifest('<manifest package="com.x"><application /></manifest>');
    expect(m.packageName).toBe("com.x");
    expect(m.permissions).toEqual([]);
    expect(m.exportedComponents).toEqual([]);
  });
});
