'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const HOME = path.join(os.homedir(), '.hongclaw');
const CONFIG_PATH = path.join(HOME, 'config.json');
const SESSIONS_DIR = path.join(HOME, 'sessions');

function defaultConfig() {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.HONGCLAW_BASE_URL || 'https://api.deepseek.com',
    model: process.env.HONGCLAW_MODEL || 'deepseek-chat',
    host: '127.0.0.1',
    port: 19870,
    token: crypto.randomBytes(24).toString('hex'),
  };
}
function loadConfig() {
  try { if (fs.existsSync(CONFIG_PATH)) return Object.assign(defaultConfig(), JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); } catch (e) {}
  const c = defaultConfig(); saveConfig(c); return c;
}
function saveConfig(c) { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }
const config = loadConfig();

function readBody(req) { return new Promise((res, rej) => { let d = ''; req.on('data', c => d += c); req.on('end', () => res(d)); req.on('error', rej); }); }

async function* streamChat(messages, tools) {
  const body = { model: config.model, messages, stream: true, temperature: 0.7 };
  if (tools && tools.length) body.tools = tools;
  const base = config.baseUrl.replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('DeepSeek API ' + res.status + ': ' + (await res.text()).slice(0, 400));
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      let j; try { j = JSON.parse(data); } catch { continue; }
      const ch = j.choices && j.choices[0];
      if (!ch) continue;
      const d = ch.delta || {};
      if (typeof d.content === 'string' && d.content) yield { kind: 'delta', text: d.content };
      if (Array.isArray(d.tool_calls)) {
        for (const tc of d.tool_calls) yield { kind: 'tool_call', index: tc.index || 0, id: tc.id, name: tc.function && tc.function.name, argsDelta: tc.function && tc.function.arguments };
      }
    }
  }
}

const BAR = '[|｜]';
function containsDsml(t) { return new RegExp('<DSML' + BAR + 'function_calls>').test(t); }
function parseDsml(text) {
  const out = [];
  const block = text.match(new RegExp('<DSML' + BAR + 'function_calls>([\\s\\S]*?)<\\/DSML' + BAR + 'function_calls>'));
  if (!block) return out;
  const inv = new RegExp('<DSML' + BAR + 'invoke name="([^"]+)"\\s*>([\\s\\S]*?)<\\/DSML' + BAR + 'invoke>', 'g');
  let m, i = 0;
  while ((m = inv.exec(block[1]))) {
    const p = {};
    const pr = new RegExp('<DSML' + BAR + 'parameter name="([^"]+)"\\s*>([\\s\\S]*?)<\\/DSML' + BAR + 'parameter>', 'g');
    let pm;
    while ((pm = pr.exec(m[2]))) p[pm[1]] = pm[2].trim();
    out.push({ id: 'dsml_' + (i++), name: m[1], arguments: JSON.stringify(p) });
  }
  return out;
}
function formatDsmlResults(rs) {
  return '<DSML|function_results>\n' + rs.map(r =>
    '<DSML|result name="' + r.name + '">\n<DSML|status>' + (r.isError ? 'error' : 'success') + '</DSML|status>\n<DSML|content>\n' + r.content + '\n</DSML|content>\n</DSML|result>'
  ).join('\n') + '\n</DSML|function_results>';
}

