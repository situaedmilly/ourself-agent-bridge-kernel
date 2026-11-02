import { fileURLToPath } from "node:url";
import path from "node:path";
const MOATS = [
"IDENTITYMOAT","OSMOAT","BOOTMOAT","ACCESSMOAT","JURISDICTIONMOAT",
"EXECUTIONMOAT","COGNITIONMOAT","MEMORYMOAT","NETWORKMOAT",
"RESOURCEPROOFMOAT","PROVENANCEMOAT","RECEIPTMOAT","MUTATIONMOAT","RECOVERYMOAT"
];
const TYPES = new Set(["PHYSICAL_SUBSTRATE","OPERATING_SYSTEM","VIRTUAL_SUBSTRATE","ACCESS_SURFACE","ECOSYSTEM_REALITY"]);
const STATES = ["DECLARED","DISCOVERED","IDENTITY_VERIFIED","BOUND","MOATED","OPERATIONAL","PROVEN"];
const MOAT_STATES = new Set(["UNASSESSED","DECLARED","IMPLEMENTED_UNVERIFIED","VERIFIED","BLOCKED","NOT_APPLICABLE"]);
function evidenceGate(value) {
  return Boolean(value && value.status === "VERIFIED" &&
    Array.isArray(value.evidence_refs) && value.evidence_refs.length > 0 &&
    typeof value.verification_method === "string" && value.verification_method.trim());
}
export function assessInstance(instance) {
  const errors=[];
  if (!instance || typeof instance !== "object" || Array.isArray(instance)) return {valid:false,errors:["Instance must be a JSON object"]};
  for (const field of ["instance_id","canonical_name","entity_type"]) if (typeof instance[field] !== "string" || !instance[field].trim()) errors.push("Missing "+field);
  if (!TYPES.has(instance.entity_type)) errors.push("Unsupported entity_type: "+instance.entity_type);
  const requested=instance.admission_state??"DECLARED";
  if (!STATES.includes(requested)) errors.push("Invalid admission_state");
  const supplied=instance.moats??{};
  const moat_matrix=Object.fromEntries(MOATS.map(name=>{
    const item=supplied[name]??{status:"UNASSESSED",evidence_refs:[]};
    const status=item.status??"UNASSESSED";
    const refs=Array.isArray(item.evidence_refs)?item.evidence_refs:[];
    const verified=status==="VERIFIED"&&refs.length>0&&typeof item.verification_method==="string"&&item.verification_method.trim().length>0;
    if (!MOAT_STATES.has(status)) errors.push("Invalid moat status for "+name);
    if (status==="VERIFIED"&&!verified) errors.push(name+" claims VERIFIED without evidence_refs and verification_method");
    if (status==="NOT_APPLICABLE"&&!item.rationale) errors.push(name+" NOT_APPLICABLE requires rationale");
    return [name,{status:MOAT_STATES.has(status)?status:"UNASSESSED",evidence_refs:refs,verification_method:item.verification_method??null,rationale:item.rationale??null,satisfies_gate:verified||(status==="NOT_APPLICABLE"&&Boolean(item.rationale))}];
  }));
  const allMoats=Object.values(moat_matrix).every(x=>x.satisfies_gate);
  const gates = {
    IDENTITY_VERIFIED: evidenceGate(instance.identity_verification),
    BOUND: evidenceGate(instance.identity_verification)&&evidenceGate(instance.binding_receipt),
    MOATED: allMoats&&evidenceGate(instance.moat_audit),
    OPERATIONAL: allMoats&&evidenceGate(instance.moat_audit)&&evidenceGate(instance.authority_grant)&&evidenceGate(instance.operational_witness),
    PROVEN: evidenceGate(instance.admission_receipt)&&instance.admission_receipt.independent_verification===true
  };
  const required=STATES.indexOf(requested);
  const unmet=Object.entries(gates).filter(([state,ok])=>STATES.indexOf(state)<=required&&STATES.indexOf(state)>=2&&!ok).map(([state])=>state);
  if (unmet.length) errors.push("Admission prerequisites missing: "+unmet.join(", "));
  return {
    valid:errors.length===0,errors,instance_id:instance.instance_id??null,
    canonical_name:instance.canonical_name??null,entity_type:instance.entity_type??null,
    requested_state:requested,compiler_disposition:"ASSESSMENT_ONLY_NO_AUTOPROMOTION",
    moat_matrix,moat_gate_satisfied:allMoats,prerequisite_gates:gates,
    admission_receipt:{status:"NOT_ISSUED",reference:null,reason:"Compiler does not sign or attest hardware state."},
    eligible_for_admission_review:errors.length===0&&requested!=="PROVEN"
  };
}
