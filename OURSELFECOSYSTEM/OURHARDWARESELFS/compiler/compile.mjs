#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessInstance } from "./assess-instance.mjs";
const HERE=path.dirname(fileURLToPath(import.meta.url));
const ROOT=path.resolve(HERE,"..");
function readJson(p){return JSON.parse(fs.readFileSync(p,"utf8"));}
function compileRegistry(){
  const hardware=readJson(path.join(ROOT,"REGISTRY/hardware-instances.json"));
  const os=readJson(path.join(ROOT,"REGISTRY/operating-systems.json"));
  const bindings=readJson(path.join(ROOT,"REGISTRY/identity-bindings.json"));
  const physical=hardware.physical_substrates??[];
  const virtual=hardware.virtual_substrates??[];
  const ids=[...physical,...virtual].map(x=>x.instance_id);
  const names=physical.map(x=>x.canonical_name);
  const errors=[
    ...ids.filter((x,i)=>ids.indexOf(x)!==i).map(x=>"Duplicate instance_id: "+x),
    ...names.filter((x,i)=>names.indexOf(x)!==i).map(x=>"Duplicate physical canonical_name: "+x),
    ...(os.instances??[]).filter(x=>!ids.includes(x.host_instance_id)).map(x=>"OS host binding unresolved: "+x.os_instance_id+" -> "+x.host_instance_id)
  ];
  const toAssessment=x=>assessInstance({
    instance_id:x.instance_id,canonical_name:x.canonical_name,entity_type:x.entity_type,
    admission_state:x.identity_status==="DISCOVERED"?"DISCOVERED":"DECLARED"
  });
  const unresolved=(bindings.bindings??[]).filter(x=>x.status!=="VERIFIED");
  return {
    schema:"ourself.hardware.compiler-assessment.v0.1",generated_at:new Date().toISOString(),
    mode:"READ_ONLY_ASSESSMENT",registry_status:"NOT_ADMITTED_BY_COMPILER",
    inventory:{physical_substrates:physical.length,virtual_substrates:virtual.length,operating_system_instances:(os.instances??[]).length,identity_bindings:(bindings.bindings??[]).length,unresolved_identity_bindings:unresolved.length},
    registry_errors:errors,physical_assessments:physical.map(toAssessment),virtual_assessments:virtual.map(toAssessment),
    invariants:{alias_creates_physical_instance:false,access_surface_inherits_target_authority:false,ecosystem_identity_auto_binds_to_hardware:false,observation_equals_attestation:false,compiler_promotes_admission_state:false},
    limitations:["No hardware attestation performed","No signatures generated or verified","No boot measurements collected by this compiler","No admission or mutation performed","Registry evidence references are not dereferenced or independently validated"],
    registry_valid:errors.length===0
  };
}
const arg=process.argv[2];
const result=arg?assessInstance(readJson(path.resolve(process.cwd(),arg))):compileRegistry();
process.stdout.write(JSON.stringify(result,null,2)+"\n");
if(result.valid===false||result.registry_valid===false)process.exitCode=1;
