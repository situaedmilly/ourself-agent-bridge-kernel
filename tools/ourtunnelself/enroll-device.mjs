import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const deviceId = process.argv[2];
const label = process.argv[3] || deviceId;
if (!deviceId || !/^[a-zA-Z0-9._-]{3,128}$/.test(deviceId)) {
  process.stderr.write("Usage: node tools/ourtunnelself/enroll-device.mjs <device-id> [label]\n");
  process.exit(2);
}
const key = crypto.generateKeyPairSync("ed25519");
const dir = process.env.OURTUNNELSELF_KEY_DIR || path.join(process.env.HOME || ".", ".ourself", "keys");
await fs.mkdir(dir, { recursive: true, mode: 0o700 });
const privatePath = path.join(dir, deviceId + ".ed25519.pem");
await fs.writeFile(privatePath, key.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
const publicKey = key.publicKey.export({ type: "spki", format: "pem" }).toString();
process.stdout.write(JSON.stringify({ device_id: deviceId, label, enabled: false, public_key: publicKey, private_key_path: privatePath, enrollment_state: "KEY_CREATED_NOT_ADMITTED" }, null, 2) + "\n");
