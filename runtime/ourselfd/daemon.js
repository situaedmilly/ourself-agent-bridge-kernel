import "dotenv/config";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { OURSELFdCore } from "./core.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function createOURSELFdServer({
  repoRoot = process.env.OURSELF_REPO_ROOT || path.resolve(HERE, "../.."),
  socketPath = process.env.OURSELFD_SOCKET || "/var/tmp/ourselfd.sock",
  stateDir = process.env.OURSELFD_STATE_DIR,
  authToken = process.env.OURSELFD_AGENTBRIDGE_TOKEN || process.env.BRIDGE_TOKEN,
  principal = "agentbridge"
} = {}) {
  const core = new OURSELFdCore({ repoRoot, stateDir, authToken, principal });

  const send = (res, status, body) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.end(JSON.stringify(body));
  };

  const readJson = async (req) => {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > 64 * 1024) throw new Error("REQUEST_TOO_LARGE");
    }
    try {
      return raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error("JSON_INVALID");
    }
  };

  const authorized = (req) => {
    const presented = req.headers["x-ourself-agent-token"];
    if (!core.authenticate(presented)) return false;
    return true;
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        return send(res, 200, { service: "OURSELFd", state: "READY" });
      }
      if (!authorized(req)) return send(res, 401, { error: "AUTHENTICATION_REQUIRED" });

      if (req.method === "GET" && req.url === "/v1/capabilities") {
        return send(res, 200, core.capabilities());
      }

      if (req.method === "GET" && req.url === "/v1/ledger") {
        await core.initialize();
        return send(res, 200, core.ledgerStatus());
      }

      if (req.method === "POST" && req.url === "/v1/instances") {
        const metadata = await readJson(req);
        const instance = await core.createInstance(metadata, principal);
        return send(res, 201, instance);
      }

      if (req.method === "POST" && req.url === "/v1/transitions/request") {
        const body = await readJson(req);
        const receipt = await core.requestTransition({ ...body, principal });
        return send(res, 200, receipt);
      }

      const receiptMatch = req.url?.match(/^\/v1\/(?:receipts|recontact\/receipts)\/([^/]+)$/);
      if (req.method === "GET" && receiptMatch) {
        return send(res, 200, await core.getReceipt(decodeURIComponent(receiptMatch[1])));
      }

      const instanceMatch = req.url?.match(/^\/v1\/(?:instances|recontact\/instances)\/([^/]+)$/);
      if (req.method === "GET" && instanceMatch) {
        return send(res, 200, await core.getInstance(decodeURIComponent(instanceMatch[1])));
      }

      return send(res, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const code = error?.message || "INTERNAL_ERROR";
      const status = code === "INSTANCE_NOT_FOUND" || code === "RECEIPT_NOT_FOUND"
        ? 404
        : code === "PRE_STATE_DRIFT" || code === "PRINCIPAL_BINDING_MISMATCH"
          ? 409
          : code === "CAPABILITY_FORBIDDEN" || code === "CAPABILITY_NOT_IMPLEMENTED" ||
            code === "CAPABILITY_NOT_FOUND" || code === "AUTHORITY_DENIED" ||
            code === "PRINCIPAL_NOT_ADMITTED" || code === "TARGET_NOT_ADMITTED" ||
            code === "PRE_STATE_BINDING_REQUIRED"
            ? 403
            : code === "LEDGER_CORRUPT" || code.startsWith("LEDGER_CORRUPT:")
              ? 503
              : 400;
      return send(res, status, { error: code });
    }
  });

  return {
    core,
    server,
    socketPath,
    async start() {
      if (!core.authTokenHash) throw new Error("OURSELFD_AUTH_TOKEN_REQUIRED");
      await core.initialize();
      await fs.mkdir(path.dirname(socketPath), { recursive: true });
      try {
        const existing = await fs.lstat(socketPath);
        if (existing) throw new Error("SOCKET_PATH_OCCUPIED");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await fs.chmod(socketPath, 0o600);
      return { service: "OURSELFd", state: "RUNNING", socket: socketPath, pid: process.pid };
    },
    async stop() {
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      try {
        const existing = await fs.lstat(socketPath);
        if (existing.isSocket()) await fs.unlink(socketPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const daemon = createOURSELFdServer();
  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  const started = await daemon.start();
  process.stdout.write(JSON.stringify(started) + "\n");
}