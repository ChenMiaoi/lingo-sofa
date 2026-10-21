type SDK = typeof import("@oh-my-pi/pi-coding-agent");

export function restrictedSettings(
  sdk: SDK,
  budget = { keepRecentTokens: 4096, reserveTokens: 2048 },
) {
  return sdk.Settings.isolated({
    "retry.enabled": false,
    "features.unexpectedStopDetection": "none",
    "compaction.enabled": false,
    "compaction.methodOrder": ["soft"],
    "compaction.asyncEnabled": false,
    "compaction.keepRecentTokens": budget.keepRecentTokens,
    "compaction.reserveTokens": budget.reserveTokens,
    "compaction.autoContinue": false,
    "compaction.idleEnabled": false,
    "memory.backend": "off",
    "autolearn.enabled": false,
    "providers.cacheWarming": "off",
  });
}

export function createRestrictedSession(
  sdk: SDK,
  options: Pick<
    NonNullable<Parameters<SDK["createAgentSession"]>[0]>,
    "cwd" | "agentDir" | "model" | "authStorage" | "modelRegistry"
  >,
  budget?: { keepRecentTokens: number; reserveTokens: number },
) {
  return sdk.createAgentSession({
    ...options,
    settings: restrictedSettings(sdk, budget),
    sessionManager: sdk.SessionManager.inMemory(options.cwd),
    agentRegistry: new sdk.AgentRegistry(),
    toolNames: [],
    restrictToolNames: true,
    enableMCP: false,
    enableLsp: false,
    enableIrc: false,
    skipPythonPreflight: true,
    disableExtensionDiscovery: true,
    preloadedExtensionPaths: [],
    preloadedCustomToolPaths: [],
    extensions: [],
    skills: [],
    rules: [],
    contextFiles: [],
    promptTemplates: [],
    slashCommands: [],
    autoTitle: false,
    cacheWarming: false,
    bindProcessState: false,
    systemPrompt:
      "Translate or answer only the supplied text. No tools. Keep responses short.",
    thinkingLevel: "off",
  });
}
