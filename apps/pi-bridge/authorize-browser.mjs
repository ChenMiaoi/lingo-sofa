import { access, mkdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { bridgeConfigSchema } from "./config.js";
import { browserRegistration, save } from "./native-registration.mjs";

const extensions = process.argv.slice(2);
if (!extensions.length || extensions.some((id) => !/^[a-p]{32}$/.test(id)))
  throw new Error("Invalid extension ID");
const home = resolve(
  process.env.LINGO_SOFA_HOME ?? join(homedir(), ".config/lingo-sofa"),
);
// Authorization requires a complete installation and never downloads or replaces it.
await access(join(home, "runtime-install.json"));
await access(
  join(
    home,
    `lingo-sofa-native-host${process.platform === "win32" ? ".exe" : ""}`,
  ),
);
const lock = join(home, ".installer-lock");
await mkdir(lock);
try {
  let config = bridgeConfigSchema.parse(
    JSON.parse(await readFile(join(home, "config.json"), "utf8")),
  );
  config.allowedExtensions = [
    ...new Set([...config.allowedExtensions, ...extensions]),
  ];
  config = bridgeConfigSchema.parse(config);
  const register = await browserRegistration(home, config);
  await register();
  await save(join(home, "config.json"), config);
  console.log(
    "浏览器授权完成。回到扩展设置点击“检测连接”；无需关闭浏览器或 Discord，已有账户和用量已保留。",
  );
} finally {
  await rm(lock, { recursive: true, force: true });
}
