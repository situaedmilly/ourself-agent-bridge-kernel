import test from "node:test";
import assert from "node:assert/strict";
import { assessInstance } from "../compiler/assess-instance.mjs";
const base={instance_id:"x",canonical_name:"x",entity_type:"PHYSICAL_SUBSTRATE"};
test("unknown entity type is rejected",()=>assert.equal(assessInstance({...base,entity_type:"MAGIC_DEVICE"}).valid,false));
test("unassessed moats do not pass the moat gate",()=>assert.equal(assessInstance(base).moat_gate_satisfied,false));
test("VERIFIED moat without evidence and method is rejected",()=>{
 const r=assessInstance({...base,moats:{IDENTITYMOAT:{status:"VERIFIED",evidence_refs:[]}}});
 assert.equal(r.valid,false);assert.match(r.errors.join(" "),/VERIFIED without evidence_refs/);
});
test("PROVEN requires independently verified admission receipt",()=>{
 const r=assessInstance({...base,admission_state:"PROVEN"});
 assert.equal(r.valid,false);assert.match(r.errors.join(" "),/PROVEN/);
});
test("BOUND requires independently evidenced identity and binding",()=>{
 const r=assessInstance({...base,admission_state:"BOUND"});
 assert.equal(r.valid,false);assert.match(r.errors.join(" "),/BOUND/);
});
test("a named access surface cannot inherit a host as an identity",()=>{
 const r=assessInstance({instance_id:"ssh",canonical_name:"SSH",entity_type:"ACCESS_SURFACE"});
 assert.equal(r.entity_type,"ACCESS_SURFACE");assert.notEqual(r.entity_type,"PHYSICAL_SUBSTRATE");
});
