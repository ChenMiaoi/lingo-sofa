export { restrictedSettings } from "../../apps/omp-worker/src/restricted-sdk";
import { createRestrictedSession as create } from "../../apps/omp-worker/src/restricted-sdk";
export const createRestrictedSession = (...args: Parameters<typeof create>) =>
  create(args[0], args[1], { keepRecentTokens: 128, reserveTokens: 512 });
