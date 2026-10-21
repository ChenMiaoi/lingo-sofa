import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { cleanEnv, root } from "./process";

export const signingDirectory = join(
  homedir(),
  "Library/Application Support/LingoSofa/CodeSigning",
);
export type SigningIdentity = {
  identity: string;
  keychain: string;
  password: string;
};

export function signedCargoArguments(bun = process.execPath, directory = root) {
  return ["aarch64-apple-darwin", "x86_64-apple-darwin"].flatMap((target) => [
    "--config",
    `target.${target}.runner=${JSON.stringify([bun, resolve(directory, "scripts/run-signed-macos.ts")])}`,
  ]);
}

// Never include command arguments in errors: security commands carry keychain passwords.
export async function signingCommand(args: string[], env = cleanEnv()) {
  const child = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code)
    throw new Error(
      `Signing operation failed: ${basename(args[0]!)} (${code})${args[0] === "/usr/bin/codesign" ? `: ${stderr.trim()}` : ""}`,
    );
  return stdout + stderr;
}

export async function localIdentity(): Promise<SigningIdentity | undefined> {
  let saved: string;
  try {
    saved = await readFile(join(signingDirectory, "identity.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const config = JSON.parse(saved) as { identity: string };
  if (!/^[A-F0-9]{40}$/.test(config.identity))
    throw new Error("Invalid local signing identity");
  return {
    identity: config.identity,
    keychain: join(signingDirectory, "development.keychain-db"),
    password: (
      await readFile(join(signingDirectory, "password"), "utf8")
    ).trim(),
  };
}

export async function setupLocalSigning() {
  if (process.platform !== "darwin") throw new Error("macOS only");
  const existing = await localIdentity();
  if (existing) {
    await chmod(existing.keychain, 0o600);
    return existing;
  }
  await mkdir(signingDirectory, { recursive: true, mode: 0o700 });
  await chmod(signingDirectory, 0o700);
  const keychain = join(signingDirectory, "development.keychain-db");
  if (await Bun.file(keychain).exists())
    throw new Error(
      "An incomplete signing store exists; preserve it and inspect before retrying",
    );
  const work = await mkdtemp(join(tmpdir(), "lingosofa-signing-"));
  await chmod(work, 0o700);
  const password = crypto.randomUUID() + crypto.randomUUID();
  const certificate = join(work, "certificate.pem");
  const key = join(work, "private.pem");
  const p12 = join(work, "identity.p12");
  try {
    await signingCommand([
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-nodes",
      "-days",
      "3650",
      "-subj",
      "/CN=LingoSofa Local Development/",
      "-addext",
      "basicConstraints=critical,CA:FALSE",
      "-addext",
      "keyUsage=critical,digitalSignature",
      "-addext",
      "extendedKeyUsage=critical,codeSigning",
      "-keyout",
      key,
      "-out",
      certificate,
    ]);
    await chmod(key, 0o600);
    const pem = await readFile(certificate, "utf8");
    const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
    const identity = createHash("sha1").update(der).digest("hex").toUpperCase();
    const privateEnv = { ...cleanEnv(), LINGOSOFA_P12_PASSWORD: password };
    await signingCommand(
      [
        "openssl",
        "pkcs12",
        "-export",
        "-legacy",
        "-inkey",
        key,
        "-in",
        certificate,
        "-out",
        p12,
        "-passout",
        "env:LINGOSOFA_P12_PASSWORD",
      ],
      privateEnv,
    );
    await writeFile(join(signingDirectory, "password"), password, {
      mode: 0o600,
      flag: "wx",
    });
    await signingCommand([
      "/usr/bin/security",
      "create-keychain",
      "-p",
      password,
      keychain,
    ]);
    await signingCommand([
      "/usr/bin/security",
      "unlock-keychain",
      "-p",
      password,
      keychain,
    ]);
    await signingCommand([
      "/usr/bin/security",
      "import",
      p12,
      "-k",
      keychain,
      "-P",
      password,
      "-T",
      "/usr/bin/codesign",
    ]);
    // Only this dedicated signing keychain is configured for unattended codesign.
    await signingCommand([
      "/usr/bin/security",
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:,codesign:",
      "-s",
      "-k",
      password,
      keychain,
    ]);
    await chmod(keychain, 0o600);
    await writeFile(
      join(signingDirectory, "identity.json"),
      JSON.stringify({ identity }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    return { identity, keychain, password };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export function signatureArguments(
  path: string,
  identity: SigningIdentity,
  id: string,
  worker = false,
) {
  return [
    "/usr/bin/codesign",
    "--force",
    "--sign",
    identity.identity,
    "--keychain",
    identity.keychain,
    "--identifier",
    id,
    "--timestamp=none",
    ...(worker
      ? [
          "--entitlements",
          resolve(root, "apps/desktop/src-tauri/worker.entitlements.plist"),
        ]
      : []),
    path,
  ];
}

export async function signBinary(
  path: string,
  identity: SigningIdentity,
  id: string,
  worker = false,
) {
  await signingCommand(signatureArguments(path, identity, id, worker));
  await signingCommand(["/usr/bin/codesign", "--verify", "--strict", path]);
}

export async function signRuntime(
  identity: SigningIdentity,
  directory = resolve(root, "apps/desktop/src-tauri/resources"),
) {
  await signingCommand([
    "/usr/bin/security",
    "unlock-keychain",
    "-p",
    identity.password,
    identity.keychain,
  ]);
  for (const name of await readdir(directory)) {
    if (
      [
        "omp-worker",
        "selection-helper",
        "ocr-helper",
        "region-selector",
      ].includes(name) ||
      name.endsWith(".node")
    )
      await signBinary(
        join(directory, name),
        identity,
        `com.lingosofa.desktop.${name.replace(/[^a-zA-Z0-9.-]/g, "-")}`,
        name === "omp-worker",
      );
  }
}

if (import.meta.main && process.argv[2] === "setup") {
  await setupLocalSigning();
  console.log(
    "Stable local development signing is configured. Restart npm run dev to use it.",
  );
}
