// Bounded classroom benchmark. Reports actual completions/errors and percentiles.
import {randomBytes} from 'node:crypto';
const args=Object.fromEntries(process.argv.slice(2).map(x=>{const [k,...v]=x.replace(/^--/,'').split('=');return[k,v.join('=')];}));
const base=(args.url||'http://localhost:3000').replace(/\/$/,'');
const users=Number(args.users||5),count=Number(args.messages||50),rps=Number(args.rps||5);
if(!Number.isInteger(users)||users<1||users>100||!Number.isInteger(count)||count<1||count>100000||!Number.isFinite(rps)||rps<0.1||rps>1000)throw Error('users 1..100, messages 1..100000 per user, rps 0.1..1000 per user');
const latency=[],errors={},sessions=[];let ok=0,received=0;const sockets=[];
async function request(path,body,cookie){const start=performance.now();try{const r=await fetch(base+'/api'+path,{method:'POST',headers:{'content-type':'application/json',...(cookie?{cookie}: {})},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});await r.arrayBuffer();return {r,ms:performance.now()-start};}catch(e){return{error:e.name,ms:performance.now()-start};}}
for(let i=0;i<users;i++){const name='load_'+randomBytes(6).toString('hex');const {r,error}=await request('/auth/register',{username:name,display_name:'Нагрузка '+(i+1),password:randomBytes(20).toString('hex')});if(!r?.ok)throw Error('Registration failed: '+(r?.status||error));sessions.push(r.headers.get('set-cookie').split(';')[0]);}
const {WebSocket}=await import('ws');
for(const cookie of sessions){const ws=new WebSocket(base.replace(/^http/,'ws')+'/ws',{headers:{cookie}});ws.on('message',raw=>{if(JSON.parse(raw).type==='message')received++;});ws.on('error',()=>{});sockets.push(ws);}
await Promise.all(sockets.map(ws=>ws.readyState===WebSocket.OPEN?Promise.resolve():new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);})));
const start=performance.now();
await Promise.all(sessions.map(async(cookie,u)=>{for(let i=0;i<count;i++){const tick=performance.now();const {r,error,ms}=await request('/channels/general/messages',{text:`[load] ${u}:${i} — ${new Date().toISOString()}`,client_id:`load-${randomBytes(12).toString('hex')}`},cookie);latency.push(ms);if(r?.ok)ok++;else{const key=r?.status||error;errors[key]=(errors[key]||0)+1;}const wait=1000/rps-(performance.now()-tick);if(wait>0)await new Promise(r=>setTimeout(r,wait));}}));
await new Promise(r=>setTimeout(r,300));for(const ws of sockets)ws.terminate();latency.sort((a,b)=>a-b);const pct=p=>Math.round(latency[Math.min(latency.length-1,Math.floor(latency.length*p))]);
const report={url:base,users,attempted:users*count,accepted:ok,errors,seconds:+((performance.now()-start)/1000).toFixed(2),messages_per_second:+(ok/((performance.now()-start)/1000)).toFixed(2),latency_ms:{p50:pct(.5),p95:pct(.95),p99:pct(.99)},websocket_deliveries:received};console.log(JSON.stringify(report,null,2));if(ok!==users*count)process.exitCode=1;
