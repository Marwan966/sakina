import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createQuranSearchHandler } from "../supabase/functions/quran-search/handler";
import { createVoiceBudgetHandler } from "../supabase/functions/voice-budget/handler";
import { signingSecret } from "../apps/sakina/lib/live-security";
const token="unit-test-only-internal-credential-".repeat(2);
const env={get:(name:string)=>({SAKINA_INTERNAL_KEY_SHA256:createHash("sha256").update(token).digest("hex"),SUPABASE_URL:"https://database.test",SUPABASE_SERVICE_ROLE_KEY:"unit-test-only-service-key"}[name])};
const request=(body:unknown,key=token)=>new Request("https://edge.test",{method:"POST",headers:{"Content-Type":"application/json","X-Internal-Key":key},body:JSON.stringify(body)});
for(const [name,factory] of [["quran-search",createQuranSearchHandler],["voice-budget",createVoiceBudgetHandler]] as const){
  test(`${name} rejects wrong and missing configured secrets before any database call`,async()=>{
    let calls=0;const fetcher:typeof fetch=async()=>{calls++;throw Error("must not run");};
    assert.equal((await factory(env,fetcher)(request({},"wrong-credential-".repeat(4)))).status,401);
    assert.equal((await factory({get:()=>undefined},fetcher)(request({}))).status,401);
    assert.equal(calls,0);
  });
}
test("search rejects extra fields, oversized payload, unbounded results and malformed vectors",async()=>{
 let calls=0; const handler=createQuranSearchHandler(env,async()=>{calls++;return Response.json([]);});
 const valid={kind:"lexical",terms:["صبر"],excluded_surahs:[],take_count:5};
 for(const body of [{...valid,url:"https://evil.test"},{...valid,take_count:100},{...valid,terms:["x".repeat(41000)]},{kind:"semantic",query_embedding:Array(1024).fill(1),excluded_surahs:[],take_count:5}]) assert.equal((await handler(request(body))).status,400);
 assert.equal(calls,0);
});
test("search authenticates, calls only a fixed bounded RPC and strips extra response fields",async()=>{
 const handler=createQuranSearchHandler(env,async(url,init)=>{
  assert.equal(String(url),"https://database.test/rest/v1/rpc/match_quran_corpus");
  assert.equal(new Headers(init?.headers).get("authorization"),"Bearer unit-test-only-service-key");
  const body=JSON.parse(String(init?.body));assert.equal(body.kind,undefined);assert.equal(body.take_count,1);
  return Response.json([{verse_key:"2:286",similarity:.9,private_field:"must-not-escape"},{verse_key:"94:5",similarity:.8}]);
 });
 const response=await handler(request({kind:"semantic",query_embedding:Array.from({length:1024},(_,i)=>i===0?1:0),excluded_surahs:[],take_count:1}));
 assert.deepEqual(await response.json(),[{verse_key:"2:286",similarity:.9}]);
});
test("budget sends only client hash to the admission RPC and preserves quota denial",async()=>{
 let calls=0;const handler=createVoiceBudgetHandler(env,async(url,init)=>{calls++;assert.ok(String(url).endsWith('/reserve_voice_session'));assert.deepEqual(JSON.parse(String(init?.body)),{p_client_hash:"a".repeat(64)});return Response.json(false);});
 assert.equal((await handler(request({clientHash:"a".repeat(64)}))).status,429);assert.equal(calls,1);
 assert.equal((await handler(request({clientHash:"a".repeat(64),extra:true}))).status,400);assert.equal(calls,1);
});
test("session signing requires its own high-entropy-length credential",()=>{
 const old=process.env.LIVE_SESSION_SECRET,internal=process.env.INTERNAL_API_TOKEN;
 try {process.env.INTERNAL_API_TOKEN=token;delete process.env.LIVE_SESSION_SECRET;assert.throws(signingSecret);process.env.LIVE_SESSION_SECRET=token;assert.throws(signingSecret);process.env.LIVE_SESSION_SECRET="separate-unit-test-signing-value-".repeat(2);assert.equal(signingSecret(),process.env.LIVE_SESSION_SECRET);}
 finally {if(old===undefined)delete process.env.LIVE_SESSION_SECRET;else process.env.LIVE_SESSION_SECRET=old;if(internal===undefined)delete process.env.INTERNAL_API_TOKEN;else process.env.INTERNAL_API_TOKEN=internal;}
});
