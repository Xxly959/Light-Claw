// Authorized, bounded functional acceptance. Never starts a second WebSocket client.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { loadConfig } from '/Users/x/.pi/lightclaw/releases/20261106-final/independent-verified/install/node_modules/lightclaw/dist/config.js';
import { initializeHttpTransport } from '/Users/x/.pi/lightclaw/releases/20261106-final/independent-verified/install/node_modules/lightclaw/dist/http.js';
import { FeishuBot } from '/Users/x/.pi/lightclaw/releases/20261106-final/independent-verified/install/node_modules/lightclaw/dist/feishu.js';
import { ChannelStore } from '/Users/x/.pi/lightclaw/releases/20261106-final/independent-verified/install/node_modules/lightclaw/dist/store.js';
import { GoalStore } from '/Users/x/.pi/lightclaw/releases/20261106-final/independent-verified/install/node_modules/lightclaw/dist/goals/store.js';
import { createAgentRunner } from '/Users/x/.pi/lightclaw/releases/20261106-final/independent-verified/install/node_modules/lightclaw/dist/agent.js';
import { createPromptRewriter } from '/Users/x/.pi/lightclaw/releases/20261106-final/independent-verified/install/node_modules/lightclaw/dist/prompt-input.js';
const repo='/Users/x/Light-Claw', base='/Users/x/.pi/lightclaw/releases/20261106-final/live-verified';
mkdirSync(base,{recursive:true,mode:0o700});
const receiptPath=join(base,'receipt.private.json');
if(existsSync(receiptPath)) throw new Error('Acceptance already attempted; no automatic replay');
const env=parseEnv(readFileSync(join(repo,'.env'),'utf8'));
Object.assign(process.env,env); delete process.env.NODE_OPTIONS;
const scope=JSON.parse(readFileSync('/Users/x/.pi/lightclaw/releases/20261106-final/live/scope.private.json','utf8'));
const channel=scope.dedicatedConversation;
const config=loadConfig(env);
if(scope.platform!=='feishu'||scope.dedicatedApplication!==config.feishu.appId||!/^oc_[\w-]+$/.test(channel)) throw new Error('Scope mismatch');
const receipt={schema:1,startedAt:new Date().toISOString(),authorization:'2026-11-06 user reply: private chat max send5/edit5/upload1; isolated build/install',destinationSha256:createHash('sha256').update(channel).digest('hex'),limits:{send:2,edit:1,upload:1},reservedForManual:{send:3,edit:4},counts:{send:0,edit:0,upload:0},steps:[],status:'started',realUserCallbackTested:false};
const save=()=>writeFileSync(receiptPath,JSON.stringify(receipt,null,2)+'\n',{mode:0o600}); save();
const reserve=kind=>{if(receipt.counts[kind]>=receipt.limits[kind])throw new Error('Acceptance quota exhausted');receipt.counts[kind]++;save();};
const step=name=>{receipt.steps.push(name);save();console.log(JSON.stringify({step:name}));};
const working=join(base,'work');mkdirSync(join(working,channel),{recursive:true,mode:0o700});
const store=new ChannelStore({workingDir:working});
const handler={isRunning:()=>false,handleQueueFailure:async()=>{},handleEvent:async()=>{},handleStop:async()=>{}};
let runner; const dispatcher=initializeHttpTransport();
const bot=new FeishuBot(handler,{...config.feishu,workingDir:working,store,platformTimeoutMs:30000});
try{
 const chat=await bot.client.im.v1.chat.get({path:{chat_id:channel}});
 receipt.destinationCheck={code:chat.code,mode:chat.data?.chat_mode};save();
 if(chat.code!==0||chat.data?.chat_mode!=='p2p')throw new Error('Destination not verified private');
 step('real-api-destination-p2p-verified');
 const rewrite=await createPromptRewriter(config)('这是虚构的功能验收：请只输出固定文本 LIGHTCLAW_ACCEPTANCE_OK，不调用工具，不附加解释。',AbortSignal.timeout(120000));
 if(!rewrite.prompt.includes('LIGHTCLAW_ACCEPTANCE_OK'))throw new Error('Rewrite lost literal');
 receipt.rewrite={taskType:rewrite.taskType,chars:rewrite.prompt.length,changes:rewrite.changes.length};step('installed-real-rewrite-and-constraint-review');
 const testChannel='installed-functional',channelDir=join(working,testChannel);
 const goals=new GoalStore({channelDir,controlChannelDir:join(base,'control',testChannel),limits:{maxCycles:8,maxFailures:2,maxStaleCycles:2}});
 let answer='';
 const context={message:{text:'只输出 LIGHTCLAW_ACCEPTANCE_OK，不调用工具，不附加解释。',rawText:'只输出 LIGHTCLAW_ACCEPTANCE_OK，不调用工具，不附加解释。',user:'authorized-functional-fixture',channel:testChannel,ts:String(Date.now()),attachments:[]},channelName:'isolated acceptance',channels:[],users:[],respond:async text=>{answer=text;},replaceMessage:async text=>{answer=text;},respondInThread:async()=>{},setTyping:async()=>{},uploadFile:async()=>{throw new Error('Tools disabled');},setWorking:async()=>{},deleteMessage:async()=>{throw new Error('Recall forbidden');}};
 runner=createAgentRunner({type:'host'},testChannel,channelDir,{...config,controlDir:join(base,'control'),modelFallbacks:[]},goals,{tools:[],inMemoryState:true,quiet:true});
 const timeout=setTimeout(()=>runner.abort(),120000);
 let result;try{result=await runner.run(context,store);}finally{clearTimeout(timeout);}
 if(result.stopReason!=='stop'||result.toolCalls!==0||answer.trim()!=='LIGHTCLAW_ACCEPTANCE_OK')throw new Error('Installed real Agent roundtrip failed');
 receipt.model={stopReason:result.stopReason,toolCalls:result.toolCalls,inputTokens:result.inputTokens,outputTokens:result.outputTokens,providerReportedCost:result.cost,usageIncomplete:result.usageIncomplete??false};step('installed-real-agent-no-tool-roundtrip');
 reserve('send');const messageId=await bot.postMessage(channel,'LightClaw 收尾功能验收：独立安装产物已完成真实模型往返。本消息为获授权的验收消息，不执行业务任务。');receipt.messageId=messageId;save();step('real-private-send');
 reserve('edit');await bot.updateMessage(channel,messageId,'LightClaw 收尾功能验收：独立安装、真实模型往返、私聊发送与更新已通过。随后发送一份虚构验收文件；真实卡片点击仍以你的操作结果为准。');step('real-private-update');
 writeFileSync(join(working,channel,'acceptance.txt'),'LIGHTCLAW_ACCEPTANCE_FILE\nFictional functional acceptance fixture.\n',{flag:'wx',mode:0o600});
 reserve('upload');reserve('send');await bot.uploadFile(channel,'acceptance.txt','LightClaw-虚构验收文件.txt');step('installed-python-helper-upload-and-file-message');
 receipt.status='passed';save();
}catch(error){receipt.status='failed';receipt.failureName=error?.constructor?.name??'Unknown';save();console.error(JSON.stringify({status:'failed',failureName:receipt.failureName,completedSteps:receipt.steps}));process.exitCode=1;}
finally{runner?.dispose();await bot.stop();await dispatcher.close();}
const publicReceipt={...receipt};delete publicReceipt.messageId;
writeFileSync(join(repo,'docs/verification/2026-11-06-final-acceptance/live-result.json'),JSON.stringify(publicReceipt,null,2)+'\n');
