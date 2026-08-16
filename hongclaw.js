// ==== HongClaw v1.1.0 ====
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
const SKILLS_DIR = path.join(HOME, 'skills');
const PLUGINS_DIR = path.join(HOME, 'plugins');
const SKILLS_STATE_PATH = path.join(HOME, 'skills-state.json');
const ASSETS_DIR = path.join(__dirname, 'assets');
const MEMORY_PATH = path.join(HOME, 'memory.md');
const MAID_SRC = path.join(os.homedir(), 'dsh-deep-whale', 'maid-atelier', 'lib', 'client.js');
const VERSION = '1.4.1';

function defaultConfig() {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: process.env.HONGCLAW_BASE_URL || 'https://api.deepseek.com',
    model: process.env.HONGCLAW_MODEL || 'deepseek-chat',
    provider: 'deepseek',
    providers: [],
    reasoningEffort: 'off',
    host: '127.0.0.1',
    port: 19870,
    token: crypto.randomBytes(24).toString('hex'),
    email: null,
    mcpServers: {},
    persona: '',
  };
}
function loadConfig() {
  try { if (fs.existsSync(CONFIG_PATH)) return Object.assign(defaultConfig(), JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))); } catch (e) {}
  const c = defaultConfig(); saveConfig(c); return c;
}
function saveConfig(c) { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }
const config = loadConfig();
function normalizeConfig() {
  if (!Array.isArray(config.providers) || !config.providers.length) {
    config.providers = [{ id: 'deepseek', name: 'DeepSeek', baseUrl: config.baseUrl || 'https://api.deepseek.com', apiKey: config.apiKey || '', models: [config.model || 'deepseek-chat', 'deepseek-reasoner'] }];
  }
  if (!config.provider) config.provider = config.providers[0].id;
  if (!config.model || !config.providers.find(p => p.id === config.provider && (p.models || []).includes(config.model))) {
    const p0 = config.providers.find(p => p.id === config.provider) || config.providers[0];
    config.model = (p0.models && p0.models[0]) || 'deepseek-chat';
  }
  if (!config.reasoningEffort) config.reasoningEffort = 'off';
  const prov = config.providers.find(p => p.id === config.provider) || config.providers[0];
  config.baseUrl = prov.baseUrl || config.baseUrl;
  config.apiKey = prov.apiKey || config.apiKey;
}
normalizeConfig();
function getProvider() { return config.providers.find(p => p.id === config.provider) || config.providers[0]; }

function readBody(req) { return new Promise((res, rej) => { let d = ''; req.on('data', c => d += c); req.on('end', () => res(d)); req.on('error', rej); }); }

async function* streamChat(messages, tools) {
  const prov = getProvider();
  const body = { model: config.model, messages, stream: true, temperature: 0.7, stream_options: { include_usage: true } };
  if (config.reasoningEffort && config.reasoningEffort !== 'off') body.reasoning_effort = config.reasoningEffort;
  if (tools && tools.length) body.tools = tools;
  const base = String(prov.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (prov.apiKey || config.apiKey) },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(prov.id + ' API ' + res.status + ': ' + (await res.text()).slice(0, 400));
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
      if (j.usage) yield { kind: 'usage', usage: j.usage };
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

// ---------- Skills（AgentSkills / SKILL.md）----------
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!m) return { body: text, meta: {} };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const km = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!km) continue;
    let v = km[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else if (v.startsWith('{') || v.startsWith('[')) { try { v = JSON.parse(v); } catch {} }
    else if (v === 'true') v = true;
    else if (v === 'false') v = false;
    meta[km[1]] = v;
  }
  return { body: text.slice(m[0].length), meta };
}
function hasBin(b) {
  return (process.env.PATH || '').split(path.delimiter).some(d => { try { fs.accessSync(path.join(d, b), fs.constants.X_OK); return true; } catch { return false; } });
}
function skillGatesPass(meta) {
  const g = meta.metadata && meta.metadata.openclaw;
  if (!g) return true;
  if (g.always) return true;
  const r = g.requires || {};
  if (r.bins && !r.bins.every(hasBin)) return false;
  if (r.anyBins && !r.anyBins.some(hasBin)) return false;
  if (r.env && !r.env.every(e => process.env[e] !== undefined)) return false;
  if (g.os && Array.isArray(g.os) && g.os.length && !g.os.includes(process.platform)) return false;
  return true;
}
function walkSkills(root, out, depth) {
  if (!fs.existsSync(root) || depth > 4) return;
  let entries; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) walkSkills(full, out, depth + 1);
    else if (e.name === 'SKILL.md') out.push(full);
  }
}
function replaceBaseDir(body, dir) { return body.split('{baseDir}').join(dir); }
function loadSkillsState() { try { return JSON.parse(fs.readFileSync(SKILLS_STATE_PATH, 'utf8')); } catch { return {}; } }
function saveSkillsState(s) { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(SKILLS_STATE_PATH, JSON.stringify(s, null, 2)); }
let skillsState = loadSkillsState();
let skills = [];
function loadSkills() {
  const files = [];
  walkSkills(SKILLS_DIR, files, 0);
  for (const p of plugins) for (const r of p.skillRoots) walkSkills(r, files, 0);
  const seen = new Set();
  const out = [];
  for (const f of files) {
    try {
      const { meta, body } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
      if (!meta.name || !meta.description || seen.has(meta.name)) continue;
      seen.add(meta.name);
      if (!skillGatesPass(meta)) continue;
      out.push({ name: meta.name, description: String(meta.description), dir: path.dirname(f), body, enabled: skillsState[meta.name] !== false });
    } catch {}
  }
  return out;
}

// ---------- Plugins（openclaw.plugin.json / .claude-plugin）----------
let plugins = [];
function findManifest(dir) {
  const candidates = ['openclaw.plugin.json', path.join('.claude-plugin', 'plugin.json'), 'plugin.json'];
  for (const c of candidates) { const f = path.join(dir, c); if (fs.existsSync(f)) return f; }
  return null;
}
function scanPlugins() {
  const out = [];
  if (!fs.existsSync(PLUGINS_DIR)) return out;
  for (const e of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const dir = path.join(PLUGINS_DIR, e.name);
    const mf = findManifest(dir);
    if (!mf) continue;
    let manifest; try { manifest = JSON.parse(fs.readFileSync(mf, 'utf8')); } catch { continue; }
    const skillRoots = [];
    const std = path.join(dir, 'skills');
    if (fs.existsSync(std)) skillRoots.push(std);
    if (Array.isArray(manifest.skills)) for (const s of manifest.skills) skillRoots.push(path.join(dir, s));
    out.push({ id: manifest.id || e.name, name: manifest.name || e.name, dir, manifest, skillRoots, mcpServers: manifest.mcpServers || {} });
  }
  return out;
}

