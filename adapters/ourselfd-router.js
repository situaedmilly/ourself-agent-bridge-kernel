import express from "express";
import { createOURSELFdClient } from "./ourselfd-client.js";

export function createOURSELFdRouter(options = {}) {
  const router = express.Router();
  const client = createOURSELFdClient(options);

  const forward = (operation) => async (req, res) => {
    try {
      const result = await operation(req);
      return res.status(200).json(result);
    } catch (error) {
      const status = Number.isInteger(error.status)
        ? error.status
        : error.code === "ENOENT" || error.code === "ECONNREFUSED"
          ? 503
          : 502;
      return res.status(status).json({
        error: error.message || "OURSELFD_UNAVAILABLE"
      });
    }
  };

  router.get("/capabilities", forward(() => client.capabilities()));
  router.post("/instances", forward((req) => client.createInstance(req.body || {})));
  router.post("/transitions/request", forward((req) => client.requestTransition(req.body || {})));
  router.get("/instances/:instanceId", forward((req) => client.getInstance(req.params.instanceId)));
  router.get("/receipts/:receiptId", forward((req) => client.getReceipt(req.params.receiptId)));
  router.get("/ledger", forward(() => client.ledger()));

  return router;
}