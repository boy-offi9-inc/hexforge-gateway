import { describe, expect, it } from "vitest";
import { parseInheritance, parseInheritanceEdges } from "../src/graph/inheritance-indexer.js";

describe("parseInheritance", () => {
  it("extracts extends and implements from a class declaration", () => {
    const source = `
      package com.acme;
      import java.util.List;
      public class Login extends BaseActivity implements Runnable, View.OnClickListener {
      }
    `;
    expect(parseInheritance(source)).toEqual({
      name: "Login",
      extends: ["BaseActivity"],
      implements: ["Runnable", "View.OnClickListener"],
    });
  });

  it("returns null when there is no class declaration", () => {
    expect(parseInheritance("int x = 1; // nothing here")).toBeNull();
  });

  it("ignores comments and strings mentioning class", () => {
    const source = `
      // class Fake extends Nothing
      /* class AlsoFake extends Nope */
      public final class Real extends Base {}
    `;
    expect(parseInheritance(source)?.name).toBe("Real");
    expect(parseInheritance(source)?.extends).toEqual(["Base"]);
  });

  it("handles a class with no clauses", () => {
    expect(parseInheritance("class Plain { int x; }")).toEqual({
      name: "Plain",
      extends: [],
      implements: [],
    });
  });
});

describe("parseInheritanceEdges", () => {
  it("resolves bare superclass names against the same package", () => {
    const edges = parseInheritanceEdges(
      new Map([["com/acme/Login.java", "package com.acme; class Login extends BaseActivity {}"]]),
    ).edges;
    expect(edges).toHaveLength(1);
    expect(edges[0].from).toEqual({ type: "class", name: "com.acme.Login" });
    expect(edges[0].to).toEqual({ type: "class", name: "com.acme.BaseActivity" });
    expect(edges[0].relation).toBe("inherits");
  });

  it("keeps fully-qualified supertypes that live outside the package", () => {
    const edges = parseInheritanceEdges(
      new Map([
        ["com/acme/Net.java", "class Net extends java.util.Observable {}"],
        ["com/other/Out.java", "class Out extends com.acme.Net {}"],
      ]),
    ).edges;
    expect(edges.map((e) => e.to.name)).toEqual(["java.util.Observable", "com.acme.Net"]);
  });

  it("skips non-java files and generics in supertypes", () => {
    const { edges } = parseInheritanceEdges(
      new Map([
        ["res/values.xml", "class Nope extends Base {}"],
        ["com/a/B.java", "class B extends C<D> {}"],
      ]),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0].to.name).toBe("com.a.C");
  });

  it("stops at the edge cap and reports truncation", () => {
    const files = new Map(
      Array.from({ length: 10 }, (_, i) => [`p/C${i}.java`, `class C${i} extends Base {}`]),
    );
    const { edges, truncated } = parseInheritanceEdges(files, 5);
    expect(edges).toHaveLength(5);
    expect(truncated).toBe(true);
  });
});
