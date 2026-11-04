import { getEnv } from "../config/env.js";
import { BitrefillMerchantAdapter } from "./bitrefill.js";
import { MockMerchantAdapter } from "./mock.js";
import { MerchantAdapter } from "./types.js";

let adapterInstance: MerchantAdapter | null = null;

export function getMerchantAdapter(): MerchantAdapter {
  if (adapterInstance) return adapterInstance;

  const env = getEnv();
  if (env.BITREFILL_MODE === "mock" || !env.BITREFILL_API_KEY) {
    adapterInstance = new MockMerchantAdapter();
  } else {
    adapterInstance = new BitrefillMerchantAdapter();
  }

  return adapterInstance;
}

export * from "./types.js";
export * from "./bitrefill.js";
export * from "./mock.js";

