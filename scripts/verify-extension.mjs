import { TextDecoder } from "node:util";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import ts from "typescript";
const root = resolve("apps/browser-extension/.output/chrome-mv3");
const manifest = JSON.parse(
  await readFile(join(root, "manifest.json"), "utf8"),
);
if (manifest.manifest_version !== 3 || manifest.host_permissions?.length)
  throw new Error("Release package must be MV3 with optional host permissions");
if (manifest.content_scripts?.length)
  throw new Error(
    "Content scripts must require manual or per-site authorization",
  );
let checked = 0;
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await inspect(path);
      continue;
    }
    if (!entry.name.endsWith(".js")) continue;
    const script = new TextDecoder("utf-8", { fatal: true }).decode(
      await readFile(path),
    );
    for (const character of script) {
      const point = character.codePointAt(0);
      if (
        point === 0 ||
        (point >= 0xfdd0 && point <= 0xfdef) ||
        (point & 0xffff) >= 0xfffe
      )
        throw new Error(
          `Code point unsupported by Chrome script injection in ${path}`,
        );
    }
    const source = ts.createSourceFile(
      path,
      script,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    function checkImport(value) {
      if (
        !value ||
        !ts.isStringLiteralLike(value) ||
        !/^\.\.?\//.test(value.text)
      )
        throw new Error(`Nonlocal or computed module import in ${path}`);
    }
    function visit(node) {
      if (
        ts.isImportDeclaration(node) ||
        (ts.isExportDeclaration(node) && node.moduleSpecifier)
      )
        checkImport(node.moduleSpecifier);
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        node.initializer.text === "Function"
      )
        throw new Error(`Aliased dynamic code constructor in ${path}`);
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
          checkImport(node.arguments[0]);
        if (
          ts.isIdentifier(node.expression) &&
          ["eval", "Function", "require"].includes(node.expression.text)
        )
          throw new Error(`Runtime code evaluation or require in ${path}`);
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Function"
      )
        throw new Error(`Runtime code generation in ${path}`);
      ts.forEachChild(node, visit);
    }
    visit(source);
    checked++;
  }
}
await inspect(root);
console.log(
  `Audited ${checked} extension scripts: local static modules, no eval or Node require; hosts remain optional.`,
);