// ---------- MCP stdio 客户端（插件 manifest.mcpServers）----------
class McpClient {
  constructor(name, def, rootDir) {
    this.name = name;
    const command = path.isAbsolute(def.command) ? def.command : path.resolve(rootDir, def.command);
    const args = (def.args || []).map(a => (path.isAbsolute(a) ? a : path.resolve(rootDir, a)));
    this.proc = spawn(command, args, { env: { ...process.env, ...(def.env || {}) }, cwd: def.cwd ? path.resolve(rootDir, def.cwd) : rootDir, stdio: ['pipe', 'pipe', 'pipe'] });
    this.id = 0; this.pending = new Map(); this.buf = '';
    this.proc.stdout.on('data', d => this.onData(String(d)));
    this.proc.stderr.on('data', () => {});
  }
  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && this.pending.has(msg.id)) { const p = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
    }
  }
  request(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  }
  async init() {
    await this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'hongclaw', version: VERSION } });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  async listTools() { const r = await this.request('tools/list', {}); return (r && r.tools) || []; }
  async call(tool, args) { const r = await this.request('tools/call', { name: tool, arguments: args }); return Array.isArray(r && r.content) ? r.content.map(c => (c.text != null ? c.text : JSON.stringify(c))).join('\n') : JSON.stringify(r); }
}
// ---------- Token 用量统计 ----------
const USAGE_PATH = path.join(HOME, 'usage.json');
function loadUsage() { try { return JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8')); } catch { return {}; } }
function saveUsage(u) { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(USAGE_PATH, JSON.stringify(u, null, 2)); }
function recordUsage(key, u) {
  if (!u || !u.total) return;
  const all = loadUsage();
  const cur = all[key] || { prompt: 0, completion: 0, total: 0 };
  cur.prompt += u.prompt || 0; cur.completion += u.completion || 0; cur.total += u.total || 0;
  all[key] = cur; saveUsage(all);
}
class McpHttpClient {
  constructor(name, def) {
    this.name = name;
    this.url = def.url || def.baseUrl;
    this.headers = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', ...(def.headers || {}) };
  }
  async request(method, params) {
    const res = await fetch(this.url, { method: 'POST', headers: this.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (!res.ok) throw new Error('MCP HTTP ' + res.status);
    const text = await res.text();
    let msg;
    if (text.indexOf('\n') >= 0) { const line = text.split('\n').find(l => l.startsWith('data:')); msg = line ? JSON.parse(line.slice(5).trim()) : null; }
    else msg = JSON.parse(text);
    if (!msg) throw new Error('MCP 响应为空');
    if (msg.error) throw new Error(msg.error.message || 'MCP error');
    return msg.result;
  }
  async init() { await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'hongclaw', version: VERSION } }); }
  async listTools() { const r = await this.request('tools/list', {}); return (r && r.tools) || []; }
  async call(tool, args) { const r = await this.request('tools/call', { name: tool, arguments: args }); return Array.isArray(r && r.content) ? r.content.map(c => (c.text != null ? c.text : JSON.stringify(c))).join('\n') : JSON.stringify(r); }
}
async function loadMcpTools() {
  const out = [];
  const servers = [];
  for (const [name, def] of Object.entries(config.mcpServers || {})) servers.push(['user:' + name, def, __dirname]);
  for (const p of plugins) for (const [name, def] of Object.entries(p.mcpServers || {})) servers.push([p.id + ':' + name, def, p.dir]);
  for (const [key, def, rootDir] of servers) {
    if (!def) continue;
    const isHttp = /^https?:\/\//.test(String(def.url || def.baseUrl || ''));
    try {
      let c, ts;
      if (isHttp) { c = new McpHttpClient(key, def); await c.init(); ts = await c.listTools(); }
      else { if (!def.command) continue; c = new McpClient(key, def, rootDir); await c.init(); ts = await c.listTools(); }
      for (const t of ts) {
        const toolName = 'mcp__' + key.replace(/[^A-Za-z0-9_]/g, '_') + '__' + t.name;
        out.push({ name: toolName, description: t.description || ('MCP 工具 ' + key + '.' + t.name), params: t.inputSchema || { type: 'object', properties: {} }, exec: (args) => c.call(t.name, args) });
      }
      console.error('[HongClaw] MCP 服务器 "' + key + '" 已连接，注册 ' + ts.length + ' 个工具');
    } catch (e) { console.error('[HongClaw] MCP 服务器 "' + key + '" 连接失败: ' + e.message); }
  }
  return out;
}
async function reloadMcp() {
  for (const k of Object.keys(tools)) if (k.startsWith('mcp__')) delete tools[k];
  const keep = toolDefs.filter(d => !d.function.name.startsWith('mcp__'));
  toolDefs.length = 0; for (const d of keep) toolDefs.push(d);
  for (const mt of await loadMcpTools()) { tools[mt.name] = mt.exec; toolDefs.push({ type: 'function', function: { name: mt.name, description: mt.description, parameters: mt.params } }); }
}

// ---------- 会话 ----------
function readMemory() { try { return fs.readFileSync(MEMORY_PATH, 'utf8').slice(0, 2000); } catch { return ''; } }
function buildSystemPrompt() {
  let s = '你是 HongClaw，一个运行在用户电脑上的 AI 智能体。你的平台能力：\n' +
    '- 文件读写/目录浏览/执行命令（需用户批准）/抓取网页\n' +
    '- 技能（skills）：用 skill_load 读取已启用技能的操作说明\n' +
    '- 邮箱：邮箱在 ~/.hongclaw/config.json 的 email 字段配置（smtpHost/smtpUser/smtpPass 用于发信，imapHost/imapUser/imapPass 用于自动收信并回复，定时任务/心跳结果可邮件通知）。当用户问"能不能绑定邮箱/配置邮箱/发邮件"时，先调用 email_status 查看当前配置状态，再如实回答并指导；需要实际发信时用 send_email 工具\n' +
    '- 定时任务（cron）与心跳机制：由用户在 Web UI「定时」中管理\n' +
    '- 多模型/多 Provider/思考强度：由用户在 Web UI 顶栏切换\n' +
    '执行命令前会请求用户批准。用用户的语言回复。';
  if (config.persona && String(config.persona).trim()) s = '【当前人设】' + String(config.persona).trim() + '\n\n' + s;
  const mem = readMemory();
  if (mem) s += '\n\n长期记忆（用户确认要记住的内容，必要时用 memory_write 更新）：\n' + mem + '\n';
  const active = skills.filter(x => x.enabled);
  if (active.length) {
    s += '\n\n可用技能（当任务匹配某技能的描述时，先调用 skill_load 读取该技能的操作说明）：\n';
    for (const sk of active) s += '- ' + sk.name + ': ' + sk.description + '\n';
  }
  return s;
}
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
  const usageTotal = { prompt: 0, completion: 0, total: 0 };
  try {
  session.messages.push({ role: 'user', content: text });
  if (!session.title) session.title = text.slice(0, 40);
  for (let step = 0; step < 20; step++) {
    const msgs = [{ role: 'system', content: buildSystemPrompt() }].concat(toApi(session.messages));
    let text2 = '';
    const accum = new Map();
    for await (const ev of streamChat(msgs, toolDefs)) {
      if (ev.kind === 'delta') { text2 += ev.text; emit({ type: 'event.delta', text: ev.text }); }
      else if (ev.kind === 'tool_call') { const cur = accum.get(ev.index) || { id: '', name: '', args: '' }; if (ev.id) cur.id = ev.id; if (ev.name) cur.name += ev.name; if (ev.argsDelta) cur.args += ev.argsDelta; accum.set(ev.index, cur); }
      else if (ev.kind === 'usage') { const u = ev.usage || {}; usageTotal.prompt += u.prompt_tokens || 0; usageTotal.completion += u.completion_tokens || 0; usageTotal.total += u.total_tokens || 0; }
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
  } finally {
    if (usageTotal.total) recordUsage(config.provider + '/' + config.model, usageTotal);
  }
}

const sseClients = new Set();
const busy = new Set();
const eventQueues = new Map();
function sendSse(sessionId, obj) {
  let q = eventQueues.get(sessionId);
  if (!q) { q = { seq: 0, events: [] }; eventQueues.set(sessionId, q); }
  q.seq += 1; q.events.push(obj);
  if (q.events.length > 200) q.events.shift();
  const data = JSON.stringify(Object.assign({ sessionId }, obj));
  for (const res of sseClients) res.write('data: ' + data + '\n\n');
}

// ---------- 定时任务（Cron）----------
const CRON_PATH = path.join(HOME, 'cron.json');
function loadCronJobs() { try { return JSON.parse(fs.readFileSync(CRON_PATH, 'utf8')); } catch { return []; } }
function saveCronJobs(jobs) { fs.mkdirSync(HOME, { recursive: true }); fs.writeFileSync(CRON_PATH, JSON.stringify(jobs, null, 2)); }
let cronJobs = loadCronJobs();
const cronLastRuns = new Map();
function cronFieldMatch(field, v) {
  for (const seg of String(field).split(',')) {
    const parts = seg.split('/');
    const step = parts[1] ? Number(parts[1]) : 1;
    let lo = 0, hi = 59;
    if (parts[0] !== '*') {
      if (parts[0].includes('-')) { const t = parts[0].split('-'); lo = Number(t[0]); hi = Number(t[1]); }
      else { lo = Number(parts[0]); hi = lo; }
    }
    if (v >= lo && v <= hi && (v - lo) % step === 0) return true;
  }
  return false;
}
function cronMatch(expr, d) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return cronFieldMatch(parts[0], d.getMinutes()) && cronFieldMatch(parts[1], d.getHours()) && cronFieldMatch(parts[2], d.getDate()) && cronFieldMatch(parts[3], d.getMonth() + 1) && cronFieldMatch(parts[4], d.getDay());
}
function runCronJob(job) {
  const s = newSession();
  s.title = '[定时] ' + (job.name || job.id);
  saveSession(s);
  console.error('[HongClaw] 定时任务触发: ' + (job.name || job.id) + '  cron=' + job.cron);
  runAgent(s, job.prompt, () => {}).then(() => {
    saveSession(s);
    const last = s.messages[s.messages.length - 1] || {};
    job.lastResult = String(last.content || '').slice(0, 2000);
    job.lastRunAt = Date.now();
    saveCronJobs(cronJobs);
    if (config.email && config.email.smtpHost && config.email.notifyCron !== false) {
      sendEmail({ to: config.email.to || config.email.smtpUser, subject: '[HongClaw 定时任务] ' + (job.name || job.id), text: '任务内容：\n' + job.prompt + '\n\n执行结果：\n' + job.lastResult }).catch(e => console.error('[HongClaw] 定时结果邮件失败: ' + e.message));
    }
  }).catch(e => {
    console.error('[HongClaw] 定时任务失败: ' + e.message);
    job.lastResult = 'Error: ' + e.message;
    job.lastRunAt = Date.now();
    saveCronJobs(cronJobs);
  });
}
setInterval(() => {
  const now = new Date();
  const keyBase = now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate() + '-' + now.getHours() + ':' + now.getMinutes();
  for (const job of cronJobs) {
    if (!job.enabled) continue;
    if (!cronMatch(job.cron, now)) continue;
    const key = job.id + ':' + keyBase;
    if (cronLastRuns.has(key)) continue;
    cronLastRuns.add(key);
    runCronJob(job);
  }
}, 30000);

// ---------- 邮箱（SMTP 发送 + IMAP 收取，零依赖）----------
function decodeMime(s) {
  if (!s) return s;
  return String(s).replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (m, charset, enc, data) => {
    try {
      if (enc.toLowerCase() === 'b') return Buffer.from(data, 'base64').toString('utf8');
      return decodeURIComponent(data.replace(/=([0-9A-Fa-f]{2})/g, '%$1'));
    } catch { return m; }
  });
}
function sendEmail(opts) {
  const cfg = config.email || {};
  if (!cfg.smtpHost || !cfg.smtpUser) return Promise.reject(new Error('邮箱 SMTP 未配置（请在 ~/.hongclaw/config.json 填写 email.smtpHost/smtpUser/smtpPass）'));
  return new Promise((resolve, reject) => {
    const net = require('node:net');
    const tls = require('node:tls');
    const port = cfg.smtpPort || 465;
    const secure = cfg.smtpSecure !== false;
    const conn = secure ? tls.connect({ host: cfg.smtpHost, port, rejectUnauthorized: false }) : net.connect(port, cfg.smtpHost);
    let buf = '';
    const queue = [];
    conn.on('error', e => reject(e));
    conn.on('data', d => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (line.length > 3 && line[3] === '-') continue;
        const fn = queue.shift();
        if (fn) fn(parseInt(line.slice(0, 3), 10), line);
      }
    });
    function cmd(str) {
      return new Promise((res, rej) => {
        queue.push((code) => { if (code >= 400) rej(new Error('SMTP ' + code + ': ' + str)); else res(); });
        conn.write(str + '\r\n');
      });
    }
    (async () => {
      await new Promise((res, rej) => queue.push((code) => (code === 220 ? res() : rej(new Error('SMTP 未收到 220')))));
      await cmd('EHLO hongclaw');
      if (cfg.smtpUser) {
        try {
          await cmd('AUTH LOGIN');
          await cmd(Buffer.from(cfg.smtpUser).toString('base64'));
          await cmd(Buffer.from(cfg.smtpPass || '').toString('base64'));
        } catch (e) {
          await cmd('AUTH PLAIN ' + Buffer.from('\0' + cfg.smtpUser + '\0' + (cfg.smtpPass || '')).toString('base64'));
        }
      }
      await cmd('MAIL FROM:<' + (cfg.from || cfg.smtpUser) + '>');
      await cmd('RCPT TO:<' + opts.to + '>');
      await cmd('DATA');
      const msg = 'From: ' + (cfg.from || cfg.smtpUser) + '\r\nTo: ' + opts.to + '\r\nSubject: ' + (opts.subject || '') + '\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' + (opts.text || '');
      conn.write(msg.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.\r\n');
      await new Promise((res, rej) => queue.push((code) => (code >= 400 ? rej(new Error('SMTP data ' + code)) : res())));
      await cmd('QUIT').catch(() => {});
      conn.end();
      resolve();
    })().catch(e => { try { conn.destroy(); } catch {} reject(e); });
  });
}
function fetchEmails() {
  const cfg = config.email || {};
  if (!cfg.imapHost || !cfg.imapUser) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const net = require('node:net');
    const tls = require('node:tls');
    const port = cfg.imapPort || 993;
    const secure = cfg.imapSecure !== false;
    const conn = secure ? tls.connect({ host: cfg.imapHost, port, rejectUnauthorized: false }) : net.connect(port, cfg.imapHost);
    let buf = Buffer.alloc(0);
    let literalRemaining = 0;
    let nextLiteralIs = '';
    let cur = null;
    let lastSearch = [];
    const emails = [];
    const pending = new Map();
    let seq = 0;
    let done = false;
    function finish() { if (!done) { done = true; try { conn.destroy(); } catch {} resolve(emails); } }
    function fail(e) { if (!done) { done = true; try { conn.destroy(); } catch {} reject(e); } }
    function onLine(line) {
      if (line.startsWith('* SEARCH')) { lastSearch = line.slice(8).trim().split(/\s+/).filter(Boolean).map(Number); return; }
      if (line.startsWith('* ')) {
        if (/^\* \d+ FETCH/.test(line)) { cur = { from: '', subject: '', date: '', body: '' }; return; }
        if (cur && line.trim() === ')') { emails.push(cur); cur = null; }
        return;
      }
      const sp = line.indexOf(' ');
      const tag = sp > 0 ? line.slice(0, sp) : line;
      const p = pending.get(tag);
      if (p) { pending.delete(tag); p(line); }
    }
    function onLiteral(text) {
      if (!cur) return;
      if (nextLiteralIs === 'header') {
        const fm = text.match(/From: ([^\r\n]+)/i);
        const sm = text.match(/Subject: ([^\r\n]+)/i);
        const dm = text.match(/Date: ([^\r\n]+)/i);
        if (fm) cur.from = fm[1].trim();
        if (sm) cur.subject = sm[1].trim();
        if (dm) cur.date = dm[1].trim();
        nextLiteralIs = '';
      } else if (nextLiteralIs === 'body') {
        cur.body = text.trim().slice(0, 6000);
        nextLiteralIs = '';
      }
    }
    conn.on('data', d => {
      buf = Buffer.concat([buf, d]);
      while (true) {
        if (literalRemaining > 0) {
          if (buf.length < literalRemaining) return;
          onLiteral(buf.slice(0, literalRemaining).toString('utf8'));
          buf = buf.slice(literalRemaining);
          literalRemaining = 0;
          continue;
        }
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        const line = buf.slice(0, nl).toString('utf8').replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        const lm = line.match(/\{(\d+)\}$/);
        if (lm && line.includes('BODY[')) {
          literalRemaining = Number(lm[1]);
          nextLiteralIs = line.includes('HEADER.FIELDS') ? 'header' : 'body';
          if (line.includes('FETCH')) cur = { from: '', subject: '', date: '', body: '' };
          continue;
        }
        onLine(line);
      }
    });
    conn.on('error', e => fail(e));
    function cmd(str) {
      const tag = 'a' + (++seq);
      return new Promise((res, rej) => {
        pending.set(tag, (line) => { if (/^a\d+ OK/i.test(line)) res(); else rej(new Error('IMAP: ' + line)); });
        conn.write(tag + ' ' + str + '\r\n');
      });
    }
    (async () => {
      await cmd('LOGIN ' + cfg.imapUser + ' ' + (cfg.imapPass || ''));
      await cmd('SELECT INBOX');
      await cmd('SEARCH UNSEEN');
      const ids = lastSearch.slice(0, 10);
      if (ids.length) {
        await cmd('FETCH ' + ids.join(',') + ' (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT])');
        await cmd('STORE ' + ids.join(',') + ' +FLAGS (\\Seen)');
      }
      await cmd('LOGOUT').catch(() => {});
      finish();
    })().catch(e => fail(e));
  });
}
async function checkMail() {
  const cfg = config.email || {};
  if (!cfg.imapHost || !cfg.imapUser) return;
  let emails = [];
  try { emails = await fetchEmails(); } catch (e) { console.error('[HongClaw] 收件检查失败: ' + e.message); return; }
  for (const em of emails) {
    const from = decodeMime(em.from);
    const subject = decodeMime(em.subject);
    const body = em.body.slice(0, 4000);
    if (!from || !subject) continue;
    const s = newSession();
    s.title = '[邮件] ' + subject.slice(0, 40);
    saveSession(s);
    console.error('[HongClaw] 收到新邮件: ' + subject);
    runAgent(s, '用户收到一封新邮件，请阅读内容并用中文写一封回复邮件的正文：\n发件人：' + from + '\n主题：' + subject + '\n正文：\n' + body, () => {}).then(() => {
      saveSession(s);
      const last = s.messages[s.messages.length - 1] || {};
      const reply = String(last.content || '').slice(0, 4000);
      const to = String(from).replace(/^.*<([^>]+)>.*$/, '$1').trim() || from;
      sendEmail({ to, subject: 'Re: ' + subject, text: reply }).then(() => console.error('[HongClaw] 回复邮件已发送至 ' + to)).catch(e => console.error('[HongClaw] 回复邮件失败: ' + e.message));
    }).catch(e => console.error('[HongClaw] 邮件处理失败: ' + e.message));
  }
}
setInterval(checkMail, 60000);

