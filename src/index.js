// Cloudflare Worker with CORS + SQLite Durable Object
function withCORS(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return new Response(res.body, { status: res.status, headers: h });
}
function ok(text='OK'){ return withCORS(new Response(text, {status:200})); }
function notFound(){ return withCORS(new Response('Not found', {status:404})); }
function json(obj, status=200){
  return withCORS(new Response(JSON.stringify(obj), {status, headers:{'content-type':'application/json'}}));
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') {
      return withCORS(new Response(null, { status: 204 }));
    }

    if (url.pathname === '/create-room' && req.method === 'POST') {
      const room = genRoomCode();
      const id = env.ROOM.idFromName(room);
      const obj = env.ROOM.get(id);
      const res = await obj.fetch('https://do/init', { method:'POST', body: JSON.stringify({ room }) });
      // ignore DO body (it returns {"room":...}); client只需要 room
      return json({ room });
    }

    if (url.pathname === '/' || url.pathname === '/health') {
      return ok('OK');
    }

    // WebSocket (no CORS needed for Upgrade)
    if (url.pathname === '/ws' && req.headers.get('Upgrade') === 'websocket') {
      return this.upgradeWS(req, env);
    }
    if (url.searchParams.get('room') && req.headers.get('Upgrade') === 'websocket') {
      return this.upgradeWS(req, env);
    }

    return notFound();
  },

  upgradeWS(req, env) {
    const url = new URL(req.url);
    const room = (url.searchParams.get('room')||'').toUpperCase().trim();
    const name = (url.searchParams.get('name')||'Guest').slice(0,16);
    if(!room) return withCORS(new Response('room required', {status:400}));
    const id = env.ROOM.idFromName(room);
    const obj = env.ROOM.get(id);
    return obj.fetch(req, { headers:{ 'x-name': name }});
  }
};

function genRoomCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s=''; for(let i=0;i<4;i++) s+=chars[Math.floor(Math.random()*chars.length)];
  return s;
}

// Durable Object (SQLite)
export class Room {
  constructor(state, env){
    this.state = state;
    this.env = env;
    this.clients = new Map(); // id -> {ws, name, wins, time}
    this.room = '----';
    this.match = null; // {qn, puzzles:[{nums, par}], started:ts}
  }
  async fetch(req){
    const url = new URL(req.url);
    if(req.method === 'OPTIONS'){
      return withCORS(new Response(null, {status:204}));
    }
    if(url.hostname==='do' && url.pathname==='/init' && req.method==='POST'){
      const j = await req.json();
      this.room = j.room;
      return json({ room:this.room });
    }
    if(req.headers.get('Upgrade')==='websocket'){
      const name = req.headers.get('x-name') || 'Guest';
      const pair = new WebSocketPair(); const client = pair[0]; const server = pair[1];
      server.accept();
      const id = crypto.randomUUID();
      this.clients.set(id, { ws:server, name, wins:0, time:0 });
      const hello = { type:'hello', id, room:this.room, players:this.playerList() };
      server.send(JSON.stringify(hello));
      this.broadcast({ type:'players', players: this.playerList() });
      server.addEventListener('message', (ev)=>{
        try{
          const msg = JSON.parse(ev.data);
          if(msg.type==='start'){ this.startMatch(); }
          else if(msg.type==='submit'){ this.handleSubmit(id, msg); }
        }catch{}
      });
      server.addEventListener('close', ()=>{
        this.clients.delete(id);
        this.broadcast({ type:'players', players: this.playerList() });
      });
      return new Response(null, { status: 101, webSocket: client });
    }
    return ok('OK Room '+this.room);
  }
  playerList(){
    return Array.from(this.clients.entries()).map(([id,v])=>({ id, name:v.name, wins:v.wins, time:v.time }));
  }
  broadcast(obj){
    const s = JSON.stringify(obj);
    for(const v of this.clients.values()){ try{ v.ws.send(s); }catch{} }
  }
  startMatch(){
    const puzzles = [];
    for(let i=0;i<10;i++){
      const p = S24.gen();
      puzzles.push({ nums:p.nums, par:p.par });
    }
    for(const v of this.clients.values()){ v.wins=0; v.time=0; }
    this.match = { qn:0, puzzles, started:Date.now() };
    this.broadcast({ type:'start', room:this.room });
    this.nextQuestion();
  }
  nextQuestion(){
    if(!this.match) return;
    this.match.qn++;
    if(this.match.qn>10){
      const summary = this.playerList()
        .sort((a,b)=> (b.wins-a.wins)|| (a.time-b.time))
        .map((p,i)=>`${i+1}.${p.name}（胜${p.wins}/10｜${p.time.toFixed(1)}s）`).join('  ');
      this.broadcast({ type:'end', summary });
      this.match=null; return;
    }
    const q = this.match.puzzles[this.match.qn-1];
    this.qStart = Date.now();
    this.broadcast({ type:'question', qn:this.match.qn, nums:q.nums, par:q.par });
  }
  handleSubmit(id, msg){
    if(!this.match) return;
    const v = this.clients.get(id); if(!v) return;
    const q = this.match.puzzles[this.match.qn-1];
    const t = Math.max(0, msg.time||0);
    v.time += t;
    if(msg.ok && t<=q.par){
      v.wins += 1;
      this.send(id, { type:'verdict', qn:this.match.qn, ok:true, par:q.par, time:t });
    }else{
      this.send(id, { type:'verdict', qn:this.match.qn, ok:false, par:q.par, time:t, reason: msg.ok? '超出 par' : '答案错误' });
    }
    this.broadcast({ type:'players', players: this.playerList() });
    this.nextQuestion();
  }
  send(id, obj){
    const v = this.clients.get(id); if(!v) return;
    try{ v.ws.send(JSON.stringify(obj)); }catch{}
  }
}

