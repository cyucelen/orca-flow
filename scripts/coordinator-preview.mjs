// Isolated production-panel fixture: synthetic sessions and a fake bridge, never live Orca state.
// Run with Node, then open the printed localhost URL. Artifacts stay in ignored .orca/.
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, '.orca/coordinator-preview')
mkdirSync(output, { recursive: true })
execFileSync('npx', ['-y', 'esbuild', 'src/panel/app.ts', '--bundle', '--format=esm', '--tsconfig-raw={}', `--outfile=${join(output, 'app.js')}`], { cwd: root, stdio: 'inherit' })
// Linear and Token Speed fixtures for the sidebar sections: ?linear=off / ?speed=off turn those switches off (Settings → Features).
const { speedView, emptyHistory, addResponse, addNet } = await import('../src/token-speed.ts')
const T = Date.now(), MIN = 60_000
const hist = emptyHistory()
for (let m = 0; m < 50; m++) addResponse(hist, { model: m % 3 ? 'claude-opus-5-5' : 'claude-sonnet-5-5', out: 900 + (m * 137) % 700, start: T - (50 - m) * MIN, end: T - (50 - m) * MIN + 30_000 }, T)
for (let m = 0; m < 40; m++) addNet(hist, { at: T - (40 - m) * MIN, up: 40_000 + (m * 911) % 9000, down: 120_000 + (m * 1733) % 30_000, secs: 30, procs: 3 })
const speedWire = speedView(hist, T, { ready: true, testing: false, testError: null })
const linearWire = { wire: 1, urlBase: 'https://linear.app/acme/issue/', me: 'u1', teams: ['SHP'], connectedTeams: ['SHP'], cycles: [], sent: {}, lastSent: {}, at: T,
  states: [['In Progress', 'started', '#f2c94c'], ['Todo', 'unstarted', '#e2e2e2']], projects: [['Checkout', '#5e6ad2']], people: [['u1', 'You']], cycleIds: [],
  issues: [['SHP-12', 'Fix the cart total rounding', 2, 0, 0, 0, -1, Math.floor(T / 1000)], ['SHP-14', 'Validate coupon stacking', 3, 1, 0, 0, -1, Math.floor(T / 1000)], ['SHP-19', 'Empty-state copy for orders', 4, 1, -1, 0, -1, Math.floor(T / 1000)]] }