// ---------- 心跳（Heartbeat：周期性主动检查，OpenClaw 同款语义）----------
const HEARTBEAT_PATH = path.join(HOME, 'heartbeat.json');
function loadHeartbeat() { try { return JSON.parse(fs.readFileSync(HEARTBEAT_PATH, 'utf8')); } catch { return {}; } }
let heartbeatCfg = Object.assign({ enabled: false, intervalMin: 30, prompt: '', emailNotify: true }, loadHeartbeat());
let lastHeartbeatAt = Date.now();
function heartbeatPromptText() {
  return heartbeatCfg.prompt || '检查当前是否有需要主动处理的事情（如未读邮件、定时任务结果、待办提醒）。如果没有任何需要关注的事，只回复 HEARTBEAT_OK。';
}
function runHeartbeat() {
  lastHeartbeatAt = Date.now();
  let s = loadSession('main');
  if (!s) { s = newSession(); s.id = 'main'; s.title = '主会话'; }
  saveSession(s);
  console.error('[HongClaw] 心跳触发');
  runAgent(s, heartbeatPromptText(), () => {}).then(() => {
    saveSession(s);
    const last = s.messages[s.messages.length - 1] || {};
    const reply = String(last.content || '').trim();
    if (/HEARTBEAT_OK/.test(reply)) {
      console.error('[HongClaw] 心跳：无需要关注的事项（HEARTBEAT_OK）');
    } else {
      console.error('[HongClaw] 心跳提醒: ' + reply.slice(0, 200));
      if (heartbeatCfg.emailNotify !== false && config.email && config.email.smtpHost) {
        sendEmail({ to: config.email.to || config.email.smtpUser, subject: '[HongClaw 心跳提醒] ' + new Date().toLocaleString(), text: reply.slice(0, 4000) }).catch(e => console.error('[HongClaw] 心跳提醒邮件失败: ' + e.message));
      }
    }
  }).catch(e => console.error('[HongClaw] 心跳失败: ' + e.message));
}
setInterval(() => {
  if (!heartbeatCfg.enabled) return;
  const interval = Math.max(1, Number(heartbeatCfg.intervalMin) || 30) * 60000;
  if (Date.now() - lastHeartbeatAt >= interval) runHeartbeat();
}, 30000);

