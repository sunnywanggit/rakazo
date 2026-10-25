import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LocalAgentStart } from "@rakazo/contracts";
import { CodexAppServerEngine } from "./codex-app-server.js";

// This process models the wire protocol, not natural-language quality. It never calls a model.
const fakeCli = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
if (process.argv.includes('--version')) { fs.appendFileSync(path.join(process.env.HOME,'version-probes'),'1\\n'); process.stdout.write('codex-cli 0.163.0\\n'); process.exit(0); }
const args = process.argv.slice(2);
const setting = args.find(v => v.startsWith('permissions.') && v.includes('.filesystem='));
const profile = setting.split('.')[1];
const cwd = process.cwd();
const access = setting.includes(JSON.stringify(cwd) + '="write"') ? 'write' : 'read';
let thread = 'native-session', turn = 'turn-1', prompt = '', selectedModel = 'fake-model', turnSequence = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const reply = (id, result) => send({id, result});
const done = () => send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'completed'}}});
readline.createInterface({input:process.stdin}).on('line', line => {
 const m = JSON.parse(line); fs.appendFileSync(path.join(process.env.HOME,'wire.jsonl'), JSON.stringify(m)+'\\n');
 if (m.method === 'initialize') reply(m.id,{});
 if (m.method === 'account/read') reply(m.id,{account:{type:'chatgpt'}});
 if (m.method === 'config/read') {
   const table = setting.slice(setting.indexOf('=')+1).slice(1,-1);
   const filesystem = {glob_scan_max_depth:null,...Object.fromEntries(table.split(',').map(row => { const split=row.lastIndexOf('='); return [JSON.parse(row.slice(0,split)),JSON.parse(row.slice(split+1))]; }))};
   if (process.env.LANG === 'mismatch') filesystem['/'] = 'read';
   reply(m.id,{layers:[{name:{type:'sessionFlags'}}],config:{web_search:'disabled',permissions:{[profile]:{filesystem,network:{enabled:false}}},mcp_servers:{},plugins:{},hooks:{},features:Object.fromEntries(args.filter(v=>v.startsWith('features.')&&v.endsWith('=false')).map(v=>[v.slice(9,-6),false]))}});
 }
 if (m.method === 'model/list') reply(m.id,{data:[{id:'fake-model',displayName:'Fake'}],nextCursor:null});
 if (m.method === 'thread/start' || m.method === 'thread/resume') { selectedModel = m.params.model; reply(m.id,{thread:{id:thread},cwd,runtimeWorkspaceRoots:[cwd],activePermissionProfile:{id:profile},approvalPolicy:'on-request',approvalsReviewer:'user',instructionSources:[]}); }
 if (m.method === 'thread/read') reply(m.id,{thread:{id:thread,cwd,model:selectedModel,status:{type:'idle'},turns:[]}});
 if (m.method === 'turn/start') {
   turn='turn-'+(++turnSequence); prompt=m.params.input[0].text; reply(m.id,{turn:{id:turn}});
   send({method:'turn/started',params:{threadId:thread,turn:{id:turn}}});
   if (prompt === 'wait') return;
   if (prompt === 'late-first') {
     const oldTurn = turn; done();
     setTimeout(() => send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:oldTurn,delta:'STALE_TURN_FIXTURE'}}), 50); return;
   }
   if (prompt === 'late-second') {
     setTimeout(() => { send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,delta:'current'}}); done(); }, 150); return;
   }
   if (prompt === 'background-tool') {
     require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},10000)'],{stdio:'ignore'}); done(); return;
   }
   if (prompt === 'progress') {
     send({method:'item/started',params:{threadId:thread,turnId:turn,item:{id:'reason',type:'reasoning'}}});
     send({method:'item/reasoning/summaryTextDelta',params:{threadId:thread,turnId:turn,itemId:'reason',summaryIndex:0,delta:'Public summary'}});
     send({method:'item/reasoning/textDelta',params:{threadId:thread,turnId:turn,itemId:'reason',delta:'PRIVATE_REASONING_FIXTURE'}});
     setTimeout(() => {
       send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,delta:'one'}});
       send({method:'error',params:{threadId:thread,turnId:turn,willRetry:true,error:{message:'PRIVATE_PROVIDER_DETAILS',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:429}}}}});
       send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,delta:'two'}}); done();
     }, 300); return;
   }
   if (prompt === 'delayed') { send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,delta:'started'}}); setTimeout(done, 1500); return; }
   if (prompt === 'question') { send({id:900,method:'item/tool/requestUserInput',params:{threadId:thread,turnId:turn,itemId:'ask',isBlocking:true,questions:[{id:'choice',question:'Which file?',isSecret:false,options:[{label:'one'}]}]}}); return; }
   if (prompt === 'approval') {
     send({method:'item/started',params:{threadId:thread,turnId:turn,item:{id:'patch',type:'fileChange',changes:[{path:path.join(cwd,'file.txt'),diff:'+updated'}]}}});
     send({id:901,method:'item/fileChange/requestApproval',params:{threadId:thread,turnId:turn,itemId:'patch',grantRoot:null,reason:'Apply patch'}}); return;
   }
   if (prompt === 'escape') { send({id:902,method:'item/commandExecution/requestApproval',params:{threadId:thread,turnId:turn,itemId:'cmd',command:'outside-project',cwd:'/',additionalPermissions:null}}); return; }
   send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,delta:'done'}}); done();
 }
 if (m.id === 901 && m.result) { if (m.result.decision === 'accept') fs.writeFileSync(path.join(cwd,'file.txt'),'updated'); done(); }
 if (m.id === 902 && m.result) { if (m.result.decision === 'accept') fs.writeFileSync(path.join(process.env.HOME,'escaped'),'bad'); done(); }
 if (m.id === 900 && m.result) { send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,delta:JSON.stringify(m.result)}}); done(); }
 if (m.method === 'turn/interrupt') { reply(m.id,{}); send({method:'turn/completed',params:{threadId:thread,turn:{id:turn,status:'interrupted'}}}); }
});
`;

export async function codexFixture() {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-codex-test-")));
  const cwd = path.join(base, "project");
  await mkdir(cwd);
  const executable = path.join(base, "codex");
  await writeFile(executable, fakeCli);
  await chmod(executable, 0o700);
  const engine = new CodexAppServerEngine({
    executable,
    env: { HOME: base, PATH: process.env.PATH, LANG: "en_US.UTF-8" },
  });
  const request: LocalAgentStart = {
    scope: { spaceId: "space", userId: "owner", botId: "bot", threadId: "chat" },
    runId: "run",
    sessionId: "session",
    projectId: "project",
    model: "fake-model",
    access: "read",
    prompt: "inspect",
    instructions: "Test",
    fence: 1,
  };
  return {
    base,
    cwd,
    executable,
    engine,
    request,
    async dispose() {
      await engine.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}
