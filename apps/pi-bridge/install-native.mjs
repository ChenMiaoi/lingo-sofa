import {
  mkdir,
  writeFile,
  access,
  copyFile,
  chmod,
  rename,
} from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
const extensionId = process.argv[2];
if (!extensionId || !/^[a-p]{32}$/.test(extensionId))
  throw new Error("Pass the installed extension ID");
const builtBinary = resolve(
  `dist/lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`,
);
await access(builtBinary);
execFileSync(process.execPath, ["install-runtime.mjs", extensionId], {
  stdio: "inherit",
});
const assistantHome = resolve(
  process.env.LINGO_SOFA_HOME ?? join(homedir(), ".config/lingo-sofa"),
);
const binary = join(
  assistantHome,
  `lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`,
);
await copyFile(builtBinary, `${binary}.tmp`);
await chmod(`${binary}.tmp`, 0o755);
await rename(`${binary}.tmp`, binary);
const name = "com.lingosofa.bridge";
const manifest = {
  name,
  description: "LingoSofa Native Messaging Bridge",
  path: binary,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`],
};
const home = homedir();
const directories =
  process.platform === "darwin"
    ? ["Google/Chrome", "Google/ChromeForTesting", "Microsoft Edge"].map(
        (browser) =>
          join(
            home,
            "Library/Application Support",
            browser,
            "NativeMessagingHosts",
          ),
      )
    : process.platform === "win32"
      ? [join(home, ".config/lingo-sofa/native")]
      : [
          "google-chrome",
          "google-chrome-for-testing",
          "chromium",
          "microsoft-edge",
        ].map((browser) =>
          join(home, ".config", browser, "NativeMessagingHosts"),
        );
for (const directory of directories) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}.json`);
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  if (process.platform === "win32")
    for (const browser of ["Google\\Chrome", "Microsoft\\Edge"])
      execFileSync("reg", [
        "ADD",
        `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${name}`,
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        path,
        "/f",
      ]);
  console.log(`Registered ${path}`);
}
console.log(
  "The local runtime and extension allowlist are installed. Keep the installed assistant directory and Node path in place.",
);