// ---------- Doctor（自检与自修复）----------
function pingCurrentModel() {
  const prov = getProvider();
  const base = String(prov.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (prov.apiKey || config.apiKey) }, body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }) });
}
async function runDoctor() {
  const checks = [];
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  checks.push({ id: 'node', name: 'Node.js 版本', ok: nodeMajor >= 18, detail: process.version + (nodeMajor >= 18 ? '' : '（需要 >= 18.17）'), fixable: false });
  let cfgOk = false;
  try { const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); cfgOk = raw && typeof raw === 'object'; } catch {}
  checks.push({ id: 'config', name: '配置文件', ok: cfgOk, detail: cfgOk ? CONFIG_PATH : '缺失或损坏', fixable: !cfgOk });
  const hasKey = (config.providers || []).some(p => p.apiKey);
  checks.push({ id: 'apikey', name: 'API Key', ok: hasKey, detail: hasKey ? '已配置' : '未配置任何 Provider 的 API Key', fixable: false, hint: '在 Web UI「配置」中为 Provider 填写 API Key' });
  for (const d of [['sessions', SESSIONS_DIR], ['skills', SKILLS_DIR], ['plugins', PLUGINS_DIR]]) {
    const ok = fs.existsSync(d[1]) && fs.statSync(d[1]).isDirectory();
    checks.push({ id: 'dir_' + d[0], name: '目录 ' + d[0], ok, detail: d[1], fixable: !ok });
  }
  let cronOk = true;
  try { loadCronJobs(); } catch { cronOk = false; }
  checks.push({ id: 'cron', name: '定时任务配置', ok: cronOk, detail: cronOk ? (cronJobs.length + ' 个任务') : 'cron.json 损坏', fixable: !cronOk });
  let ssOk = true;
  try { loadSkillsState(); } catch { ssOk = false; }
  checks.push({ id: 'skills_state', name: '技能开关状态', ok: ssOk, detail: ssOk ? '正常' : 'skills-state.json 损坏', fixable: !ssOk });
  if (config.email && config.email.smtpHost) {
    const mailOk = !!(config.email.smtpUser && config.email.smtpPass);
    checks.push({ id: 'email', name: '邮箱配置', ok: mailOk, detail: mailOk ? 'SMTP/IMAP 已配置' : 'SMTP 主机已填但缺 smtpUser/smtpPass', fixable: false });
  }
  try {
    const res = await pingCurrentModel();
    const ok = res.ok;
    checks.push({ id: 'model', name: '模型连通性', ok, detail: ok ? (config.provider + '/' + config.model + ' 可访问') : (config.provider + '/' + config.model + ' 请求失败（HTTP ' + res.status + '）'), fixable: false, hint: '检查 API Key / Base URL / 模型名' });
  } catch (e) {
    checks.push({ id: 'model', name: '模型连通性', ok: false, detail: config.provider + '/' + config.model + ' 连接失败: ' + e.message, fixable: false });
  }
  return checks;
}
function doctorFixOne(check) {
  try {
    switch (check.id) {
      case 'config': fs.mkdirSync(HOME, { recursive: true }); saveConfig(config); return '已重建默认配置';
      case 'dir_sessions': fs.mkdirSync(SESSIONS_DIR, { recursive: true }); return '已创建';
      case 'dir_skills': fs.mkdirSync(SKILLS_DIR, { recursive: true }); return '已创建';
      case 'dir_plugins': fs.mkdirSync(PLUGINS_DIR, { recursive: true }); return '已创建';
      case 'cron': if (fs.existsSync(CRON_PATH)) fs.copyFileSync(CRON_PATH, CRON_PATH + '.bak'); fs.writeFileSync(CRON_PATH, '[]'); cronJobs = []; return '已重置（备份为 cron.json.bak）';
      case 'skills_state': if (fs.existsSync(SKILLS_STATE_PATH)) fs.copyFileSync(SKILLS_STATE_PATH, SKILLS_STATE_PATH + '.bak'); fs.writeFileSync(SKILLS_STATE_PATH, '{}'); skillsState = {}; return '已重置（备份为 skills-state.json.bak）';
      default: return '无需修复';
    }
  } catch (e) { return '修复失败: ' + e.message; }
}
// ---------- 鲸鱼娘皮肤素材（从原版仓库自动提取）----------
function extractMaidAssets() {
  if (!fs.existsSync(MAID_SRC)) { console.error('[HongClaw] 未找到原版皮肤源（' + MAID_SRC + '），皮肤素材跳过。请先 git clone https://github.com/Small-tailqwq/dsh-deep-whale'); return 0; }
  let src = '';
  try { src = fs.readFileSync(MAID_SRC, 'utf8'); } catch (e) { console.error('[HongClaw] 读取皮肤源失败: ' + e.message); return 0; }
  const map = {
    MAID_ATELIER_CHIBI: 'chibi', MAID_ATELIER_BOW_CLEAN: 'bow', MAID_ATELIER_NEW_SESSION: 'new-session',
    MAID_ATELIER_SIDEBAR_SWAG: 'sidebar-swag', MAID_ATELIER_TOP_TRIM_TILE: 'top-trim', MAID_ATELIER_ICON: 'icon',
    MAID_ATELIER_PALACE_LIGHT: 'palace-light', MAID_ATELIER_PALACE_DARK: 'palace-dark',
    MAID_ATELIER_MAID_LEFT: 'maid-left', MAID_ATELIER_MAID_RIGHT: 'maid-right',
    MAID_ATELIER_BOTTOM_TRIM_TILE: 'bottom-trim', MAID_ATELIER_BOTTOM_CREST: 'bottom-crest',
    MAID_ATELIER_SIDEBAR_CORNER: 'sidebar-corner', MAID_ATELIER_COMPOSER_FRAME: 'composer-frame',
    MAID_ATELIER_SETTINGS_FRAME: 'settings-frame', MAID_ATELIER_WORKSPACE_SHIELD: 'workspace-shield',
    MAID_ATELIER_WORKSPACE_RIBBON: 'workspace-ribbon'
  };
  let n = 0;
  for (const [varName, outName] of Object.entries(map)) {
    const m = src.match(new RegExp('const ' + varName + ' = "data:image/webp;base64,([A-Za-z0-9+/=]+)"'));
    if (!m) continue;
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    fs.writeFileSync(path.join(ASSETS_DIR, outName + '.webp'), Buffer.from(m[1], 'base64'));
    n++;
  }
  console.error('[HongClaw] 已提取 ' + n + ' 个鲸鱼娘皮肤素材到 ' + ASSETS_DIR);
  return n;
}
// ---------- 发布到 GitHub（publish 子命令）----------
async function publishToGithub() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.error('缺少 GITHUB_TOKEN：请先 export GITHUB_TOKEN=ghp_xxx（Settings → Developer settings → Personal access tokens → 勾 repo）'); process.exit(1); }
  const OWNER = 'Entity-Him';
  const REPO = 'hongclaw';
  const api = 'https://api.github.com/repos/' + OWNER + '/' + REPO;
  const headers = { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'User-Agent': 'hongclaw', 'Accept': 'application/vnd.github+json' };
  async function gh(method, url, body) {
    const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const t = await res.text();
    if (!res.ok) throw new Error(method + ' ' + url + ' -> ' + res.status + ': ' + t.slice(0, 200));
    return t ? JSON.parse(t) : null;
  }
  try {
    for (const f of ['hongclaw.js', 'package.json', 'README.md']) {
      let sha = null;
      try { const meta = await gh('GET', api + '/contents/' + f); sha = meta.sha; } catch {}
      await gh('PUT', api + '/contents/' + f, { message: 'HongClaw v' + VERSION + ': 鲸鱼娘皮肤/多模型/定时/邮箱/心跳/Doctor/发布', content: Buffer.from(fs.readFileSync(path.join(__dirname, f), 'utf8')).toString('base64'), ...(sha ? { sha } : {}) });
      console.log('已更新 ' + f);
    }
    const ref = await gh('GET', api + '/git/ref/heads/main');
    const commitSha = ref.object.sha;
    const tagObj = await gh('POST', api + '/git/tags', { tag: 'v' + VERSION, message: 'HongClaw v' + VERSION, object: commitSha, type: 'commit' });
    try { await gh('POST', api + '/git/refs', { ref: 'refs/tags/v' + VERSION, sha: tagObj.sha }); console.log('已打 tag v' + VERSION); } catch (e) { console.log('tag 已存在: ' + e.message.split('\n')[0]); }
    try {
      await gh('POST', api + '/releases', { tag_name: 'v' + VERSION, name: 'HongClaw v' + VERSION + ' — 深海女仆工坊 · 鲸鱼娘', body: '鸿蒙电脑原生 AI Agent（纯 Node.js 零依赖）。\n\n- Gateway + Web UI（SSE/轮询）、多 Provider/多模型/思考强度\n- Skills（SKILL.md）+ 插件兼容（manifest + MCP）\n- Cron 定时任务、心跳机制、邮箱（SMTP/IMAP 自动收发回复）\n- Doctor 自检自修复（Web 面板 + 终端 doctor --fix）\n- 鲸鱼娘皮肤：深海女仆工坊主题（素材 CC BY-NC-SA 4.0，来源 dsh-deep-whale）', draft: false, prerelease: false });
      console.log('已创建 Release');
    } catch (e) { console.log('Release 已存在: ' + e.message.split('\n')[0]); }
    console.log('✅ 发布完成: https://github.com/' + OWNER + '/' + REPO);
  } catch (e) { console.error('发布失败: ' + e.message); process.exit(1); }
}
async function runDoctorCli(autoFix) {
  console.log('');
  console.log('HongClaw v' + VERSION + ' 自检（doctor）');
  console.log('----------------------------------------');
  const checks = await runDoctor();
  let failCount = 0;
  for (const c of checks) {
    const mark = c.ok ? '✅' : '❌';
    console.log(mark + ' ' + c.name + ': ' + (c.detail || ''));
    if (c.hint) console.log('   提示: ' + c.hint);
    if (!c.ok) {
      failCount++;
      if (c.fixable && autoFix) console.log('   → 已自动修复: ' + doctorFixOne(c));
      else if (c.fixable) console.log('   → 可修复（加 --fix 自动修复）');
    }
  }
  console.log('----------------------------------------');
  if (failCount === 0) console.log('✅ 全部正常');
  else console.log('❌ ' + failCount + ' 项异常' + (autoFix ? '' : '（加 --fix 尝试自动修复）'));
}

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>深海女仆工坊 · HongClaw</title><link rel="icon" href="/assets/icon.webp">
<style>
:root{--maid-navy-950:#091333;--maid-navy-900:#10204d;--maid-navy-800:#1c326b;--maid-indigo:#526aa8;--maid-periwinkle:#8ea5da;--maid-porcelain:#f8f6f0;--maid-gold:#c5a468;--maid-gold-soft:#e2cfaa;--maid-glass:rgba(13,25,59,.74);--maid-shadow:0 18px 58px rgba(0,0,0,.38),0 2px 10px rgba(0,0,0,.3);--text:#e5eaf6;--muted:#96a6c9;--border:rgba(151,169,216,.34);--accent:#c5a468}
*{box-sizing:border-box}html,body,#app{height:100%;margin:0}body{background:#080f27;color:var(--text);font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;overflow:hidden}
body::before{content:'';position:fixed;inset:0;z-index:0;background:url(/assets/palace-dark.webp) center/cover no-repeat;pointer-events:none}
#top-trim{position:fixed;top:0;left:0;right:0;height:16px;z-index:4;background:url(/assets/top-trim.webp) repeat-x top left/auto 16px;pointer-events:none}
#maid-stage{position:fixed;inset:0;z-index:1;pointer-events:none;overflow:hidden}
#maid-stage img{position:absolute;bottom:0;max-width:44vw;object-fit:contain;filter:drop-shadow(0 20px 24px rgba(27,44,91,.3))}
#maid-left{left:-2vw;height:80vh}
#maid-right{right:-2vw;height:80vh}
#app{position:relative;z-index:2;display:flex;height:100vh}
#sidebar{width:264px;background:rgba(5,13,40,.9);backdrop-filter:blur(14px);border-right:1px solid var(--border);display:flex;flex-direction:column;padding:14px}
#maid-chibi{width:118px;margin:2px auto 10px;display:block;filter:drop-shadow(0 8px 14px rgba(0,0,0,.4))}
.brand{font-size:19px;font-weight:800;margin-bottom:12px;color:#e7ecf7;letter-spacing:.5px;text-shadow:0 0 18px rgba(155,176,225,.4)}.ver{color:var(--muted);font-size:11px;font-weight:400;display:block;margin-top:2px}
#session-list{flex:1;overflow-y:auto}
.session-item{padding:9px 12px;border-radius:10px;cursor:pointer;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;transition:all .15s}
.session-item:hover{background:rgba(164,183,229,.14)}
.session-item.active{background:linear-gradient(90deg,rgba(211,180,119,.28),rgba(164,183,229,.12));color:#e7ecf7;border-left:2px solid var(--maid-gold)}
#main{flex:1;display:flex;flex-direction:column;min-width:0}
#topbar{padding:12px 18px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;background:rgba(13,25,59,.5);backdrop-filter:blur(8px)}
#status.ok{color:#8fe3b4;text-shadow:0 0 10px rgba(143,227,180,.5)}#status.err{color:#ff8fa3}
#messages{flex:1;overflow-y:auto;padding:22px}
.msg{margin-bottom:16px;display:flex}.msg.user{justify-content:flex-end}
.msg.user .bubble{background:linear-gradient(135deg,#1c326b,#526aa8);border-bottom-right-radius:4px;box-shadow:0 4px 18px rgba(16,32,77,.4)}
.msg.assistant .bubble{background:rgba(18,31,67,.9);border:1px solid var(--border);border-bottom-left-radius:4px;backdrop-filter:blur(6px)}
.bubble{max-width:76%;padding:11px 16px;border-radius:16px;white-space:pre-wrap;word-break:break-word;box-shadow:var(--maid-shadow)}
.tool-block{margin:12px 0;background:rgba(13,25,59,.6);border:1px solid var(--border);border-radius:12px;padding:10px 12px;backdrop-filter:blur(6px)}.tool-head{color:var(--muted);font-size:12px;margin-bottom:6px}
.tool-block pre{margin:0;white-space:pre-wrap;word-break:break-word;color:var(--muted);font-size:12px}.tool-block .btn{margin-right:8px}
#composer{display:flex;gap:10px;padding:14px 18px;border-top:1px solid var(--border);background:rgba(8,15,39,.6);backdrop-filter:blur(10px)}
#input{flex:1;resize:none;background:rgba(17,30,66,.88);border:1px solid var(--border);border-radius:14px;color:var(--text);padding:12px 14px;outline:none;transition:border-color .2s}
#input:focus{border-color:var(--maid-gold);box-shadow:0 0 0 3px rgba(211,180,119,.15)}
.btn{background:rgba(28,44,84,.94);color:#e7ecf7;border:1px solid var(--border);border-radius:10px;padding:8px 14px;cursor:pointer;transition:all .15s}.btn:hover{background:#354d88;transform:translateY(-1px)}.btn.primary{background:linear-gradient(135deg,#c5a468,#e2cfaa);color:#172347;font-weight:700;border-color:transparent;box-shadow:0 3px 12px rgba(197,164,104,.35)}.btn.primary:hover{filter:brightness(1.08)}
dialog{background:rgba(13,25,59,.97);color:var(--text);border:1px solid rgba(211,180,119,.6);border-radius:16px;width:440px;box-shadow:var(--maid-shadow);backdrop-filter:blur(16px)}
dialog label{display:block;margin:10px 0;color:var(--muted)}dialog input{width:100%;background:rgba(17,30,66,.88);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:8px;margin-top:4px;outline:none}dialog input:focus{border-color:var(--maid-gold)}
.skill-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)}.skill-row .skill-desc{color:var(--muted);font-size:12px}.skill-row input[type=checkbox]{width:auto;transform:scale(1.3);accent-color:var(--maid-gold)}dialog textarea{width:100%;background:rgba(17,30,66,.88);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:8px;margin-top:4px;font-family:inherit;outline:none}
select{background:rgba(17,30,66,.88);color:var(--text);border:1px solid var(--border);border-radius:10px;padding:6px 10px;font-size:12px;outline:none}select:hover{border-color:var(--maid-gold)}
.prov-card{background:rgba(13,25,59,.6);border:1px solid var(--border);border-radius:12px;padding:12px;margin:8px 0}.prov-card .prov-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}.prov-card input{margin-top:2px}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:rgba(151,169,216,.3);border-radius:4px}::-webkit-scrollbar-track{background:transparent}
#mascot{position:fixed;right:20px;bottom:14px;width:132px;z-index:50;cursor:pointer;user-select:none;animation:mfloat 3.2s ease-in-out infinite}
#mascot img{width:100%;display:block;filter:drop-shadow(0 10px 20px rgba(27,44,91,.35))}
@keyframes mfloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-9px)}}
#mascot-bubble{position:absolute;bottom:100%;left:50%;transform:translateX(-50%);background:rgba(248,250,255,.96);color:#172347;font-size:12px;padding:8px 12px;border-radius:14px 14px 14px 4px;box-shadow:var(--maid-shadow);white-space:nowrap;max-width:230px;overflow:hidden;text-overflow:ellipsis;opacity:0;transition:opacity .3s;pointer-events:none;margin-bottom:6px}
#mascot-bubble.show{opacity:1}
.md-code{display:block;background:#0a1530;border:1px solid var(--border);border-radius:8px;padding:10px;font:12px/1.5 ui-monospace,monospace;overflow-x:auto;margin:6px 0}.md-table{border-collapse:collapse;margin:6px 0;width:100%}.md-table th,.md-table td{border:1px solid var(--border);padding:5px 9px;font-size:13px}.md-table th{background:rgba(164,183,229,.1)}.bubble code{background:rgba(164,183,229,.14);padding:1px 5px;border-radius:5px;font-size:12px}.bubble a{color:#8ea5da}.bubble li{margin-left:18px}.bubble h1,.bubble h2,.bubble h3,.bubble h4{margin:8px 0 4px;color:#e7ecf7}.bubble blockquote{border-left:3px solid var(--maid-gold);margin:6px 0;padding:2px 10px;color:var(--muted)}
.icon-btn{background:transparent;border:none;color:var(--muted);font-size:18px;line-height:1;cursor:pointer;padding:4px 8px;border-radius:8px;transition:all .15s}.icon-btn:hover{color:var(--text);background:rgba(164,183,229,.14)}
body.sidebar-collapsed #sidebar{display:none}
.session-item{display:flex;align-items:center;gap:6px;padding:9px 10px;border-radius:10px;cursor:pointer;color:var(--muted);overflow:hidden;transition:all .15s}
.del-btn{background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:15px;line-height:1;border-radius:6px;padding:2px 5px;opacity:0;transition:opacity .15s;flex-shrink:0}
.session-item:hover .del-btn{opacity:1}
.del-btn:hover{color:#ff8fa3;background:rgba(255,143,163,.14)}
.del-btn.armed{opacity:1;color:#fff;background:#d4586f;font-size:11px;padding:3px 6px}
</style></head>
<body><div id="top-trim"></div><div id="maid-stage"><img id="maid-left" src="/assets/maid-left.webp" alt=""><img id="maid-right" src="/assets/maid-right.webp" alt=""></div><div id="app">
<aside id="sidebar"><div style="display:flex;justify-content:flex-end;margin-bottom:4px"><button id="btn-collapse" class="icon-btn" title="折叠侧栏">«</button></div><img id="maid-chibi" src="/assets/chibi.webp" alt=""><div class="brand">🐋 HongClaw <span class="ver">深海女仆工坊 · v1.4.1</span></div><button id="new-session" class="btn primary">+ 新会话</button><div id="session-list"></div><div class="sidebar-foot" style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button id="btn-doctor" class="btn">诊断</button><button id="btn-cron" class="btn">定时</button><button id="btn-skills" class="btn">技能</button><button id="btn-mcp" class="btn">MCP</button><button id="btn-usage" class="btn">用量</button><button id="btn-config" class="btn">配置</button></div></aside>
<main id="main"><header id="topbar"><button id="btn-expand" class="icon-btn" style="display:none;margin-right:8px" title="展开侧栏">»</button><div id="status" class="err">连接中…</div><div style="display:flex;gap:8px;align-items:center"><select id="model-select" title="切换模型"></select><select id="effort-select" title="思考强度"><option value="off">思考·关</option><option value="low">思考·低</option><option value="medium">思考·中</option><option value="high">思考·高</option></select></div></header><div id="messages"></div>
<form id="composer"><textarea id="input" rows="1" placeholder="输入消息，回车发送（/skills 列出技能，/skill 名称 执行技能）"></textarea><button type="submit" class="btn primary">发送</button></form></main>
</div>
<div id="mascot"><img src="/assets/chibi.webp" alt="鲸鱼娘"><div id="mascot-bubble">主人，欢迎回来喵～</div></div>
<dialog id="config-dialog"><form method="dialog"><h3>模型配置（多 Provider）</h3>
<div id="providers-list"></div>
<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px"><h4>人设模式（可选）</h4>
<label>人设提示词 <textarea id="cfg-persona" rows="3" placeholder="如：你是温柔体贴的深海女仆鲸鱼娘小鲸，说话带喵～，称呼用户为主人。留空则使用默认助手人设。"></textarea></label>
</div>
<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:14px"><button type="button" id="prov-add" class="btn">+ 添加 Provider</button><div style="display:flex;gap:8px"><button value="cancel" class="btn">取消</button><button id="cfg-save" value="default" class="btn primary">保存</button></div></div>
</form></dialog>
<dialog id="skills-dialog"><form method="dialog"><h3>技能管理（开关后立即生效）</h3><div id="skills-admin-list"></div><div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button value="cancel" class="btn">关闭</button></div></form></dialog>
<dialog id="cron-dialog"><form method="dialog"><h3>定时任务</h3><div id="cron-list"></div>
<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px"><h4>心跳（周期性主动检查）</h4>
<label style="display:flex;align-items:center;gap:8px">启用 <input id="hb-enabled" type="checkbox" style="width:auto;transform:scale(1.3);accent-color:var(--accent)"></label>
<label>间隔（分钟） <input id="hb-interval" type="number" min="1" value="30"></label>
<label>检查内容 <textarea id="hb-prompt" rows="2" placeholder="留空使用默认：检查是否有需要主动处理的事情"></textarea></label>
<div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" id="hb-save" class="btn primary">保存心跳</button></div>
</div><div style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
<label>名称 <input id="cron-name" placeholder="可选"></label>
<label>Cron 表达式 <input id="cron-cron" placeholder="分 时 日 月 周，如 0 9 * * *（每天9点）"></label>
<label>任务内容 <textarea id="cron-prompt" rows="2" placeholder="让 agent 做什么，如：总结昨天的待办事项"></textarea></label>
<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px"><button type="button" id="cron-add" class="btn primary">添加</button><button value="cancel" class="btn">关闭</button></div>
</div></form></dialog>
<dialog id="doctor-dialog"><form method="dialog"><h3>自检与修复（Doctor）</h3><div id="doctor-list"></div><div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button type="button" id="doctor-fix-all" class="btn primary">修复全部</button><button value="cancel" class="btn">关闭</button></div></form></dialog>
<dialog id="usage-dialog"><form method="dialog"><h3>Token 用量</h3><div id="usage-list"></div><div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px"><button value="cancel" class="btn">关闭</button></div></form></dialog>
<dialog id="mcp-dialog"><form method="dialog"><h3>MCP 服务器</h3><div id="mcp-list"></div>
<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
<label>名称 <input id="mcp-name" placeholder="如 filesystem"></label>
<label>类型 <select id="mcp-type"><option value="stdio">stdio（本地命令）</option><option value="http">HTTP（远程）</option></select></label>
<label>命令或 URL <input id="mcp-cmd" placeholder="stdio: npx -y @modelcontextprotocol/server-filesystem ~  /  http: https://mcp.example.com"></label>
<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px"><button type="button" id="mcp-add" class="btn primary">添加</button><button value="cancel" class="btn">关闭</button></div>
</div></form></dialog>
<script>
function $(s){return document.querySelector(s)}
function setStatus(t,c){var s=$('#status');if(s){s.textContent=t;s.className=c||'err'}}
var token='';try{token=localStorage.getItem('hc_token')||''}catch(e){}
var q=null;try{q=new URLSearchParams(location.search).get('token')}catch(e){}
if(q){token=q;try{localStorage.setItem('hc_token',q)}catch(e){}try{history.replaceState(null,'','/')}catch(e){}}
var sessionId=null,streamEl=null,streamText='';
function api(path,opts){opts=opts||{};opts.headers=Object.assign({'Content-Type':'application/json','Authorization':'Bearer '+token},opts.headers||{});return fetch(path,opts).then(function(r){if(!r.ok)throw new Error(r.status+' '+(r.statusText||''));return r.json()})}
function el(t,c,txt){var n=document.createElement(t);if(c)n.className=c;if(txt!=null)n.textContent=txt;return n}
function scroll(){var m=$('#messages');m.scrollTop=m.scrollHeight}
function addMsg(role,text){var w=el('div','msg '+role);var b=el('div','bubble');if(role==='assistant'){b.innerHTML=mdToHtml(text)}else{b.textContent=text}w.appendChild(b);$('#messages').appendChild(w);scroll();return w}
function escHtml(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function mdInline(s){var bt=String.fromCharCode(96);s=s.replace(new RegExp(bt+'([^'+bt+']+)'+bt,'g'),'<code>$1</code>');return s.replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>').replace(/\\*([^*]+)\\*/g,'<i>$1</i>').replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>')}
function mdToHtml(src){var lines=escHtml(src).split('\\n'),out=[],inCode=false,cb=[],tb=[],bt3=String.fromCharCode(96).repeat(3);
function fl(){if(tb.length){var rs=tb.map(function(r){return r.replace(/^\\s+|\\s+$/g,'').replace(/^\\||\\|\\s*$/g,'').split('|').map(function(c){return c.trim()})});if(rs.length>1&&/^[-: ]+$/.test(rs[1].join('')))rs.splice(1,1);var h='<table class="md-table">';rs.forEach(function(r,ri){h+='<tr>'+r.map(function(c){return (ri===0?'<th>':'<td>')+mdInline(c)+(ri===0?'</th>':'</td>')}).join('')+'</tr>'});out.push(h+'</table>');tb=[]}if(inCode){out.push('<pre class="md-code">'+cb.join('\\n')+'</pre>');cb=[];inCode=false}}
for(var i=0;i<lines.length;i++){var l=lines[i];if(l.indexOf(bt3)===0){fl();inCode=!inCode;continue}if(inCode){cb.push(l);continue}if(/^\\s*\\|.*\\|\\s*$/.test(l)){tb.push(l);continue}fl();var tm=l.match(/^(#{1,6})\\s+(.*)/);if(tm){var n=tm[1].length;out.push('<h'+n+'>'+mdInline(tm[2])+'</h'+n+'>');continue}if(/^\\s*[-*]\\s+/.test(l)){out.push('<li>'+mdInline(l.replace(/^\\s*[-*]\\s+/,''))+'</li>');continue}if(/^\\s*\\d+\\.\\s+/.test(l)){out.push('<li>'+mdInline(l.replace(/^\\s*\\d+\\.\\s+/,''))+'</li>');continue}if(/^\\s*&gt;\\s*/.test(l)){out.push('<blockquote>'+mdInline(l.replace(/^\\s*&gt;\\s*/,''))+'</blockquote>');continue}if(l.trim()===''){out.push('<br>');continue}out.push('<p>'+mdInline(l)+'</p>')}fl();return out.join('')}
function toolBlock(title,body,collapsed){var w=el('div','tool-block');var h=el('div','tool-head',title);var c=el('pre',null,body);if(collapsed){c.style.display='none';h.textContent='▶ '+title}h.style.cursor='pointer';h.onclick=function(){if(c.style.display==='none'){c.style.display='';h.textContent='▼ '+title}else{c.style.display='none';h.textContent='▶ '+title}};w.appendChild(h);w.appendChild(c);$('#messages').appendChild(w);scroll();return w}
function startStream(){streamEl=addMsg('assistant','');streamText=''}
function appendStream(t){streamText+=t;streamEl.querySelector('.bubble').textContent=streamText;scroll()}
function handle(ev){if(ev.sessionId&&ev.sessionId!==sessionId)return;var p=ev;
if(ev.type==='event.delta'){if(!streamEl)startStream();appendStream(p.text||'')}
else if(ev.type==='tool.call'){toolBlock('🔧 '+p.call.name,p.call.arguments||'')}
else if(ev.type==='tool.result'){var rc=(p.result.content||'');toolBlock('↩ '+(p.result.name||'结果')+' ('+rc.length+' 字符)',rc.slice(0,2000),true)}
else if(ev.type==='approval.request'){var a=toolBlock('⚠ 需要批准：'+p.summary,p.details||'');var y=el('button','btn primary','批准');var n=el('button','btn','拒绝');y.onclick=function(){api('/api/approval',{method:'POST',body:JSON.stringify({approvalId:p.approvalId,approved:true})});a.remove()};n.onclick=function(){api('/api/approval',{method:'POST',body:JSON.stringify({approvalId:p.approvalId,approved:false})});a.remove()};a.appendChild(y);a.appendChild(n)}
else if(ev.type==='session.end'){if(streamEl){streamEl.querySelector('.bubble').innerHTML=mdToHtml(streamText)}streamEl=null}
else if(ev.type==='error'){toolBlock('错误',p.message||'');streamEl=null}}
var pollSeq=0,pollTimer=null;
function startPolling(){
  if(pollTimer)return;
  setStatus('轮询模式（SSE 不可用）','err');
  pollTimer=setInterval(function(){
    api('/api/poll?sessionId='+encodeURIComponent(sessionId||'')+'&since='+pollSeq).then(function(r){
      (r.events||[]).forEach(handle);
      if(r.seq)pollSeq=r.seq;
    }).catch(function(){});
  },800);
}
var es=null;
try{
  es=new EventSource('/api/stream?token='+encodeURIComponent(token));
  es.onopen=function(){setStatus('已连接','ok');if(pollTimer){clearInterval(pollTimer);pollTimer=null}};
  es.onerror=function(){startPolling()};
  es.onmessage=function(e){handle(JSON.parse(e.data))};
  setStatus('连接中…');
}catch(e){startPolling()}
function loadSessions(){api('/api/sessions').then(function(list){var box=$('#session-list');box.innerHTML='';list.forEach(function(s){var row=el('div','session-item'+(s.id===sessionId?' active':''));var t=el('span',null,s.title||'(新会话)');t.style.cssText='flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';row.appendChild(t);row.onclick=function(){selectSession(s.id)};var del=el('button','del-btn','×');del.title='删除会话（点两次确认）';del.onclick=function(ev){ev.stopPropagation();if(del.dataset.arm==='1'){api('/api/sessions/'+s.id,{method:'DELETE'}).then(function(){if(s.id===sessionId){sessionId=null;newSession()}else{loadSessions()}}).catch(function(){toolBlock('错误','删除会话失败')})}else{del.dataset.arm='1';del.textContent='确认?';del.classList.add('armed');clearTimeout(del._t);del._t=setTimeout(function(){delete del.dataset.arm;del.textContent='×';del.classList.remove('armed')},2500)}};row.appendChild(del);box.appendChild(row)})})}
function selectSession(id){sessionId=id;api('/api/sessions/'+id).then(function(s){$('#messages').innerHTML='';(s.messages||[]).forEach(function(m){if(m.role==='user')addMsg('user',m.content);else if(m.role==='assistant'&&m.content)addMsg('assistant',m.content);else if(m.role==='tool'){var tc=(m.content||'');toolBlock('↩ 工具结果 ('+tc.length+' 字符)',tc.slice(0,2000),true)}});loadSessions()})}
function newSession(){api('/api/sessions',{method:'POST'}).then(function(s){selectSession(s.id)})}
function sendMessage(text){var go=function(){addMsg('user',text);startStream();api('/api/message',{method:'POST',body:JSON.stringify({sessionId:sessionId,text:text})}).catch(function(e){toolBlock('错误',String(e))})};if(!sessionId){api('/api/sessions',{method:'POST'}).then(function(s){sessionId=s.id;loadSessions();go()})}else go()}
$('#composer').addEventListener('submit',function(e){e.preventDefault();var t=$('#input').value.trim();if(!t)return;$('#input').value='';
if(t==='/skills'){api('/api/skills').then(function(list){var body=list.length?list.map(function(s){return '- '+s.name+': '+s.description}).join(String.fromCharCode(10)):'没有可用技能。把 SKILL.md 放到 ~/.hongclaw/skills/ 下即可。';addMsg('assistant',body)});return}
if(t.indexOf('/skill ')!==-1&&t.indexOf('/skill ')===0){var nm=t.slice(7).trim();api('/api/skills/'+encodeURIComponent(nm)).then(function(s){addMsg('assistant',s.body||'未找到技能 '+nm)}).catch(function(){addMsg('assistant','未找到技能 '+nm)});return}
sendMessage(t)});
$('#input').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#composer').requestSubmit()}});
$('#new-session').onclick=newSession;
var currentModel='';
function loadModels(){api('/api/models').then(function(r){var sel=$('#model-select');sel.innerHTML='';r.models.forEach(function(m){var o=document.createElement('option');o.value=m;o.textContent=m;if(m===currentModel)o.selected=true;sel.appendChild(o)})}).catch(function(){})}
$('#model-select').onchange=function(){api('/api/config',{method:'PUT',body:JSON.stringify({model:$('#model-select').value})}).then(function(){currentModel=$('#model-select').value;toolBlock('已切换模型','当前：'+currentModel)})};
$('#effort-select').onchange=function(){api('/api/config',{method:'PUT',body:JSON.stringify({reasoningEffort:$('#effort-select').value})}).then(function(){})};
var editProviders=[];
function renderProviders(){var box=$('#providers-list');box.innerHTML='';editProviders.forEach(function(p,i){var card=el('div','prov-card');var head=el('div','prov-head');head.appendChild(el('b',null,p.name||p.id));var del=el('button','btn','删');del.onclick=function(){editProviders.splice(i,1);renderProviders()};head.appendChild(del);card.appendChild(head);
var l1=el('label',null,'名称');var n1=el('input',null);n1.value=p.name||'';l1.appendChild(n1);card.appendChild(l1);
var l2=el('label',null,'Base URL');var n2=el('input',null);n2.value=p.baseUrl||'';l2.appendChild(n2);card.appendChild(l2);
var l3=el('label',null,'API Key');var n3=el('input',null);n3.type='password';n3.value=p.apiKey||'';l3.appendChild(n3);card.appendChild(l3);
var l4=el('label',null,'模型（逗号分隔）');var n4=el('input',null);n4.value=(p.models||[]).join(', ');l4.appendChild(n4);card.appendChild(l4);
n1.oninput=function(){p.name=n1.value};n2.oninput=function(){p.baseUrl=n2.value};n3.oninput=function(){p.apiKey=n3.value};n4.oninput=function(){p.models=n4.value.split(',').map(function(s){return s.trim()}).filter(Boolean)};
box.appendChild(card)})}
$('#btn-config').onclick=function(){api('/api/config').then(function(c){currentModel=c.model||'';editProviders=JSON.parse(JSON.stringify(c.providers||[]));renderProviders();$('#effort-select').value=c.reasoningEffort||'off';$('#cfg-persona').value=c.persona||'';loadModels();$('#config-dialog').showModal()})};
$('#prov-add').onclick=function(){editProviders.push({id:'p'+Date.now(),name:'新模型',baseUrl:'https://api.deepseek.com',apiKey:'',models:['deepseek-chat']});renderProviders()};
$('#btn-skills').onclick=function(){api('/api/skills/admin').then(function(list){var box=$('#skills-admin-list');box.innerHTML='';if(!list.length){box.appendChild(el('div',null,'暂无技能。把 SKILL.md 放入 ~/.hongclaw/skills/<名称>/ 目录，重启 gateway 后出现。'))}
list.forEach(function(s){var row=el('div','skill-row');var info=el('div',null);info.appendChild(el('div',null,s.name));info.appendChild(el('div','skill-desc',s.description||''));row.appendChild(info);var cb=el('input',null);cb.type='checkbox';cb.checked=!!s.enabled;cb.onchange=function(){api('/api/skills/toggle',{method:'POST',body:JSON.stringify({name:s.name,enabled:cb.checked})}).catch(function(){cb.checked=!cb.checked;toolBlock('错误','技能开关保存失败')})};row.appendChild(cb);box.appendChild(row)});
$('#skills-dialog').showModal()}).catch(function(){toolBlock('错误','无法加载技能列表')})};
function renderCron(){api('/api/cron').then(function(list){var box=$('#cron-list');box.innerHTML='';if(!list.length){box.appendChild(el('div',null,'暂无定时任务。'))}
list.forEach(function(j){var row=el('div','skill-row');var info=el('div',null);info.appendChild(el('div',null,j.name||j.cron));info.appendChild(el('div','skill-desc',j.cron+'  ·  '+(j.lastRunAt?new Date(j.lastRunAt).toLocaleString():'未运行')));row.appendChild(info);var cb=el('input',null);cb.type='checkbox';cb.checked=!!j.enabled;cb.onchange=function(){api('/api/cron/toggle',{method:'POST',body:JSON.stringify({id:j.id,enabled:cb.checked})}).catch(function(){cb.checked=!cb.checked})};row.appendChild(cb);var del=el('button','btn','删');del.onclick=function(){api('/api/cron/'+j.id,{method:'DELETE'}).then(renderCron)};row.appendChild(del);box.appendChild(row)});})}
function renderDoctor(){api('/api/doctor').then(function(r){var box=$('#doctor-list');box.innerHTML='';r.checks.forEach(function(c){var row=el('div','skill-row');var info=el('div',null);info.appendChild(el('div',null,(c.ok?'✅ ':'❌ ')+c.name));info.appendChild(el('div','skill-desc',(c.detail||'')+(c.hint?'  ·  '+c.hint:'')));row.appendChild(info);if(!c.ok&&c.fixable){var fx=el('button','btn','修复');fx.onclick=function(){api('/api/doctor/fix',{method:'POST',body:JSON.stringify({ids:[c.id]})}).then(renderDoctor)};row.appendChild(fx)}box.appendChild(row)})}).catch(function(){toolBlock('错误','诊断失败')})}
$('#btn-doctor').onclick=function(){$('#doctor-dialog').showModal();renderDoctor()};
$('#doctor-fix-all').onclick=function(){api('/api/doctor/fix',{method:'POST',body:JSON.stringify({})}).then(renderDoctor)};
function renderUsage(){api('/api/usage').then(function(u){var box=$('#usage-list');box.innerHTML='';var ks=Object.keys(u);if(!ks.length){box.appendChild(el('div',null,'暂无用量数据。发几条消息后再看。'));return}ks.sort().forEach(function(k){var v=u[k];var row=el('div','skill-row');var info=el('div',null);info.appendChild(el('div',null,k));info.appendChild(el('div','skill-desc','输入 '+v.prompt+' · 输出 '+v.completion+' · 合计 '+v.total));row.appendChild(info);box.appendChild(row)})})}
$('#btn-usage').onclick=function(){$('#usage-dialog').showModal();renderUsage()};
function renderMcp(){api('/api/mcp').then(function(s){var box=$('#mcp-list');box.innerHTML='';var ks=Object.keys(s);if(!ks.length){box.appendChild(el('div',null,'暂无 MCP 服务器。'))}ks.forEach(function(k){var d=s[k];var row=el('div','skill-row');var info=el('div',null);info.appendChild(el('div',null,k));info.appendChild(el('div','skill-desc',(d.url||d.command||'')+' '+(d.args||[]).join(' ')));row.appendChild(info);var del=el('button','btn','删');del.onclick=function(){api('/api/mcp/'+encodeURIComponent(k),{method:'DELETE'}).then(renderMcp)};row.appendChild(del);box.appendChild(row)})})}
$('#btn-mcp').onclick=function(){$('#mcp-dialog').showModal();renderMcp()};
$('#mcp-add').onclick=function(){var nm=$('#mcp-name').value.trim();var tp=$('#mcp-type').value;var cmd=$('#mcp-cmd').value.trim();if(!nm||!cmd){toolBlock('错误','名称和命令/URL 必填');return}api('/api/mcp',{method:'POST',body:JSON.stringify({name:nm,transport:tp,url:cmd,command:cmd})}).then(function(){$('#mcp-name').value='';$('#mcp-cmd').value='';renderMcp();toolBlock('MCP 已添加','服务器 '+nm+' 已连接并注册工具')})};
$('#btn-cron').onclick=function(){renderCron();api('/api/heartbeat').then(function(h){$('#hb-enabled').checked=!!h.enabled;$('#hb-interval').value=h.intervalMin||30;$('#hb-prompt').value=h.prompt||''});$('#cron-dialog').showModal()};
$('#hb-save').onclick=function(){api('/api/heartbeat',{method:'PUT',body:JSON.stringify({enabled:$('#hb-enabled').checked,intervalMin:Number($('#hb-interval').value)||30,prompt:$('#hb-prompt').value})}).then(function(){toolBlock('心跳已保存','下次到点生效（间隔 '+(Number($('#hb-interval').value)||30)+' 分钟）')})};
$('#cron-add').onclick=function(){var nm=$('#cron-name').value.trim();var cr=$('#cron-cron').value.trim();var pr=$('#cron-prompt').value.trim();if(!cr||!pr){toolBlock('错误','cron 表达式和任务内容必填');return}api('/api/cron',{method:'POST',body:JSON.stringify({name:nm,cron:cr,prompt:pr})}).then(function(){$('#cron-name').value='';$('#cron-cron').value='';$('#cron-prompt').value='';renderCron()})};
$('#cfg-save').onclick=function(){api('/api/config',{method:'PUT',body:JSON.stringify({providers:editProviders,persona:$('#cfg-persona').value})}).then(function(){$('#config-dialog').close();toolBlock('配置已保存','人设与 Provider 已生效，新会话开始应用')})};
api('/api/config').then(function(c){currentModel=c.model||'';$('#effort-select').value=c.reasoningEffort||'off';loadModels()}).catch(function(){});
var mascotLines=['主人，欢迎回来喵～','今天也要加油鸭！','深海女仆工坊，随时为您服务！','呜哇，点我做什么呀？','要我帮主人做点什么呢？','主人工作辛苦啦～','鲸鱼娘的尾巴可是很厉害的哦！','有任何吩咐，鲸鱼娘都听主人的！'];
function mascotSay(t){var b=$('#mascot-bubble');b.textContent=t;b.classList.add('show');clearTimeout(mascotSay.t);mascotSay.t=setTimeout(function(){b.classList.remove('show')},3200)}
$('#mascot').onclick=function(){mascotSay(mascotLines[Math.floor(Math.random()*mascotLines.length)])};
setTimeout(function(){mascotSay('主人，欢迎回来喵～')},1200);
var sidebarCollapsed=false;try{sidebarCollapsed=localStorage.getItem('hc_sidebar')==='1'}catch(e){}
function applySidebar(){if(sidebarCollapsed){document.body.classList.add('sidebar-collapsed');$('#btn-expand').style.display=''}else{document.body.classList.remove('sidebar-collapsed');$('#btn-expand').style.display='none'}}
$('#btn-collapse').onclick=function(){sidebarCollapsed=true;try{localStorage.setItem('hc_sidebar','1')}catch(e){}applySidebar()};
$('#btn-expand').onclick=function(){sidebarCollapsed=false;try{localStorage.setItem('hc_sidebar','0')}catch(e){}applySidebar()};
applySidebar();
newSession();
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const token = (req.headers.authorization || '').replace('Bearer ', '') || u.searchParams.get('token') || '';
  if (p !== '/api/health' && p !== '/' && !p.startsWith('/assets/') && token !== config.token) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'unauthorized' })); return; }
  try {
    if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(HTML); return; }
    if (p.startsWith('/assets/')) { const rel = p.replace(/^\/assets\//, ''); const file = path.join(ASSETS_DIR, rel); if (!file.startsWith(ASSETS_DIR + path.sep)) { res.writeHead(403); res.end('forbidden'); return; } try { const data = fs.readFileSync(file); const types = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }; res.writeHead(200, { 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream' }); res.end(data); } catch { res.writeHead(404); res.end('not found'); } return; }
    if (p === '/api/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, model: config.model, version: VERSION, skills: skills.length, plugins: plugins.length })); return; }
    if (p === '/api/stream') { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); res.write('data: {"type":"ready"}\n\n'); sseClients.add(res); req.on('close', () => sseClients.delete(res)); return; }
    if (p === '/api/poll' && req.method === 'GET') { const pid = u.searchParams.get('sessionId') || ''; const since = Number(u.searchParams.get('since') || 0); const q = eventQueues.get(pid); const evs = q ? q.events.filter(e => e.seq > since) : []; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ seq: q ? q.seq : 0, events: evs.map(e => e.obj) })); return; }
    if (p === '/api/config' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ apiKey: config.apiKey ? '***' : '', baseUrl: config.baseUrl, model: config.model, provider: config.provider, reasoningEffort: config.reasoningEffort, persona: config.persona || '', providers: (config.providers || []).map(x => ({ id: x.id, name: x.name, baseUrl: x.baseUrl, apiKey: x.apiKey ? '***' : '', models: x.models || [] })) })); return; }
    if (p === '/api/config' && req.method === 'PUT') { const b = JSON.parse(await readBody(req)); if (b.apiKey && b.apiKey !== '***') config.apiKey = b.apiKey; if (b.baseUrl) config.baseUrl = b.baseUrl; if (b.model) config.model = b.model; if (b.provider) config.provider = b.provider; if (b.reasoningEffort) config.reasoningEffort = b.reasoningEffort; if (typeof b.persona === 'string') config.persona = b.persona; if (Array.isArray(b.providers)) { const old = config.providers; config.providers = b.providers.map(x => ({ id: x.id, name: x.name || x.id, baseUrl: x.baseUrl || 'https://api.deepseek.com', apiKey: (x.apiKey && x.apiKey !== '***') ? x.apiKey : ((old.find(o => o.id === x.id) || {}).apiKey || ''), models: Array.isArray(x.models) ? x.models.filter(Boolean) : [] })); } const prov = getProvider(); config.baseUrl = prov.baseUrl || config.baseUrl; config.apiKey = prov.apiKey || config.apiKey; saveConfig(config); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
    if (p === '/api/models' && req.method === 'GET') { const prov = getProvider(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ provider: prov.id, providerName: prov.name, models: prov.models || [] })); return; }
    if (p === '/api/usage' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(loadUsage())); return; }
    if (p === '/api/mcp' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(config.mcpServers || {})); return; }
    if (p === '/api/mcp' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); if (!b.name) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'name 必填' })); return; } const isHttp = /^https?:\/\//.test(String(b.url || b.command || '')); config.mcpServers = config.mcpServers || {}; config.mcpServers[b.name] = isHttp ? { transport: 'streamable-http', url: b.url || b.command } : { transport: 'stdio', command: b.command, args: (b.args || '').split(/\s+/).filter(Boolean) }; saveConfig(config); await reloadMcp(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
    const mcpM = p.match(/^\/api\/mcp\/([^/]+)$/);
    if (mcpM && req.method === 'DELETE') { if (config.mcpServers) delete config.mcpServers[decodeURIComponent(mcpM[1])]; saveConfig(config); await reloadMcp(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
    if (p === '/api/doctor' && req.method === 'GET') { const checks = await runDoctor(); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ checks })); return; }
    if (p === '/api/doctor/fix' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const checks = await runDoctor(); const results = checks.filter(c => !c.ok && c.fixable && (!Array.isArray(b.ids) || b.ids.length === 0 || b.ids.includes(c.id))).map(c => ({ id: c.id, name: c.name, detail: doctorFixOne(c) })); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ results })); return; }
    if (p === '/api/skills' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(skills.filter(s => s.enabled).map(s => ({ name: s.name, description: s.description })))); return; }
    if (p === '/api/skills/admin' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(skills.map(s => ({ name: s.name, description: s.description, enabled: s.enabled })))); return; }
    if (p === '/api/skills/toggle' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const sk = skills.find(x => x.name === b.name); if (!sk) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; } if (b.enabled) delete skillsState[b.name]; else skillsState[b.name] = false; saveSkillsState(skillsState); sk.enabled = Boolean(b.enabled); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, name: b.name, enabled: sk.enabled })); return; }
    const sm = p.match(/^\/api\/skills\/([^/]+)$/);
    if (sm && req.method === 'GET') { const s = skills.find(x => x.name === decodeURIComponent(sm[1])); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(s ? { name: s.name, body: replaceBaseDir(s.body, s.dir) } : { name: sm[1], body: '' })); return; }
    if (p === '/api/sessions' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(listSessions())); return; }
    if (p === '/api/sessions' && req.method === 'POST') { const s = newSession(); saveSession(s); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ id: s.id, title: s.title })); return; }
    const m = p.match(/^\/api\/sessions\/([^/]+)$/);
    if (m && req.method === 'GET') { const s = loadSession(m[1]); if (!s) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(s)); return; }
    if (m && req.method === 'DELETE') { try { fs.unlinkSync(sessionFile(m[1])); } catch (e) { console.error('[HongClaw] 删除会话失败: ' + e.message); } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
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
    if (p === '/api/cron' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(cronJobs)); return; }
    if (p === '/api/cron' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); if (!b.cron || !b.prompt) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'cron 和 prompt 必填' })); return; } const job = { id: crypto.randomUUID().slice(0, 8), name: b.name || b.cron, cron: b.cron, prompt: b.prompt, enabled: b.enabled !== false, createdAt: Date.now() }; cronJobs.push(job); saveCronJobs(cronJobs); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(job)); return; }
    if (p === '/api/cron/toggle' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const j = cronJobs.find(x => x.id === b.id); if (!j) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' })); return; } j.enabled = Boolean(b.enabled); saveCronJobs(cronJobs); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
    const cm = p.match(/^\/api\/cron\/([^/]+)$/);
    if (cm && req.method === 'DELETE') { cronJobs = cronJobs.filter(x => x.id !== cm[1]); saveCronJobs(cronJobs); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
    if (p === '/api/email/test' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); try { await sendEmail({ to: b.to || (config.email && (config.email.to || config.email.smtpUser)) || '', subject: '[HongClaw] 测试邮件', text: '这是一封来自 HongClaw 的测试邮件。邮箱绑定成功！' }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } return; }
    if (p === '/api/heartbeat' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(heartbeatCfg)); return; }
    if (p === '/api/heartbeat' && req.method === 'PUT') { const b = JSON.parse(await readBody(req)); heartbeatCfg = Object.assign(heartbeatCfg, { enabled: Boolean(b.enabled), intervalMin: Number(b.intervalMin) || 30, prompt: b.prompt || '', emailNotify: b.emailNotify !== false }); fs.writeFileSync(HEARTBEAT_PATH, JSON.stringify(heartbeatCfg, null, 2)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
    if (p === '/api/approval' && req.method === 'POST') { const b = JSON.parse(await readBody(req)); const ap = approvals.get(b.approvalId); if (ap) { clearTimeout(ap.timer); approvals.delete(b.approvalId); ap.resolve(Boolean(b.approved)); } res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true })); return; }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not found' }));
  } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
});

