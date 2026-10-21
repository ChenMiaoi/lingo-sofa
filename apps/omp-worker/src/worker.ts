import { runWorker } from "./runtime";
await runWorker({
  provider: "deepseek",
  modelId: "deepseek-flash",
  accounts: ["deepseek"],
  origin: "https://api.deepseek.com",
  outputCap: 2048,
});
