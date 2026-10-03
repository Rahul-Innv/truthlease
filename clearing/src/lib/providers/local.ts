import { extractLocal } from "../interpret";
import type { ReasoningProvider } from "./types";

/** Deterministic rules. Zero model calls. */
export function localProvider(): ReasoningProvider {
  return {
    mode: "local",
    provider: "Local rules",
    async interpret(text) {
      return { value: extractLocal(text), reasoning: "local", callsUsed: 0 };
    },
    async chooseAsks(candidates) {
      return { value: candidates, reasoning: "local", callsUsed: 0 };
    },
    async chooseSellerLever(_offer, lever) {
      return { value: lever, reasoning: "local", callsUsed: 0 };
    },
    callsUsed: () => 0,
  };
}
