import { expect, it } from "vitest";
import { createHash, createPublicKey } from "node:crypto";
import {
  BROWSER_EXTENSION_ID,
  BROWSER_EXTENSION_KEY,
} from "@lingo-sofa/protocol";

it("keeps the published browser identity tied to the same valid public key", () => {
  const bytes = Buffer.from(BROWSER_EXTENSION_KEY, "base64");
  const key = createPublicKey({ key: bytes, type: "spki", format: "der" });
  expect(key.asymmetricKeyType).toBe("rsa");
  const id = createHash("sha256")
    .update(bytes)
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) =>
      String.fromCharCode(97 + Number.parseInt(digit, 16)),
    );
  expect(id).toBe(BROWSER_EXTENSION_ID);
  expect(id).toBe("ahbkbjlbljldmlgkdppdkeeemlajjhgh");
});
