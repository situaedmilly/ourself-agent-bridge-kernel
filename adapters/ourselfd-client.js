import http from "node:http";

export function createOURSELFdClient({
  socketPath = process.env.OURSELFD_SOCKET || "/var/tmp/ourselfd.sock",
  token = process.env.BRIDGE_TOKEN
} = {}) {
  if (!socketPath || !token) throw new Error("OURSELFD_CLIENT_CONFIGURATION_REQUIRED");

  const request = (method, requestPath, body) => new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      socketPath,
      path: requestPath,
      method,
      timeout: 7000,
      headers: {
        "x-ourself-agent-token": token,
        ...(payload ? {
          "content-type": "application/json",
          "content-length": String(payload.length)
        } : {})
      }
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          return reject(new Error("OURSELFD_RESPONSE_INVALID"));
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error(parsed?.error || "OURSELFD_REQUEST_FAILED");
          error.status = res.statusCode;
          return reject(error);
        }
        resolve(parsed);
      });
    });
    req.on("timeout", () => req.destroy(new Error("OURSELFD_TIMEOUT")));
    req.on("error", (error) => reject(error));
    if (payload) req.write(payload);
    req.end();
  });

  return Object.freeze({
    capabilities: () => request("GET", "/v1/capabilities"),
    createInstance: (metadata = {}) => request("POST", "/v1/instances", metadata),
    requestTransition: (transition) => request("POST", "/v1/transitions/request", transition),
    getInstance: (instanceId) => request("GET", "/v1/recontact/instances/" + encodeURIComponent(instanceId)),
    getReceipt: (receiptId) => request("GET", "/v1/recontact/receipts/" + encodeURIComponent(receiptId)),
    ledger: () => request("GET", "/v1/ledger")
  });
}