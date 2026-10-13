import { mkdir, writeFile, access } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
const extensionId = process.argv[2];
if (!extensionId || !/^[a-p]{32}$/.test(extensionId))
  throw new Error("Pass the installed extension ID");
const binary = resolve(
  `dist/lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`,
);
await access(binary);
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
  "Add the same extension ID to allowedExtensions in your Bridge config. Keep this checkout and packaged host in place.",
);
