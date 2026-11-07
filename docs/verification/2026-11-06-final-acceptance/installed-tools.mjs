// Native Node execution of the installed tarballs; faux model, actual host tools.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerFauxProvider, fauxAssistantMessage, fauxToolCall } from '/Users/x/.pi/lightclaw/releases/20261106-final/independent-verified/install/node_modules/@mariozechner/pi-ai/dist/index.js';
import { createAgentRunner } from '/Users/x/.pi/lightclaw/releases/20261106-final/independent-verified/install/node_modules/lightclaw/dist/agent.js';
import { ChannelStore } from '/Users/x/.pi/lightclaw/releases/20261106-final/independent-verified/install/node_modules/lightclaw/dist/store.js';
import { GoalStore } from '/Users/x/.pi/lightclaw/releases/20261106-final/independent-verified/install/node_modules/lightclaw/dist/goals/store.js';
const base='/Users/x/.pi/lightclaw/releases/20261106-final/installed-tools';
if(existsSync(base))throw new Error('Fresh fixture required');
const work=join(base,'work'), channel='fixture', channelDir=join(work,channel), file=join(channelDir,'artifact.txt');
mkdirSync(channelDir,{recursive:true,mode:0o700});
const faux=registerFauxProvider();
const value='fictional-installed-tool-fixture';
faux.setResponses([
 fauxAssistantMessage(fauxToolCall('write',{label:'Write fixture',path:file,content:value}),{stopReason:'toolUse'}),
 fauxAssistantMessage(fauxToolCall('read',{label:'Read fixture',path:file}),{stopReason:'toolUse'}),
 context=>{assert.ok(JSON.stringify(context.messages).includes(value));return fauxAssistantMessage('INSTALLED_TOOLS_OK');},
]);
const goals=new GoalStore({channelDir,controlChannelDir:join(base,'control',channel),limits:{maxCycles:8,maxFailures:2,maxStaleCycles:2}});
let answer='';
const context={message:{text:'Run fictional isolated tool fixture',rawText:'Run fictional isolated tool fixture',user:'fixture-owner',channel,ts:'1',attachments:[]},channels:[],users:[],respond:async text=>{answer=text;},replaceMessage:async text=>{answer=text;},respondInThread:async()=>{},setTyping:async()=>{},uploadFile:async()=>{throw new Error('No external calls');},setWorking:async()=>{},deleteMessage:async()=>{}};
const runner=createAgentRunner({type:'host'},channel,channelDir,{transport:'feishu',modelProvider:'unused',modelId:'unused',policyMode:'off',maxGoalCycles:8,maxGoalFailures:2,maxStaleCycles:2},goals,{model:faux.getModel(),apiKey:'faux',quiet:true});
try{
 const result=await runner.run(context,new ChannelStore({workingDir:work}));
 assert.equal(result.stopReason,'stop');assert.equal(result.toolCalls,2);assert.equal(result.toolErrors,0);
 assert.equal(readFileSync(file,'utf8'),value);assert.equal(answer,'INSTALLED_TOOLS_OK');
 assert.ok(existsSync(join(channelDir,'context.jsonl')));
 const receipt={status:'passed',installedNativeNode:true,provider:'faux',actualTools:['write','read'],toolCalls:2,persistedContext:true,networkRequests:0,limits:'Controlled fixture, policy off inside isolated directory; not a live model tool-selection or production authorization proof'};
 writeFileSync('/Users/x/Light-Claw/docs/verification/2026-11-06-final-acceptance/installed-tools-result.json',JSON.stringify(receipt,null,2)+'\n');
 console.log(JSON.stringify(receipt));
}finally{runner.dispose();faux.unregister();}