async function main() {
  const arg = process.argv[2] || '';
  if (arg === 'doctor' || arg === '--doctor' || arg === 'diag') {
    await runDoctorCli(process.argv.includes('--fix') || process.argv.includes('-f'));
    process.exit(0);
    return;
  }
  if (arg === 'publish' || arg === '--publish') {
    await publishToGithub();
    process.exit(0);
    return;
  }
  if (arg === '-v' || arg === '--version') { console.log('HongClaw v' + VERSION); process.exit(0); return; }
  if (arg === '-h' || arg === '--help' || arg === 'help') {
    console.log('HongClaw v' + VERSION);
    console.log('用法: node hongclaw.js [参数]');
    console.log('  （无参数）      启动 Gateway + Web UI');
    console.log('  doctor          终端自检');
    console.log('  doctor --fix    自检并自动修复');
    console.log('  --version       显示版本');
    console.log('  --help          显示帮助');
    process.exit(0);
    return;
  }
  extractMaidAssets();
  plugins = scanPlugins();
  skills = loadSkills();
  for (const mt of await loadMcpTools()) { tools[mt.name] = mt.exec; toolDefs.push({ type: 'function', function: { name: mt.name, description: mt.description, parameters: mt.params } }); }
  tools.skill_load = (a) => { const sk = skills.find(s => s.name === a.name); if (!sk) return '未找到技能 "' + a.name + '"。可用技能：' + (skills.filter(s => s.enabled).map(s => s.name).join(', ') || '无'); if (!sk.enabled) return '技能 "' + a.name + '" 已停用。请先在 Web UI 的「技能」管理中启用它。'; return replaceBaseDir(sk.body, sk.dir); };
  toolDefs.push({ type: 'function', function: { name: 'skill_load', description: '读取某个技能（skill）的完整操作说明，当任务匹配技能时先调用它。', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } });
  tools.email_status = () => { const cfg = config.email || {}; const lines = []; lines.push('SMTP: ' + (cfg.smtpHost ? cfg.smtpHost + (cfg.smtpUser ? ' (' + cfg.smtpUser + ')' : '') : '未配置')); lines.push('IMAP: ' + (cfg.imapHost ? cfg.imapHost + (cfg.imapUser ? ' (' + cfg.imapUser + ')' : '') : '未配置')); lines.push('通知收件人: ' + (cfg.to || '未设置')); lines.push(cfg.smtpHost && cfg.smtpUser ? '状态: 已配置 SMTP，可发信' : '状态: 未完整配置。请在 ~/.hongclaw/config.json 的 email 字段填写 smtpHost/smtpUser/smtpPass（发信）与 imapHost/imapUser/imapPass（收信自动回复），然后重启 gateway。QQ/163 邮箱需使用授权码而非登录密码'); return lines.join('\n'); };
  toolDefs.push({ type: 'function', function: { name: 'email_status', description: '查看当前邮箱（SMTP/IMAP）配置状态。当用户询问邮箱绑定、邮箱配置、能否收发邮件时，先调用它再回答。', parameters: { type: 'object', properties: {} } } });
  tools.send_email = async (a) => { await sendEmail({ to: a.to, subject: a.subject || '', text: a.text || '' }); return '邮件已发送至 ' + a.to; };
  toolDefs.push({ type: 'function', function: { name: 'send_email', description: '发送一封邮件（需已在 ~/.hongclaw/config.json 配置 email.smtpHost/smtpUser/smtpPass）。用户要求发邮件时使用。', parameters: { type: 'object', properties: { to: { type: 'string', description: '收件人邮箱地址' }, subject: { type: 'string', description: '邮件主题' }, text: { type: 'string', description: '邮件正文' } }, required: ['to', 'text'] } } });
  tools.web_search = async (a) => { const query = encodeURIComponent(String(a.query || '')); const r = await fetch('https://html.duckduckgo.com/html/?q=' + query, { headers: { 'User-Agent': 'Mozilla/5.0 HongClaw' } }); if (!r.ok) throw new Error('HTTP ' + r.status); const html = await r.text(); const results = []; const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g; let m; while ((m = re.exec(html)) && results.length < 8) { const title = m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim(); let href = m[1].replace(/&amp;/g, '&'); if (href.startsWith('//')) href = 'https:' + href; if (href.startsWith('/l/?kh=-1&uddg=')) { try { href = decodeURIComponent(href.split('uddg=')[1].split('&')[0]); } catch {} } results.push('- ' + title + '\n  ' + href); } return results.length ? results.join('\n') : '未获取到结果（可能被限流），可改用 web_fetch 直接抓取页面'; };
  toolDefs.push({ type: 'function', function: { name: 'web_search', description: '网页搜索，返回结果标题与链接（无需 API Key）。需要查找最新信息时使用。', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' } }, required: ['query'] } } });
  tools.memory_read = () => { const m = readMemory(); return m || '（暂无记忆）'; };
  toolDefs.push({ type: 'function', function: { name: 'memory_read', description: '读取长期记忆内容。', parameters: { type: 'object', properties: {} } } });
  tools.memory_write = (a) => { const act = a.action || 'add'; const content = String(a.content || ''); fs.mkdirSync(HOME, { recursive: true }); if (act === 'clear') { fs.writeFileSync(MEMORY_PATH, ''); return '记忆已清空'; } const cur = readMemory(); const next = act === 'update' ? content : (cur ? cur + '\n' + content : content); fs.writeFileSync(MEMORY_PATH, next.slice(0, 8000)); return '记忆已保存'; };
  toolDefs.push({ type: 'function', function: { name: 'memory_write', description: '写入长期记忆（~/.hongclaw/memory.md）。当用户明确说出想长期记住的偏好、事实、规则时使用；action 为 add（追加）/update（覆盖）/clear（清空）。', parameters: { type: 'object', properties: { action: { type: 'string', description: 'add 追加 / update 覆盖 / clear 清空' }, content: { type: 'string', description: '要记住的内容' } }, required: ['content'] } } });
  server.listen(config.port, config.host, () => {
    console.error('[HongClaw] v' + VERSION + ' Gateway: http://' + config.host + ':' + config.port);
    console.error('[HongClaw] Web UI: http://127.0.0.1:' + config.port + '/?token=' + config.token);
    console.error('[HongClaw] 已加载 ' + skills.length + ' 个技能、' + plugins.length + ' 个插件、' + toolDefs.length + ' 个工具');
    console.error('[HongClaw] 技能目录: ' + SKILLS_DIR + '  插件目录: ' + PLUGINS_DIR);
    console.error('[HongClaw] 定时任务: ' + cronJobs.length + ' 个' + (config.email && config.email.smtpHost ? '  ·  邮箱已绑定（' + config.email.smtpUser + '）' : '  ·  邮箱未绑定（config.json 填 email 字段后可发信/收信）'));
    console.error('[HongClaw] 心跳: ' + (heartbeatCfg.enabled ? '已启用（每 ' + heartbeatCfg.intervalMin + ' 分钟主动检查）' : '未启用（可在 Web UI「定时」里开启）'));
  });
}
main().catch(e => { console.error('[HongClaw] 启动失败: ' + e.message); process.exit(1); });