function runCmd(a, ok) {
  if (!ok) return Promise.resolve('用户拒绝执行');
  return new Promise((resolve) => {
    const child = spawn(a.command, { shell: true, cwd: a.cwd || os.homedir(), env: process.env });
    let out = '', err = '';
    const t = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('error', e => { clearTimeout(t); resolve('Error: ' + e.message); });
    child.on('close', code => { clearTimeout(t); resolve([out && 'STDOUT:\n' + out, err && 'STDERR:\n' + err, '[exit ' + code + ']'].filter(Boolean).join('\n').slice(0, 6000)); });
  });
}
const tools = {
  read_file: (a) => fs.readFileSync(path.resolve(a.path), 'utf8').slice(0, 20000),
  write_file: (a) => { const p = path.resolve(a.path); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, a.content, 'utf8'); return '已写入 ' + p; },
  list_dir: (a) => fs.readdirSync(path.resolve(a.path), { withFileTypes: true }).map(e => (e.isDirectory() ? 'd ' : '- ') + e.name).join('\n'),
  run_command: runCmd,
  web_fetch: async (a) => { const r = await fetch(a.url, { headers: { 'User-Agent': 'Mozilla/5.0 HongClaw' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return (await r.text()).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 20000); },
};
const toolDefs = [
  { type: 'function', function: { name: 'read_file', description: '读取文本文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: '写入文本文件', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'list_dir', description: '列出目录', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'run_command', description: '执行 shell 命令（需要用户批准）', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'web_fetch', description: '抓取网页内容', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
];

function sessionFile(id) { return path.join(SESSIONS_DIR, id + '.json'); }
function newSession() { return { id: crypto.randomUUID(), title: '', createdAt: Date.now(), messages: [] }; }
function loadSession(id) { try { return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')); } catch { return null; } }
function saveSession(s) { s.updatedAt = Date.now(); fs.mkdirSync(SESSIONS_DIR, { recursive: true }); fs.writeFileSync(sessionFile(s.id), JSON.stringify(s, null, 2)); }
function listSessions() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  return fs.readdirSync(SESSIONS_DIR).filter(n => n.endsWith('.json')).map(n => {
    try { const s = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, n), 'utf8')); return { id: s.id, title: s.title || '(新会话)', updatedAt: s.updatedAt || s.createdAt }; } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

const approvals = new Map();
function requestApproval(sessionId, summary, details, emit) {
  const id = crypto.randomUUID();
  emit({ type: 'approval.request', approvalId: id, summary, details });
  return new Promise((resolve) => { const t = setTimeout(() => { approvals.delete(id); resolve(false); }, 5 * 60 * 1000); approvals.set(id, { resolve, timer: t }); });
}

function toApi(messages) {
  return messages.map(m => {
    if (m.role === 'assistant' && m.toolCalls) return { role: 'assistant', content: m.content || '', tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) };
    if (m.role === 'tool') return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
    return { role: m.role, content: m.content };
  });
}

async function runAgent(session, text, emit) {
  session.messages.push({ role: 'user', content: text });
  if (!session.title) session.title = text.slice(0, 40);
  const system = '你是 HongClaw，一个运行在用户电脑上的 AI 智能体。可用工具完成任务，执行命令前会请求用户批准。用用户的语言回复。';
  for (let step = 0; step < 20; step++) {
    const msgs = [{ role: 'system', content: system }].concat(toApi(session.messages));
    let text2 = '';
    const accum = new Map();
    for await (const ev of streamChat(msgs, toolDefs)) {
      if (ev.kind === 'delta') { text2 += ev.text; emit({ type: 'event.delta', text: ev.text }); }
      else if (ev.kind === 'tool_call') { const cur = accum.get(ev.index) || { id: '', name: '', args: '' }; if (ev.id) cur.id = ev.id; if (ev.name) cur.name += ev.name; if (ev.argsDelta) cur.args += ev.argsDelta; accum.set(ev.index, cur); }
    }
    let calls = Array.from(accum.entries()).sort((a, b) => a[0] - b[0]).map(e => ({ id: e[1].id || 'call_' + e[0], name: e[1].name, arguments: e[1].args }));
    const isDsml = calls.length === 0 && containsDsml(text2);
    if (isDsml) calls = parseDsml(text2);
    if (calls.length === 0) { session.messages.push({ role: 'assistant', content: text2 }); emit({ type: 'session.end', text: text2 }); return; }
    session.messages.push(Object.assign({ role: 'assistant', content: text2 }, isDsml ? {} : { toolCalls: calls }));
    const results = [];
    for (const call of calls) {
      const fn = tools[call.name];
      emit({ type: 'tool.call', call });
      let result;
      if (!fn) result = { toolCallId: call.id, name: call.name, content: '未知工具 ' + call.name, isError: true };
      else {
        let args = {}; try { args = JSON.parse(call.arguments || '{}'); } catch {}
        try {
          if (call.name === 'run_command') { const ok = await requestApproval(session.id, 'run_command', call.arguments.slice(0, 120), call.arguments, emit); result = { toolCallId: call.id, name: call.name, content: await runCmd(args, ok), isError: !ok }; }
          else result = { toolCallId: call.id, name: call.name, content: await fn(args) };
        } catch (e) { result = { toolCallId: call.id, name: call.name, content: 'Error: ' + e.message, isError: true }; }
      }
      emit({ type: 'tool.result', result });
      results.push(result);
    }
    if (isDsml) session.messages.push({ role: 'user', content: formatDsmlResults(results) });
    else for (const r of results) session.messages.push({ role: 'tool', content: r.content, toolCallId: r.toolCallId });
  }
  emit({ type: 'error', message: '达到最大步数' });
  emit({ type: 'session.end', text: '' });
}

const sseClients = new Set();
const busy = new Set();
function sendSse(sessionId, obj) { const data = JSON.stringify(Object.assign({ sessionId }, obj)); for (const res of sseClients) res.write('data: ' + data + '\n\n'); }

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HongClaw</title>
<style>
:root{--bg:#0f1117;--panel:#171a23;--border:#262b38;--text:#e6e8ee;--muted:#8b93a7;--accent:#4f7cff}
*{box-sizing:border-box}html,body,#app{height:100%;margin:0}body{background:var(--bg);color:var(--text);font:14px/1.5 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
#app{display:flex}#sidebar{width:260px;background:var(--panel);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:12px}
.brand{font-size:18px;font-weight:700;margin-bottom:12px}#session-list{flex:1;overflow-y:auto}
.session-item{padding:8px 10px;border-radius:8px;cursor:pointer;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.session-item:hover{background:#202430}.session-item.active{background:#232a3d;color:var(--text)}
#main{flex:1;display:flex;flex-direction:column;min-width:0}#topbar{padding:10px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between}
#status.ok{color:#3ddc84}#status.err{color:#ff6b6b}#messages{flex:1;overflow-y:auto;padding:20px}
.msg{margin-bottom:14px;display:flex}.msg.user{justify-content:flex-end}.msg.user .bubble{background:var(--accent)}.msg.assistant .bubble{background:var(--panel)}
.bubble{max-width:78%;padding:10px 14px;border-radius:12px;white-space:pre-wrap;word-break:break-word}
.tool-block{margin:10px 0;background:#131722;border:1px solid var(--border);border-radius:8px;padding:10px}.tool-head{color:var(--muted);font-size:12px;margin-bottom:6px}
.tool-block pre{margin:0;white-space:pre-wrap;word-break:break-word;color:var(--muted);font-size:12px}.tool-block .btn{margin-right:8px}
#composer{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--border)}
#input{flex:1;resize:none;background:var(--panel);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:10px}
.btn{background:#242938;color:var(--text);border:1px solid var(--border);border-radius:8px;padding:8px 14px;cursor:pointer}.btn.primary{background:var(--accent);border-color:var(--accent)}
dialog{background:var(--panel);color:var(--text);border:1px solid var(--border);border-radius:12px;width:420px}
dialog label{display:block;margin:10px 0;color:var(--muted)}dialog input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px;margin-top:4px}
</style></head>
<body><div id="app">
<aside id="sidebar"><div class="brand">HongClaw</div><button id="new-session" class="btn primary">+ 新会话</button><div id="session-list"></div><div class="sidebar-foot" style="margin-top:8px"><button id="btn-config" class="btn">配置</button></div></aside>
<main id="main"><header id="topbar"><div id="status" class="err">连接中…</div><div id="model-tag"></div></header><div id="messages"></div>
<form id="composer"><textarea id="input" rows="1" placeholder="输入消息，回车发送"></textarea><button type="submit" class="btn primary">发送</button></form></main>
</div>
<dialog id="config-dialog"><form method="dialog"><h3>配置</h3>
<label>API Key <input id="cfg-apiKey" type="password" placeholder="sk-..."></label>
<label>Base URL <input id="cfg-baseUrl"></label>
<label>Model <input id="cfg-model"></label>
<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button value="cancel" class="btn">取消</button><button id="cfg-save" value="default" class="btn primary">保存</button></div>
</form></dialog>
<script>
function $(s){return document.querySelector(s)}
var token=localStorage.getItem('hc_token')||'';var q=new URLSearchParams(location.search).get('token');if(q){token=q;localStorage.setItem('hc_token',q);history.replaceState(null,'','/')}
var sessionId=null,streamEl=null,streamText='';
function api(path,opts){opts=opts||{};opts.headers=Object.assign({'Content-Type':'application/json','Authorization':'Bearer '+token},opts.headers||{});return fetch(path,opts).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()})}
function el(t,c,txt){var n=document.createElement(t);if(c)n.className=c;if(txt!=null)n.textContent=txt;return n}
function scroll(){var m=$('#messages');m.scrollTop=m.scrollHeight}
function addMsg(role,text){var w=el('div','msg '+role);w.appendChild(el('div','bubble',text));$('#messages').appendChild(w);scroll();return w}
function toolBlock(title,body){var w=el('div','tool-block');w.appendChild(el('div','tool-head',title));w.appendChild(el('pre',null,body));$('#messages').appendChild(w);scroll();return w}
function startStream(){streamEl=addMsg('assistant','');streamText=''}
function appendStream(t){streamText+=t;streamEl.querySelector('.bubble').textContent=streamText;scroll()}
var es=new EventSource('/api/stream?token='+encodeURIComponent(token));
es.onmessage=function(e){var ev=JSON.parse(e.data);if(ev.sessionId&&ev.sessionId!==sessionId)return;var p=ev;
if(ev.type==='event.delta'){if(!streamEl)startStream();appendStream(p.text||'')}
else if(ev.type==='tool.call'){toolBlock('🔧 '+p.call.name,p.call.arguments||'')}
else if(ev.type==='tool.result'){toolBlock('↩ 结果',(p.result.content||'').slice(0,2000))}
else if(ev.type==='approval.request'){var a=toolBlock('⚠ 需要批准：'+p.summary,p.details||'');var y=el('button','btn primary','批准');var n=el('button','btn','拒绝');y.onclick=function(){api('/api/approval',{method:'POST',body:JSON.stringify({approvalId:p.approvalId,approved:true})});a.remove()};n.onclick=function(){api('/api/approval',{method:'POST',body:JSON.stringify({approvalId:p.approvalId,approved:false})});a.remove()};a.appendChild(y);a.appendChild(n)}
else if(ev.type==='session.end'){streamEl=null}
else if(ev.type==='error'){toolBlock('错误',p.message||'');streamEl=null}};
function loadSessions(){api('/api/sessions').then(function(list){var box=$('#session-list');box.innerHTML='';list.forEach(function(s){var it=el('div','session-item'+(s.id===sessionId?' active':''),s.title||'(新会话)');it.onclick=function(){selectSession(s.id)};box.appendChild(it)})})}
function selectSession(id){sessionId=id;api('/api/sessions/'+id).then(function(s){$('#messages').innerHTML='';(s.messages||[]).forEach(function(m){if(m.role==='user')addMsg('user',m.content);else if(m.role==='assistant'&&m.content)addMsg('assistant',m.content);else if(m.role==='tool')toolBlock('工具结果',(m.content||'').slice(0,2000))});loadSessions()})}
function newSession(){api('/api/sessions',{method:'POST'}).then(function(s){selectSession(s.id)})}
function sendMessage(text){var go=function(){addMsg('user',text);startStream();api('/api/message',{method:'POST',body:JSON.stringify({sessionId:sessionId,text:text})}).catch(function(e){toolBlock('错误',String(e))})};if(!sessionId){api('/api/sessions',{method:'POST'}).then(function(s){sessionId=s.id;loadSessions();go()})}else go()}
$('#composer').addEventListener('submit',function(e){e.preventDefault();var t=$('#input').value.trim();if(!t)return;$('#input').value='';sendMessage(t)});
$('#input').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#composer').requestSubmit()}});
$('#new-session').onclick=newSession;
$('#btn-config').onclick=function(){api('/api/config').then(function(c){$('#cfg-apiKey').value=c.apiKey||'';$('#cfg-baseUrl').value=c.baseUrl||'';$('#cfg-model').value=c.model||'';$('#config-dialog').showModal()})};
$('#cfg-save').onclick=function(){api('/api/config',{method:'PUT',body:JSON.stringify({apiKey:$('#cfg-apiKey').value,baseUrl:$('#cfg-baseUrl').value,model:$('#cfg-model').value})}).then(function(){$('#config-dialog').close()})};
$('#status').textContent='已连接';$('#status').className='ok';newSession();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const token = (req.headers.authorization || '').replace('Bearer ', '') || u.searchParams.get('token') || '';
  if (p !== '/api/health' && p !== '/' && token !== config.token) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return; }
  try {
    if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    if (p === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, model: config.model })); return; }
    if (p === '/api/stream') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write('data: {"type":"ready"}\n\n'); sseClients.add(res); req.on('close', () => sseClients.delete(res)); return; }
    if (p === '/api/config' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ apiKey: config.apiKey ? '***' : '', baseUrl: config.baseUrl, model: config.model })); return; }
    if (p === '/api/config' && req.method === 'PUT') { const b = JSON.parse(await readBody(req)); if (b.apiKey && b.apiKey !== '***') config.apiKey = b.apiKey; if (b.baseUrl) config.baseUrl = b.baseUrl; if (b.model) config.model = b.model; saveConfig(config); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
    if (p === '/api/sessions' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(listSessions())); return; }
    if (p === '/api/sessions' && req.method === 'POST') { const s = newSession(); saveSession(s); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: s.id, title: s.title })); return; }
    const m = p.match(/^\/api\/sessions\/([^/]+)$/);
    if (m && req.method === 'GET') { const s = loadSession(m[1]); if (!s) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(s)); return; }
    if (m && req.method === 'DELETE') { try { fs.unlinkSync(sessionFile(m[1])); } catch {} res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
    if (p === '/api/message' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      const s = loadSession(b.sessionId);
      if (!s) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no session' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
      if (!busy.has(s.id)) {
        busy.add(s.id);
        runAgent(s, b.text, ev => sendSse(s.id, ev)).then(() => saveSession(s)).catch(e => sendSse(s.id, { type: 'error', message: e.message })).finally(() => busy.delete(s.id));
      }
      return;
    }
    if (p === '/api/approval' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const ap = approvals.get(b.approvalId); if (ap) { clearTimeout(ap.timer); approvals.delete(b.approvalId); ap.resolve(Boolean(b.approved)); } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
});

server.listen(config.port, config.host, () => {
  console.error('[HongClaw] Gateway 已启动: http://' + config.host + ':' + config.port);
  console.error('[HongClaw] Web UI: http://127.0.0.1:' + config.port + '/?token=' + config.token);
  console.error('[HongClaw] API Key: ' + (config.apiKey ? '已配置' : '未配置（打开 Web UI 点右上角「配置」填写）'));
});
