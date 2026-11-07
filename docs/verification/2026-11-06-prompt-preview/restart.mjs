import {readFileSync,readdirSync,existsSync,openSync,closeSync,fstatSync,writeFileSync,mkdirSync,constants} from 'node:fs';
import {join,resolve} from 'node:path';
import {parseEnv} from 'node:util';
import {execFileSync,spawn} from 'node:child_process';
const repo='/Users/x/Light-Claw';
const env=parseEnv(readFileSync(join(repo,'.env'),'utf8'));
const control=env.LIGHTCLAW_CONTROL_DIR;
const evidence=join(repo,'docs/verification/2026-11-06-prompt-preview/restart-result.private.json');
if(process.argv.includes('--execute')&&existsSync(evidence))throw new Error('Restart receipt already exists; no automatic repeat');
const read=path=>{const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const st=fstatSync(fd);if(!st.isFile()||st.nlink!==1||st.size>1048576)throw new Error('Invalid state');return JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}};
const counts={queued:0,running:0,activeGoals:0,promptRunning:0,startedOperations:0,unreadable:0};
const scan=(directory,accept)=>{if(!existsSync(directory))return;for(const name of readdirSync(directory)){if(!/^[a-f0-9]{64}\.json$/.test(name))continue;try{accept(read(join(directory,name)));}catch{counts.unreadable++;}}};
scan(join(control,'.inbox'),r=>{if(r.status==='queued')counts.queued++;if(r.status==='running')counts.running++;});
scan(join(control,'.operations'),r=>{if(['prepared','started'].includes(r.status))counts.startedOperations++;});
for(const folder of ['.prompt-inputs','.prompt-composer-v2'])scan(join(control,folder),r=>{if(r.status==='running')counts.promptRunning++;});
for(const d of readdirSync(control,{withFileTypes:true})){if(!d.isDirectory()||d.name.startsWith('.'))continue;const p=join(control,d.name,'goal.json');if(existsSync(p))try{if(read(p).status==='active')counts.activeGoals++;}catch{counts.unreadable++;}}
if(Object.values(counts).some(n=>n!==0)){console.log(JSON.stringify({stage:'busy-no-restart',counts}));process.exit(2);}
const healthPath=join(control,'health.json');const previous=read(healthPath);if(!Number.isSafeInteger(previous.pid)||previous.pid<2||Date.now()-previous.heartbeatAt>30000||!previous.ready||!['connected','reconnecting'].includes(previous.platform))throw new Error('Current runtime identity/readiness not verified');
const args=execFileSync('ps',['-p',String(previous.pid),'-o','command='],{encoding:'utf8'});if(!args.includes(join(repo,'packages/lightclaw/src/main.ts')))throw new Error('PID is not the expected source entry');
const lockPath=join(control,'instance.lock');
const held=()=>execFileSync('python3',['-I','-c',`import os,fcntl,sys,stat
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW)
s=os.fstat(fd)
if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1: raise ValueError('bad lock')
try:
 fcntl.flock(fd,fcntl.LOCK_SH|fcntl.LOCK_NB)
 print('free')
except BlockingIOError: print('held')
finally: os.close(fd)`,lockPath],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim()==='held';
if(!held())throw new Error('Live instance lock not held');
const result={status:'idle-verified',checkedAt:new Date().toISOString(),oldPid:previous.pid,counts,model:env.LIGHTCLAW_MODEL_ID,scope:'graceful restart only; no test message or direct model request'};
console.log(JSON.stringify({stage:'idle-verified',oldPid:previous.pid,counts}));
if(!process.argv.includes('--execute'))process.exit(0);
writeFileSync(evidence,JSON.stringify(result,null,2)+'\n',{mode:0o600});
const wait=ms=>new Promise(r=>setTimeout(r,ms));
process.kill(previous.pid,'SIGINT');result.status='old-stop-requested';writeFileSync(evidence,JSON.stringify(result,null,2)+'\n');
const deadline=Date.now()+20000;while(held()&&Date.now()<deadline)await wait(200);
if(held())throw new Error('Old instance did not release its lock; no force kill or second instance started');
console.log(JSON.stringify({stage:'old-lock-released'}));
const logDir='/Users/x/.pi/lightclaw/logs';mkdirSync(logDir,{recursive:true,mode:0o700});
const log=join(logDir,'prompt-preview-'+Date.now()+'.log');const fd=openSync(log,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
const childEnv={...process.env};delete childEnv.NODE_OPTIONS;
const child=spawn('rtk',['proxy','bash',join(repo,'scripts/start-lightclaw.sh')],{cwd:repo,env:childEnv,detached:true,stdio:['ignore',fd,fd]});
child.unref();closeSync(fd);result.launcherPid=child.pid;result.logPath=log;result.status='starting';writeFileSync(evidence,JSON.stringify(result,null,2)+'\n');
const readyUntil=Date.now()+30000;
while(Date.now()<readyUntil){await wait(500);let h;try{h=read(healthPath);}catch{continue;}if(h.pid!==previous.pid&&h.ready&&h.platform==='connected'&&Date.now()-h.heartbeatAt<15000&&held()){try{process.kill(h.pid,0);}catch{continue;}result.status='ready';result.pid=h.pid;result.readyAt=new Date().toISOString();result.healthy=true;result.modelRoundtripTestedByRestart=false;writeFileSync(evidence,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({stage:'ready',pid:h.pid,model:env.LIGHTCLAW_MODEL_ID,logPath:log,testMessages:0,directModelTests:0}));process.exit(0);}}
result.status='startup-not-verified';writeFileSync(evidence,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({stage:result.status,logPath:log}));process.exitCode=1;