const agent = (pane, provider, title, extra = {}) => ({ paneKey: pane, agentType: provider, title, orcaSession: `session-${pane}`, live: true, state: 'working', coordinator: 'shop', leadPane: null, parentPane: null, dispatch: null, terminal: `term-${pane}`, question: null, workingMode: null, summary: null, ...extra })
const old = agent('old', 'claude', 'Original planning conversation', { state: 'waiting', question: 'Approve the original rollout?' })
const current = agent('current', 'codex', 'Replacement coordinator')
const member = (a) => ({ id: JSON.stringify(['folder:shop', 'session', a.orcaSession]), workspaceId: 'folder:shop', orcaSession: a.orcaSession, agentType: a.agentType, title: a.title, paneKey: a.paneKey, terminals: [a.terminal], resumeSessionId: `provider-${a.paneKey}`, lastAgent: a, agent: a })
const members = [member(old), member(current)]
const row = (id, a, extra = {}) => ({ id, name: a.title, branch: 'feature', repo: 'shop', path: '/fixture/shop', main: false, agents: [a], state: a.state, priority: null, card: null, parentId: null, liveTerminals: 1, pinned: false, unread: false, active: false, workspaceStatus: null, lastActivityAt: 1, createdAt: 1, pr: null, ...extra })
const fixture = { coordinatorProviders: [{id:'claude',name:'Claude'},{id:'codex',name:'Codex'},{id:'hermes',name:'Hermes'},{id:'antigravity',name:'Antigravity'}], handoverProviders: ['claude', 'codex'], source: 'cli', capacity: null, ready: true, focusedPanes: [], coordinators: [{ key: 'shop', name: 'Shop', repos: ['shop'], workspaceId: 'folder:shop', session: current, sessions: { version: 1, current: members[1].id, members }, members, routing: 'Some runs still route to a previous member. Pending asks retain their source.' }], rows: [
  row('folder:shop', agent('lead', 'claude', 'Planner workstream', { dispatch: 'open' }), { folderOf: 'shop', branch: null, main: true }),
  row('folder:shop', agent('worker', 'codex', 'Validate totals', { leadPane: 'lead', parentPane: 'lead', dispatch: 'open' }), { folderOf: 'shop', branch: null, main: true }),
  row('folder:shop', agent('helper', 'claude', 'Check edge cases', { leadPane: 'worker', parentPane: 'worker', dispatch: 'open' }), { folderOf: 'shop', branch: null, main: true }),
  row('folder:shop', agent('sibling', 'codex', 'Review planner copy', { leadPane: 'lead', parentPane: 'lead', dispatch: 'open' }), { folderOf: 'shop', branch: null, main: true }),
  row('feature:second', agent('second', 'codex', 'Independent workstream', { dispatch: 'open' })),
  row('folder:shop', agent('candidate', 'codex', 'Fresh same-provider conversation'), { folderOf: 'shop', branch: null, main: true })
] }
fixture.coordinators.push({ key: 'first', name: 'New coordinator', repos: [], workspaceId: null, session: null, sessions: { version: 1, current: null, members: [] }, members: [] })
const bridge = `<script>
const fixture = ${JSON.stringify(fixture).replaceAll('<', '\\u003c')};
fixture.features = { linear: new URLSearchParams(location.search).get('linear') !== 'off', tokenSpeed: new URLSearchParams(location.search).get('speed') !== 'off' };
const listeners = new Map();
window.previewCalls = [];
window.previewLaunches = [];
window.previewResumes = [];
let firstPending = false;
const neverStarted = (name='New coordinator',key='first') => ({key,name,repos:[],workspaceId:null,session:null,sessions:{version:1,current:null,members:[]},members:[]});
window.orca = { plugin: {
 request: async (name, data) => {
  previewCalls.push({name, data});
  const c = fixture.coordinators[0];
  if(name==='sidebar.list') return structuredClone(fixture);
  if(name==='sidebar.linear') return new URLSearchParams(location.search).get('linear')==='off' ? null : ${JSON.stringify(linearWire)};
  if(name==='sidebar.tokenSpeed') return ${JSON.stringify(speedWire)};
  if(name==='sidebar.createCoordinator') { fixture.coordinators.push(neverStarted(data.name,data.name));listeners.get('sidebar.changed')?.(structuredClone(fixture));return {ok:true}; }
  if(name==='sidebar.openCoordinator') {
   const c=fixture.coordinators.find(c=>c.key===data.key);
   if(c.session) return {ok:true,kind:'opened'};
   const saved=c.sessions?.members.find(m=>m.id===c.sessions.current);
   if(saved?.resumeSessionId) {
    previewResumes.push({provider:saved.agentType,sessionId:saved.resumeSessionId});
    const a={...saved.lastAgent,live:true,state:'working'};
    c.session=a;for(const m of c.members)if(m.id===saved.id)m.agent=a;
    listeners.get('sidebar.changed')?.(structuredClone(fixture));return {ok:true,kind:'resumed'};
   }
   if(firstPending) return {ok:true,kind:'starting'};
   const choices=fixture.coordinatorProviders;
   const selected=data.provider ? choices?.find(p=>p.id===data.provider) : choices?.length===1 ? choices[0] : null;
   if(!selected) return {ok:false,kind:'provider',providers:choices??[],error:data.provider ? 'That provider is no longer available. Choose an enabled provider or check Orca Settings → Agents.' : choices===null ? 'Could not check agent availability. Retry, or check Orca Settings → Agents.' : !choices.length ? 'No supported provider is enabled. Install or enable an agent with coordinator session tracking in Orca Settings → Agents, then Retry.' : 'Choose a provider for the first conversation.'};
   firstPending=true; previewLaunches.push({key:data.key,provider:selected.id});
   await new Promise(resolve=>setTimeout(resolve,250));
   const a={...fixture.rows[0]?.agents[0],paneKey:'first-pane',agentType:selected.id,title:'First conversation',orcaSession:'first-session',terminal:'term-first',live:true,state:'working',parentPane:null,dispatch:null,coordinator:data.key,leadPane:null};
   const m={id:'first-member',workspaceId:'folder:'+data.key,orcaSession:a.orcaSession,agentType:a.agentType,title:a.title,paneKey:a.paneKey,terminals:[a.terminal],agent:a,lastAgent:a};
   c.session=a;c.workspaceId=m.workspaceId;c.members=[m];c.sessions={version:1,current:m.id,members:[m]};firstPending=false;
   listeners.get('sidebar.changed')?.(structuredClone(fixture));return {ok:true,kind:'started'};
  }
  if(name==='sidebar.handover') {
   c.handover={provider:data.provider,phase:'launching'};
   listeners.get('sidebar.changed')?.(structuredClone(fixture));
   await new Promise(resolve=>setTimeout(resolve,1200));
   c.handover={provider:data.provider,phase:'launching',error:'Synthetic launch reply lost. Retry replays the same operation; the original stays current.'};
   listeners.get('sidebar.changed')?.(structuredClone(fixture));
   return {ok:false,error:c.handover.error};
  }
  if(name==='sidebar.coordinatorHistory') return {title:c.members.find(m=>m.id===data.member).title,text:'Synthetic historical scrollback.\\nOriginal approval remains with this source session.\\n<script>escaped content<\\/script>',truncated:true};
  if(name==='sidebar.coordinatorSessions') {
   if(data.action==='select') { const m=c.members.find(m=>m.orcaSession===data.orcaSession&&m.workspaceId===data.workspaceId);if(m){c.sessions.current=m.id;c.session=m.agent;} }
   if(data.action==='current') { c.sessions.current=data.member; c.session=c.members.find(m=>m.id===data.member).agent; }
   if(data.action==='associate') {
    const r=fixture.rows.find(r=>r.id===data.workspaceId&&r.agents.some(a=>a.paneKey===data.paneKey));
    const a=r.agents[0]; const m={id:JSON.stringify([r.id,'session',a.orcaSession]),workspaceId:r.id,orcaSession:a.orcaSession,agentType:a.agentType,title:a.title,paneKey:a.paneKey,terminals:[a.terminal],lastAgent:a,agent:a};
    c.members.push(m);c.sessions.members=c.members;fixture.rows=fixture.rows.filter(x=>x!==r);
   }
   listeners.get('sidebar.changed')?.(structuredClone(fixture));return {ok:true};
  }
  return {opened:true,ok:true};
 },on:(name,fn)=>{listeners.set(name,fn);return()=>listeners.delete(name)}
},storage:{get:async()=>null,set:async()=>{}},shell:{openExternal:async()=>{}}};
window.fixtureState=()=>structuredClone(fixture);
window.previewNeverStarted=()=>{fixture.coordinators=[neverStarted()];fixture.rows=[];previewCalls.length=0;previewLaunches.length=0;firstPending=false;listeners.get('sidebar.changed')?.(structuredClone(fixture));};
window.previewFirstProviders=(providers)=>{fixture.coordinatorProviders=providers;listeners.get('sidebar.changed')?.(structuredClone(fixture));};
window.previewSleepCurrent=()=>{const c=fixture.coordinators[0];for(const m of c.members)if(m.id===c.sessions.current){m.lastAgent={...m.agent,live:false};m.resumeSessionId='native-original-'+m.agentType;m.agent=null;}c.sessions.members=structuredClone(c.members);c.session=null;listeners.get('sidebar.changed')?.(structuredClone(fixture));};
window.previewAvailable=(providers)=>{fixture.handoverProviders=providers;listeners.get('sidebar.changed')?.(structuredClone(fixture));};
window.previewProvider=(provider)=>{const c=fixture.coordinators[0];c.session.agentType=provider;for(const m of c.members)if(m.id===c.sessions.current){m.agentType=provider;m.agent.agentType=provider;}delete c.handover;listeners.get('sidebar.changed')?.(structuredClone(fixture));};
</script>`
const html = readFileSync(join(root, 'src/panel/index.html'), 'utf8').replace('<head>', '<head><title>Coordinator fixture · Orca Flow</title>').replace('<script type="module" src="./app.ts"></script>', `${bridge}<script type="module" src="./app.js"></script>`)
const assets = new Map([['/', ['text/html', html]], ['/panel.css', ['text/css', readFileSync(join(root, 'src/panel/panel.css'))]], ['/app.js', ['text/javascript', readFileSync(join(output, 'app.js'))]]])
const server = createServer((req, res) => { const a = assets.get(new URL(req.url, 'http://x').pathname); if(!a){res.writeHead(404);res.end();return} res.writeHead(200, {'Content-Type': a[0]});res.end(a[1]) })
server.listen(Number(process.env.ORCA_FLOW_PREVIEW_PORT || 0), '127.0.0.1', () => console.log(`Coordinator fixture: http://127.0.0.1:${server.address().port}`))
