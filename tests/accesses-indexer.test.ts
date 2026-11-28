import { describe, expect, it } from "vitest";
import {
  parseFieldDeclarations,
  parseMethodBodies,
  parseFieldAccessGraph,
} from "../src/graph/accesses-indexer.js";

describe("parseFieldDeclarations", () => {
  it("extracts declared fields with their bare types", () => {
    const src = [
      "package com.acme;",
      "class Login {",
      "  private Api api;",
      "  static final int MAX_TRIES = 3;",
      "  String[] tags;",
      "  List<String> names = new ArrayList<>();",
      "}",
    ].join("\n");
    const fields = parseFieldDeclarations(src);
    expect(fields.get("api")).toBe("Api");
    expect(fields.get("MAX_TRIES")).toBe("int");
    expect(fields.get("tags")).toBe("String");
    expect(fields.get("names")).toBe("List");
  });
});

describe("parseMethodBodies", () => {
  it("returns signatures identical to the calls indexer's method entities", () => {
    const src = [
      "package com.acme;",
      "class Login {",
      "  public boolean performLogin(String user) {",
      "    return true;",
      "  }",
      "  abstract void plan(String s);",
      "}",
    ].join("\n");
    const bodies = parseMethodBodies(src, "com.acme.Login");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.signature).toBe("com.acme.Login.performLogin(String)");
    expect(bodies[0]!.body).toContain("return true");
  });

  it("does not leak a field reference across method boundaries", () => {
    const src = [
      "class A {",
      "  int x = 0;",
      "  void first() { int local = 1; }",
      "  void second() { x = local + 2; }",
      "}",
    ].join("\n");
    const bodies = parseMethodBodies(src, "A");
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.body).not.toContain("x = local");
    expect(bodies[1]!.body).not.toContain("int local = 1;");
  });

  it("skips abstract and native declarations instead of borrowing the next body", () => {
    const src = [
      "class A {",
      "  int x = 0;",
      "  abstract void plan(String s);",
      "  void run() { x = 1; }",
      "}",
    ].join("\n");
    const bodies = parseMethodBodies(src, "A");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.signature).toBe("A.run()");
    expect(bodies[0]!.body).toContain("x = 1");
  });

  it("returns distinct offsets for identical bodies", () => {
    const src = [
      "class A {",
      "  void a() { int p = 1; }",
      "  void b() { int p = 2; }",
      "}",
    ].join("\n");
    const bodies = parseMethodBodies(src, "A");
    expect(bodies).toHaveLength(2);
    // indexOf would map both to the first occurrence - the offsets must not
    expect(bodies[0]!.start).toBeLessThan(bodies[1]!.start);
    expect(bodies[0]!.body).toContain("p = 1");
    expect(bodies[1]!.body).toContain("p = 2");
  });
});

describe("parseFieldAccessGraph", () => {
  it("creates field entities and accesses edges from method bodies", () => {
    const src = [
      "package com.acme;",
      "class Login {",
      "  private Api api;",
      "  int tries = 0;",
      "  public void performLogin(String user) {",
      "    this.tries = tries + 1;",
      "    api.send(user);",
      "    log.info(user);",
      "  }",
      "}",
    ].join("\n");
    const files = new Map([["com/acme/Login.java", src]]);
    const { entities, edges } = parseFieldAccessGraph({ files });
    const fieldNames = entities.map((e) => e.name).sort();
    // api.send(user) is a method call, not a field access - only `tries`
    // (read AND write, this-qualified and bare) is an access
    expect(fieldNames).toEqual(["com.acme.Login.tries"]);
    const from = edges.map((e) => e.from.name);
    expect(from.every((n) => n === "com.acme.Login.performLogin(String)")).toBe(true);
    // read AND write of the same field produce two raw matches that collapse
    // to one edge upstream (edge ids derive from from + relation + to)
    expect(edges).toHaveLength(2);
    expect(new Set(edges.map((e) => e.to.name))).toEqual(new Set(["com.acme.Login.tries"]));
    expect(edges.every((e) => e.relation === "accesses")).toBe(true);
  });

  it("never promotes local variables to fields", () => {
    const src = [
      "package com.acme;",
      "class Login {",
      "  public void run() {",
      "    int count = 0;",
      "    count = count + 1;",
      "  }",
      "}",
    ].join("\n");
    const { entities, edges } = parseFieldAccessGraph({
      files: new Map([["com/acme/Login.java", src]]),
    });
    expect(entities).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it("resolves static accesses to other artifact classes", () => {
    const files = new Map([
      [
        "com/acme/Login.java",
        [
          "package com.acme;",
          "class Login {",
          "  public void run() {",
          "    Config.DEBUG = false;",
          "  }",
          "}",
        ].join("\n"),
      ],
      ["com/acme/Config.java", "package com.acme;\nclass Config {\n  static boolean DEBUG = true;\n}"],
    ]);
    const { entities, edges } = parseFieldAccessGraph({ files });
    expect(entities.map((e) => e.name)).toEqual(["com.acme.Config.DEBUG"]);
    expect(edges).toHaveLength(1);
    expect(edges[0]!.to).toEqual({ type: "field", name: "com.acme.Config.DEBUG" });
    expect(edges[0]!.from).toEqual({
      type: "method",
      name: "com.acme.Login.run()",
    });
  });

  it("resolves a receiver field through its declared type", () => {
    const files = new Map([
      [
        "com/acme/Login.java",
        [
          "package com.acme;",
          "class Login {",
          "  private Config cfg;",
          "  public void run() {",
          "    cfg.verbose = true;",
          "  }",
          "}",
        ].join("\n"),
      ],
      ["com/acme/Config.java", "package com.acme;\nclass Config {\n  boolean verbose;\n}"],
    ]);
    const { edges } = parseFieldAccessGraph({ files });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.to.name).toBe("com.acme.Config.verbose");
  });

  it("does not fabricate fields of unknown classes", () => {
    const src = [
      "package com.acme;",
      "class Login {",
      "  public void run() {",
      "    android.util.Log.d(TAG, \"x\");",
      "    unknownThing.field = 1;",
      "  }",
      "}",
    ].join("\n");
    const { entities, edges } = parseFieldAccessGraph({
      files: new Map([["com/acme/Login.java", src]]),
    });
    expect(entities).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it("ignores string literals and comments as access sources", () => {
    const src = [
      "class A {",
      "  int x = 0;",
      "  void run() {",
      '    String s = "x = 1";',
      "    // x = 2",
      "  }",
      "}",
    ].join("\n");
    const { entities, edges } = parseFieldAccessGraph({
      files: new Map([["com/acme/A.java", src]]),
    });
    expect(entities).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });

  it("honours the entity and edge caps", () => {
    const files = new Map([
      [
        "com/acme/A.java",
        [
          "package com.acme;",
          "class A {",
          "  int f1 = 0; int f2 = 0; int f3 = 0;",
          "  void run() { f1 = f2 + f3; f2 = f3; }",
          "}",
        ].join("\n"),
      ],
    ]);
    const { entities, edges, truncated } = parseFieldAccessGraph({
      files,
      maxFieldEntities: 1,
      maxAccessEdges: 1,
    });
    expect(entities).toHaveLength(1);
    expect(edges).toHaveLength(1);
    expect(truncated).toBe(true);
  });

  it("ignores non-java files", () => {
    const { entities, edges } = parseFieldAccessGraph({
      files: new Map([["res/values.xml", "<resources/>"]]),
    });
    expect(entities).toHaveLength(0);
    expect(edges).toHaveLength(0);
  });
});
