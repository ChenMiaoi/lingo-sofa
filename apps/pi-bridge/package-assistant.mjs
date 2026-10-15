import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const project = import.meta.dirname;
const version = JSON.parse(
  await readFile(join(project, "package.json"), "utf8"),
).version;
if (process.versions.node.split(".")[0] !== "24")
  throw new Error("Package with Node 24");
if (
  process.config.variables.node_shared ||
  process.config.variables.node_shared_openssl
)
  throw new Error(
    "Use the official self-contained Node distribution, not a shared-library Node build",
  );
const output = resolve(process.argv[2] ?? join(project, "dist/installers"));
await mkdir(output, { recursive: true });
const name = `lingo-sofa-assistant-${version}-${process.platform}-${process.arch}`;
const work = await mkdtemp(join(tmpdir(), "lingo-package-"));
const payload = join(work, name);
try {
  await mkdir(payload);
  // Reuse the dependency closure installer in a temporary home, never the user's installation.
  const staging = join(work, "staging");
  execFileSync(process.execPath, [join(project, "install-runtime.mjs")], {
    cwd: project,
    env: { ...process.env, LINGO_SOFA_HOME: staging },
    stdio: "inherit",
  });
  const installed = JSON.parse(
    await readFile(join(staging, "runtime-install.json"), "utf8"),
  );
  await cp(dirname(installed.entrypoint), join(payload, "runtime"), {
    recursive: true,
    dereference: true,
  });
  await cp(join(project, "dist/config.js"), join(payload, "runtime/config.js"));
  await cp(join(project, "installer.mjs"), join(payload, "install.mjs"));
  const nativeName = `lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`;
  await cp(join(project, "dist", nativeName), join(payload, nativeName));
  const nodeRoot = resolve(
    dirname(process.execPath),
    process.platform === "win32" ? "." : "..",
  );
  const license =
    process.env.LINGO_SOFA_NODE_LICENSE ?? join(nodeRoot, "LICENSE");
  await access(license);
  await cp(license, join(payload, "runtime/NODE-LICENSE"));
  for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md"])
    await cp(resolve(project, "../..", file), join(payload, file));
  const shell =
    '#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\n./runtime/node install.mjs --interactive\nstatus=$?\nprintf "\\nPress Enter to close…"\nread -r answer\nexit "$status"\n';
  await writeFile(join(payload, "Install.command"), shell);
  await chmod(join(payload, "Install.command"), 0o755);
  await writeFile(
    join(payload, "Install.cmd"),
    '@echo off\r\ncd /d "%~dp0"\r\n"runtime\\node.exe" "install.mjs" --interactive\r\nset "result=%errorlevel%"\r\npause\r\nexit /b %result%\r\n',
  );
  await writeFile(
    join(payload, "README.txt"),
    `LingoSofa ${version} — ${process.platform}/${process.arch}\n\n解压后双击 ${process.platform === "win32" ? "Install.cmd" : "Install.command"}。浏览器用户先从扩展设置复制扩展 ID，在安装提示中粘贴。仅 Discord 使用可直接回车。\n安装到当前用户目录，无需另装 Node。所有客户端共用一份助手。升级或新增浏览器授权前关闭所有客户端，等待助手退出。\nCLI: runtime/${process.platform === "win32" ? "node.exe" : "node"} install.mjs [EXTENSION_ID ...]\n本开发包尚未签名/公证；公开发行条件见 THIRD_PARTY_NOTICES.md 和项目文档。\n`,
  );
  const files = {};
  async function inventory(directory, prefix = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory())
        await inventory(join(directory, entry.name), path + "/");
      else if (entry.isFile())
        files[path] = createHash("sha256")
          .update(await readFile(join(directory, entry.name)))
          .digest("hex");
      else throw new Error("Unexpected special file in assistant bundle");
    }
  }
  await inventory(payload);
  await writeFile(
    join(payload, "bundle.json"),
    JSON.stringify(
      { version, platform: process.platform, arch: process.arch, files },
      null,
      2,
    ) + "\n",
  );
  const archive = join(output, `${name}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", work, name]);
  const url = `https://github.com/ChenMiaoi/lingo-sofa/releases/download/v${version}/${name}.tar.gz`;
  const manifest = {
    version,
    assets: {
      [`${process.platform}-${process.arch}`]: {
        url,
        sha256: createHash("sha256")
          .update(await readFile(archive))
          .digest("hex"),
        directory: name,
      },
    },
  };
  await writeFile(
    join(output, `${name}.json`),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  console.log(
    `Assistant package: ${archive}\nRelease manifest: ${name}.json (publish the archive at its versioned URL before enabling automatic downloads)`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}
