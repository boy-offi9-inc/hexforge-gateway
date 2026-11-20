import { describe, expect, it } from "vitest";
import {
  parseDeclaredMethods,
  parseCallSites,
  parseMethodAndCallGraph,
} from "../src/graph/calls-indexer.js";

describe("parseDeclaredMethods", () => {
  it("extracts declared methods with their parameter types", () => {
    const src = [
      "package com.acme;",
      "public class Login {",
      "  public boolean performLogin(String user, Context ctx) {",
      "    return true;",
      "  }",
      "  void refresh() {}",
      "}",
    ].join("\n");
    const methods = parseDeclaredMethods(src);
    expect(methods.map((m) => m.name)).toEqual(["performLogin", "refresh"]);
    expect(methods[0]!.params).toEqual(["String", "Context"]);
    expect(methods[1]!.params).toEqual([]);
  });

  it("marks native methods and ignores strings and comments", () => {
    const src = [
      "class Crypto {",
      "  // String fake(int a) { } a comment",
      '  String s = "not a method(String x) { ";',
      "  private native byte[] derive(byte[] seed);",
      "  int real() { return 1; }",
      "}",
    ].join("\n");
    const methods = parseDeclaredMethods(src);
    expect(methods.map((m) => m.name)).toEqual(["derive", "real"]);
    expect(methods[0]!.isNative).toBe(true);
    expect(methods[1]!.isNative).toBe(false);
  });

  it("does not mistake control keywords for methods", () => {
    const src = [
      "class X {",
      "  int go(int n) {",
      "    if (n > 0) { return n; }",
      "    while (n > 1) { n--; }",
      "    switch (n) { default: break; }",
      "    return n;",
      "  }",
      "}",
    ].join("\n");
    expect(parseDeclaredMethods(src).map((m) => m.name)).toEqual(["go"]);
  });
});

describe("parseCallSites", () => {
  it("extracts receivers and method names, skipping keywords and new", () => {
    const src = [
      "class A {",
      "  void run(Context ctx) {",
      "    if (ctx.ready()) { return; }",
      "    B b = new B();",
      "    b.start(ctx);",
      "    this.helper.finish();",
      "  }",
      "}",
    ].join("\n");
    const calls = parseCallSites(src);
    expect(calls.map((c) => `${c.receiver}.${c.method}`)).toEqual([
      "ctx.ready",
      "b.start",
      "this.helper.finish",
    ]);
  });

  it("flags reflective files with a synthetic invoke site", () => {
    const src = [
      "class R {",
      "  void x(String cls) throws Exception {",
      '    Object o = Class.forName(cls).getDeclaredMethod("go").invoke(null);',
      "  }",
      "}",
    ].join("\n");
    const calls = parseCallSites(src);
    expect(calls.some((c) => c.isReflective)).toBe(true);
  });

  it("flags super calls", () => {
    const calls = parseCallSites("class A extends B { A(){ super.go(); } }");
    expect(calls.some((c) => c.method === "go" && c.isSuper)).toBe(true);
  });
});

describe("parseMethodAndCallGraph", () => {
  const files = new Map<string, string>([
    [
      "com/acme/Login.java",
      [
        "package com.acme;",
        "class Login {",
        "  private final Api api = new Api();",
        "  public boolean performLogin(String user) {",
        "    return api.send(user);",
        "  }",
        "  native long token(long seed);",
        "}",
      ].join("\n"),
    ],
    [
      "com/acme/Api.java",
      ["package com.acme;", "class Api {", "  boolean send(String u) { return true; }", "}"].join(
        "\n",
      ),
    ],
    [
      "com/other/Reflect.java",
      [
        "package com.other;",
        "class Reflect {",
        "  void go(String c) throws Exception {",
        '    Class.forName(c).getMethod("x").invoke(null);',
        "  }",
        "}",
      ].join("\n"),
    ],
  ]);

  it("creates method entities with signature names and the native flag", () => {
    const { entities, edges, truncated } = parseMethodAndCallGraph({ files });
    expect(truncated).toBe(false);
    const names = entities.map((e) => e.name);
    expect(names).toContain("com.acme.Login.performLogin(String)");
    expect(names).toContain("com.acme.Login.token(long)");
    expect(names).toContain("com.acme.Api.send(String)");
    const token = entities.find((e) => e.name === "com.acme.Login.token(long)")!;
    expect(token.attributes.native).toBe(true);
    // every entity references a class in the same artifact set
    for (const e of entities) {
      const cls = e.name.slice(0, e.name.indexOf("(")).split(".").slice(0, -1).join(".");
      expect(files.has(cls.split(".").join("/") + ".java")).toBe(true);
    }
    void edges;
  });

  it("resolves receivers to same-artifact classes as calls edges", () => {
    const { edges } = parseMethodAndCallGraph({ files });
    const calls = edges.filter((e) => e.relation === "calls");
    expect(calls).toContainEqual({
      from: { type: "class", name: "com.acme.Login" },
      to: { type: "class", name: "com.acme.Api" },
      relation: "calls",
    });
  });

  it("writes invokes edges for reflective classes, self-looped", () => {
    const { edges } = parseMethodAndCallGraph({ files });
    expect(edges).toContainEqual({
      from: { type: "class", name: "com.other.Reflect" },
      to: { type: "class", name: "com.other.Reflect" },
      relation: "invokes",
    });
  });

  it("never fabricates targets outside the given class set", () => {
    const files2 = new Map<string, string>([
      ["com/acme/A.java", 'class A { void go() { System.out.println("x"); jdk.other.call(); } }'],
    ]);
    const { edges } = parseMethodAndCallGraph({ files: files2 });
    expect(edges.filter((e) => e.relation === "calls")).toEqual([]);
  });

  it("honors the entity cap", () => {
    const files2 = new Map<string, string>([
      ["a/B.java", "class B { int m1() {return 1;} int m2() {return 2;} int m3() {return 3;} }"],
    ]);
    const { entities, truncated } = parseMethodAndCallGraph({
      files: files2,
      maxMethodEntities: 2,
    });
    expect(entities).toHaveLength(2);
    expect(truncated).toBe(true);
  });
});
