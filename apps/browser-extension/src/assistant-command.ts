export type AssistantPlatform = "win" | "mac" | "linux";

export function assistantAuthorizationCommand(
  platform: AssistantPlatform,
  extensionId: string,
): string {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error("Invalid extension ID");
  if (platform === "win")
    return `$h = if ($env:LINGO_SOFA_HOME) {
  $env:LINGO_SOFA_HOME
} else {
  Join-Path $HOME '.config/lingo-sofa'
}
$r = Get-Content -LiteralPath (Join-Path $h 'runtime-install.json') -Raw -ErrorAction Stop |
  ConvertFrom-Json
$authorize = Join-Path (Split-Path $r.entrypoint) 'authorize-browser.mjs'
& $r.executable $authorize '${extensionId}'`;
  return `sh "\${LINGO_SOFA_HOME:-$HOME/.config/lingo-sofa}/Authorize.command" '${extensionId}'`;
}
