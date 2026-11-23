 const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  jidNormalizedUser,
  generateWAMessageFromContent,
  proto
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const SESSION_DIR = path.join(__dirname, 'auth_session');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const DB_FILE = path.join(SESSION_DIR, 'database.json');
const NOTES_DIR = path.join(SESSION_DIR, 'notes_storage');
const TEMP_DIR = path.join(__dirname, 'temp');
const PLUGINS_DIR = path.join(__dirname, 'plugins');
const PLUGIN_MEDIA_DIR = path.join(PLUGINS_DIR, 'media');
const PLUGIN_DATA_DIR = path.join(PLUGINS_DIR, 'data');
for (const d of [PLUGINS_DIR, PLUGIN_MEDIA_DIR, PLUGIN_DATA_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

let db = {
  ownerName: 'Oxc',
  prefix: '.',
  mode: 'public',
  groqApiKey: '',
  grokApiKey: '',
  autoAi: true,
  autoDelSeconds: 0,
  currency: 'IDR',
  defaultChannel: 'ochild bot ai Channel',
  anticall: false,
  antidelete: false,
  autostory: false,
  ghostmode: false,
  adbanner: true,
  fwdboost: true,
  aitag: false,
  quoteVerified: true,
  fakequoteText: '🪸 ochild bot ai',
    globalPresence: '',
  presenceChats: [],
  
  antilink: {},
  welcome: {},
  users: {},
  afk: {}
};


if (fs.existsSync(DB_FILE)) {
  try {
    db = Object.assign(db, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  } catch (e) {}
}

function saveDb() {
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (e) { console.error('[DB SAVE]', e.message); }
}

function getUser(jid) {
  const id = jidNormalizedUser(jid);
  if (!db.users[id]) {
    db.users[id] = { xp: 0, level: 1, limit: 9999 };
  }
  return db.users[id];
}

function addXp(jid, amount) {
  const user = getUser(jid);
  user.xp += amount;
  while (user.xp >= user.level * 100) user.level += 1;
  saveDb();
  return user;
}

function formatRuntime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}d ${h}h ${m}m`;
}

function getProgressBar(current, max) {
  const pct = Math.min(100, Math.floor((current / max) * 100));
  const filled = Math.round(pct / 10);
  return '■'.repeat(filled) + '□'.repeat(10 - filled) + ` ${pct}%`;
}

function extractMessageContent(msg) {
  if (!msg) return null;
  let m = msg;
  while (m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.viewOnceMessageV2Extension || m.documentWithCaptionMessage) {
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    else if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
    else if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message;
    else if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
  }
  return m;
}

function getMessageText(m) {
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    ''
  ).trim();
}

// Rolleys-style declarative JSON plugin helpers (no JS/eval/shell in plugin files).
const pluginMemory = new Map();
const pluginCooldowns = new Map();
const pluginSeen = new Set();
const safePluginId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
function pluginFile(id) { if (!safePluginId(id)) throw new Error('Plugin ID tidak valid.'); return path.join(PLUGINS_DIR, `${id}.json`); }
function listPlugins() { return fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.')).map(file => { try { return {file,plugin:JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR,file),'utf8'))}; } catch(e) { return {file,plugin:null,error:e.message}; } }).sort((a,b)=>String(a.plugin?.name||a.file).localeCompare(String(b.plugin?.name||b.file))); }
function savePlugin(plugin) { if(!plugin||!safePluginId(plugin.id)||!plugin.rules||typeof plugin.rules!=='object'||Array.isArray(plugin.rules)) throw new Error('JSON harus berisi id valid dan object rules.'); const target=pluginFile(plugin.id),tmp=target+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(plugin,null,2));fs.renameSync(tmp,target);return target; }
function pluginSafePath(root,relative) { const rel=String(relative||'').replace(/\\/g,'/'); if(rel==='' )return root; if(rel.startsWith('/')||rel.split('/').some(p=>p==='..'||p==='.'||p===''))throw new Error('Path plugin tidak aman.'); const resolved=path.resolve(root,rel),base=path.resolve(root);if(!resolved.startsWith(base+path.sep)&&resolved!==base)throw new Error('Path keluar folder plugin.');return resolved; }
function pluginResolveString(str,vars) { return String(str).replace(/\{([^{}]+)\}/g,(whole,key)=>{const bits=key.trim().split('|');let name=bits.shift(),v;const alias={chat:'chat',remoteJid:'chat',sender:'sender',senderJid:'senderJid',pushName:'pushName',text:'text',message:'text',body:'text',args:'args',command:'command',quotedText:'quotedText',quotedId:'quotedId',quotedSender:'quotedSender',time:'time',date:'date',isGroup:'isGroup',isOwner:'isOwner',isAdmin:'isAdmin',isBotAdmin:'isBotAdmin',messageType:'messageType',mediaType:'mediaType',hasMedia:'hasMedia',messageId:'messageId',item:'item',index:'index',number:'number',downloadError:'downloadError'}; if(alias[name])v=vars[alias[name]];else if(name==='random')v=Math.floor(Math.random()*100000);else if(name.startsWith('results.'))v=name.slice(8).split('.').reduce((o,p)=>o==null?undefined:o[p],vars.results);else if(name.startsWith('secret.'))v=vars.secrets?.[name.slice(7)];else v=name.split('.').reduce((o,p)=>o==null?undefined:o[p],vars.results);if(v==null)v='';for(const f of bits){if(f==='url')v=encodeURIComponent(String(v));else if(f==='json')v=JSON.stringify(v);else if(f==='upper')v=String(v).toUpperCase();else if(f==='lower')v=String(v).toLowerCase();else if(f==='trim')v=String(v).trim();else if(f==='number')v=Number(v)||0;}return typeof v==='object'?JSON.stringify(v):String(v);}).replace(/\{\{([^{}]+)\}\}/g,(w,k)=>{const v=String(k).trim().split('.').reduce((o,p)=>o==null?undefined:o[p],vars.results);return v==null?'':typeof v==='object'?JSON.stringify(v):String(v);}); }
function pluginResolve(value,vars) { if(typeof value==='string')return pluginResolveString(value,vars);if(Array.isArray(value))return value.map(v=>pluginResolve(v,vars));if(value&&typeof value==='object'){if(Object.keys(value).length===1&&value.$ref)return String(value.$ref).split('.').reduce((o,p)=>o==null?undefined:o[p],vars.results);if(Object.keys(value).length===1&&value.$template)return pluginResolveString(value.$template,vars);const o={};for(const [k,v]of Object.entries(value))o[k]=pluginResolve(v,vars);return o;}return value; }
function pluginRuleMatches(rule,v) { const text=String(v.text||'').trim(),low=text.toLowerCase(),conditions=[];if(rule.command||rule.cmd){const c=String(rule.command||rule.cmd).trim().toLowerCase();const yes=low===c||low.startsWith(c+' ');conditions.push(yes);if(yes)v.args=text.slice(c.length).trim();}if(rule.aliases)conditions.push((Array.isArray(rule.aliases)?rule.aliases:[rule.aliases]).some(c=>low===String(c).toLowerCase()||low.startsWith(String(c).toLowerCase()+' ')));if(rule.exact!==undefined)conditions.push(low===String(rule.exact).toLowerCase());if(rule.contains!==undefined)conditions.push(low.includes(String(rule.contains).toLowerCase()));if(rule.prefix!==undefined){const p=String(rule.prefix),yes=text.startsWith(p);conditions.push(yes);if(yes)v.args=text.slice(p.length).trim();}if(rule.regex!==undefined){try{const m=text.match(new RegExp(rule.regex,rule.ignoreCase===false?'':'i'));conditions.push(!!m);if(m?.length>1)v.args=m.at(-1)||'';}catch{return false;}}if(rule.always===true)conditions.push(true);const list=x=>Array.isArray(x)?x:String(x||'').split(',').map(s=>s.trim()).filter(Boolean);const types=rule.messageTypes||rule.messageType;if(types)conditions.push(list(types).map(x=>x.toLowerCase()).includes(String(v.messageType).toLowerCase()));const mt=rule.mediaTypes||rule.mediaType;if(mt)conditions.push(list(mt).map(x=>x.toLowerCase()).includes(String(v.mediaType).toLowerCase()));for(const k of ['hasMedia','isViewOnce','isEdited'])if(rule[k]!==undefined)conditions.push(Boolean(v[k])===Boolean(rule[k]));if(rule.reactionEmoji!==undefined)conditions.push(String(v.reactionEmoji||'')===String(rule.reactionEmoji));if(rule.buttonId!==undefined)conditions.push(String(v.buttonId||'')===String(rule.buttonId));const scope=String(rule.scope||rule.senderScope||'any').toLowerCase();if(['self','me','owner'].includes(scope))conditions.push(v.fromMe||v.isOwner);if(['others','public'].includes(scope))conditions.push(!v.fromMe&&!v.isOwner);if(rule.fromMe!==undefined)conditions.push(Boolean(v.fromMe)===Boolean(rule.fromMe));if(rule.isGroup===true||rule.groupOnly===true)conditions.push(v.isGroup);if(rule.isGroup===false||rule.dmOnly||rule.privateOnly)conditions.push(!v.isGroup);if(rule.chatType)conditions.push(['private','direct','dm'].includes(String(rule.chatType).toLowerCase())?!v.isGroup:String(rule.chatType).toLowerCase()==='group'&&v.isGroup);if(rule.chats)conditions.push(list(rule.chats).some(x=>x.includes('@')?x===v.chat:x===v.chat.split('@')[0]));if(rule.excludeChats)conditions.push(!list(rule.excludeChats).some(x=>x.includes('@')?x===v.chat:x===v.chat.split('@')[0]));if(rule.senders)conditions.push(list(rule.senders).some(x=>x.includes('@')?x===v.senderJid:x===v.sender));if(rule.excludeSenders)conditions.push(!list(rule.excludeSenders).some(x=>x.includes('@')?x===v.senderJid:x===v.sender));if(rule.adminOnly)conditions.push(v.isAdmin);if(rule.botAdminRequired)conditions.push(v.isBotAdmin);if(rule.ignoreBots)conditions.push(!v.isBot);if(rule.isBot!==undefined)conditions.push(Boolean(v.isBot)===Boolean(rule.isBot));if(rule.allowSelf===false&&v.fromMe)conditions.push(false);return conditions.length>0&&conditions.every(Boolean); }

const aiHistories = {};
const deletedMessagesCache = {};
const processedIds = new Set();
const reconnecting = { active: false };
const groupCache = new Map();
const botStartTime = Math.floor(Date.now() / 1000);

async function getGroupMetadataCached(sock, chatId) {
  const cached = groupCache.get(chatId);
  if (cached && Date.now() - cached.time < 300000) {
    return cached.data;
  }
  const meta = await sock.groupMetadata(chatId);
  groupCache.set(chatId, { data: meta, time: Date.now() });
  return meta;
}

async function askAi(chatId, prompt, systemPrompt) {
  if (!aiHistories[chatId]) aiHistories[chatId] = [];
  const sys = systemPrompt || 'Kamu adalah Ochild Bot AI yang cerdas, ramah, dan membantu. Jawab dalam bahasa yang digunakan pengguna.';
  const messages = [{ role: 'system', content: sys }]
    .concat(aiHistories[chatId].slice(-8))
    .concat([{ role: 'user', content: prompt }]);
  const providers = [];
  if (db.grokApiKey) providers.push({ name: 'Grok', url: 'https://api.x.ai/v1/chat/completions', key: db.grokApiKey, models: ['grok-3-mini', 'grok-2-latest'] });
  if (db.groqApiKey) providers.push({ name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: db.groqApiKey, models: ['llama-3.3-70b-versatile'] });
  for (const provider of providers) {
    for (const model of provider.models) {
      try {
        const res = await axios.post(provider.url, { model, messages }, { headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' }, timeout: 25000 });
        const reply = res.data?.choices?.[0]?.message?.content;
        if (!reply) throw new Error('Respons AI kosong');
        aiHistories[chatId].push({ role: 'user', content: prompt }, { role: 'assistant', content: reply });
        aiHistories[chatId] = aiHistories[chatId].slice(-20);
        return reply;
      } catch (e) { console.warn(`[AI ${provider.name}/${model}]`, e.message); }
    }
  }
  try {
    const res = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(sys + '\n\nUser: ' + prompt)}`, { timeout: 20000 });
    const reply = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    if (!reply.trim()) throw new Error('Respons AI kosong');
    aiHistories[chatId].push({ role: 'user', content: prompt }, { role: 'assistant', content: reply });
    aiHistories[chatId] = aiHistories[chatId].slice(-20);
    return reply;
  } catch (e) { throw new Error('Semua provider AI gagal. Periksa API key atau koneksi.'); }
}

