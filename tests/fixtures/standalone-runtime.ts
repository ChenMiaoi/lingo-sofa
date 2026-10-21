console.log(
  JSON.stringify({
    configuration: process.env.LINGOSOFA_RUNTIME_CONFIG_PROBE ?? "isolated",
    mode: process.env.NODE_ENV,
  }),
);
