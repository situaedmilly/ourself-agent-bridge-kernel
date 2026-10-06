import test from 'node:test';
import assert from 'node:assert/strict';
import { createGitHubActionsTransport } from '../adapters/github-actions-transport.js';

test('transport pins origin and maps an admitted dispatch request to GitHub HTTP', async () => {
  const calls=[];
  const transport=createGitHubActionsTransport({token:'test-token',fetchImpl:async (url,init)=>{
    calls.push({url,init});
    return new Response(JSON.stringify({workflow_run_id:42}),{status:200,headers:{'content-type':'application/json'}});
  }});
  const result=await transport({
    method:'POST',
    path:'/repos/situaedmilly/ourself-agent-bridge-kernel/actions/workflows/311518895/dispatches',
    body:JSON.stringify({ref:'signal/local-ollama-cognition-20260922',inputs:{proof:'control-plane'}})
  });
  assert.equal(result.status,200);
  assert.equal(calls[0].url,'https://api.github.com/repos/situaedmilly/ourself-agent-bridge-kernel/actions/workflows/311518895/dispatches');
  assert.equal(calls[0].init.method,'POST');
  assert.equal(calls[0].init.headers.authorization,'Bearer test-token');
});

test('transport refuses arbitrary hosts and paths', async () => {
  const transport=createGitHubActionsTransport({token:'test-token',fetchImpl:async()=>{throw new Error('must not call fetch');}});
  await assert.rejects(()=>transport({method:'POST',path:'https://evil.example/execute',body:'{}'}),/outside the Actions boundary/);
  await assert.rejects(()=>transport({method:'DELETE',path:'/repos/situaedmilly/ourself-agent-bridge-kernel/actions/workflows/311518895/dispatches'}),/method is not allowed/);
});

test('transport does not expose the bearer token in error messages', async () => {
  const transport=createGitHubActionsTransport({token:'secret-token',fetchImpl:async()=>new Response(JSON.stringify({message:'denied'}),{status:403})});
  await assert.rejects(()=>transport({method:'POST',path:'/repos/situaedmilly/ourself-agent-bridge-kernel/actions/workflows/311518895/dispatches',body:'{"ref":"x","inputs":{}}'}),err=>!err.message.includes('secret-token'));
});
