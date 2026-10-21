import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  localIdentity,
  signedCargoArguments,
  signingCommand,
} from "./macos-signing";
import { cleanEnv, root } from "./process";

if (process.platform !== "darwin" || !(await localIdentity()))
  throw new Error("Run npm run signing:setup on macOS first");
const directory = resolve(root, ".cache/local-signing-verification");
await mkdir(resolve(directory, "src"), { recursive: true });
await writeFile(
  resolve(directory, "Cargo.toml"),
  '[package]\nname="signing-probe"\nversion="0.0.0"\nedition="2024"\n[workspace]\n',
);
let requirement: string | undefined;
for (const version of [1, 2]) {
  await writeFile(
    resolve(directory, "src/main.rs"),
    `fn main() { println!("signed version ${version}"); }\n`,
  );
  const output = await signingCommand([
    "cargo",
    "run",
    "--manifest-path",
    resolve(directory, "Cargo.toml"),
    ...signedCargoArguments(),
  ]);
  if (!output.includes(`signed version ${version}`))
    throw new Error("Signed Cargo runner did not execute the rebuilt program");
  const executable = resolve(directory, "target/debug/signing-probe");
  const description = await signingCommand([
    "/usr/bin/codesign",
    "-d",
    "-r-",
    executable,
  ]);
  const current = description
    .split("\n")
    .find((line) => line.startsWith("designated => "))
    ?.slice("designated => ".length);
  if (!current || current.includes("cdhash"))
    throw new Error("Local signature is not certificate-bound");
  if (requirement && current !== requirement)
    throw new Error("Rebuild changed the signing identity");
  requirement = current;
  await signingCommand([
    "/usr/bin/codesign",
    "--verify",
    "--strict",
    "--test-requirement",
    `=${requirement}`,
    executable,
  ]);
}
await writeFile(
  resolve(directory, "src/main.rs"),
  'fn main() { println!("pid={}", std::process::id()); std::thread::sleep(std::time::Duration::from_secs(30)); }\n',
);
await signingCommand([
  "cargo",
  "build",
  "--manifest-path",
  resolve(directory, "Cargo.toml"),
]);
const child = Bun.spawn(
  [
    process.execPath,
    resolve(root, "scripts/run-signed-macos.ts"),
    resolve(directory, "target/debug/signing-probe"),
  ],
  {
    env: cleanEnv(),
    stdout: "pipe",
    stderr: "pipe",
  },
);
let applicationPid: number | undefined;
const deadline = setTimeout(() => child.kill("SIGKILL"), 5000);
try {
  const reader = child.stdout.getReader();
  let output = "";
  while (!output.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done)
      throw new Error(
        "Signed runner exited without launching the lifetime probe",
      );
    output += new TextDecoder().decode(chunk.value);
  }
  const pid = /^pid=(\d+)\n/.exec(output);
  if (!pid) throw new Error("Invalid lifetime probe output");
  applicationPid = Number(pid[1]);
  if (applicationPid !== child.pid)
    throw new Error(
      "Signed runner spawned an orphanable child instead of replacing itself",
    );
  child.kill("SIGTERM");
  await child.exited;
  try {
    process.kill(applicationPid, 0);
    throw new Error("Signed application survived runner termination");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
} finally {
  clearTimeout(deadline);
  child.kill("SIGKILL");
  if (applicationPid && applicationPid !== child.pid) {
    try {
      process.kill(applicationPid, "SIGKILL");
    } catch {
      /* Probe already exited. */
    }
  }
  await child.exited;
}
console.log(
  "Signed Cargo runner passed: rebuilds preserve certificate identity and termination leaves no orphan application.",
);
