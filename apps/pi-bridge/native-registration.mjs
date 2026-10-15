import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

export async function save(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(`${path}.tmp`, path);
}

export async function browserRegistration(home, config) {
  const binary = join(
    home,
    `lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`,
  );
  const name = "com.lingosofa.bridge";
  const browserDirectories =
    process.platform === "darwin"
      ? ["Google/Chrome", "Google/ChromeForTesting", "Microsoft Edge"].map(
          (browser) =>
            join(
              homedir(),
              "Library/Application Support",
              browser,
              "NativeMessagingHosts",
            ),
        )
      : process.platform === "win32"
        ? [join(home, "native")]
        : [
            "google-chrome",
            "google-chrome-for-testing",
            "chromium",
            "microsoft-edge",
          ].map((browser) =>
            join(homedir(), ".config", browser, "NativeMessagingHosts"),
          );
  if (config.allowedExtensions.length) {
    for (const directory of browserDirectories) {
      try {
        const existing = JSON.parse(
          await readFile(join(directory, `${name}.json`), "utf8"),
        );
        if (existing.path !== binary || existing.name !== name)
          throw new Error(
            "A different Native Host registration already exists; it was not overwritten",
          );
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  return async () => {
    if (config.allowedExtensions.length) {
      for (const directory of browserDirectories) {
        const path = join(directory, `${name}.json`);
        await save(path, {
          name,
          description: "LingoSofa Native Messaging Bridge",
          path: binary,
          type: "stdio",
          allowed_origins: config.allowedExtensions.map(
            (id) => `chrome-extension://${id}/`,
          ),
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
      }
    }
  };
}
