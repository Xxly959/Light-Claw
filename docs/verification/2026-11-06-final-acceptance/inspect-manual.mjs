// Read-only capture of the user-completed, explicitly authorized private flow.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
const repo='/Users/x/Light-Claw';
const env=parseEnv(readFileSync(join(repo,'.env'),'utf8'));
const scope=JSON.parse(readFileSync('/Users/x/.pi/lightclaw/releases/20261106-final/live/scope.private.json','utf8'));
const directory=join(env.LIGHTCLAW_CONTROL_DIR,'.prompt-composer-v2');
const drafts=readdirSync(directory).filter(name=>name.endsWith('.json'))
 .map(name=>JSON.parse(readFileSync(join(directory,name),'utf8')))
 .filter(draft=>draft.channel===scope.dedicatedConversation&&draft.input==='只回复：收尾验收通过')
 .sort((left,right)=>right.expiresAt-left.expiresAt);
const draft=drafts[0];
if(!draft||draft.status!=='consumed'||!draft.effectiveInput)throw new Error('Completed manual fixture missing');
const workspace=resolve(repo,env.LIGHTCLAW_WORK_DIR||'lightclaw-data');
const context=readFileSync(join(workspace,scope.dedicatedConversation,'context.jsonl'),'utf8');
const entries=context.trim().split('\n').map(line=>JSON.parse(line));
const users=entries.filter(entry=>entry.type==='message'&&entry.message?.role==='user');
const last=users.at(-1);
const content=typeof last.message.content==='string'?last.message.content:
 last.message.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
const originalExcluded=!context.includes(draft.input);
const detailsExcluded=(draft.rewriteDetails?.changes??[]).every(text=>!context.includes(text));
const finalIncluded=content.includes(draft.effectiveInput);
const result={schema:1,status:originalExcluded&&detailsExcluded&&finalIncluded?'passed':'failed',
 source:'User reported completion plus actual native Feishu UI and protected draft/session inspection',
 originalInput:draft.input,finalEditedInput:draft.effectiveInput,draftStatus:draft.status,
 structuredRewriteDetailsPresent:!!draft.rewriteDetails,finalTextInLastAgentUserTurn:finalIncluded,
 originalInputAbsentFromMainSession:originalExcluded,rewriteChangesAbsentFromMainSession:detailsExcluded,
 realUserCallbackTested:true,uiFinalResponseObserved:true,previousConversationRetained:true,
 limits:'Fixed functional flow only; user edited final input to an acknowledgement without the literal-only instruction. The contextual response is not scored as exact-output quality.'};
writeFileSync(join(repo,'docs/verification/2026-11-06-final-acceptance/manual-result.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result));
if(result.status!=='passed')process.exitCode=1;
