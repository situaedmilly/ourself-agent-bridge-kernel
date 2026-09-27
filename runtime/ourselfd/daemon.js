import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { OURSELFdCore } from "./core.js";

export function createOURSELFdServer({
  repoRoot = process.env.OURSELF_REPO_ROOT || process.cwd(),
  socketPath = process.env.OURSELFD_SOCKET || "/var/tmp/ourselfd.sock",
  requester = process.env.OURSELFD_REQUESTER || "agentbridge",
  receiptDir = process.env.OURSELFD_RECEIPT_DIR || null
} = {}) {
  const core = new OURSELFdCore({ repoRoot, requester, receiptDir });

  const send = (res, status, body) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  };

  const readJson = async (req) => {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 64 * 1024) throw new Error("REQUEST_TOO_LARGE");
    }
    return raw ? JSON.parse(raw) : {};
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/v1/capabilities") {
        return send(res, 200, {
          authority: "OURSELFd",
          capabilities: core.capabilities(),
          explicitly_absent: [
            "shell.execute",
            "process.start",
            "repo.write",
            "file.write",
            "arbitrary_filesystem_access"
          ]
        });
      }

      if (req.method === "POST" && req.url === "/v1/instances") {
        return send(res, 201, core.createInstance(await readJson(req)));
      }

      if (req.method === "POST" && req.url === "/v1/transitions/request") {
        const receipt = await core.requestTransition(await readJson(req));
        return send(res, 200, receipt);
      }

      const receiptMatch = req.url?.match(/^\/v1\/receipts\/([^/]+)$/);
      if (req.method === "GET" && receiptMatch) {
        return send(res, 200, await core.recontactReceipt(receiptMatch[1]));
      }

      const instanceMatch = req.url?.match(/^\/v1\/instances\/([^/]+)$/);
      if (req.method === "GET" && instanceMatch) {
        return send(res, 200, core.getInstance(instanceMatch[1]));
      }

      return send(res, 404, { error: "NOT_FOUND" });
    } catch (error) {
      const known = new Set([
        "INSTANCE_NOT_FOUND",
        "RECEIPT_NOT_FOUND",
        "CAPABILITY_FORBIDDEN:shell.execute",
        "CAPABILITY_NOT_FOUND:repo.status",
        "CAPABILITY_NOT_FOUND:repo.read",
        "CAPABILITY_NOT_FOUND:repo.diff",
        "OPERATION_INVALID",
        "OPERATION_NOT_IMPLEMENTED",
        "TARGET_OUTSIDE_REPOSITORY",
        "REQUEST_TOO_LARGE"
      ]);
      const status = known.has(error.message) || error.message.startsWith("CAPABILITY_FORBIDDEN:")
        ? 403
        : error.message === "INSTANCE_NOT_FOUND" || error.message === "RECEIPT_NOT_FOUND"
          ? 404
          : 400;
      return send(res, status, { error: error.message });
    }
  });

  return {
    core,
    server,
    socketPath,
    async start() {
      await fs.rm(socketPath, { force: true });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      await fs.chmod(socketPath, 0o600);
      return { socketPath, pid: process.pid };
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(socketPath, { force: true });
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const daemon = createOURSELFdServer();
  const shutdown = async () => {
    await daemon.stop();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  await daemon.start();
  console.log(JSON.stringify({
    service: "OURSELFd",
    state: "RUNNING",
    socket: daemon.socketPath,
    pid: process.pid
  }));
}