// Minimal 24-point generator for server
const OPS2 = [
  { sym: '+', f: (a,b)=>a+b },
  { sym: '-', f: (a,b)=>a-b },
  { sym: '*', f: (a,b)=>a*b },
  { sym: '/', f: (a,b)=> (b===0? null : a/b) },
];
function approx(x,y){ return Math.abs(x-y)<1e-6; }
function* pairs(n){ for(let i=0;i<n;i++) for(let j=i+1;j<n;j++) yield [i,j]; }
function comb(a,b){
  const r=[];
  for(const op of OPS2){
    const v1 = op.f(a,b); if(v1!==null) r.push(v1);
    if(op.sym==='-'||op.sym==='/'){ const v2=op.f(b,a); if(v2!==null) r.push(v2); }
  }
  return r;
}
function solve(list){
  if(list.length===1) return approx(list[0],24);
  for(const [i,j] of pairs(list.length)){
    const rest = list.filter((_,k)=>k!==i && k!==j);
    for(const c of comb(list[i], list[j])){
      if(solve([...rest, c])) return true;
    }
  }
  return false;
}
function rnd(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function par(exp){
  const base = Math.log2(Math.max(4,exp))*3 + 4;
  return Math.max(6, Math.min(45, Math.round(base)));
}
const S24 = {
  gen(){
    let tries=0;
    while(tries++<300){
      const nums=[rnd(1,13),rnd(1,13),rnd(1,13),rnd(1,13)];
      const ok = solve(nums);
      if(ok){
        let exp=0;
        function dfs(list){
          exp++;
          if(list.length===1) return approx(list[0],24);
          const idxA = Math.floor(Math.random()*list.length);
          let idxB = idxA; while(idxB===idxA) idxB = Math.floor(Math.random()*list.length);
          const a = list[idxA], b=list[idxB];
          const rest = list.filter((_,k)=>k!==idxA && k!==idxB);
          for(const c of comb(a,b)){ if(dfs([...rest,c])) return true; }
          return false;
        }
        dfs(nums);
        return { nums, par: par(Math.max(30, exp)) };
      }
    }
    return { nums:[1,5,5,5], par:12 };
  }
};
