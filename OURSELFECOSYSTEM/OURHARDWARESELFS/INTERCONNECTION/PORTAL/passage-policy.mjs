const STATES = Object.freeze({
  DISCOVERY:"DISCOVERY", IDENTITY_BINDING:"IDENTITY_BINDING",
  PORTAL_EVALUATION:"PORTAL_EVALUATION", PORTAL_ADMISSION:"PORTAL_ADMISSION",
  CAPABILITY_NEGOTIATION:"CAPABILITY_NEGOTIATION", PIPE_CONNECTION:"PIPE_CONNECTION",
  EXECUTION_REQUEST:"EXECUTION_REQUEST", KERNEL_ENFORCEMENT:"KERNEL_ENFORCEMENT",
  WITNESS:"WITNESS", DENIED:"DENIED"
});

export function evaluatePortalPolicy(request, context) {
  const reasons=[];
  if (!request || !context) return {state:STATES.DENIED,decision:"DENY",reasons:["request_or_context_missing"],execution_authorized:false,signed:false};
  if (context.sourceIdentityVerified!==true) reasons.push("source_identity_not_verified");
  if (context.targetIdentityVerified!==true) reasons.push("target_identity_not_verified");
  if (context.bindingVerified!==true) reasons.push("identity_binding_not_verified");
  if (context.sourceJurisdictionVerified!==true) reasons.push("source_jurisdiction_not_verified");
  if (context.targetJurisdictionVerified!==true) reasons.push("target_jurisdiction_not_verified");
  if (context.authorityGrantVerified!==true) reasons.push("authority_grant_not_verified");
  if (context.requiredMoatsVerified!==true) reasons.push("required_moats_not_verified");
  if (context.evidenceFresh!==true) reasons.push("evidence_freshness_not_verified");
  const requested=new Set(request.requested_capabilities??[]);
  const sourceAllowed=new Set(context.sourcePermittedCapabilities??[]);
  const targetAllowed=new Set(context.targetPermittedCapabilities??[]);
  for (const cap of requested) {
    if (!sourceAllowed.has(cap)||!targetAllowed.has(cap)) reasons.push("capability_not_mutually_permitted:"+cap);
  }
  const expiry=Date.parse(request.expires_at??"");
  const now=Date.parse(context.now??"");
  if (!Number.isFinite(expiry)||!Number.isFinite(now)||expiry<=now) reasons.push("request_expired_or_invalid_time");
  if (reasons.length) return {
    state:STATES.DENIED,decision:"DENY",reasons:[...new Set(reasons)],
    admitted_capabilities:[],execution_authorized:false,signed:false,
    artifact_status:"UNSIGNED_POLICY_EVALUATION"
  };
  return {
    state:STATES.PORTAL_EVALUATION,decision:"ADMISSION_CANDIDATE",reasons:[],
    admitted_capabilities:[...requested],execution_authorized:false,signed:false,
    artifact_status:"UNSIGNED_POLICY_EVALUATION",
    next_required:"Independent PORTAL signer and admission-decision verification"
  };
}

export function mayConnect(decision, now=Date.now()) {
  return Boolean(decision&&decision.decision==="ADMIT"&&decision.signature_verified===true&&
    decision.expires_at&&Date.parse(decision.expires_at)>now);
}

export function mayExecute(decision, kernelAuthorization, now=Date.now()) {
  return mayConnect(decision,now)&&kernelAuthorization?.authorized===true&&
    kernelAuthorization?.target_identity_ref===decision.target_identity_ref&&
    Array.isArray(decision.admitted_capabilities)&&
    decision.admitted_capabilities.includes(kernelAuthorization.capability);
}
export {STATES as PASSAGE_STATES};