async function createWebpSticker(inputBuffer, isVideo, packname, author) {
  const id = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const ext = isVideo ? 'mp4' : 'png';
  const inputPath = path.join(TEMP_DIR, `in_${id}.${ext}`);
  const outputPath = path.join(TEMP_DIR, `out_${id}.webp`);
  fs.writeFileSync(inputPath, inputBuffer);

  try {
    if (isVideo) {
      await execAsync(`ffmpeg -y -i "${inputPath}" -vcodec libwebp -filter:v "fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000" -loop 0 -ss 00:00:00 -t 00:00:07 -preset default -an -fps_mode vfr "${outputPath}"`);
    } else {
      await execAsync(`ffmpeg -y -i "${inputPath}" -vcodec libwebp -filter:v "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000" -lossless 1 -preset default -an -fps_mode vfr "${outputPath}"`);
    }
    const webpBuffer = fs.readFileSync(outputPath);
    return addExifToWebp(webpBuffer, packname || 'Ochild Bot AI', author || 'Rolleys Suite');
  } finally {
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
}

function addExifToWebp(webpBuffer, packname, author) {
  const json = {
    'sticker-pack-id': 'com.ochild.rolleys.pack',
    'sticker-pack-name': packname,
    'sticker-pack-publisher': author,
    'emojis': ['🔥', '🤖']
  };
  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00
  ]);
  const jsonBuff = Buffer.from(JSON.stringify(json), 'utf-8');
  const exif = Buffer.concat([exifAttr, jsonBuff]);
  exif.writeUIntLE(jsonBuff.length, 14, 4);

  if (webpBuffer.slice(0, 4).toString() !== 'RIFF' || webpBuffer.slice(8, 12).toString() !== 'WEBP') {
    return webpBuffer;
  }

  const chunks = [];
  let offset = 12;
  while (offset < webpBuffer.length) {
    const chunkId = webpBuffer.slice(offset, offset + 4).toString();
    const chunkSize = webpBuffer.readUInt32LE(offset + 4);
    const chunkEnd = offset + 8 + chunkSize + (chunkSize % 2);
    if (chunkId !== 'EXIF') chunks.push(webpBuffer.slice(offset, chunkEnd));
    offset = chunkEnd;
  }

  const exifHeader = Buffer.alloc(8);
  exifHeader.write('EXIF', 0);
  exifHeader.writeUInt32LE(exif.length, 4);
  const exifPad = exif.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);
  chunks.push(Buffer.concat([exifHeader, exif, exifPad]));

  const body = Buffer.concat(chunks);
  const riffHeader = Buffer.alloc(12);
  riffHeader.write('RIFF', 0);
  riffHeader.writeUInt32LE(body.length + 4, 4);
  riffHeader.write('WEBP', 8);
  return Buffer.concat([riffHeader, body]);
}

async function webpToPng(webpBuffer) {
  const id = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const inPath = path.join(TEMP_DIR, `st_${id}.webp`);
  const outPath = path.join(TEMP_DIR, `im_${id}.png`);
  fs.writeFileSync(inPath, webpBuffer);
  try {
    await execAsync(`ffmpeg -y -i "${inPath}" "${outPath}"`);
    return fs.readFileSync(outPath);
  } finally {
    if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  }
}

