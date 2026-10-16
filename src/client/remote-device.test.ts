import { describe, expect, it } from "vitest";
import { deriveSessionKey } from "./e2ee-client.js";
import { deviceFor } from "./device.js";
import { unlockWithPassphrase } from "./remote-device.js";

/**
 * One passphrase, typed once, opens every machine that uses it and nothing
 * else (docs/MULTI_DEVICE_FEDERATION_IMPLEMENTATION.md §10). Each machine has
 * its own salt, so the same words derive a different key per machine.
 */
describe("unlocking several machines at once", () => {
  const ITERATIONS = 60_000;
  const saltA = Buffer.alloc(16, 1).toString("base64");
  const saltB = Buffer.alloc(16, 2).toString("base64");
  const saltC = Buffer.alloc(16, 3).toString("base64");

  it("hands each machine the key derived with its own salt, and skips the one with another passphrase", async () => {
    const a = deviceFor("4a0e3b4a-5c6d-4e7f-8a9b-0c1d2e3f4a51");
    const b = deviceFor("4a0e3b4a-5c6d-4e7f-8a9b-0c1d2e3f4a52");
    const c = deviceFor("4a0e3b4a-5c6d-4e7f-8a9b-0c1d2e3f4a53");
    const keyA = await deriveSessionKey("同一个口令", saltA, ITERATIONS);
    const keyB = await deriveSessionKey("同一个口令", saltB, ITERATIONS);
    const keyC = await deriveSessionKey("另一个口令", saltC, ITERATIONS);
    // Same words, different salts: different keys, which is why nothing can
    // be replayed from one machine to another.
    expect(keyA.fingerprint).not.toBe(keyB.fingerprint);
    await a.gate.applyRequirement({ required: true, fingerprint: keyA.fingerprint });
    await b.gate.applyRequirement({ required: true, fingerprint: keyB.fingerprint });
    await c.gate.applyRequirement({ required: true, fingerprint: keyC.fingerprint });

    const opened = await unlockWithPassphrase("同一个口令", [
      { device: a, kdf: { salt: saltA, iterations: ITERATIONS } },
      { device: b, kdf: { salt: saltB, iterations: ITERATIONS } },
      { device: c, kdf: { salt: saltC, iterations: ITERATIONS } },
    ]);
    expect(opened).toBe(2);
    expect(a.gate.currentKey()?.fingerprint).toBe(keyA.fingerprint);
    expect(b.gate.currentKey()?.fingerprint).toBe(keyB.fingerprint);
    expect(c.gate.currentKey()).toBeNull();
  });

  it("reports that nothing took a wrong passphrase", async () => {
    const d = deviceFor("4a0e3b4a-5c6d-4e7f-8a9b-0c1d2e3f4a54");
    const keyD = await deriveSessionKey("正确的口令", saltA, ITERATIONS);
    await d.gate.applyRequirement({ required: true, fingerprint: keyD.fingerprint });
    expect(await unlockWithPassphrase("打错了", [{ device: d, kdf: { salt: saltA, iterations: ITERATIONS } }])).toBe(0);
    expect(d.gate.currentKey()).toBeNull();
  });
});
