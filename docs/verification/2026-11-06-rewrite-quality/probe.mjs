import {readFileSync,writeFileSync,existsSync} from "node:fs";
import {parseEnv} from "node:util";
import {initializeHttpTransport} from "../../../packages/lightclaw/src/http.ts";
import {loadConfig} from "../../../packages/lightclaw/src/config.ts";
import {createPromptRewriter,describePromptFailure} from "../../../packages/lightclaw/src/prompt-input.ts";
const receipt=new URL("real-rewrite.private.json",import.meta.url);
if(existsSync(receipt))throw new Error("Receipt exists; refusing automatic repeat");
const env=parseEnv(readFileSync(".env","utf8"));
const dispatcher=initializeHttpTransport();
const nativeFetch=globalThis.fetch;let requests=0;
globalThis.fetch=async(input,init)=>{if(requests>=2)throw new Error("Bounded verification request limit reached");requests++;return nativeFetch(input,init);};
const result={startedAt:new Date().toISOString(),maxRequests:2,requests:0,toolsExecuted:0,feishuMessages:0,cases:[]};
writeFileSync(receipt,JSON.stringify(result),{mode:0o600,flag:"wx"});
const config=loadConfig(env);
try {
 for(const input of ["帮我调研一下现在有哪些 agent 提示词自动优化的方法，整理一下","只回复 OK，不调用工具。"]){
  const item={input,status:"started",output:null,usage:null};result.cases.push(item);
  const started=performance.now();
  try {
   const rewrite=createPromptRewriter(config,{apiKey:env.OPENAI_API_KEY,onUsage:(_step,model,usage)=>{item.model=model.id;item.usage=usage?{input:usage.input,cacheRead:usage.cacheRead,output:usage.output,totalTokens:usage.totalTokens}:null;}});
   item.output=await rewrite(input,AbortSignal.timeout(25000));
   item.status="valid-rewrite";
   item.punctuationOnly=input.replace(/[\p{P}\s]/gu,"")===item.output.replace(/[\p{P}\s]/gu,"");
   item.unchanged=input===item.output;
  }catch(error){item.status="failed";item.failureCode=describePromptFailure(error).code;}
  item.elapsedMs=Math.round(performance.now()-started);
 }
}finally{
 result.requests=requests;writeFileSync(receipt,JSON.stringify(result,null,2)+"\n");globalThis.fetch=nativeFetch;await dispatcher.close();console.log(JSON.stringify(result,null,2));
}
