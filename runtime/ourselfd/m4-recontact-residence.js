import { evaluateMachineResidence, requiredResidenceEvidence } from "./residence.js";

const instance_id = process.env.OURSELF_RECONTACT_INSTANCE_ID || "m4-reverself-local";
const process_identity = process.env.OURSELF_RECONTACT_PROCESS_IDENTITY || "pid:RECONTACT_REQUIRED";

const graph = requiredResidenceEvidence().map((species) => ({
  species,
  instance_id,
  payload: {
    process_identity:
      species === "BIRTH" || species === "RECONTACT" || species === "PROCESS_IDENTITY" || species === "LIVENESS"
        ? process_identity
        : undefined
  }
}));

const result = evaluateMachineResidence(graph);

const receipt = {
  receipt_version: "0.1",
  gate: "M4-REVERSELF",
  transition: "BOUNDED_BIRTH_RECEIPT → RECONTACT → RESIDENCE_EVALUATION",
  result,
  boundary: {
    ci_runner_residence: "NOT_TARGET_MACHINE_RESIDENCE",
    target_machine_residence: result.state === "PROVEN" ? "PROVEN_ONLY_FOR_SUBMITTED_EVIDENCE" : "UNPROVEN"
  }
};

process.stdout.write(JSON.stringify(receipt, null, 2) + "\n");
