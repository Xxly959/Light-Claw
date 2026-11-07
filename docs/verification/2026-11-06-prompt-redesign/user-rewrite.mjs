import {readFileSync,writeFileSync,existsSync} from "node:fs";
import {parseEnv} from "node:util";
import {initializeHttpTransport} from "../../../packages/lightclaw/src/http.ts";
import {loadConfig} from "../../../packages/lightclaw/src/config.ts";
import {createPromptRewriter} from "../../../packages/lightclaw/src/prompt-input.ts";
const file=new URL("user-rewrite.private.json",import.meta.url);if(existsSync(file))throw new Error("Receipt exists");
const env=parseEnv(readFileSync(".env","utf8"));const dispatcher=initializeHttpTransport();const nativeFetch=globalThis.fetch;let requests=0;
globalThis.fetch=async(i,o)=>{if(requests>=2)throw new Error("Budget exhausted");requests++;return nativeFetch(i,o);};
const report={requests:0,tools:0,messages:0,usage:[]};writeFileSync(file,JSON.stringify(report),{mode:0o600,flag:"wx"});
try {const rewrite=createPromptRewriter(loadConfig(env),{apiKey:env.OPENAI_API_KEY,onUsage:(step,model,u)=>{report.usage.push({step,model:model.id,totalTokens:u?.totalTokens??null});}});report.suggestion=await rewrite("帮我调研一下现在有哪些 agent 提示词自动优化的方法，整理一下",AbortSignal.timeout(50000));report.status="candidate-and-review-complete";}catch{report.status="failed";}finally{report.requests=requests;writeFileSync(file,JSON.stringify(report,null,2)+"\n");globalThis.fetch=nativeFetch;await dispatcher.close();console.log(JSON.stringify(report));}