async function sendMusicCard(sock, chatId, query, quotedMsg) {
  const res = await axios.get(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=1`,
    { timeout: 15000 }
  );
  const results = res.data?.results || [];
  if (results.length === 0) {
    return sock.sendMessage(chatId, { text: '❌ Lagu tidak ditemukan di katalog musik.' }, { quoted: quotedMsg });
  }

  const track = results[0];
  const payload = {
    musicMessage: {
      artworkUri: track.artworkUrl100 ? track.artworkUrl100.replace('100x100bb.jpg', '300x300bb.jpg') : '',
      songUri: track.previewUrl || '',
      style: 2,
      embeddedMusic: {
        artistAttribution: track.artistViewUrl || '',
        author: track.artistName || 'Unknown Artist',
        derivedContentStartTimeInMs: 0,
        isExplicit: track.trackExplicitness === 'explicit',
        musicContentMediaId: String(track.trackId),
        musicSongStartTimeInMs: 0,
        overlapDurationInMs: 30000,
        songId: String(track.trackId),
        title: track.trackName || query
      },
      contextInfo: {
        expiration: 604800
      }
    }
  };

  const encodedProto = proto.Message.fromObject(payload);
  if (!encodedProto.musicMessage) {
    throw new Error('Skema proto musicMessage tidak ditemukan pada Baileys saat ini. Jalankan: rm -rf node_modules package-lock.json && npm install');
  }

  const msg = generateWAMessageFromContent(
    chatId,
    encodedProto,
    {
      userJid: sock.user.id,
      quoted: quotedMsg
    }
  );

  await sock.relayMessage(chatId, msg.message, {
    messageId: msg.key.id
  });
}

function buildContextInfo(m) {
  const ctx = {};
  if (db.fwdboost) {
    ctx.isForwarded = true;
    ctx.forwardingScore = 999;
    ctx.forwardedNewsletterMessageInfo = {
      newsletterJid: '120363000000000000@newsletter',
      newsletterName: db.defaultChannel || 'ochild bot ai Channel',
      serverMessageId: 100
    };
  }
  if (db.aitag) {
    ctx.mentionedJid = [m.key.participant || m.key.remoteJid];
  }
  if (db.adbanner) {
    ctx.externalAdReply = {
      title: 'ochild',
      body: 'Fast, native Baileys-powered WhatsApp client ...',
      mediaType: 1,
      showAdAttribution: false,
      renderLargerThumbnail: true,
      thumbnailUrl: 'https://placehold.co/600x400/png',
      
      sourceUrl: 'https://instagram.com'
    };
  }
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

function buildQuotedOption(m) {
  if (db.quoteVerified) {
    const namaQuote = db.fakequoteText || '🪸 ochild bot ai';
    return {
      quoted: {
        key: {
          remoteJid: 'status@broadcast',
          fromMe: false,
          id: 'VERIFIED_' + Date.now(),
          participant: '0@s.whatsapp.net'
        },
        message: {
          contactMessage: {
            displayName: namaQuote,
            vcard: `BEGIN:VCARD\nVERSION:3.0\nN:;${namaQuote};;;\nFN:${namaQuote}\nEND:VCARD`
          }
        }
      }
    };
  }
  return m ? { quoted: m } : {};
}

let presenceInterval = null;

function startPresenceLoop(sock) {
  if (presenceInterval) clearInterval(presenceInterval);
  presenceInterval = setInterval(async () => {
    if (!db.globalPresence) return;
    const targets = Array.isArray(db.presenceChats) ? db.presenceChats : [];
    for (const jid of targets) {
      try {
        await sock.presenceSubscribe(jid);
        await sock.sendPresenceUpdate(db.globalPresence, jid);
      } catch (e) {}
    }
  }, 3000);
}



async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth_session'));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['Ubuntu', 'Chrome', '20.0.04'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    cachedGroupMetadata: async (jid) => groupCache.get(jid)?.data
  });
  const pluginHttpAllowed = urlText => {
    try { const u=new URL(urlText); if(!['http:','https:'].includes(u.protocol))return false; const h=u.hostname.toLowerCase(); if(h==='localhost'||h.endsWith('.localhost')||h==='0.0.0.0'||h==='127.0.0.1'||h==='::1'||/^10\./.test(h)||/^192\.168\./.test(h)||/^172\.(1[6-9]|2\d|3[01])\./.test(h))return false; return true; } catch { return false; }
  };
  const transformPluginOutgoing = content => {
    if(!content||typeof content!=='object')return content;
    const copy={...content}; const plugins=listPlugins().filter(x=>x.plugin?.enabled&&x.plugin.rules);
    const v={chat:'',sender:'User',senderJid:'',pushName:'User',text:'',args:'',command:'',time:new Date().toLocaleTimeString('id-ID'),date:new Date().toLocaleDateString('id-ID'),messageType:'text',results:{},pluginId:''};
    const transform=(text,plugin)=>{let t=String(text);const r=plugin.rules||{};const tr=r.textTransform||{};if(tr.enabled!==false){t=pluginResolveString(tr.prefix||'',v)+t+pluginResolveString(tr.suffix||'',v);for(const rep of tr.replace||[]){if(!rep.from)continue;try{t=rep.regex? t.replace(new RegExp(rep.from,rep.ignoreCase?'gi':'g'),rep.to||''):t.split(rep.ignoreCase?String(rep.from).toLowerCase():String(rep.from)).join(rep.to||'');}catch{}}if(tr.case==='uppercase')t=t.toUpperCase();else if(tr.case==='lowercase')t=t.toLowerCase();else if(tr.case==='reverse')t=[...t].reverse().join('');}for(const [key,val]of Object.entries(r.shortcodes||{}))t=t.split(key).join(String(val));return r.template?.placeholders===false?t:pluginResolveString(t,v);};
    for(const {plugin} of plugins){const rules=plugin.rules;if(typeof copy.text==='string')copy.text=transform(copy.text,plugin);for(const k of ['caption','name','address','title'])if(typeof copy[k]==='string')copy[k]=transform(copy[k],plugin);if(copy.poll&&Array.isArray(copy.poll.options))copy.poll={...copy.poll,options:copy.poll.options.map(x=>transform(x,plugin))};}
    return copy;
  };
  const pluginRunActions = async (actions, vars, quote) => {
    if(!Array.isArray(actions))actions=[actions];
    for(const raw of actions){
      if(typeof raw==='string'){await sock.sendMessage(vars.chat,{text:pluginResolveString(raw,vars)},quote?{quoted:quote}:{});continue;}
      if(!raw||typeof raw!=='object')continue;const a=pluginResolve(raw,vars);
      if(a.when!==undefined){const val=String(a.when??'');let ok=false;if(a.is!==undefined)ok=val===String(a.is);else if(a.isNot!==undefined)ok=val!==String(a.isNot);else if(a.contains!==undefined)ok=val.includes(String(a.contains));else if(a.matches!==undefined){try{ok=new RegExp(a.matches,a.ignoreCase===false?'':'i').test(val);}catch{}}else if(a.notEmpty!==undefined)ok=val.length>0;else if(a.empty!==undefined)ok=val.length===0;await pluginRunActions(ok?a.then:a.else,vars,quote);continue;}
      if(a.each!==undefined){const items=Array.isArray(a.each)?a.each:[];for(let i=0;i<Math.min(items.length,Math.max(0,Math.min(20,Number(a.limit||20))));i++){const old={item:vars.item,index:vars.index,number:vars.number};vars.item=items[i];vars.index=i;vars.number=i+1;await pluginRunActions(a.actions,vars,quote);Object.assign(vars,old);}continue;}
      if(a.parse!==undefined){let x=a.parse;if(typeof x==='string'){try{x=JSON.parse(x);}catch{}}if(a.extract&&x&&typeof x==='object'){const y={};for(const[k,p]of Object.entries(a.extract))y[k]=String(p).split('.').reduce((o,q)=>o==null?undefined:o[q],x);x=y;}vars.results[a.saveAs||'parsed']=x;continue;}
      if(a.remember){pluginMemory.set(`${vars.pluginId}:${a.remember}`,a.value??'');continue;}if(a.recall){vars.results[a.saveAs||'memory']=pluginMemory.get(`${vars.pluginId}:${a.recall}`)??a.default??'';continue;}if(a.forget){pluginMemory.delete(`${vars.pluginId}:${a.forget}`);continue;}
      if(a.storageWrite||a.storageAppend||a.storageRead||a.storageDelete||a.storageList||a.storageMkdir||a.storageStat){const root=path.join(PLUGIN_DATA_DIR,vars.pluginId);fs.mkdirSync(root,{recursive:true});const op=a.storageWrite?'write':a.storageAppend?'append':a.storageRead?'read':a.storageDelete?'delete':a.storageList?'list':a.storageMkdir?'mkdir':'stat';const p=pluginSafePath(root,a.path||'');if(op==='write'||op==='append'){if(Buffer.byteLength(String(a.content??''))>8*1024*1024)throw new Error('File plugin melebihi 8 MB.');fs.mkdirSync(path.dirname(p),{recursive:true});if(op==='append')fs.appendFileSync(p,String(a.content??''));else{const tmp=p+'.tmp';fs.writeFileSync(tmp,String(a.content??''));fs.renameSync(tmp,p);}vars.results[a.saveAs||'storage']={path:a.path};}else if(op==='read'){vars.results[a.saveAs||'storage']=fs.readFileSync(p,a.encoding==='base64'?'base64':'utf8');}else if(op==='delete'){if(p===root)throw new Error('Tidak boleh menghapus root storage.');fs.rmSync(p,{recursive:true,force:true});}else if(op==='list'){vars.results[a.saveAs||'storage']=fs.existsSync(p)?fs.readdirSync(p,{withFileTypes:true}).map(d=>({name:d.name,isDirectory:d.isDirectory()})):[];}else if(op==='mkdir'){fs.mkdirSync(p,{recursive:true});}else if(op==='stat'){vars.results[a.saveAs||'storage']=fs.existsSync(p)?{size:fs.statSync(p).size,isDirectory:fs.statSync(p).isDirectory()}:null;}continue;}
      if(a.download!==undefined){let bytes,mime='application/octet-stream',filename='download.bin',target;if(a.download===true||a.download==='auto'||a.download==='quoted'){target=a.download==='quoted'?(vars.quotedMessage||vars.mediaMessage):vars.mediaMessage;if(!target)throw new Error('Media input tidak ditemukan.');bytes=await downloadMediaMessage(target,'buffer',{});const inner=extractMessageContent(target.message||{});const mm=inner.imageMessage||inner.videoMessage||inner.audioMessage||inner.documentMessage||inner.stickerMessage;mime=mm?.mimetype||mime;filename=mm?.fileName||filename;}else if(typeof a.download==='string'&&pluginHttpAllowed(a.download)){const res=await axios.get(a.download,{responseType:'arraybuffer',timeout:30000,maxRedirects:0,maxContentLength:25*1024*1024});bytes=Buffer.from(res.data);mime=res.headers['content-type']||mime;filename=path.basename(new URL(a.download).pathname)||filename;}else throw new Error('Sumber download invalid.');const p=pluginSafePath(PLUGIN_MEDIA_DIR,`${vars.pluginId}_${Date.now()}_${filename.replace(/[^\w.-]/g,'_')}`);fs.writeFileSync(p,bytes);vars.results[a.saveAs||'download']={path:p,fileName:filename,size:bytes.length,mimeType:mime};continue;}
      if(a.method){const method=String(a.method),args=a.args||{};if(method==='httpRequest'||method==='curl'){if(!pluginHttpAllowed(args.url))throw new Error('URL HTTP tidak aman atau host lokal ditolak.');const response=await axios({url:args.url,method:args.method||'GET',headers:args.headers,params:args.query,data:args.body,timeout:Math.min(120000,Math.max(1000,Number(args.timeoutMs||15000))),maxRedirects:0,responseType:args.responseType==='arraybuffer'?'arraybuffer':'text',maxContentLength:10*1024*1024});let body=response.data;if(args.responseType==='json'&&typeof body==='string'){try{body=JSON.parse(body);}catch{}}vars.results[a.saveAs||'http']={status:response.status,body,json:body,headers:response.headers,url:args.url};continue;}
        if(!['sendText','sendMessage','sendImage','sendVideo','sendAudio','sendDocument','sendSticker','sendMediaFile','groupParticipantsUpdate','groupSettingUpdate','groupUpdateSubject','groupUpdateDescription','groupMetadata','profilePictureUrl','fetchStatus','sendReaction','sendPoll','sendLocation','sendContact','sendMessageJson','sendNewsletterMessage'].includes(method)&&typeof sock[method]!=='function')throw new Error(`Method Baileys tidak tersedia: ${method}`);
        if(method==='sendText'||method==='sendMessage'){const dest=args.toJid||args.chatJid||vars.chat;const payload={text:args.text??args.message??'',...(args.mentions?{mentions:args.mentions}:{}),...(args.contextInfo?{contextInfo:args.contextInfo}:{})};vars.results[a.saveAs||'sent']=await sock.sendMessage(dest,payload,quote&&args.quote?{quoted:quote}:{});continue;}
        if(method==='sendImage'||method==='sendVideo'||method==='sendAudio'||method==='sendDocument'||method==='sendSticker'){const dest=args.toJid||vars.chat,kind=method.slice(4).toLowerCase(),source=args.url||args.path||args.bytes;const payload={[kind]:typeof source==='string'&&/^https?:\/\//.test(source)?{url:source}:source};if(args.caption)payload.caption=args.caption;if(args.fileName)payload.fileName=args.fileName;if(args.ptt)payload.ptt=true;vars.results[a.saveAs||'sent']=await sock.sendMessage(dest,payload,quote&&args.quote?{quoted:quote}:{});continue;}
        let fn=sock[method];if(typeof fn!=='function')throw new Error(`Native method '${method}' belum tersedia di Baileys versi ini.`);let callArgs=Array.isArray(args)?args:[args];vars.results[a.saveAs||'result']=await fn.apply(sock,callArgs);continue;}
      if(a.reply!==undefined||a.text!==undefined){const value=(a.reply??a.text)===true?vars.args:(a.reply??a.text);const dest=a.toJid||vars.chat;await sock.sendMessage(dest,{text:String(value??''),...(a.mentions?{mentions:a.mentions}:{})},a.quote&&quote?{quoted:quote}:{});}
      if(a.react||a.reaction)await sock.sendMessage(vars.chat,{react:{text:a.react||a.reaction,key:vars.messageKey}});
      if(a.delete||a.revoke)await sock.sendMessage(vars.chat,{delete:a.delete===true?vars.messageKey:a.delete});
      if(a.forward||a.fwd){if(vars.quotedMessage)await sock.sendMessage(a.to||a.toJid||vars.chat,{forward:vars.quotedMessage});}
      for(const kind of ['image','video','audio','document','sticker'])if(a[kind]!==undefined){let src=a[kind],payload={};if(src===true&&vars.mediaMessage)payload[kind]=await downloadMediaMessage(vars.mediaMessage,'buffer',{});else if(typeof src==='string'&&/^https?:\/\//i.test(src))payload[kind]={url:src};else if(typeof src==='string'&&fs.existsSync(src))payload[kind]=fs.readFileSync(src);else if(src&&typeof src==='object'&&src.url)payload[kind]={url:src.url};if(a.caption)payload.caption=a.caption;if(a.fileName)payload.fileName=a.fileName;if(a.ptt)payload.ptt=true;if(payload[kind])await sock.sendMessage(a.toJid||vars.chat,payload,a.quote&&quote?{quoted:quote}:{});}
      if(a.media!==undefined){const src=a.media;const kind=a.as||'document';const payload={[kind]:src&&src.url?{url:src.url}:src};if(a.caption)payload.caption=a.caption;if(a.ptt)payload.ptt=true;await sock.sendMessage(a.toJid||vars.chat,payload,a.quote&&quote?{quoted:quote}:{});}
      if(a.kick||a.remove||a.promote||a.demote){if(!vars.isGroup||!vars.isAdmin||!vars.isBotAdmin)throw new Error('Moderasi grup membutuhkan admin dan bot admin.');const who=a.kick||a.remove||a.promote||a.demote;const member=who===true?(vars.quotedSender||vars.args.split(/\s+/)[0]):who;const jid=String(member).includes('@')?member:String(member).replace(/\D/g,'')+'@s.whatsapp.net';await sock.groupParticipantsUpdate(vars.chat,[jid],a.promote?'promote':a.demote?'demote':'remove');}
      if(a.muteGroup||a.closeGroup||a.openGroup){if(!vars.isGroup||!vars.isAdmin||!vars.isBotAdmin)throw new Error('Perlu admin grup dan bot admin.');await sock.groupSettingUpdate(vars.chat,a.openGroup?'not_announcement':'announcement');}
      if(a.setSubject){if(!vars.isGroup||!vars.isAdmin||!vars.isBotAdmin)throw new Error('Perlu admin grup dan bot admin.');await sock.groupUpdateSubject(vars.chat,String(a.setSubject));}
      if(a.setDescription){if(!vars.isGroup||!vars.isAdmin||!vars.isBotAdmin)throw new Error('Perlu admin grup dan bot admin.');await sock.groupUpdateDescription(vars.chat,String(a.setDescription));}
    }
  };
  const runRolleysPlugins = async vars => {
    const dedupe=`${vars.chat}:${vars.messageId}`;if(pluginSeen.has(dedupe))return false;pluginSeen.add(dedupe);if(pluginSeen.size>1000)pluginSeen.delete(pluginSeen.values().next().value);
    for(const {file,plugin} of listPlugins()){if(!plugin||plugin.enabled!==true||!plugin.rules)continue;vars.pluginId=plugin.id;const rules=plugin.rules,auto=rules.autoResponder||{};
      if(auto.enabled!==false){for(const [cmd,actions]of Object.entries(auto.commands||{})){const c=String(cmd).toLowerCase();if(vars.text.toLowerCase()===c||vars.text.toLowerCase().startsWith(c+' ')){vars.args=vars.text.slice(cmd.length).trim();await pluginRunActions(actions,vars,vars.quotedRaw);return true;}}if(auto.echoPrefix&&vars.text.startsWith(auto.echoPrefix)){vars.args=vars.text.slice(auto.echoPrefix.length);await pluginRunActions({reply:vars.args},vars,vars.quotedRaw);return true;}for(const r of auto.autoReply||[]){if(r.enabled!==false&&r.match&&vars.text.toLowerCase().includes(String(r.match).toLowerCase())){await pluginRunActions(r.actions||{reply:r.reply},vars,vars.quotedRaw);return true;}}}
      for(const rule of rules.onIncoming||[]){if(rule.enabled===false||!pluginRuleMatches(rule,vars))continue;const n=String(vars.args||'').trim().split(/\s+/).filter(Boolean).length;const missing=rule.requireArgs&&!vars.args||rule.minArgs&&n<Number(rule.minArgs)|| (rule.requireQuoted||rule.requireQuote)&&!vars.quotedId||rule.requireMedia&&!vars.hasMedia||rule.botAdminRequired&&!vars.isBotAdmin;if(missing){if(rule.usage)await sock.sendMessage(vars.chat,{text:pluginResolveString(rule.usage,vars)});return true;}const cooldown=Math.max(0,Number(rule.cooldown||plugin.cooldown||0));const key=`${plugin.id}:${vars.chat}:${vars.senderJid}:${rule.command||rule.prefix||rule.exact||rule.contains||rule.regex||file}`;if(cooldown&&Date.now()-(pluginCooldowns.get(key)||0)<cooldown*1000)continue;pluginCooldowns.set(key,Date.now());try{await pluginRunActions(rule.actions,vars,vars.quotedRaw);}catch(e){console.error(`[PLUGIN ${plugin.name||plugin.id}]`,e.message);if(rule.onError)await sock.sendMessage(vars.chat,{text:pluginResolveString(rule.onError,vars)});}return true;}
    }return false;
  };

  const originalSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, options = {}) => {
    const defaultCtx = buildContextInfo({ key: { remoteJid: jid } }) || {};
    const defaultQuote = buildQuotedOption(options.quoted || null);

    if (content && typeof content === 'object' && !content.react && !content.delete) {
      content = { ...content };
      if (defaultCtx && Object.keys(defaultCtx).length) content.contextInfo = { ...defaultCtx, ...(content.contextInfo || {}) };
    }

    const finalOptions = {
      ...defaultQuote,
      ...options
    };

    if (db.quoteVerified && defaultQuote.quoted && !options.quoted) {
      finalOptions.quoted = defaultQuote.quoted;
    }

    return originalSendMessage(jid, transformPluginOutgoing(content), finalOptions);
  };

  if (!sock.authState.creds.registered) {
    const nomorBot = process.env.BOT_NUMBER || ''; // Isi BOT_NUMBER di environment jika memakai pairing code
    setTimeout(async () => {
      try {
        if (!nomorBot) { console.log('📱 Bot belum terhubung. Untuk pairing code, jalankan dengan BOT_NUMBER=628xxxx. QR akan ditangani Baileys bila tersedia.'); return; }
        let code = await sock.requestPairingCode(nomorBot.replace(/[^0-9]/g, ''));
        code = code?.match(/.{1,4}/g)?.join('-') || code;
        console.log('\n========================================');
        console.log('[PAIRING CODE] Kode Anda:', code);
        console.log('========================================\n');
      } catch (err) {
        console.log('[GAGAL PAIRING CODE]:', err.message);
      }
    }, 3000);
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { console.log('\n📱 Scan QR ini melalui WhatsApp > Perangkat tertaut > Tautkan perangkat:'); qrcode.generate(qr, { small: true }); }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode || 0;
      console.log('[KONEKSI TERPUTUS] Kode:', code);
      if (code !== DisconnectReason.loggedOut && !reconnecting.active) { reconnecting.active = true; setTimeout(() => { reconnecting.active = false; startBot().catch(e => console.error('[RECONNECT]', e)); }, 3000); }
        } else if (connection === 'open') {
      console.log('✅ ochild bot ai + Rolleys Suite (Full & Fast) Berhasil Terhubung!');
      startPresenceLoop(sock);
    }

  });

  sock.ev.on('call', async (calls) => {
    if (!db.anticall) return;
    for (const call of calls) {
      if (call.status === 'offer') {
        await sock.rejectCall(call.id, call.from);
        await sock.sendMessage(call.from, { text: '⚠️ *Anti-Call Aktif:* Maaf, bot tidak menerima panggilan.' });
      }
    }
  });

  sock.ev.on('group-participants.update', async (anu) => {
    groupCache.delete(anu.id);
    if (!db.welcome[anu.id]) return;
    for (const participant of anu.participants) {
      const tag = '@' + participant.split('@')[0];
      if (anu.action === 'add') {
        await sock.sendMessage(anu.id, { text: `👋 Selamat datang ${tag} di grup!`, mentions: [participant] });
      } else if (anu.action === 'remove') {
        await sock.sendMessage(anu.id, { text: `👋 Sampai jumpa ${tag}!`, mentions: [participant] });
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      const chatId = m.key?.remoteJid;
      try {
        if (!m.message || !m.key?.id) continue;
        if (!chatId) continue;
            if (chatId !== 'status@broadcast') {
        if (!Array.isArray(db.presenceChats)) db.presenceChats = [];
        if (!db.presenceChats.includes(chatId)) {
          db.presenceChats.push(chatId);
          saveDb();
        }
        if (db.globalPresence) {
          sock.presenceSubscribe(chatId)
            .then(() => sock.sendPresenceUpdate(db.globalPresence, chatId))
            .catch(() => {});
        }
      }

        
        deletedMessagesCache[m.key.id] = m;
        const cacheKeys = Object.keys(deletedMessagesCache);
        if (cacheKeys.length > 300) delete deletedMessagesCache[cacheKeys[0]];

        const actualMsg = extractMessageContent(m.message);
        if (actualMsg?.protocolMessage?.type === 0 && db.antidelete) {
          const delKey = actualMsg.protocolMessage.key;
          const cached = deletedMessagesCache[delKey.id];
          if (cached) {
            await sock.sendMessage(chatId, { text: '🛡️ *Anti-Delete Mendeteksi Pesan Dihapus:*' });
            await sock.copyNForward(chatId, cached, true);
          }
          continue;
        }

        if (chatId === 'status@broadcast') {
          if (db.autostory && !db.ghostmode && !m.key.fromMe) {
            await sock.readMessages([m.key]).catch(() => {});
          }
          continue;
        }

        const msgTimestamp = Number(m.messageTimestamp || 0);
        if (msgTimestamp > 0 && msgTimestamp < botStartTime - 10) continue;

        if (processedIds.has(m.key.id)) continue;
        processedIds.add(m.key.id);
        if (processedIds.size > 500) processedIds.delete(processedIds.values().next().value);

        const trimmed = getMessageText(actualMsg);
        const isGroup = chatId.endsWith('@g.us');
        const botJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : '';
        const botLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : '';
        const rawSender = isGroup ? (m.key.participant || '') : chatId;
        const sender = m.key.fromMe ? botJid : jidNormalizedUser(rawSender);

        const isOwner = Boolean(
          m.key.fromMe ||
          (botJid && sender === botJid) ||
          (botLid && sender === botLid)
        );

        if (trimmed) {
          console.log(`[PESAN] Chat: ${chatId.split('@')[0]} | Owner: ${isOwner} | Teks: ${trimmed.slice(0, 50)}`);
        }

        if (db.mode === 'self' && !isOwner) continue;

        if (db.afk[sender] && !trimmed.startsWith(db.prefix + 'afk')) {
          const afkData = db.afk[sender];
          delete db.afk[sender];
          saveDb();
          await sock.sendMessage(chatId, { text: `✅ Kamu kembali dari mode AFK (Alasan: ${afkData.reason}).` }, { quoted: m });
        }

        if (isGroup && db.antilink[chatId] && !isOwner && /(https?:\/\/chat\.whatsapp\.com\/)/i.test(trimmed)) {
          await sock.sendMessage(chatId, { text: '🚫 *Anti-Link Aktif:* Tautan grup tidak diperbolehkan!' });
          await sock.sendMessage(chatId, { delete: m.key });
          continue;
        }

        const sendReply = async (text, extraOptions = {}) => {
          const ctx = buildContextInfo(m);
          if (ctx) extraOptions.contextInfo = Object.assign(extraOptions.contextInfo || {}, ctx);
          const sent = await sock.sendMessage(chatId, Object.assign({ text }, extraOptions), buildQuotedOption(m));
          if (db.autoDelSeconds > 0 && sent?.key) {
            setTimeout(() => sock.sendMessage(chatId, { delete: sent.key }).catch(() => {}), db.autoDelSeconds * 1000);
          }
          return sent;
        };
         if (
     m.key.fromMe &&
     trimmed &&
     !trimmed.startsWith(db.prefix) &&
     db.quoteVerified &&
     !actualMsg?.extendedTextMessage?.contextInfo?.quotedMessage &&
     !actualMsg?.extendedTextMessage?.contextInfo?.isForwarded
   ) {
     await sock.sendMessage(chatId, { delete: m.key });
     await sock.sendMessage(chatId, { text: trimmed });
     continue;
   }

        
        if (!trimmed.startsWith(db.prefix)) {
          if (!isGroup && !m.key.fromMe && db.autoAi && trimmed.length > 1) {
            try {
              const aiRes = await askAi(chatId, trimmed);
              await sendReply(aiRes);
            } catch (e) {}
          }
          continue;
        }

        const userStats = addXp(sender, 15);
        const withoutPrefix = trimmed.slice(db.prefix.length).trim();
        const spaceIdx = withoutPrefix.indexOf(' ');
        const cmd = (spaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, spaceIdx)).toLowerCase();
        const arg = spaceIdx === -1 ? '' : withoutPrefix.slice(spaceIdx + 1).trim();

        const quotedMsg = actualMsg.extendedTextMessage?.contextInfo?.quotedMessage || null;
        const getTargetMediaMessage = () => {
          if (actualMsg.imageMessage || actualMsg.videoMessage || actualMsg.stickerMessage || actualMsg.audioMessage || actualMsg.documentMessage) {
            return { key: m.key, message: actualMsg };
          }
          if (quotedMsg) {
            const qctx = actualMsg.extendedTextMessage?.contextInfo || actualMsg.imageMessage?.contextInfo || actualMsg.videoMessage?.contextInfo || actualMsg.documentMessage?.contextInfo || actualMsg.stickerMessage?.contextInfo;
            const qkey = qctx?.stanzaId ? { remoteJid: chatId, id: qctx.stanzaId, participant: qctx.participant, fromMe: qctx.participant ? jidNormalizedUser(qctx.participant) === botJid : false } : m.key;
            return { key: qkey, message: extractMessageContent(quotedMsg) };
          }
          return null;
        };

        let groupMeta = null;
        let isAdmin = isOwner;
        let isBotAdmin = false;
        if (isGroup) {
          try {
            groupMeta = await getGroupMetadataCached(sock, chatId);
            for (const p of groupMeta.participants) {
              const pId = jidNormalizedUser(p.id);
              if (pId === sender && (p.admin === 'admin' || p.admin === 'superadmin')) isAdmin = true;
              if ((pId === botJid || pId === botLid) && (p.admin === 'admin' || p.admin === 'superadmin')) isBotAdmin = true;
            }
          } catch (e) {}
        }

        switch (cmd) {
          case 'menu':
          case 'help': {
            const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
            const nextXp = userStats.level * 100;
            const menuText = [
              'ochild bot ai',
              '╭─── ✦ 𝐎𝐂𝐇𝐈𝐋𝐃 𝐁𝐎𝐓 𝐀𝐈 + 𝐑𝐎𝐋𝐋𝐄𝐘𝐒 ✦ ───',
              `│ Halo, ${db.ownerName}`,
              '│',
              `├ ◆ ROLE     : ${isOwner ? 'OWNER' : 'MEMBER'}`,
              `├ ◆ LEVEL    : ${userStats.level} (${userStats.xp}/${nextXp} XP)`,
              '├ ◆ LIMIT    : ∞',
              `├ ◆ AUTO AI  : ${db.autoAi ? 'ON (Chat Pribadi)' : 'OFF'}`,
              `├ ◆ AUTO DEL : ${db.autoDelSeconds > 0 ? db.autoDelSeconds + 's' : 'OFF'}`,
              '│',
              `├ ◆ RUNTIME  : ${formatRuntime(process.uptime())}`,
              `├ ◆ MODE     : ${db.mode.toUpperCase()}`,
              '│',
              `╰── ${getProgressBar(userStats.xp, nextXp)}`,
              '',
              '┌── ✦ Informasi',
              '│ ▸ .infobot / .menu / .owner / .ping / .echo',
              '└─────────────',
              '',
              '┌── ✦ Kecerdasan Buatan (Groq & Grok xAI)',
              '│ ▸ .autoai on/off (chat pribadi)',
              '│ ▸ .setgroq <api_key> / .setgrok <api_key>',
              '│ ▸ .ai / .grok / .gpt / .code / .translate',
              '│ ▸ .summary / .roast / .reset',
              '└─────────────',
              '',
              '┌── ✦ Auto-Delete & Payment',
              '│ ▸ .autodel <detik> | <pesan>',
              '│ ▸ .setautodel <detik> (0 = off)',
              '│ ▸ .fakepay <nominal> | <catatan>',
              '│ ▸ .stickerpay <nominal> (balas gambar)',
              '│ ▸ .paymsg <nominal> | <catatan>',
              '│ ▸ .setcurrency / .kurs',
              '└─────────────',
              '',
              '┌── ✦ Media, Stiker & Saluran (Rolleys)',
              '│ ▸ .sticker / .s / .sprem / .toimg',
              '│ ▸ .swm <pack>|<author> / .take',
              '│ ▸ .sai <prompt> (stiker AI)',
              '│ ▸ .rvo / .vv / .1x (buka sekali lihat)',
              '│ ▸ .dl <url> / .pvmu (preview ZIP)',
              '│ ▸ .imgch / .stickch / .sch / .setch',
              '│ ▸ .brat <teks>',
              '└─────────────',
              '',
              '┌── ✦ Rich Builders & Interaktif (Rolleys)',
              '│ ▸ .poll judul|opsi1|opsi2',
              '│ ▸ .quiz pertanyaan|opsi1|opsi2',
              '│ ▸ .event judul|deskripsi|lokasi',
              '│ ▸ .table judul|col1,col2|val1,val2',
              '│ ▸ .button teks|btn1|btn2',
              '│ ▸ .listmenu judul|opsi1|opsi2',
              '│ ▸ .carousel / .html / .comment',
              '└─────────────',
              '',
              '┌── ✦ Manajemen Grup & Status (Rolleys)',
              '│ ▸ .tagall / .hidetag / .fwd',
              '│ ▸ .kick / .promote / .demote',
              '│ ▸ .mute / .unmute / .setname / .setdesc',
              '│ ▸ .groupstatus / .gstatus <teks>',
              '│ ▸ .archive / .unarchive / .afk / .getjid',
              '│ ▸ .antilink on/off / .welcome on/off',
              '│ ▸ .faketyping / .fakerecording',
              '└─────────────',
              '',
              '┌── ✦ Catatan & Utilitas (Rolleys)',
              '│ ▸ .save <nama>|<isi> / .load <nama>',
              '│ ▸ .files / .delnote <nama>',
              '│ ▸ .qr <teks> / .tts <teks> / .weather <kota>',
              '│ ▸ .img <prompt> / .dog / .zen',
              '│ ▸ .musik <lagu> / .play <lagu> / .lyrics <lagu>',
              '└─────────────',
              '',
              '┌── ✦ Kontrol Bot & Lencana Pesan',
              '│ ▸ .self / .public / .ghostmode',
              '│ ▸ .anticall / .antidelete / .autostory',
              '│ ▸ .fwdboost on/off / .aitag on/off',
              '│ ▸ .adbanner on/off / .fakequote <teks>',
              '└─────────────',
              '',
              '╭─── ✦ 𝐒𝐲𝐬𝐭𝐞𝐦 ───',
              `├ NODE     : ${process.version}`,
              `├ RAM      : ${memMb} MB`,
              '├ STATUS   : ONLINE',
              '╰── _ᴘᴏᴡᴇʀᴇᴅ ʙʏ ochild bot ai_'
            ].join('\n');
            await sendReply(menuText);
            break;
          }

          case 'ping': {
            const start = Date.now();
            const sent = await sendReply('🏓 Pong!');
            if (sent?.key) {
              await sock.sendMessage(chatId, { text: `🏓 Pong! Kecepatan respon: *${Date.now() - start} ms*`, edit: sent.key });
            }
            break;
          }

          case 'infobot':
          case 'info': {
            const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
            await sendReply(
              '🤖 *INFO OCHILD BOT AI + ROLLEYS*\n' +
              `• Runtime: ${formatRuntime(process.uptime())}\n` +
              `• Mode: ${db.mode.toUpperCase()}\n` +
              `• Node.js: ${process.version}\n` +
              `• RAM: ${memMb} MB\n` +
              `• Grok AI: ${db.grokApiKey ? 'Aktif' : 'Belum diset'}\n` +
              `• Groq AI: ${db.groqApiKey ? 'Aktif' : 'Belum diset'}`
            );
            break;
          }

          case 'owner': {
            await sendReply(`👑 *Owner Bot:* ${db.ownerName} (${sock.user?.id?.split(':')[0] || ''})`);
            break;
          }

          case 'echo': {
            if (!arg) return sendReply('Gunakan: .echo <teks>');
            await sendReply(arg);
            break;
          }

          case 'setgroq': {
            if (!isOwner) return sendReply('Khusus Owner!');
            db.groqApiKey = arg;
            saveDb();
            await sendReply('✅ API Key Groq berhasil disimpan!');
            break;
          }

          case 'setgrok': {
            if (!isOwner) return sendReply('Khusus Owner!');
            db.grokApiKey = arg;
            saveDb();
            await sendReply('✅ API Key Grok (xAI) berhasil disimpan!');
            break;
          }

          case 'autoai': {
            if (!isOwner) return sendReply('Khusus Owner!');
            db.autoAi = arg.toLowerCase() === 'on';
            saveDb();
            await sendReply(`🤖 Auto AI Chat Pribadi sekarang: *${db.autoAi ? 'ON' : 'OFF'}*`);
            break;
          }

          case 'reset': {
            delete aiHistories[chatId];
            await sendReply('🧹 Riwayat percakapan AI pada chat ini telah dibersihkan.');
            break;
          }

          case 'ai':
          case 'grok':
          case 'gpt':
          case 'tanya': {
            if (!arg) return sendReply(`Gunakan: .${cmd} <pertanyaan>`);
            const reply = await askAi(chatId, arg);
            await sendReply(reply);
            break;
          }

          case 'code': {
            if (!arg) return sendReply('Gunakan: .code <permintaan kode>');
            const reply = await askAi(chatId, arg, 'Kamu adalah programmer ahli. Berikan solusi kode yang bersih dan akurat.');
            await sendReply(reply);
            break;
          }

          case 'translate': {
            if (!arg) return sendReply('Gunakan: .translate <bahasa> | <teks>');
            const parts = arg.split('|');
            const targetLang = parts.length > 1 ? parts[0].trim() : 'Indonesia';
            const textToTrans = parts.length > 1 ? parts.slice(1).join('|').trim() : arg;
            const reply = await askAi(chatId, `Terjemahkan teks berikut ke bahasa ${targetLang} tanpa penjelasan tambahan:\n\n${textToTrans}`);
            await sendReply(reply);
            break;
          }

          case 'summary': {
            const targetText = arg || (quotedMsg && getMessageText(quotedMsg));
            if (!targetText) return sendReply('Kirim teks atau balas pesan dengan .summary');
            const reply = await askAi(chatId, `Ringkas poin-poin penting dari teks berikut secara singkat:\n\n${targetText}`);
            await sendReply(reply);
            break;
          }

          case 'roast': {
            const targetText = arg || (quotedMsg && getMessageText(quotedMsg)) || 'Orang yang malas ngetik';
            const reply = await askAi(chatId, `Berikan roasting yang lucu dan menghibur dalam bahasa Indonesia untuk: ${targetText}`);
            await sendReply(reply);
            break;
          }

          case 'setautodel': {
            if (!isOwner) return sendReply('Khusus Owner!');
            const sec = Math.max(0, Math.min(86400, parseInt(arg, 10) || 0));
            db.autoDelSeconds = sec;
            saveDb();
            await sendReply(sec > 0 ? `⏱️ Auto-Delete pesan bot diatur ke *${sec} detik*.` : '✅ Auto-Delete pesan bot dimatikan.');
            break;
          }

          case 'autodel': {
            const parts = arg.split('|');
            const sec = parseInt(parts[0], 10);
            const text = parts.slice(1).join('|').trim();
            if (!Number.isFinite(sec) || sec < 1 || sec > 86400 || !text) return sendReply('Gunakan: .autodel 1-86400 | <pesan>');
            const sent = await sock.sendMessage(chatId, { text }, { quoted: m });
            if (sent?.key) {
              setTimeout(() => sock.sendMessage(chatId, { delete: sent.key }).catch(() => {}), sec * 1000);
            }
            break;
          }

          case 'setcurrency':
          case 'kurs': {
            if (!arg) return sendReply(`Kurs saat ini: *${db.currency}*. Ubah dengan: .setcurrency USD`);
            db.currency = arg.toUpperCase();
            saveDb();
            await sendReply(`💱 Mata uang default diubah ke *${db.currency}*`);
            break;
          }

          case 'fakepay':
          case 'paymsg': {
            if (!arg) return sendReply(`Gunakan: .${cmd} <nominal> | <catatan>`);
            const parts = arg.split('|');
            const amount = parseInt((parts[0] || '').replace(/[^0-9]/g, ''), 10);
            if (!Number.isFinite(amount) || amount <= 0) return sendReply('Nominal harus berupa angka lebih dari 0.');
            const note = parts[1] ? parts[1].trim() : 'Pembayaran via Ochild Bot AI';
            await sendReply(`🧾 *PERMINTAAN PEMBAYARAN*\n\n💰 Nominal: *${amount.toLocaleString('id-ID')} ${db.currency}*\n📝 Catatan: ${note}\n👤 Penerima/pengirim: @${sender.split('@')[0]}\n\n _Ini hanya pesan invoice teks, bukan permintaan pembayaran WhatsApp resmi._`, { mentions: [sender] });
            break;
          }

          case 'stickerpay': {
            const target = getTargetMediaMessage();
            if (!target) return sendReply('Kirim/balas gambar dengan .stickerpay <nominal>');
            const buf = await downloadMediaMessage(target, 'buffer', {});
            const webp = await createWebpSticker(buf, false, 'Payment Sticker', db.ownerName);
            await sock.sendMessage(chatId, { sticker: webp }, { quoted: m });
            break;
          }

          case 's':
          case 'sticker':
          case 'sprem': {
            const target = getTargetMediaMessage();
            if (!target) return sendReply(`Kirim atau balas foto/video pendek dengan perintah *.${cmd}*`);
            const isVid = Boolean(target.message.videoMessage);
            const buf = await downloadMediaMessage(target, 'buffer', {});
            const webp = await createWebpSticker(buf, isVid, cmd === 'sprem' ? 'Premium Sticker' : 'Ochild Bot AI', db.ownerName);
            await sock.sendMessage(chatId, { sticker: webp }, { quoted: m });
            break;
          }

          case 'swm':
          case 'take': {
            const target = getTargetMediaMessage();
            if (!target) return sendReply('Balas stiker/foto dengan .swm NamaPack|NamaAuthor');
            const parts = arg.split('|');
            const pack = parts[0] ? parts[0].trim() : 'Ochild Pack';
            const author = parts[1] ? parts[1].trim() : db.ownerName;
            const buf = await downloadMediaMessage(target, 'buffer', {});
            const webp = target.message.stickerMessage
              ? addExifToWebp(buf, pack, author)
              : await createWebpSticker(buf, Boolean(target.message.videoMessage), pack, author);
            await sock.sendMessage(chatId, { sticker: webp }, { quoted: m });
            break;
          }

          case 'sai': {
            if (!arg) return sendReply('Gunakan: .sai <deskripsi stiker AI>');
            const imgUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(arg + ', sticker style, white outline, vector art')}?width=512&height=512&nologo=true`;
            const res = await axios.get(imgUrl, { responseType: 'arraybuffer', timeout: 30000 });
            const webp = await createWebpSticker(Buffer.from(res.data), false, 'AI Sticker', 'Ochild Bot AI');
            await sock.sendMessage(chatId, { sticker: webp }, { quoted: m });
            break;
          }

          case 'toimg': {
            const target = getTargetMediaMessage();
            if (!target?.message?.stickerMessage) return sendReply('Balas stiker dengan perintah *.toimg*');
            const buf = await downloadMediaMessage(target, 'buffer', {});
            const png = await webpToPng(buf);
            await sock.sendMessage(chatId, { image: png, caption: '✅ Berhasil diubah ke gambar.' }, { quoted: m });
            break;
          }

          case 'brat': {
            if (!arg) return sendReply('Gunakan: *.brat teks kamu*');
            const id = Date.now();
            const outWebp = path.join(TEMP_DIR, `brat_${id}.webp`);
            const words = arg.replace(/['":\\]/g, '').slice(0, 80).split(' ');
            let lines = [];
            let currentLine = '';
            for (const w of words) {
              if ((currentLine + ' ' + w).trim().length > 16) {
                lines.push(currentLine.trim());
                currentLine = w;
              } else {
                currentLine += ' ' + w;
              }
            }
            if (currentLine.trim()) lines.push(currentLine.trim());
            const formattedText = lines.join('\n');

            await execAsync(
              `ffmpeg -y -f lavfi -i color=c=white:s=512x512:d=1 -vf "drawtext=text='${formattedText}':fontcolor=black:fontsize=46:x=(w-text_w)/2:y=(h-text_h)/2" -vcodec libwebp -lossless 1 "${outWebp}"`
            );
            try {
              const webpWithExif = addExifToWebp(fs.readFileSync(outWebp), 'Brat Sticker', db.ownerName);
              await sock.sendMessage(chatId, { sticker: webpWithExif }, { quoted: m });
            } finally { if (fs.existsSync(outWebp)) fs.unlinkSync(outWebp); }
            break;
          }

          case 'rvo':
          case 'vv':
          case '1x': {
            if (!quotedMsg) return sendReply(`Balas pesan foto/video sekali lihat dengan *.${cmd}*`);
            const innerMsg = extractMessageContent(quotedMsg);
            const qctx = actualMsg.extendedTextMessage?.contextInfo;
            const qkey = { remoteJid: chatId, id: qctx?.stanzaId || m.key.id, participant: qctx?.participant, fromMe: false };
            if (innerMsg.imageMessage) {
              const buf = await downloadMediaMessage({ key: qkey, message: innerMsg }, 'buffer', {});
              await sock.sendMessage(chatId, { image: buf, caption: innerMsg.imageMessage.caption || '🔓 View Once dibuka.' }, { quoted: m });
            } else if (innerMsg.videoMessage) {
              const buf = await downloadMediaMessage({ key: qkey, message: innerMsg }, 'buffer', {});
              await sock.sendMessage(chatId, { video: buf, caption: innerMsg.videoMessage.caption || '🔓 View Once dibuka.' }, { quoted: m });
            } else {
              await sendReply('Pesan yang dibalas bukan media View Once.');
            }
            break;
          }

          case 'dl': {
            if (!arg || !arg.startsWith('http')) return sendReply('Gunakan: .dl <url_media_langsung>');
            const res = await axios.get(arg, { responseType: 'arraybuffer', timeout: 30000, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const ct = res.headers['content-type'] || '';
            const buf = Buffer.from(res.data);
            if (ct.includes('image')) await sock.sendMessage(chatId, { image: buf, caption: '✅ Berhasil diunduh.' }, { quoted: m });
            else if (ct.includes('video')) await sock.sendMessage(chatId, { video: buf, caption: '✅ Berhasil diunduh.' }, { quoted: m });
            else if (ct.includes('audio')) await sock.sendMessage(chatId, { audio: buf, mimetype: 'audio/mp4' }, { quoted: m });
            else await sock.sendMessage(chatId, { document: buf, fileName: 'download_file', mimetype: ct || 'application/octet-stream' }, { quoted: m });
            break;
          }

          case 'setch': {
            if (!arg) return sendReply(`Nama saluran saat ini: *${db.defaultChannel}*`);
            db.defaultChannel = arg;
            saveDb();
            await sendReply(`✅ Nama saluran diatur ke: *${db.defaultChannel}*`);
            break;
          }

          case 'imgch': {
            const target = getTargetMediaMessage();
            if (!target?.message?.imageMessage) return sendReply('Kirim/balas gambar dengan .imgch Nama Saluran | Caption');
            const parts = arg.split('|');
            const chName = parts[0] ? parts[0].trim() : db.defaultChannel;
            const cap = parts[1] ? parts[1].trim() : '';
            const buf = await downloadMediaMessage(target, 'buffer', {});
            await sock.sendMessage(chatId, {
              image: buf,
              caption: cap,
              contextInfo: {
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: { newsletterJid: '120363000000000000@newsletter', newsletterName: chName, serverMessageId: 100 }
              }
            }, { quoted: m });
            break;
          }

          case 'stickch':
          case 'sch': {
            const target = getTargetMediaMessage();
            if (!target) return sendReply('Kirim/balas gambar atau stiker dengan .sch Nama Saluran');
            const chName = arg || db.defaultChannel;
            const buf = await downloadMediaMessage(target, 'buffer', {});
            const webp = target.message.stickerMessage ? buf : await createWebpSticker(buf, Boolean(target.message.videoMessage), chName, db.ownerName);
            await sock.sendMessage(chatId, {
              sticker: webp,
              contextInfo: {
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: { newsletterJid: '120363000000000000@newsletter', newsletterName: chName, serverMessageId: 101 }
              }
            }, { quoted: m });
            break;
          }

          case 'poll': {
            const parts = arg.split('|').map(s => s.trim()).filter(Boolean);
            if (parts.length < 3) return sendReply('Gunakan: .poll Judul Polling | Opsi 1 | Opsi 2');
            await sock.sendMessage(chatId, { poll: { name: parts[0], values: parts.slice(1), selectableCount: 1 } });
            break;
          }

          case 'quiz': {
            const parts = arg.split('|').map(s => s.trim()).filter(Boolean);
            if (parts.length < 3) return sendReply('Gunakan: .quiz Pertanyaan | Jawaban 1 | Jawaban 2');
            await sock.sendMessage(chatId, { poll: { name: '🧠 KUIS: ' + parts[0], values: parts.slice(1), selectableCount: 1 } });
            break;
          }

          case 'event': {
            const parts = arg.split('|').map(s => s.trim());
            if (!parts[0]) return sendReply('Gunakan: .event Nama Acara | Deskripsi | Lokasi');
            await sendReply([
              '📅 *UNDANGAN ACARA (EVENT)*',
              `• *Acara:* ${parts[0]}`,
              `• *Deskripsi:* ${parts[1] || '-'}`,
              `• *Lokasi:* ${parts[2] || 'Online / Grup WhatsApp'}`,
              `• *Waktu:* ${new Date().toLocaleString('id-ID')}`
            ].join('\n'));
            break;
          }

          case 'table': {
            const rows = arg.split('|').map(s => s.trim()).filter(Boolean);
            if (rows.length < 3) return sendReply('Gunakan: .table Judul | Kolom1,Kolom2 | Data1,Data2');
            const columns = rows[1].split(',').map(c => c.trim());
            const dataRows = rows.slice(2).map(r => r.split(',').map(c => c.trim()));
            const widths = columns.map((c, i) => Math.min(24, Math.max(c.length, ...dataRows.map(r => (r[i] || '').length))));
            const fmt = row => row.map((c, i) => String(c || '').slice(0, widths[i]).padEnd(widths[i])).join(' | ');
            let out = `📊 *${rows[0].toUpperCase()}*\n\`\`\`\n${fmt(columns)}\n${widths.map(w => '-'.repeat(w)).join('-+-')}\n`;
            for (const r of dataRows) out += fmt(r) + '\n';
            out += '```';
            await sendReply(out);
            break;
          }

          case 'button': {
            const parts = arg.split('|').map(s => s.trim()).filter(Boolean);
            if (parts.length < 2) return sendReply('Gunakan: .button Teks Pesan | Tombol 1 | Tombol 2');
            const options = parts.slice(1).slice(0, 12);
            await sock.sendMessage(chatId, { poll: { name: parts[0], values: options, selectableCount: 1 } }, { quoted: m });
            break;
          }

          case 'listmenu': {
            const parts = arg.split('|').map(s => s.trim()).filter(Boolean);
            if (parts.length < 2) return sendReply('Gunakan: .listmenu Judul Menu | Item 1 | Item 2');
            await sock.sendMessage(chatId, { poll: { name: `📋 ${parts[0]}`, values: parts.slice(1, 13), selectableCount: 1 } }, { quoted: m });
            break;
          }

          case 'carousel': {
            const cards = arg ? arg.split('|').map(s => s.trim()).filter(Boolean).slice(0, 10) : ['Kartu 1 - Ochild Bot AI', 'Kartu 2 - Rolleys Suite'];
            await sendReply('🎠 *CAROUSEL / CARD VIEW*\n\n' + cards.map((c, i) => `╭─ *Kartu ${i + 1}/${cards.length}*\n│ ${c}\n╰────────────`).join('\n'));
            break;
          }

          case 'html': {
            if (!arg) return sendReply('Gunakan: .html <b>Teks HTML</b>');
            await sendReply('🌐 *HTML Preview:*\n' + arg.replace(/<[^>]*>?/gm, ''));
            break;
          }

          case 'comment': {
            if (!arg) return sendReply('Gunakan: .comment <isi komentar>');
            await sendReply('💬 *Komentar:* ' + arg);
            break;
          }

          case 'tagall':
          case 'hidetag': {
            if (!isGroup) return sendReply('Perintah ini hanya untuk grup!');
            const members = groupMeta ? groupMeta.participants.map(p => p.id) : [];
            if (cmd === 'hidetag') {
              await sock.sendMessage(chatId, { text: arg || '📢 Perhatian semua anggota!', mentions: members });
            } else {
              const list = members.map(id => '• @' + id.split('@')[0]).join('\n');
              await sock.sendMessage(chatId, { text: `📢 *TAG ALL MEMBER*\n${arg ? arg + '\n\n' : '\n'}${list}`, mentions: members });
            }
            break;
          }

          case 'kick':
          case 'promote':
          case 'demote': {
            if (!isGroup || !isAdmin || !isBotAdmin) return sendReply('Pastikan di grup, Anda admin, dan bot juga admin!');
            const mentioned = actualMsg.extendedTextMessage?.contextInfo?.mentionedJid || [];
            const quotedP = actualMsg.extendedTextMessage?.contextInfo?.participant ? [actualMsg.extendedTextMessage.contextInfo.participant] : [];
            const targets = mentioned.length > 0 ? mentioned : quotedP;
            if (targets.length === 0) return sendReply(`Tag atau balas pesan anggota yang ingin di-${cmd}!`);
            const map = { kick: 'remove', promote: 'promote', demote: 'demote' };
            await sock.groupParticipantsUpdate(chatId, targets, map[cmd]);
            await sendReply(`✅ Berhasil melakukan *${cmd}* pada target.`);
            break;
          }

          case 'mute':
          case 'unmute': {
            if (!isGroup || !isAdmin || !isBotAdmin) return sendReply('Pastikan di grup dan bot adalah admin!');
            await sock.groupSettingUpdate(chatId, cmd === 'mute' ? 'announcement' : 'not_announcement');
            await sendReply(cmd === 'mute' ? '🔒 Grup ditutup.' : '🔓 Grup dibuka.');
            break;
          }

          case 'setname': {
            if (!isGroup || !isAdmin || !isBotAdmin) return sendReply('Pastikan di grup dan bot adalah admin!');
            if (!arg) return sendReply('Gunakan: .setname <nama grup baru>');
            await sock.groupUpdateSubject(chatId, arg);
            await sendReply(`✅ Nama grup diubah menjadi: *${arg}*`);
            break;
          }

          case 'setdesc': {
            if (!isGroup || !isAdmin || !isBotAdmin) return sendReply('Pastikan di grup dan bot adalah admin!');
            if (!arg) return sendReply('Gunakan: .setdesc <deskripsi baru>');
            await sock.groupUpdateDescription(chatId, arg);
            await sendReply('✅ Deskripsi grup diperbarui.');
            break;
          }

          case 'fwd': {
            if (!quotedMsg) return sendReply('Balas pesan yang ingin diteruskan dengan *.fwd*');
            await sock.copyNForward(chatId, { key: m.key, message: quotedMsg }, true);
            break;
          }

          case 'groupstatus':
          case 'gstatus': {
            if (!isOwner) return sendReply('Khusus Owner!');
            const target = getTargetMediaMessage();
            const myJid = jidNormalizedUser(sock.user.id);
            const rawList = isGroup && groupMeta ? groupMeta.participants.map(p => jidNormalizedUser(p.id)) : [sender];
            if (!rawList.includes(myJid)) rawList.push(myJid);

            if (target?.message?.imageMessage) {
              const buf = await downloadMediaMessage(target, 'buffer', {});
              await sock.sendMessage('status@broadcast', { image: buf, caption: arg || '' }, { statusJidList: rawList });
              await sendReply('✅ Foto berhasil diposting ke Status WhatsApp!');
            } else if (target?.message?.videoMessage) {
              const buf = await downloadMediaMessage(target, 'buffer', {});
              await sock.sendMessage('status@broadcast', { video: buf, caption: arg || '' }, { statusJidList: rawList });
              await sendReply('✅ Video berhasil diposting ke Status WhatsApp!');
            } else if (arg) {
              await sock.sendMessage('status@broadcast', { text: arg }, { backgroundColor: '#1E293B', font: 1, statusJidList: rawList });
              await sendReply('✅ Teks berhasil diposting ke Status WhatsApp!');
            } else {
              await sendReply('Gunakan: .gstatus <teks> atau balas foto/video.');
            }
            break;
          }

          case 'archive':
          case 'unarchive': {
            if (!isOwner) return sendReply('Khusus Owner!');
            await sock.chatModify({ archive: cmd === 'archive', lastMessages: [m] }, chatId);
            await sendReply(cmd === 'archive' ? '📦 Chat diarsipkan.' : '📂 Chat dikeluarkan dari arsip.');
            break;
          }

          case 'afk': {
            const reason = arg || 'Tanpa alasan';
            db.afk[sender] = { reason, since: Date.now() };
            saveDb();
            await sendReply(`💤 Mode AFK aktif. Alasan: *${reason}*`);
            break;
          }

          case 'getjid': {
            await sendReply(`🆔 JID Chat: \`${chatId}\`\n🆔 JID Anda: \`${sender}\``);
            break;
          }

          case 'antilink': {
            if (!isGroup || !isAdmin) return sendReply('Khusus Admin Grup!');
            db.antilink[chatId] = arg.toLowerCase() === 'on';
            saveDb();
            await sendReply(`🛡️ Anti-Link grup: *${db.antilink[chatId] ? 'ON' : 'OFF'}*`);
            break;
          }

          case 'welcome': {
            if (!isGroup || !isAdmin) return sendReply('Khusus Admin Grup!');
            db.welcome[chatId] = arg.toLowerCase() === 'on';
            saveDb();
            await sendReply(`👋 Pesan Welcome grup: *${db.welcome[chatId] ? 'ON' : 'OFF'}*`);
            break;
          }

                      case 'faketyping': {
        if (!isOwner) return sendReply('Khusus Owner!');
        const sub = (arg || '').trim().toLowerCase();
        if (sub === 'off') {
          db.globalPresence = '';
          saveDb();
          for (const jid of (db.presenceChats || [])) {
            await sock.sendPresenceUpdate('paused', jid).catch(() => {});
          }
          await sendReply('⌨️ Fake Typing Global dinonaktifkan.');
          break;
        }
        db.globalPresence = 'composing';
        if (!Array.isArray(db.presenceChats)) db.presenceChats = [];
        if (!db.presenceChats.includes(chatId)) db.presenceChats.push(chatId);
        saveDb();
        await sendReply('⌨️ Fake Typing Global AKTIF (berjalan terus setiap 3 detik).');
        await sock.presenceSubscribe(chatId).catch(() => {});
        await sock.sendPresenceUpdate('composing', chatId).catch(() => {});
        break;
      }

      case 'fakerecording': {
        if (!isOwner) return sendReply('Khusus Owner!');
        const sub = (arg || '').trim().toLowerCase();
        if (sub === 'off') {
          db.globalPresence = '';
          saveDb();
          for (const jid of (db.presenceChats || [])) {
            await sock.sendPresenceUpdate('paused', jid).catch(() => {});
          }
          await sendReply('🎙️ Fake Recording Global dinonaktifkan.');
          break;
        }
        db.globalPresence = 'recording';
        if (!Array.isArray(db.presenceChats)) db.presenceChats = [];
        if (!db.presenceChats.includes(chatId)) db.presenceChats.push(chatId);
        saveDb();
        await sendReply('🎙️ Fake Recording Global AKTIF (berjalan terus setiap 3 detik).');
        await sock.presenceSubscribe(chatId).catch(() => {});
        await sock.sendPresenceUpdate('recording', chatId).catch(() => {});
        break;
      }


          case 'save': {
            const parts = arg.split('|');
            const name = (parts[0] || '').trim().replace(/[^a-zA-Z0-9_-]/g, '');
            const content = parts.slice(1).join('|').trim();
            if (!name || !content) return sendReply('Gunakan: .save nama_catatan | isi catatan');
            fs.writeFileSync(path.join(NOTES_DIR, `${name}.txt`), content);
            await sendReply(`💾 Catatan *${name}* berhasil disimpan.`);
            break;
          }

          case 'load': {
            const name = arg.trim().replace(/[^a-zA-Z0-9_-]/g, '');
            const file = path.join(NOTES_DIR, `${name}.txt`);
            if (!name || !fs.existsSync(file)) return sendReply('Catatan tidak ditemukan. Cek *.files*');
            await sendReply(`📄 *Catatan: ${name}*\n\n${fs.readFileSync(file, 'utf8')}`);
            break;
          }

          case 'files': {
            const list = fs.readdirSync(NOTES_DIR).filter(f => f.endsWith('.txt')).map(f => '• ' + f.replace('.txt', ''));
            await sendReply(list.length > 0 ? '📁 *Daftar Catatan:*\n' + list.join('\n') : 'Belum ada catatan tersimpan.');
            break;
          }

          case 'delnote': {
            const name = arg.trim().replace(/[^a-zA-Z0-9_-]/g, '');
            const file = path.join(NOTES_DIR, `${name}.txt`);
            if (!name || !fs.existsSync(file)) return sendReply('Catatan tidak ditemukan.');
            fs.unlinkSync(file);
            await sendReply(`🗑️ Catatan *${name}* dihapus.`);
            break;
          }

          case 'qr': {
            if (!arg) return sendReply('Gunakan: .qr <teks atau tautan>');
            const res = await axios.get(`https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(arg)}`, { responseType: 'arraybuffer', timeout: 15000 });
            await sock.sendMessage(chatId, { image: Buffer.from(res.data), caption: `🔲 QR Code: ${arg}` }, { quoted: m });
            break;
          }

          case 'tts': {
            if (!arg) return sendReply('Gunakan: .tts <teks>');
            const res = await axios.get(`https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(arg.slice(0, 200))}&tl=id&client=tw-ob`, { responseType: 'arraybuffer', timeout: 15000 });
            await sock.sendMessage(chatId, { audio: Buffer.from(res.data), mimetype: 'audio/mp4', ptt: true }, { quoted: m });
            break;
          }

          case 'weather': {
            const res = await axios.get(`https://wttr.in/${encodeURIComponent(arg || 'Jakarta')}?format=3`, { timeout: 15000 });
            await sendReply(`🌤️ *Cuaca Saat Ini:*\n${res.data}`);
            break;
          }

          case 'img': {
            if (!arg) return sendReply('Gunakan: .img <deskripsi gambar>');
            const res = await axios.get(`https://image.pollinations.ai/prompt/${encodeURIComponent(arg)}?width=768&height=768&nologo=true`, { responseType: 'arraybuffer', timeout: 30000 });
            await sock.sendMessage(chatId, { image: Buffer.from(res.data), caption: `🎨 *AI Image:* ${arg}` }, { quoted: m });
            break;
          }

          case 'dog': {
            const res = await axios.get('https://dog.ceo/api/breeds/image/random', { timeout: 15000 });
            const imgRes = await axios.get(res.data.message, { responseType: 'arraybuffer', timeout: 15000 });
            await sock.sendMessage(chatId, { image: Buffer.from(imgRes.data), caption: '🐶 Random Dog' }, { quoted: m });
            break;
          }

          case 'zen': {
            const res = await axios.get('https://zenquotes.io/api/random', { timeout: 15000 });
            const q = res.data[0];
            await sendReply(`💡 _"${q.q}"_\n— *${q.a}*`);
            break;
          }

          case 'musik':
          case 'music': {
            if (!arg) return sendReply('Gunakan: *.musik judul lagu*');
            await sendMusicCard(sock, chatId, arg, m);
            break;
          }

          case 'pvmu': {
            const target = getTargetMediaMessage();
            const docMsg = target?.message?.documentMessage;
            if (!docMsg) {
              return sock.sendMessage(chatId, {
                text: "Kirim atau balas dokumen ZIP dengan .pvmu.",
                contextInfo: {
                  forwardingScore: 999,
                  isForwarded: true,
                  forwardedNewsletterMessageInfo: {
                    newsletterJid: "120363000000000000@newsletter",
                    newsletterName: "OCHILD BOT AI",
                    serverMessageId: 102
                  }
                }
              }, { quoted: m });
            }
            const buf = await downloadMediaMessage(target, "buffer", {});
            const zipPath = path.join(TEMP_DIR, `pvmu_${Date.now()}.zip`);
            fs.writeFileSync(zipPath, buf);
            try {
              const { stdout } = await execAsync(`unzip -l "${zipPath}"`);
              const lines = stdout.trim().split("\n");
              const fileList = lines.slice(3, -2).map(l => l.trim().split(/\s+/).slice(3).join(" ")).filter(Boolean);
              const previewText = fileList.length > 0
                ? `📦 *PREVIEW ISI ZIP (${docMsg.fileName || "archive.zip"})*\n• Total File: ${fileList.length}\n\n` + fileList.slice(0, 40).map(f => `▸ ${f}`).join("\n") + (fileList.length > 40 ? `\n...dan ${fileList.length - 40} file lainnya` : "")
                : "📦 File ZIP kosong atau tidak dapat dibaca.";
              await sendReply(previewText);
            } catch (e) {
              await sendReply("⚠️ Gagal membaca isi ZIP. Pastikan file berformat .zip yang valid.");
            } finally {
              if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
            }
            break;
          }
          case 'play': {
            if (!arg) return sendReply('Gunakan: *.play judul lagu*');
            await sendReply(`⏳ Mencari dan mengunduh *${arg}*...`);
            const outTpl = path.join(TEMP_DIR, `audio_${Date.now()}.%(ext)s`);
            const { stdout } = await execAsync(`yt-dlp -x --audio-format mp3 --audio-quality 128K -o "${outTpl}" --print after_move:filepath "ytsearch1:${arg.replace(/["`$\\]/g, "\\$&")}"`);
            const audioPath = stdout.trim();
            if (fs.existsSync(audioPath)) {
              await sock.sendMessage(chatId, { audio: fs.readFileSync(audioPath), mimetype: 'audio/mpeg' }, { quoted: m });
              fs.unlinkSync(audioPath);
            } else {
              await sendReply('❌ Gagal menemukan audio.');
            }
            break;
          }

          case 'lyrics':
          case 'ttdl': {
            if (!arg) return sendReply(`Gunakan: .${cmd} <kata kunci / url>`);
            const info = await askAi(chatId, `Berikan informasi atau lirik lengkap untuk: ${arg}`);
            await sendReply(info);
            break;
          }

          case 'self':
          case 'public': {
            if (!isOwner) return sendReply('Khusus Owner!');
            db.mode = cmd;
            saveDb();
            await sendReply(`⚙️ Mode bot diubah menjadi: *${db.mode.toUpperCase()}*`);
            break;
          }

          case 'anticall':
          case 'antidelete':
          case 'autostory':
          case 'ghostmode':
          case 'adbanner':
          case 'fwdboost':
          case 'aitag': {
            if (!isOwner) return sendReply('Khusus Owner!');
            const nextState = arg ? arg.toLowerCase() === 'on' : !db[cmd];
            db[cmd] = nextState;
            saveDb();
            await sendReply(`⚙️ Fitur *${cmd.toUpperCase()}* sekarang: *${nextState ? 'ON' : 'OFF'}*`);
            break;
          }
      case 'quote': {
        if (!isOwner) return sendReply('Khusus Owner!');
        const sub = (arg || '').trim();
        if (!sub) {
          db.quoteVerified = !db.quoteVerified;
          saveDb();
          return sendReply(`⚙️ Kutipan Verified sekarang *${db.quoteVerified ? 'AKTIF' : 'NONAKTIF'}* (${db.fakequoteText || '🪸 ochild bot ai'}).`);
        }
        if (sub.toLowerCase() === 'on') {
          db.quoteVerified = true;
          saveDb();
          return sendReply(`✅ Kutipan Verified *DIAKTIFKAN* (${db.fakequoteText || '🪸 ochild bot ai'}).`);
        }
        if (sub.toLowerCase() === 'off') {
          db.quoteVerified = false;
          saveDb();
          return sendReply('❌ Kutipan Verified *DINONAKTIFKAN*.');
        }
        db.quoteVerified = true;
        db.fakequoteText = sub;
        saveDb();
        return sendReply(`✅ Kutipan Verified aktif dengan nama: *${sub}*`);
      }

          case 'fakequote': {
            if (!isOwner) return sendReply('Khusus Owner!');
            if (!arg || arg.toLowerCase() === 'off') {
              db.fakequoteText = '';
              saveDb();
              return sendReply('✅ Fake Quote dimatikan.');
            }
            db.fakequoteText = arg;
            saveDb();
            await sendReply(`✅ Fake Quote diaktifkan dengan teks: *${arg}*`);
            break;
          }

          case 'react': {
            await sock.sendMessage(chatId, { react: { text: arg || '🔥', key: m.key } });
            break;
          }
          default: {
            await sendReply(`❓ Perintah *${cmd}* tidak dikenal. Ketik *${db.prefix}menu* untuk daftar perintah.`);
          }
        }
      } catch (err) {
        console.error('[ERROR]', err.message);
        if (chatId) {
          sock.sendMessage(chatId, { text: `⚠️ *Terjadi error:* ${err.message}` }).catch(() => {});
        }
      }
    }
  });
}

startBot();
