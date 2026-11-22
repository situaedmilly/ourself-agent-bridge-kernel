import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const keyDir = process.env.OURTUNNELSELF_KEY_DIR || "/etc/ourtunnelself";
await fs.mkdir(keyDir, { recursive: true, mode: 0o700 });
const privatePath = path.join(keyDir, "broker-private.pem");
const publicPath = path.join(keyDir, "broker-public.pem");
const pair = crypto.generateKeyPairSync("rsa", { modulusLength: 3072, publicExponent: 0x10001 });
await fs.writeFile(privatePath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
await fs.writeFile(publicPath, pair.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644, flag: "wx" });
process.stdout.write(JSON.stringify({
  state: "BROKER_KEYPAIR_CREATED",
  private_key_path: privatePath,
  public_key_path: publicPath,
  note: "Distribute broker-public.pem to enrolled device agents. Never copy broker-private.pem to devices or commit either key."
}, null, 2) + "\n");
