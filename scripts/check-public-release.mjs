import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
const git=(...args)=>execFileSync('git',args,{maxBuffer:8*1024*1024}).toString('utf8');
const files=git('ls-files','-z').split('\0').filter(Boolean);
const findings=[];
// Lockfiles generated alongside an existing node_modules tree can omit other
// platforms' optional compiler packages. Require deploy and contributor targets.
const locked=JSON.parse(readFileSync('package-lock.json','utf8')).packages;
for(const name of ['@typescript/typescript-linux-x64','@typescript/typescript-win32-x64','@typescript/typescript-darwin-arm64','@next/swc-linux-x64-gnu','@esbuild/linux-x64']){
 if(!locked[`node_modules/${name}`])findings.push({file:'package-lock.json',rule:`missing-platform:${name}`});
}
const patterns=[
 ['openai-key',/\bsk-(?:proj-|svcacct-)[A-Za-z0-9_-]{30,}/],
 ['github-token',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/],
 ['supabase-secret',/\bsb_secret_[A-Za-z0-9_-]{20,}/],
 ['jwt',/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/],
 ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
];
for(const file of files){
 if(/(^|\/)(?:\.vercel|\.codex|tmp|node_modules|\.next|test-results)\//.test(file)||(/(^|\/)\.env/.test(file)&&!file.endsWith('.env.example')))findings.push({file,rule:'private-path'});
 let raw=readFileSync(file);if(file.endsWith('.gz'))raw=gunzipSync(raw,{maxOutputLength:2*1024*1024});
 const text=raw.toString('utf8');
 for(const [rule,pattern] of patterns)if(pattern.test(text))findings.push({file,rule});
 if(file.endsWith('.env.example'))for(const line of text.split(/\r?\n/)){if(/^(?:OPENAI_API_KEY|INTERNAL_API_TOKEN|LIVE_SESSION_SECRET|SUPABASE_(?:SERVICE_ROLE_KEY|SECRET_KEY|PUBLISHABLE_KEY)|SAKINA_INTERNAL_KEY_SHA256)=\S/.test(line))findings.push({file,rule:'nonempty-credential-example'});}
}
console.log(JSON.stringify({files:files.length,findings}));
if(findings.length)process.exitCode=1;
