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
const { exec, execFile } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Resolve FFmpeg from Nixpacks PATH, an explicit path, or ffmpeg-static.
function resolveFfmpegPath() {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try {
    const bundled = require('ffmpeg-static');
    if (bundled) candidates.push(bundled);
  } catch (_) {}
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate && fs.existsSync(candidate)) return candidate;
  }
  return 'ffmpeg'; // Nixpacks system package, resolved through PATH.
}
const FFMPEG_BIN = resolveFfmpegPath();

function shellQuote(value) { return "'" + String(value).replace(/'/g, "'\\''") + "'"; }

// Use execFile (argument array) so spaces, quotes and special characters in
// sticker text or temporary paths cannot corrupt the FFmpeg shell command.
async function runFfmpeg(args, options = {}) {
  try {
    return await new Promise((resolve, reject) => {
      execFile(FFMPEG_BIN, args.map(String), {
        maxBuffer: 16 * 1024 * 1024,
        ...options
      }, (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
        } else resolve({ stdout, stderr });
      });
    });
  } catch (error) {
    const detail = String(error.stderr || error.message || '').trim();
    if (error.code === 'ENOENT' || /ffmpeg: not found|not recognized as an internal/i.test(detail)) {
      throw new Error('FFmpeg tidak ditemukan pada server. Pastikan paket ffmpeg dipasang pada builder Railway (Railpack: railpack.json / Nixpacks: nixpacks.toml), lalu lakukan redeploy.');
    }
    if (/No such filter: ['"]?drawtext|Filter not found/i.test(detail)) {
      throw new Error('FFmpeg terpasang tetapi filter drawtext tidak tersedia. Gunakan paket FFmpeg Nix dengan dukungan freetype/fontconfig.');
    }
    throw new Error(`FFmpeg gagal: ${detail.slice(0, 900) || error.message}`);
  }
}

function checkFfmpegOnStartup() {
  execFile(FFMPEG_BIN, ['-version'], (error, stdout) => {
    if (error) {
      console.error('[FFMPEG] Tidak tersedia:', error.code === 'ENOENT' ? 'binary tidak ditemukan; periksa railpack.json atau nixpacks.toml sesuai builder Railway.' : error.message);
      return;
    }
    console.log('[FFMPEG] Siap:', String(stdout).split('\n')[0]);
    execFile(FFMPEG_BIN, ['-hide_banner', '-filters'], (filterError, filterOut, filterErr) => {
      if (filterError) console.warn('[FFMPEG] Tidak dapat memeriksa filter:', filterErr || filterError.message);
      else console.log('[FFMPEG] drawtext:', /\bdrawtext\b/.test(filterOut) ? 'tersedia' : 'TIDAK tersedia');
    });
  });
}

const SESSION_DIR = path.join(__dirname, 'auth_session');
if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true });

const DB_FILE = path.join(SESSION_DIR, 'database.json');
const NOTES_DIR = path.join(SESSION_DIR, 'notes_storage');
const TEMP_DIR = path.join(__dirname, 'temp');

const PLUGINS_DIR = path.join(__dirname, 'plugins');
const PLUGIN_STORAGE_DIR = path.join(PLUGINS_DIR, 'storage');
const PLUGIN_MEDIA_DIR = path.join(PLUGINS_DIR, 'media');
const pluginCooldowns = new Map();
const pluginRuntimeData = new Map();
const pluginSeenMessages = new Set();
for (const d of [PLUGINS_DIR, PLUGIN_STORAGE_DIR, PLUGIN_MEDIA_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

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
  channelJid: '',
  anticall: false,
  antidelete: false,
  autostory: false,
  ghostmode: false,
  adbanner: false,
  fwdboost: false,
  aitag: false,
  quoteVerified: false,
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
    const stored = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) db = Object.assign(db, stored);
  } catch (e) {
    console.error('[DATABASE] database.json tidak valid; memakai pengaturan default:', e.message);
  }
}
if (typeof db.prefix !== 'string' || !db.prefix.trim()) db.prefix = '.';
if (!['public', 'self'].includes(db.mode)) db.mode = 'public';
for (const key of ['antilink', 'welcome', 'users', 'afk']) {
  if (!db[key] || typeof db[key] !== 'object' || Array.isArray(db[key])) db[key] = {};
}
if (!Array.isArray(db.presenceChats)) db.presenceChats = [];
db.autoDelSeconds = Math.max(0, Math.min(86400, Number(db.autoDelSeconds) || 0));

function saveDb() {
  try {
    const tempFile = `${DB_FILE}.tmp`;
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2));
    fs.renameSync(tempFile, DB_FILE);
  } catch (e) {
    console.error('[DATABASE] Gagal menyimpan database:', e.message);
  }
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

const aiHistories = {};
const deletedMessagesCache = {};
const processedIds = new Set();
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
  if (db.grokApiKey) providers.push({
    name: 'Grok',
    url: 'https://api.x.ai/v1/chat/completions',
    model: 'grok-3-mini',
    key: db.grokApiKey
  });
  if (db.groqApiKey) providers.push({
    name: 'Groq',
    url: 'https://api.groq.com/openai/v1/chat/completions',
    model: 'llama-3.3-70b-versatile',
    key: db.groqApiKey
  });

  for (const provider of providers) {
    try {
      const res = await axios.post(provider.url,
        { model: provider.model, messages },
        { headers: { Authorization: `Bearer ${provider.key}`, 'Content-Type': 'application/json' }, timeout: 25000 }
      );
      const reply = res.data?.choices?.[0]?.message?.content;
      if (typeof reply !== 'string' || !reply.trim()) throw new Error(`${provider.name} mengembalikan jawaban kosong`);
      aiHistories[chatId].push({ role: 'user', content: prompt }, { role: 'assistant', content: reply });
      aiHistories[chatId] = aiHistories[chatId].slice(-20);
      return reply.trim();
    } catch (e) {
      console.error(`[AI ${provider.name}]`, e.response?.data?.error?.message || e.message);
    }
  }

  try {
    const encoded = encodeURIComponent(sys + '\n\nUser: ' + prompt);
    const res = await axios.get(`https://text.pollinations.ai/${encoded}`, { timeout: 25000 });
    const reply = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    if (!reply || !reply.trim()) throw new Error('Balasan AI kosong');
    aiHistories[chatId].push({ role: 'user', content: prompt }, { role: 'assistant', content: reply });
    aiHistories[chatId] = aiHistories[chatId].slice(-20);
    return reply.trim();
  } catch (e) {
    throw new Error('Semua layanan AI gagal. Periksa API key/koneksi lalu coba lagi.');
  }
}

async function createWebpSticker(inputBuffer, isVideo, packname, author) {
  const id = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const ext = isVideo ? 'mp4' : 'png';
  const inputPath = path.join(TEMP_DIR, `in_${id}.${ext}`);
  const outputPath = path.join(TEMP_DIR, `out_${id}.webp`);
  fs.writeFileSync(inputPath, inputBuffer);

  try {
    if (isVideo) {
      await runFfmpeg(['-y', '-i', inputPath, '-vcodec', 'libwebp', '-filter:v', 'fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000', '-loop', '0', '-t', '7', '-preset', 'default', '-an', '-fps_mode', 'vfr', outputPath]);
    } else {
      await runFfmpeg(['-y', '-i', inputPath, '-vcodec', 'libwebp', '-filter:v', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000', '-lossless', '1', '-preset', 'default', '-an', '-fps_mode', 'vfr', outputPath]);
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
    await runFfmpeg(['-y', '-i', inPath, outPath]);
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
    const info = `🎵 *${track.trackName || query}*\n👤 ${track.artistName || 'Unknown Artist'}\n💿 ${track.collectionName || '-'}\n${track.previewUrl ? `▶ Preview: ${track.previewUrl}` : 'Preview tidak tersedia.'}`;
    return sock.sendMessage(chatId, { text: info }, { quoted: quotedMsg });
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
  if (db.aitag) ctx.mentionedJid = [m.key.participant || m.key.remoteJid].filter(Boolean);
  // Do not forge forwarded-channel or ad metadata; it misrepresents message origin.
  return Object.keys(ctx).length ? ctx : undefined;
}

function buildQuotedOption(m) {
  return m ? { quoted: m } : {};
}

let presenceInterval = null;

function startPresenceLoop(sock) {
  if (presenceInterval) clearInterval(presenceInterval);
  presenceInterval = setInterval(async () => {
    if (!db.globalPresence || db.ghostmode) return;
    const targets = Array.isArray(db.presenceChats) ? db.presenceChats : [];
    for (const jid of targets) {
      try {
        await sock.presenceSubscribe(jid);
        await sock.sendPresenceUpdate(db.globalPresence, jid);
      } catch (e) {}
    }
  }, 8000);
}



function safePluginId(id) {
  return /^[a-zA-Z0-9_-]{1,128}$/.test(String(id || ''));
}
function safePluginPath(root, name) {
  const candidate = path.resolve(root, String(name || ''));
  if (candidate !== root && !candidate.startsWith(root + path.sep)) throw new Error('Path plugin tidak diizinkan.');
  return candidate;
}
function pluginResolveValue(value, vars) {
  if (typeof value === 'string') {
    const exact = value.match(/^\{([a-zA-Z0-9_.|:-]+)\}$/);
    if (exact && !['args|url','args|json','random_1_100','random_1_1000'].includes(exact[1])) {
      const builtins = {chat:vars.chat,sender:vars.sender,senderJid:vars.senderJid,pushName:vars.pushName,text:vars.text,args:vars.args,command:vars.command,messageId:vars.messageId,quotedText:vars.quotedText,quotedId:vars.quotedId,quotedSender:vars.quotedSender,time:vars.time,date:vars.date,isGroup:vars.isGroup,fromMe:vars.fromMe,hasMedia:vars.hasMedia,messageType:vars.messageType,item:vars.item,index:vars.index,number:vars.number,argsCount:(String(vars.args||'').trim()?String(vars.args).trim().split(/\s+/).length:0),arg1:String(vars.args||'').trim().split(/\s+/)[0]||'',arg2:String(vars.args||'').trim().split(/\s+/)[1]||'',senderNumber:vars.senderNumber,quotedMediaType:vars.quotedMediaType,mentions:vars.mentions,mentionedJid:vars.mentions,hasMentions:vars.hasMentions,mentionsMe:vars.mentionsMe,buttonId:vars.buttonId,reactionEmoji:vars.reactionEmoji,isAdmin:vars.isAdmin,isBotAdmin:vars.isBotAdmin,isBot:vars.isBot,isEdited:vars.isEdited,isViewOnce:vars.isViewOnce};
      if (Object.prototype.hasOwnProperty.call(builtins,exact[1])) return builtins[exact[1]];
      const found=exact[1].split('.').reduce((obj,key)=>obj==null?undefined:obj[key],vars.results);
      if(found!==undefined) return found;
    }
    return value.replace(/\{([a-zA-Z0-9_.|:-]+)\}/g, (_, token) => {
      if (token === 'args|url') return encodeURIComponent(vars.args || '');
      if (token === 'args|json') return JSON.stringify(vars.args || '');
      if (token === 'random_1_100') return String(Math.floor(Math.random() * 100) + 1);
      if (token === 'random_1_1000') return String(Math.floor(Math.random() * 1000) + 1);
      const builtins = {
        chat: vars.chat, sender: vars.sender, senderJid: vars.senderJid, pushName: vars.pushName,
        text: vars.text, args: vars.args, command: vars.command, messageId: vars.messageId,
        quotedText: vars.quotedText, quotedId: vars.quotedId, quotedSender: vars.quotedSender,
        time: vars.time, date: vars.date, isGroup: String(vars.isGroup), fromMe: String(vars.fromMe),
        hasMedia: String(vars.hasMedia), messageType: vars.messageType, item: vars.item,
        index: vars.index, number: vars.number, argsCount:(String(vars.args||'').trim()?String(vars.args).trim().split(/\s+/).length:0), arg1:String(vars.args||'').trim().split(/\s+/)[0]||'', arg2:String(vars.args||'').trim().split(/\s+/)[1]||'', senderNumber:vars.senderNumber, quotedMediaType:vars.quotedMediaType, mentions:vars.mentions, mentionedJid:vars.mentions, hasMentions:vars.hasMentions, mentionsMe:vars.mentionsMe, buttonId:vars.buttonId, reactionEmoji:vars.reactionEmoji, isAdmin:vars.isAdmin, isBotAdmin:vars.isBotAdmin, isBot:vars.isBot, isEdited:vars.isEdited, isViewOnce:vars.isViewOnce
      };
      if (Object.prototype.hasOwnProperty.call(builtins, token)) return String(builtins[token] ?? '');
      const result = token.split('.').reduce((obj, key) => obj == null ? undefined : obj[key], vars.results);
      return result == null ? '' : (typeof result === 'object' ? JSON.stringify(result) : String(result));
    });
  }
  if (Array.isArray(value)) return value.map(v => pluginResolveValue(v, vars));
  if (value && typeof value === 'object') {
    if (Object.keys(value).length === 1 && typeof value.$ref === 'string') {
      return value.$ref.split('.').reduce((obj, key) => obj == null ? undefined : obj[key], vars.results);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = pluginResolveValue(v, vars);
    return out;
  }
  return value;
}
function pluginRuleMatches(rule, vars) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) return false;
  if (vars.fromMe && rule.fromMe!==true && rule.allowSelf!==true && !['self','me','owner'].includes(String(rule.scope||rule.senderScope||'').toLowerCase())) return false;
  const body=String(vars.text||'').trim(), lower=body.toLowerCase(), checks=[];
  const asList=x=>Array.isArray(x)?x:String(x??'').split(',').map(v=>v.trim()).filter(Boolean);
  let args='';
  const command=rule.command||rule.cmd;
  if(command){const c=String(command).trim().toLowerCase();const hit=lower===c||lower.startsWith(c+' ');checks.push(hit);if(hit)args=body.slice(String(command).trim().length).trim();}
  if(rule.aliases){const aliases=asList(rule.aliases);const hit=aliases.find(x=>lower===String(x).toLowerCase()||lower.startsWith(String(x).toLowerCase()+' '));checks.push(Boolean(hit));if(hit)args=body.slice(String(hit).length).trim();}
  if(rule.exact!==undefined)checks.push(lower===String(rule.exact).trim().toLowerCase());
  if(rule.contains!==undefined)checks.push(lower.includes(String(rule.contains).toLowerCase()));
  if(rule.prefix!==undefined){const pref=String(rule.prefix);const hit=body.startsWith(pref);checks.push(hit);if(hit)args=body.slice(pref.length).trim();}
  if(rule.regex!==undefined){try{const match=body.match(new RegExp(rule.regex,rule.ignoreCase===false?'':'i'));checks.push(Boolean(match));if(match&&match.length>1)args=match.at(-1)||'';}catch{return false;}}
  if(rule.always===true)checks.push(true);
  // Any text condition AND every metadata filter must match. Filter-only rules are supported.
  const types=rule.messageTypes??rule.messageType;if(types)checks.push(asList(types).some(t=>String(t).toLowerCase()==='any'||String(t).toLowerCase()===String(vars.messageType||'').toLowerCase()));
  const mediaTypes=rule.mediaTypes??rule.mediaType;if(mediaTypes)checks.push(asList(mediaTypes).some(t=>String(t).toLowerCase()==='any'||String(t).toLowerCase()===String(vars.mediaType||'').toLowerCase()));
  for(const k of ['hasMedia','isViewOnce','isEdited','fromMe','isGroup','isBot'])if(rule[k]!==undefined)checks.push(Boolean(vars[k])===Boolean(rule[k]));
  if(rule.reactionEmoji!==undefined)checks.push(String(vars.reactionEmoji||'')===String(rule.reactionEmoji));
  if(rule.buttonId!==undefined)checks.push(String(vars.buttonId||'')===String(rule.buttonId));
  if(rule.hasQuote!==undefined||rule.quotedOnly!==undefined)checks.push(Boolean(vars.quotedId)===Boolean(rule.hasQuote??rule.quotedOnly));
  if(rule.quotedHasMedia!==undefined)checks.push(Boolean(vars.quotedHasMedia)===Boolean(rule.quotedHasMedia));
  if(rule.quotedMediaType||rule.quotedMediaTypes)checks.push(asList(rule.quotedMediaType??rule.quotedMediaTypes).some(t=>String(t).toLowerCase()===String(vars.quotedMediaType||'').toLowerCase()));
  if(rule.mentionsMe!==undefined)checks.push(Boolean(vars.mentionsMe)===Boolean(rule.mentionsMe));
  if(rule.hasMentions!==undefined)checks.push(Boolean(vars.hasMentions)===Boolean(rule.hasMentions));
  const scope=String(rule.scope||rule.senderScope||'any').toLowerCase();
  if(['self','me','owner'].includes(scope))checks.push(Boolean(vars.fromMe||vars.isOwner));
  if(['others','public'].includes(scope))checks.push(!vars.fromMe&&!vars.isOwner);
  if(rule.allowSelf===false&&vars.fromMe)checks.push(false);
  if(rule.groupOnly||rule.isGroup===true)checks.push(Boolean(vars.isGroup));
  if(rule.dmOnly||rule.privateOnly||rule.isGroup===false)checks.push(!vars.isGroup);
  if(rule.chatType)checks.push(['dm','direct','private'].includes(String(rule.chatType).toLowerCase())?!vars.isGroup:String(rule.chatType).toLowerCase()==='group'&&vars.isGroup);
  if(rule.chats)checks.push(asList(rule.chats).some(x=>String(x).includes('@')?x===vars.chat:x===String(vars.chat||'').split('@')[0]));
  if(rule.excludeChats)checks.push(!asList(rule.excludeChats).some(x=>String(x).includes('@')?x===vars.chat:x===String(vars.chat||'').split('@')[0]));
  if(rule.senders)checks.push(asList(rule.senders).some(x=>String(x).includes('@')?x===vars.senderJid:x===vars.sender||x===vars.senderNumber));
  if(rule.excludeSenders)checks.push(!asList(rule.excludeSenders).some(x=>String(x).includes('@')?x===vars.senderJid:x===vars.sender||x===vars.senderNumber));
  if(rule.adminOnly)checks.push(Boolean(vars.isAdmin));
  if(rule.botAdminRequired)checks.push(Boolean(vars.isBotAdmin));
  if(rule.ignoreBots)checks.push(!vars.isBot);
  if(checks.length===0)return false;
  if(!checks.every(Boolean))return false;
  vars.args=args;return true;
}

function pluginPublicUrlAllowed(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (!['http:', 'https:'].includes(u.protocol)) return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1') return false;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a=+ipv4[1], b=+ipv4[2];
    if ([a,b,+ipv4[3],+ipv4[4]].some(n=>n>255) || a===0 || a===10 || a===127 || a===169&&b===254 || a===192&&b===168 || a===172&&b>=16&&b<=31 || a>=224) return false;
  }
  return true;
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
  const originalSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (jid, content, options = {}) => {
    const defaultCtx = buildContextInfo({ key: { remoteJid: jid } }) || {};
    if (content && typeof content === 'object' && !content.react && !content.delete && !content.sticker && !content.poll) {
      content.contextInfo = { ...defaultCtx, ...(content.contextInfo || {}) };
    }
    // Rolleys outgoing text transforms (prefix/suffix, replacements, case, shortcodes).
    if (content && typeof content === 'object' && !content.react && !content.delete && !content.forward) {
      const enabled = listPlugins().filter(({plugin}) => plugin?.enabled === true && plugin.rules?.textTransform);
      const transformText = (input, plugin) => {
        if (typeof input !== 'string') return input;
        const cfg=plugin.rules.textTransform||{}; const template=plugin.rules.template||{};
        let value=input;
        const interpolate=(str)=>String(str).replace(/\{(time|date|chat|sender|messageType|random_1_100|random_1_1000)\}/g,(_,k)=>({time:new Date().toLocaleTimeString('id-ID'),date:new Date().toLocaleDateString('id-ID'),chat:jid,sender:'Bot',messageType:'text',random_1_100:String(Math.floor(Math.random()*100)+1),random_1_1000:String(Math.floor(Math.random()*1000)+1)}[k]||''));
        if(cfg.enabled!==false){
          if(cfg.prefix)value=interpolate(cfg.prefix)+value;
          if(cfg.suffix)value=value+interpolate(cfg.suffix);
          for(const repl of (cfg.replace||[])){
            if(!repl?.from)continue;
            try{value=value.replace(repl.regex?new RegExp(repl.from,repl.ignoreCase?'gi':'g'):new RegExp(String(repl.from).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),repl.ignoreCase?'gi':'g'),String(repl.to??''));}catch(e){console.warn('[PLUGIN TRANSFORM]',e.message);}
          }
          const mode=String(cfg.case||'none').toLowerCase(); if(mode==='uppercase')value=value.toUpperCase(); else if(mode==='lowercase')value=value.toLowerCase(); else if(mode==='reverse')value=[...value].reverse().join('');
        }
        if(template.placeholders!==false)value=interpolate(value);
        for(const [short,emoji] of Object.entries(plugin.rules.shortcodes||{}))value=value.split(short).join(String(emoji));
        return value;
      };
      for(const {plugin} of enabled){
        const allowed=plugin.rules.messageTypes||plugin.rules.messageType; const typeName=content.image?'image':content.video?'video':content.audio?(content.ptt?'voice':'audio'):content.document?'document':content.sticker?'sticker':content.location?'location':content.contact?'contact':content.poll?'poll':'text'; if(allowed&&!(Array.isArray(allowed)?allowed:String(allowed).split(',')).map(x=>String(x).trim().toLowerCase()).includes(typeName))continue;
        for(const key of ['text','caption'])if(typeof content[key]==='string')content[key]=transformText(content[key],plugin);
        if(content.poll&&typeof content.poll==='object'){
          if(typeof content.poll.name==='string')content.poll.name=transformText(content.poll.name,plugin);
          if(Array.isArray(content.poll.values))content.poll.values=content.poll.values.map(v=>transformText(v,plugin));
        }
        if(content.document&&typeof content.document==='object'&&typeof content.document.fileName==='string')content.document.fileName=transformText(content.document.fileName,plugin); if(content.location&&typeof content.location.name==='string')content.location.name=transformText(content.location.name,plugin); if(content.location&&typeof content.location.address==='string')content.location.address=transformText(content.location.address,plugin); if(content.contact&&typeof content.contact.displayName==='string')content.contact.displayName=transformText(content.contact.displayName,plugin);
      }
    }
    return originalSendMessage(jid, content, options);
  };

  const listPlugins = () => fs.readdirSync(PLUGINS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('.'))
    .map(f => { try { return { file: f, plugin: JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, f), 'utf8')) }; } catch { return { file: f, plugin: null }; } })
    .sort((a,b) => String(a.plugin?.name || a.file).localeCompare(String(b.plugin?.name || b.file)));

  const executePluginActions = async (actions, vars, quoted) => {
    if (!Array.isArray(actions)) actions = [actions];
    for (const raw of actions) {
      if (typeof raw === 'string') { await sock.sendMessage(vars.chat, { text: pluginResolveValue(raw, vars) }, quoted ? { quoted } : {}); continue; }
      if (!raw || typeof raw !== 'object') continue;
      const action = pluginResolveValue(raw, vars);
      if (action.when !== undefined) {
        const conditionText = String(action.when ?? '');
        let passed = false;
        if (action.is !== undefined) passed = conditionText === String(action.is);
        else if (action.isNot !== undefined) passed = conditionText !== String(action.isNot);
        else if (action.contains !== undefined) passed = conditionText.includes(String(action.contains));
        else if (action.matches !== undefined) { try { passed = new RegExp(action.matches, action.ignoreCase === false ? '' : 'i').test(conditionText); } catch {} }
        else if (action.notEmpty !== undefined) passed = conditionText.length > 0;
        else if (action.empty !== undefined) passed = conditionText.length === 0;
        await executePluginActions(passed ? action.then : action.else, vars, quoted); continue;
      }
      if (action.each !== undefined) {
        const list = action.each;
        const items = Array.isArray(list) ? list : [];
        const max = Math.max(0, Math.min(20, Number(action.limit || 20)));
        for (let i=0;i<Math.min(items.length,max);i++) {
          const old={item:vars.item,index:vars.index,number:vars.number,argsCount:(String(vars.args||'').trim()?String(vars.args).trim().split(/\s+/).length:0),arg1:String(vars.args||'').trim().split(/\s+/)[0]||'',arg2:String(vars.args||'').trim().split(/\s+/)[1]||'',senderNumber:vars.senderNumber,quotedMediaType:vars.quotedMediaType,mentions:vars.mentions,mentionedJid:vars.mentions,hasMentions:vars.hasMentions,mentionsMe:vars.mentionsMe,buttonId:vars.buttonId,reactionEmoji:vars.reactionEmoji,isAdmin:vars.isAdmin,isBotAdmin:vars.isBotAdmin,isBot:vars.isBot,isEdited:vars.isEdited,isViewOnce:vars.isViewOnce};
          vars.item=items[i]; vars.index=i; vars.number=i+1;
          await executePluginActions(action.actions,vars,quoted);
          Object.assign(vars,old);
        }
        continue;
      }
      if (action.parse !== undefined) {
        const source=pluginResolveValue(action.parse,vars); let parsed=source;
        if(typeof source==='string') { try { parsed=JSON.parse(source); } catch { parsed=source; } }
        if(action.extract&&parsed&&typeof parsed==='object') { const extracted={}; for(const [k,v] of Object.entries(action.extract)) { extracted[k]=String(v).split('.').reduce((o,p)=>o==null?undefined:o[p],parsed); } parsed=extracted; }
        vars.results[action.saveAs||'parsed']=parsed; continue;
      }
      if(action.download !== undefined) {
        let source=action.download, mediaTarget=null, bytes=null, mime='application/octet-stream', fileName='download.bin';
        if(source===true||source==='quoted'||source==='auto') { mediaTarget=source==='quoted'?(vars.quotedMessage?{key:vars.quotedMessage.key,message:vars.quotedMessage.message}:vars.mediaMessage):vars.mediaMessage; if(!mediaTarget) throw new Error('Tidak ada media pada pesan atau kutipan.'); bytes=await downloadMediaMessage(mediaTarget,'buffer',{}); const inner=extractMessageContent(mediaTarget.message); const media=inner.imageMessage||inner.videoMessage||inner.audioMessage||inner.documentMessage||inner.stickerMessage; mime=media?.mimetype||'application/octet-stream'; fileName=media?.fileName||`${Date.now()}.${mime.split('/')[1]||'bin'}`; }
        else if(typeof source==='string'&&/^https?:\/\//i.test(source)) { if(!pluginPublicUrlAllowed(source)) throw new Error('URL download tidak aman.'); const response=await axios.get(source,{responseType:'arraybuffer',timeout:30000,maxContentLength:25*1024*1024,maxBodyLength:25*1024*1024,maxRedirects:0}); bytes=Buffer.from(response.data); mime=response.headers['content-type']||mime; fileName=path.basename(new URL(source).pathname)||fileName; }
        else throw new Error('Sumber download harus URL publik atau media pesan.');
        if(bytes.length>25*1024*1024)throw new Error('Media lebih besar dari batas 25 MB.');
        fileName=String(fileName).replace(/[^a-zA-Z0-9._-]/g,'_').slice(0,120)||'download.bin';
        const file=safePluginPath(PLUGIN_MEDIA_DIR,`${vars.pluginId}_${Date.now()}_${fileName}`); fs.writeFileSync(file,bytes);
        const mimeType=mime.split(';')[0].toLowerCase(); const mediaType=mimeType.startsWith('image/')?'image':mimeType.startsWith('video/')?'video':mimeType.startsWith('audio/')?'audio':'document';
        const result={path:file,fileName,size:bytes.length,mimeType,mediaType}; vars.downloadedPath=file;vars.downloadedFileName=fileName;vars.downloadedSize=bytes.length;vars.downloadedMime=mimeType;vars.downloadedMediaType=mediaType;vars.results[action.saveAs||'download']=result; continue;
      }
      if(action.saveViewOnce) {
        const target=vars.mediaMessage|| (vars.quotedMessage?{key:vars.quotedMessage.key,message:vars.quotedMessage.message}:null);
        if(!target)throw new Error('Reply/kirim media view-once terlebih dahulu.');
        const inner=extractMessageContent(target.message); const media=inner?.imageMessage||inner?.videoMessage||inner?.audioMessage||inner?.documentMessage;
        if(!media)throw new Error('Media quoted tidak didukung atau tidak ditemukan.');
        const bytes=await downloadMediaMessage(target,'buffer',{}); const type=inner.imageMessage?'image':inner.videoMessage?'video':inner.audioMessage?'audio':'document';
        const payload={[type]:bytes}; if(media.caption)payload.caption=media.caption;if(type==='audio')payload.mimetype=media.mimetype||'audio/mpeg';if(type==='document')payload.fileName=media.fileName||'media';
        await sock.sendMessage(vars.chat,payload,action.quote&&quoted?{quoted}:{});continue;
      }
      if(action.toImage) {
        const target=vars.mediaMessage|| (vars.quotedMessage?{key:vars.quotedMessage.key,message:vars.quotedMessage.message}:null);
        const sticker=extractMessageContent(target?.message)?.stickerMessage; if(!sticker)throw new Error('Reply stiker terlebih dahulu.');
        const bytes=await downloadMediaMessage(target,'buffer',{}); const png=await webpToPng(bytes); await sock.sendMessage(vars.chat,{image:png,caption:'Converted sticker to image'},action.quote&&quoted?{quoted}:{});continue;
      }
      if(action.sticker===true) {
        const target=vars.mediaMessage|| (vars.quotedMessage?{key:vars.quotedMessage.key,message:vars.quotedMessage.message}:null); if(!target)throw new Error('Kirim atau reply media untuk dibuat stiker.');
        const inner=extractMessageContent(target.message); const isVideo=Boolean(inner?.videoMessage); const bytes=await downloadMediaMessage(target,'buffer',{}); const sticker=await createWebpSticker(bytes,isVideo,action.packname||'Rolleys Plugin',action.author||'Ochild Bot'); await sock.sendMessage(vars.chat,{sticker},action.quote&&quoted?{quoted}:{});continue;
      }
      if(action.media!==undefined) {
        let src=action.media; let mediaBytes=null; let mime='application/octet-stream'; let type=action.as||'';
        if(src===true||src==='quoted'||src==='auto') { const target=src==='quoted'?(vars.quotedMessage?{key:vars.quotedMessage.key,message:vars.quotedMessage.message}:vars.mediaMessage):vars.mediaMessage; if(!target)throw new Error('Tidak ada media input.'); const inner=extractMessageContent(target.message); const msg=inner.imageMessage||inner.videoMessage||inner.audioMessage||inner.documentMessage; if(!msg)throw new Error('Jenis media input tidak dikenal.'); mediaBytes=await downloadMediaMessage(target,'buffer',{});mime=msg.mimetype||mime;type=type|| (inner.imageMessage?'image':inner.videoMessage?'video':inner.audioMessage?'audio':'document'); }
        else if(typeof src==='string'&&/^https?:\/\//i.test(src)) { if(!pluginPublicUrlAllowed(src))throw new Error('URL media tidak aman.'); const response=await axios.get(src,{responseType:'arraybuffer',timeout:30000,maxContentLength:25*1024*1024,maxRedirects:0});mediaBytes=Buffer.from(response.data);mime=response.headers['content-type']||mime;type=type|| (mime.startsWith('image/')?'image':mime.startsWith('video/')?'video':mime.startsWith('audio/')?'audio':'document'); }
        if(!['image','video','audio','document'].includes(type))type='document'; const payload={[type]:mediaBytes||{url:src}};if(action.caption)payload.caption=pluginResolveValue(action.caption,vars);if(action.fileName)payload.fileName=action.fileName;if(action.ptt||action.voice)payload.ptt=true;if(type==='audio')payload.mimetype=mime;
        await sock.sendMessage(action.toJid||vars.chat,payload,action.quote&&quoted?{quoted}:{});continue;
      }
      if (action.method) {
        const method=String(action.method), args=action.args||{};
        try {
          if (method === 'httpRequest') {
            if (!pluginPublicUrlAllowed(args.url)) throw new Error('URL HTTP hanya boleh menuju host publik.');
            const response=await axios({url:args.url,method:args.method||'GET',headers:args.headers,params:args.query,data:args.body,timeout:Math.min(120000,Math.max(1000,Number(args.timeoutMs||15000))),maxRedirects:0,responseType:args.responseType==='arraybuffer'?'arraybuffer':'text',maxContentLength:10*1024*1024});
            let body=response.data;
            if (args.responseType==='json' && typeof body==='string') { try { body=JSON.parse(body); } catch {} }
            vars.results[action.saveAs||'http']={status:response.status,body,json:body,headers:response.headers,url:args.url};
          } else if (method === 'sendText' || method === 'sendMessage') {
            const dest=args.toJid||args.chatJid||vars.chat;
            const payload=method==='sendText'?{text:args.text||''}:args.message||args.content||{text:args.text||''};
            const sent=await sock.sendMessage(dest,payload,args.quote&&quoted?{quoted}:{}); vars.results[action.saveAs||'send']={ok:true,key:sent?.key};
          } else if (['sendImage','sendVideo','sendAudio','sendDocument','sendSticker'].includes(method)) {
            const type=method==='sendImage'?'image':method==='sendVideo'?'video':method==='sendAudio'?'audio':method==='sendDocument'?'document':'sticker';
            const source=args.url||args.path||args.filePath||args[type]; if (!source) throw new Error('Sumber media kosong.');
            const payload={}; if(/^https?:\/\//i.test(source)&&!pluginPublicUrlAllowed(source))throw new Error('URL media tidak aman.'); payload[type]=/^https?:\/\//i.test(source)?{url:source}:fs.readFileSync(safePluginPath(PLUGINS_DIR,source));
            if(args.caption)payload.caption=args.caption; if(args.fileName)payload.fileName=args.fileName; if(args.ptt)payload.ptt=true;
            const sent=await sock.sendMessage(args.toJid||vars.chat,payload,args.quote&&quoted?{quoted}:{}); vars.results[action.saveAs||'send']={ok:true,key:sent?.key};
          } else if (method==='react') {
            await sock.sendMessage(vars.chat,{react:{text:args.emoji||args.text||'👍',key:vars.messageKey}}); vars.results[action.saveAs||'react']={ok:true};
          } else if (method==='deleteMessage') {
            await sock.sendMessage(vars.chat,{delete:args.key||vars.messageKey}); vars.results[action.saveAs||'delete']={ok:true};
          } else if (method==='forwardMessage') {
            if(!vars.quotedMessage) throw new Error('Tidak ada pesan yang dikutip.');
            await sock.sendMessage(args.toJid||vars.chat,{forward:vars.quotedMessage}); vars.results[action.saveAs||'forward']={ok:true};
          } else if (method==='groupParticipantsUpdate') {
            if(!vars.isGroup) throw new Error('Aksi ini hanya untuk grup.'); if(!vars.isAdmin||!vars.isBotAdmin) throw new Error('Moderasi memerlukan admin grup dan bot admin.');
            const participants=[].concat(args.participants||[]); await sock.groupParticipantsUpdate(vars.chat,participants,args.action); vars.results[action.saveAs||'group']={ok:true};
          } else if (method==='groupSettingUpdate') {
            if(!vars.isGroup) throw new Error('Aksi ini hanya untuk grup.'); if(!vars.isAdmin||!vars.isBotAdmin) throw new Error('Aksi grup memerlukan admin dan bot admin.'); await sock.groupSettingUpdate(vars.chat,args.setting); vars.results[action.saveAs||'group']={ok:true};
          } else if (method==='groupUpdateSubject') {
            if(!vars.isGroup) throw new Error('Aksi ini hanya untuk grup.'); if(!vars.isAdmin||!vars.isBotAdmin) throw new Error('Aksi grup memerlukan admin dan bot admin.'); await sock.groupUpdateSubject(vars.chat,args.subject); vars.results[action.saveAs||'group']={ok:true};
          } else if (method==='groupUpdateDescription') {
            if(!vars.isGroup) throw new Error('Aksi ini hanya untuk grup.'); if(!vars.isAdmin||!vars.isBotAdmin) throw new Error('Aksi grup memerlukan admin dan bot admin.'); await sock.groupUpdateDescription(vars.chat,args.description); vars.results[action.saveAs||'group']={ok:true};
          } else if (method==='curl') {
            // Accept a simple curl URL/options subset; never execute curl/shell commands.
            const raw=String(action.curl||args.command||args.url||'').trim();
            const tokens=raw.match(/(?:[^\s\\]+|\\.)+|\"[^\"]*\"|'[^']*'/g)||[];
            let url='', httpMethod='GET', headers={}, body;
            for(let i=0;i<tokens.length;i++) { const t=tokens[i].replace(/^['\"]|['\"]$/g,''); if(/^https?:\/\//i.test(t)){url=t;continue;} if(['-X','--request'].includes(t)){httpMethod=(tokens[++i]||'GET').replace(/^['\"]|['\"]$/g,'');continue;} if(['-H','--header'].includes(t)){const h=(tokens[++i]||'').replace(/^['\"]|['\"]$/g,'');const at=h.indexOf(':');if(at>0)headers[h.slice(0,at).trim()]=h.slice(at+1).trim();continue;} if(['-d','--data','--data-raw'].includes(t)){body=(tokens[++i]||'').replace(/^['\"]|['\"]$/g,'');if(httpMethod==='GET')httpMethod='POST';continue;} }
            if(!pluginPublicUrlAllowed(url)) throw new Error('URL curl tidak valid atau host lokal diblokir.');
            const response=await axios({url,method:httpMethod,headers,data:body,timeout:Math.min(120000,Number(args.timeoutMs||30000)),maxRedirects:0,maxContentLength:10*1024*1024,responseType:'text'});
            let parsed=response.data;try{parsed=JSON.parse(parsed);}catch{} vars.results[action.saveAs||'curl']={status:response.status,body:response.data,json:parsed,headers:response.headers,url};
          } else if (method==='storageWrite') {
            const id=vars.pluginId; const name=String(args.name||args.fileName||'data.json').replace(/[^a-zA-Z0-9._-]/g,'_'); const file=safePluginPath(PLUGIN_STORAGE_DIR,`${id}_${name}`); const data=args.content??args.data??''; fs.writeFileSync(file,typeof data==='string'?data:JSON.stringify(data,null,2)); vars.results[action.saveAs||'storageWrite']={ok:true,path:file};
          } else if (method==='storageRead') {
            const name=String(args.name||args.fileName||'data.json').replace(/[^a-zA-Z0-9._-]/g,'_'); const file=safePluginPath(PLUGIN_STORAGE_DIR,`${vars.pluginId}_${name}`); const data=fs.readFileSync(file,'utf8'); let parsed=data;try{parsed=JSON.parse(data);}catch{} vars.results[action.saveAs||'storageRead']={content:data,json:parsed,path:file};
          } else if (method==='storageDelete') {
            const name=String(args.name||args.fileName||'data.json').replace(/[^a-zA-Z0-9._-]/g,'_'); const file=safePluginPath(PLUGIN_STORAGE_DIR,`${vars.pluginId}_${name}`); if(fs.existsSync(file))fs.unlinkSync(file); vars.results[action.saveAs||'storageDelete']={ok:true};
          } else if (method==='groupMetadata') {
            const metadata=await sock.groupMetadata(args.groupJid||vars.chat); vars.results[action.saveAs||'groupMetadata']=metadata;
          } else if (method==='sendMessageJson') {
            let payload=args.messageJson||args.message||{}; const dest=args.toJid||vars.chat;
            if(payload && payload._rolleysFallbackText) payload={text:payload._rolleysFallbackText};
            else if(payload && payload.kind==='richResponse') { const parts=(payload.document?.items||[]).map(x=>x?.block?.data||x?.block?.text||'').filter(Boolean); payload={text:parts.join('\n\n')||'Rich response fallback'}; }
            else if(payload && payload.kind==='custom' && payload.builder==='buildCarouselMessage') { const cards=payload.options?.cards||[]; payload={text:cards.map((c,i)=>`*Kartu ${i+1}*\n${c.title||c.text||c.description||JSON.stringify(c)}`).join('\n\n')||'Carousel kosong.'}; }
            const sent=await sock.sendMessage(dest,payload,args.quote&&quoted?{quoted}:{}); vars.results[action.saveAs||'sendMessageJson']={ok:true,key:sent?.key};
          } else if (method==='buildMessageFromBuilder') {
            const builder=args.builderJson||{};
            if(builder.kind==='richResponse') vars.results[action.saveAs||'built']=builder;
            else if(builder.kind==='custom'&&builder.builder==='buildCarouselMessage') vars.results[action.saveAs||'built']={_rolleysFallbackText:(builder.options?.cards||[]).map((c,i)=>`Kartu ${i+1}: ${c.title||c.text||c.description||'Kartu'}`).join('\n')||'Carousel kosong.'};
            else vars.results[action.saveAs||'built']={_rolleysFallbackText:'Builder ini tidak didukung Baileys. Periksa builder JSON dan gunakan pesan teks fallback.'};
          } else {
            throw new Error(`Native method '${method}' tidak tersedia pada Baileys runtime ini.`);
          }
        } catch (e) { if(action.onError) await sock.sendMessage(vars.chat,{text:pluginResolveValue(action.onError,vars)}); else console.warn('[PLUGIN ACTION]',method,e.message); throw e; }
        continue;
      }
      for (const key of ['reply','text']) if (action[key]!==undefined) {
        const value=action[key]===true?vars.args:pluginResolveValue(action[key],vars); let mentions=[]; const mopt=action.mentions; if(mopt===true||mopt==='auto')mentions=vars.mentions||[];else if(mopt==='all'||action.tagall||action.hidetag){if(vars.isGroup){try{const meta=await getGroupMetadataCached(sock,vars.chat);mentions=(meta.participants||[]).map(p=>jidNormalizedUser(p.id));}catch{}}}else if(Array.isArray(mopt))mentions=mopt;
        const textOut=action.tagall||action.hidetag?`${String(value)}\n\n${mentions.map(j=>'@'+j.split('@')[0]).join(' ')}`:String(value);
        await sock.sendMessage(action.toJid||vars.chat,{text:textOut,...(mentions.length?{mentions}: {})},action.quote&&quoted?{quoted}:{});
      }
      if(action.react||action.reaction) await sock.sendMessage(vars.chat,{react:{text:action.react||action.reaction,key:vars.messageKey}});
      if(action.delete||action.revoke) await sock.sendMessage(vars.chat,{delete:action.delete===true?vars.messageKey:action.delete});
      if(action.forward||action.fwd) { if(vars.quotedMessage) await sock.sendMessage(action.to||action.toJid||vars.chat,{forward:vars.quotedMessage}); }
      for(const mediaType of ['image','video','audio','document','sticker']) if(action[mediaType]!==undefined) {
        const src=action[mediaType]; const payload={};
        if(src===true && vars.mediaMessage) payload[mediaType]=await downloadMediaMessage(vars.mediaMessage,'buffer',{});
        else if(typeof src==='string' && /^https?:\/\//i.test(src)) payload[mediaType]={url:src};
        else if(typeof src==='string') payload[mediaType]=fs.readFileSync(safePluginPath(PLUGINS_DIR,src));
        else if(src&&typeof src==='object'&&src.url) payload[mediaType]={url:src.url};
        if(action.caption)payload.caption=pluginResolveValue(action.caption,vars); if(action.fileName)payload.fileName=action.fileName; if(action.ptt)payload.ptt=true;
        if(payload[mediaType]) await sock.sendMessage(action.toJid||vars.chat,payload,action.quote&&quoted?{quoted}:{});
      }
      if(action.kick||action.remove||action.promote||action.demote) {
        if(!vars.isGroup) throw new Error('Moderasi hanya berlaku di grup.'); if(!vars.isAdmin||!vars.isBotAdmin) throw new Error('Moderasi memerlukan admin grup dan bot admin.');
        const raw=action.kick||action.remove||action.promote||action.demote; const member=raw===true?(vars.quotedSender||String(vars.args).split(/\s+/)[0]):raw;
        if(member) await sock.groupParticipantsUpdate(vars.chat,[String(member).includes('@')?String(member):String(member).replace(/[^0-9]/g,'')+'@s.whatsapp.net'],action.promote?'promote':action.demote?'demote':'remove');
      }
      if(action.muteGroup||action.closeGroup) { if(vars.isGroup&&vars.isAdmin&&vars.isBotAdmin) await sock.groupSettingUpdate(vars.chat,'announcement'); else throw new Error('Aksi ini memerlukan admin grup dan bot admin.'); }
      if(action.openGroup) { if(vars.isGroup&&vars.isAdmin&&vars.isBotAdmin) await sock.groupSettingUpdate(vars.chat,'not_announcement'); else throw new Error('Aksi ini memerlukan admin grup dan bot admin.'); }
      if(action.setSubject&&vars.isGroup) { if(!vars.isAdmin||!vars.isBotAdmin) throw new Error('Aksi ini memerlukan admin grup dan bot admin.'); await sock.groupUpdateSubject(vars.chat,pluginResolveValue(action.setSubject,vars)); }
      if(action.setDescription&&vars.isGroup) { if(!vars.isAdmin||!vars.isBotAdmin) throw new Error('Aksi ini memerlukan admin grup dan bot admin.'); await sock.groupUpdateDescription(vars.chat,pluginResolveValue(action.setDescription,vars)); }
      if(action.leaveGroup){if(!vars.isGroup)throw new Error('leaveGroup hanya bisa di grup.');await sock.groupLeave(action.groupJid||vars.chat);}
      // Rolleys JSON storage shorthand (plugin-isolated paths, atomic write, quotas).
      const storageOp=['storageWrite','storageAppend','storageRead','storageDelete','storageList','storageMkdir','storageStat'].find(k=>action[k]!==undefined);
      if(storageOp){const root=safePluginPath(PLUGIN_STORAGE_DIR,vars.pluginId);fs.mkdirSync(root,{recursive:true});const rel=String(action.path||'');if(!rel||rel.length>512||rel.split(/[\/]/).length>32)throw new Error('Path storage wajib dan maksimal 512 karakter/32 segmen.');const target=safePluginPath(root,rel);const save=action.saveAs||'storage';if(storageOp==='storageWrite'||storageOp==='storageAppend'){const content=action.content??'';let buf;if(action.encoding==='base64')buf=Buffer.from(String(content),'base64');else if(action.encoding==='json')buf=Buffer.from(JSON.stringify(content,null,2));else buf=Buffer.from(String(content));if(buf.length>8*1024*1024)throw new Error('Storage file melebihi 8 MiB.');fs.mkdirSync(path.dirname(target),{recursive:true});if(storageOp==='storageAppend')fs.appendFileSync(target,buf);else{const tmp=target+'.tmp';fs.writeFileSync(tmp,buf);fs.renameSync(tmp,target);}vars.results[save]={path:rel,size:fs.statSync(target).size};}else if(storageOp==='storageRead'){const data=fs.readFileSync(target);vars.results[save]=action.encoding==='base64'?data.toString('base64'):action.encoding==='json'?JSON.parse(data.toString('utf8')):data.toString('utf8');}else if(storageOp==='storageDelete'){if(target===root)throw new Error('Root storage tidak boleh dihapus.');fs.rmSync(target,{recursive:Boolean(action.recursive),force:true});vars.results[save]={deleted:true};}else if(storageOp==='storageList'){vars.results[save]=fs.existsSync(target)?fs.readdirSync(target,{withFileTypes:true}).map(d=>({name:d.name,isDirectory:d.isDirectory()})):[];}else if(storageOp==='storageMkdir'){fs.mkdirSync(target,{recursive:true});vars.results[save]={path:rel};}else{vars.results[save]=fs.existsSync(target)?{exists:true,size:fs.statSync(target).size,isDirectory:fs.statSync(target).isDirectory()}:{exists:false};}continue;}
      if(action.remember) pluginRuntimeData.set(`${vars.pluginId}:${action.remember}`,pluginResolveValue(action.value??'',vars));
      if(action.recall) vars.results[action.saveAs||'memory']=pluginRuntimeData.get(`${vars.pluginId}:${action.recall}`)??action.default??'';
      if(action.forget) pluginRuntimeData.delete(`${vars.pluginId}:${action.forget}`);
    }
  };

  const runRolleysPlugins = async vars => {
    const dedupeKey=`${vars.chat}:${vars.messageId}`;
    if(pluginSeenMessages.has(dedupeKey)) return false;
    pluginSeenMessages.add(dedupeKey); if(pluginSeenMessages.size>1000) pluginSeenMessages.delete(pluginSeenMessages.values().next().value);
    for(const {file,plugin} of listPlugins()) {
      if(!plugin||plugin.enabled!==true||!plugin.rules) continue;
      vars.pluginId=plugin.id||file.replace(/\.json$/,'');
      const auto=plugin.rules.autoResponder;
      if(!vars.fromMe && auto?.enabled!==false) {
        if(auto?.commands&&vars.isPrefixed) for(const [cmd,actions] of Object.entries(auto.commands)) {
          if(vars.text.toLowerCase()===cmd.toLowerCase()||vars.text.toLowerCase().startsWith(cmd.toLowerCase()+' ')) {
            vars.args=vars.text.slice(cmd.length).trim(); await executePluginActions(actions,vars,vars.quotedRaw); return true;
          }
        }
        if(auto?.echoPrefix&&vars.text.startsWith(auto.echoPrefix)) { vars.args=vars.text.slice(auto.echoPrefix.length); await executePluginActions({reply:vars.args},vars,vars.quotedRaw); return true; }
        for(const entry of auto.autoReply||[]) if(entry.enabled!==false&&entry.match&&vars.text.toLowerCase().includes(String(entry.match).toLowerCase())) { await executePluginActions(entry.actions||{reply:entry.reply},vars,vars.quotedRaw); return true; }
      }
      for(const rule of plugin.rules.onIncoming||[]) {
        if(rule.enabled===false||!pluginRuleMatches(rule,vars)) continue;
        const missingArgs=Boolean((rule.requireArgs||rule.requireInput)&&!vars.args || rule.minArgs&&String(vars.args||'').trim().split(/\s+/).filter(Boolean).length<Number(rule.minArgs));
        const missingQuote=Boolean((rule.requireQuoted||rule.requireQuote)&&!vars.quotedId);
        const missingMedia=Boolean(rule.requireMedia&&!vars.hasMedia || rule.quotedHasMedia&&!vars.quotedHasMedia || rule.quotedMediaType&&String(rule.quotedMediaType).toLowerCase()!==String(vars.quotedMediaType||'').toLowerCase());
        const missingBotAdmin=Boolean(rule.botAdminRequired&&!vars.isBotAdmin);
        if(missingArgs||missingQuote||missingMedia||missingBotAdmin) { if(rule.usage) await sock.sendMessage(vars.chat,{text:pluginResolveValue(rule.usage,vars)}); return true; }
        const cooldown=Math.max(0,Number(rule.cooldown||plugin.cooldown||0));
        const key=`${vars.pluginId}:${vars.chat}:${vars.senderJid}:${rule.command||rule.prefix||rule.exact||rule.contains||rule.regex||file}`;
        const last=pluginCooldowns.get(key)||0; if(cooldown&&Date.now()-last<cooldown*1000) continue;
        pluginCooldowns.set(key,Date.now());
        try { await executePluginActions(rule.actions,vars,vars.quotedRaw); } catch(e) { console.error(`[PLUGIN ${plugin.name||vars.pluginId}]`,e.message); }
        return true;
      }
    }
    return false;
  };

  if (!sock.authState.creds.registered) {
    const nomorBot = process.env.BOT_NUMBER || ''; // optional: set BOT_NUMBER=628xxxxxxxxxx for pairing code
    setTimeout(async () => {
      if (!nomorBot) return; // QR will be printed from connection.update
      try {
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
    if (qr && !sock.authState.creds.registered && !process.env.BOT_NUMBER) {
      console.log('Scan QR ini dari WhatsApp > Perangkat tertaut:');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode || 0;
      console.log('[KONEKSI TERPUTUS] Kode:', code);
      if (code !== DisconnectReason.loggedOut) setTimeout(() => startBot().catch(e => console.error('[RECONNECT]', e.message)), 5000);
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
      const participantJid = typeof participant === 'string' ? participant : participant.id;
      if (!participantJid) continue;
      const tag = '@' + participantJid.split('@')[0];
      if (anu.action === 'add') {
        await sock.sendMessage(anu.id, { text: `👋 Selamat datang ${tag} di grup!`, mentions: [participantJid] });
      } else if (anu.action === 'remove') {
        await sock.sendMessage(anu.id, { text: `👋 Sampai jumpa ${tag}!`, mentions: [participantJid] });
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
        if (db.globalPresence && !db.ghostmode) {
          sock.presenceSubscribe(chatId)
            .then(() => sock.sendPresenceUpdate(db.globalPresence, chatId))
            .catch(() => {});
        }
      }

        
        deletedMessagesCache[m.key.id] = m;
        const deletedCacheKeys = Object.keys(deletedMessagesCache);
        if (deletedCacheKeys.length > 500) delete deletedMessagesCache[deletedCacheKeys[0]];

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
            await sock.readMessages([m.key]);
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

        const quotedMsg = actualMsg.extendedTextMessage?.contextInfo?.quotedMessage || null;
        const getTargetMediaMessage = () => {
          if (actualMsg.imageMessage || actualMsg.videoMessage || actualMsg.stickerMessage || actualMsg.audioMessage || actualMsg.documentMessage) return { key: m.key, message: actualMsg };
          if (quotedMsg) {
            const qctx = actualMsg.extendedTextMessage?.contextInfo || {};
            if (!qctx.stanzaId) return null;
            const participant = qctx.participant || (isGroup ? undefined : chatId);
            const key = { remoteJid: chatId, id: qctx.stanzaId, ...(participant ? { participant } : {}), fromMe: Boolean(qctx.fromMe || (participant && botJid && jidNormalizedUser(participant) === botJid)) };
            return { key, message: extractMessageContent(quotedMsg) };
          }
          return null;
        };

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
          const fullText = String(text ?? '');
          const chunks = [];
          for (let i = 0; i < fullText.length; i += 4000) chunks.push(fullText.slice(i, i + 4000));
          if (!chunks.length) chunks.push('');
          let lastSent;
          for (const chunk of chunks) {
            const ctx = buildContextInfo(m);
            const options = { ...extraOptions };
            if (ctx) options.contextInfo = { ...(options.contextInfo || {}), ...ctx };
            const sent = await sock.sendMessage(chatId, { text: chunk, ...options }, { quoted: m });
            lastSent = sent;
            if (db.autoDelSeconds > 0 && sent?.key) {
              const delay = Math.max(1, Math.min(86400, Number(db.autoDelSeconds))) * 1000;
              setTimeout(() => sock.sendMessage(chatId, { delete: sent.key }).catch(() => {}), delay);
            }
          }
          return lastSent;
        };
        // Deteksi otomatis saat mengirim video tanpa caption/perintah
        if (!trimmed && !m.key.fromMe && actualMsg.videoMessage) {
          const vid = actualMsg.videoMessage;
          const width = vid.width || '-';
          const height = vid.height || '-';
          const orientation = (vid.height && vid.width)
            ? (vid.height >= vid.width ? 'Portrait' : 'Landscape')
            : '';
          const duration = vid.seconds ? `${vid.seconds}s` : '-';
          const fileSizeMb = vid.fileLength
            ? `${(Number(vid.fileLength) / (1024 * 1024)).toFixed(1)} MB`
            : '-';

          const infoText = [
            '🎬 *VIDEO DITERIMA*',
            '',
            `• *Resolusi:* ${width}x${height}${orientation ? ` (${orientation})` : ''}`,
            `• *Durasi:* ${duration}`,
            `• *Ukuran:* ${fileSizeMb}`,
            '',
            'Balas pesan video ini dengan salah satu perintah berikut:',
            `• *${db.prefix}hd* — Jadikan Status HD 60 FPS`,
            `• *${db.prefix}kompres* — Kompres Ukuran Video`,
            `• *${db.prefix}fps 60* — Haluskan Gerakan 60 FPS`,
            `• *${db.prefix}mp3* — Ambil Audio MP3 dari Video`
          ].join('\n');

          await sendReply(infoText);
          continue;
        }

        // Rolleys declarative plugins (incoming triggers, auto-replies and actions).
        if (trimmed && !trimmed.toLowerCase().startsWith(`${db.prefix}plugin`)) {
          const qctx = actualMsg.extendedTextMessage?.contextInfo || {};
          const quotedSender = qctx.participant || (qctx.fromMe ? botJid : chatId);
          const quotedText = quotedMsg ? getMessageText(extractMessageContent(quotedMsg)) : '';
          const rawType = Object.keys(actualMsg || {}).find(k => k.endsWith('Message')) || 'unknown';
          const typeMap={conversation:'text',extendedTextMessage:'text',imageMessage:'image',videoMessage:'video',audioMessage:'audio',stickerMessage:'sticker',documentMessage:'document',locationMessage:'location',liveLocationMessage:'location',contactMessage:'contact',contactsArrayMessage:'contact',reactionMessage:'reaction',buttonsResponseMessage:'button_reply',templateButtonReplyMessage:'button_reply',listResponseMessage:'list_reply'};
          const msgType=typeMap[rawType]||rawType.replace(/Message$/,'').toLowerCase();
          const ctx=actualMsg.extendedTextMessage?.contextInfo||actualMsg.imageMessage?.contextInfo||actualMsg.videoMessage?.contextInfo||actualMsg.documentMessage?.contextInfo||actualMsg.audioMessage?.contextInfo||actualMsg.stickerMessage?.contextInfo||{};
          const mentions=(ctx.mentionedJid||[]).map(jidNormalizedUser); const mentionsMe=mentions.includes(botJid)||mentions.includes(botLid);
          const qActual=quotedMsg?extractMessageContent(quotedMsg):{};const qRawType=Object.keys(qActual||{}).find(k=>k.endsWith('Message'))||'';const qMediaType=({imageMessage:'image',videoMessage:'video',audioMessage:'audio',stickerMessage:'sticker',documentMessage:'document'})[qRawType]||'';
          const viewOnce=Boolean(actualMsg.imageMessage?.viewOnce||actualMsg.videoMessage?.viewOnce||actualMsg.audioMessage?.viewOnce||actualMsg.documentMessage?.viewOnce||actualMsg.ephemeralMessage||actualMsg.viewOnceMessage||actualMsg.viewOnceMessageV2);
          let pluginAdmin = isOwner, pluginBotAdmin = false;
          if (isGroup) { try { const pm=await getGroupMetadataCached(sock,chatId); pluginAdmin=pluginAdmin||pm.participants.some(pp=>jidNormalizedUser(pp.id)===sender&&(pp.admin==='admin'||pp.admin==='superadmin')); pluginBotAdmin=pm.participants.some(pp=>jidNormalizedUser(pp.id)===botJid&&(pp.admin==='admin'||pp.admin==='superadmin')); } catch {} }
          const pluginVars = {
            chat: chatId, sender: sender.split('@')[0], senderJid: sender, pushName: m.pushName || '',
            text: trimmed, args: '', command: '', messageId: m.key.id, messageKey: m.key,
            quotedText, quotedId: qctx.stanzaId || '', quotedSender,
            quotedMessage: quotedMsg ? { key: { remoteJid: chatId, id: qctx.stanzaId, participant: qctx.participant, fromMe: Boolean(qctx.fromMe) }, message: extractMessageContent(quotedMsg) } : null,
            quotedRaw: m, isGroup, fromMe: Boolean(m.key.fromMe), isOwner, isAdmin: pluginAdmin, isBotAdmin: pluginBotAdmin, hasMedia: Boolean(actualMsg.imageMessage||actualMsg.videoMessage||actualMsg.audioMessage||actualMsg.documentMessage||actualMsg.stickerMessage||quotedMsg?.imageMessage||quotedMsg?.videoMessage||quotedMsg?.audioMessage||quotedMsg?.documentMessage||quotedMsg?.stickerMessage),
            mediaMessage: getTargetMediaMessage(), messageType: msgType, mediaType: (actualMsg.imageMessage?'image':actualMsg.videoMessage?'video':actualMsg.audioMessage?'audio':actualMsg.documentMessage?'document':actualMsg.stickerMessage?'sticker':qMediaType), quotedHasMedia:Boolean(qMediaType), quotedMediaType:qMediaType, isViewOnce:viewOnce, isEdited:Boolean(actualMsg.editedMessage||actualMsg.protocolMessage?.type===14), reactionEmoji:actualMsg.reactionMessage?.text||'', buttonId:actualMsg.buttonsResponseMessage?.selectedButtonId||actualMsg.templateButtonReplyMessage?.selectedId||actualMsg.listResponseMessage?.singleSelectReply?.selectedRowId||'', mentions, hasMentions:mentions.length>0, mentionsMe, senderNumber:sender.split('@')[0], isBot:Boolean(m.pushName&&/bot/i.test(m.pushName)),
            isPrefixed: trimmed.startsWith(db.prefix), time: new Date().toLocaleTimeString('id-ID'), date: new Date().toLocaleDateString('id-ID'),
            results: {}, pluginId: ''
          };
          if (pluginVars.isPrefixed) {
            const ptxt=trimmed.slice(db.prefix.length).trim(); const pi=ptxt.indexOf(' ');
            pluginVars.command=(pi<0?ptxt:ptxt.slice(0,pi)).toLowerCase(); pluginVars.args=pi<0?'':ptxt.slice(pi+1).trim();
          }
          if (await runRolleysPlugins(pluginVars)) continue;
        }

        const selectedMenuRow = actualMsg.listResponseMessage?.singleSelectReply?.selectedRowId || '';
        if (selectedMenuRow.startsWith('ocmenu_')) {
          const categoryText = {
            ocmenu_ai: [
              '🧠 *KECERDASAN BUATAN (GROQ & GROK)*',
              '• .autoai on/off — AI otomatis di chat pribadi',
              '• .setgroq <api_key> — atur API Groq',
              '• .setgrok <api_key> — atur API Grok',
              '• .ai / .grok / .gpt — tanya AI',
              '• .code <teks> — bantuan coding',
              '• .translate <teks> — terjemahan',
              '• .summary <teks> — ringkasan',
              '• .roast <teks> — roast',
              '• .reset — reset percakapan AI'
            ].join('\n'),
            ocmenu_download: [
              '📥 *DOWNLOADER & FILE*',
              '• .dl <url> — unduh URL yang didukung',
              '• .pvmu — preview ZIP',
              '',
              'Catatan: format dan sumber unduhan yang didukung mengikuti implementasi downloader pada bot.'
            ].join('\n'),
            ocmenu_media: [
              '🎨 *MEDIA, STIKER & SALURAN*',
              '• .sticker / .s — buat stiker',
              '• .sprem — stiker dengan metadata pack',
              '• .toimg — stiker ke gambar',
              '• .swm <pack>|<author> / .take — metadata stiker',
              '• .sai <prompt> — stiker AI',
              '• .rvo / .vv / .1x — media sekali lihat',
              '• .brat <teks> — gambar Brat',
              '• .setch <channel_jid> — atur tujuan Channel',
              '• .imgch / .stickch — kirim media ke Channel'
            ].join('\n'),
            ocmenu_group: [
              '👥 *MANAJEMEN GRUP & STATUS*',
              '• .tagall / .hidetag / .fwd',
              '• .kick / .promote / .demote',
              '• .mute / .unmute',
              '• .setname / .setdesc',
              '• .groupstatus / .gstatus <teks>',
              '• .archive / .unarchive / .afk / .getjid',
              '• .antilink on/off / .welcome on/off',
              '• .faketyping / .fakerecording'
            ].join('\n'),
            ocmenu_fun: [
              '🎮 *GAMES & FUN*',
              '• .roast <teks> — hiburan berbasis AI',
              '• .dog — gambar anjing',
              '• .zen — konten Zen',
              '',
              'Game tambahan seperti Catur atau TicTacToe tidak ditampilkan karena belum tercantum sebagai perintah aktif di menu script.'
            ].join('\n'),
            ocmenu_tools: [
              '🛠️ *CATATAN & UTILITAS*',
              '• .save <nama>|<isi> / .load <nama>',
              '• .files / .delnote <nama>',
              '• .qr <teks> / .tts <teks> / .weather <kota>',
              '• .img <prompt> / .dog / .zen',
              '• .poll judul|opsi1|opsi2',
              '• .quiz pertanyaan|opsi1|opsi2',
              '• .event judul|deskripsi|lokasi',
              '• .table judul|col1,col2|val1,val2',
              '• .button / .listmenu / .carousel / .html / .comment',
              '• .setcurrency / .kurs'
            ].join('\n'),
            ocmenu_control: [
              '⚙️ *KONTROL BOT & PENGATURAN*',
              '• .self / .public / .ghostmode',
              '• .anticall / .antidelete / .autostory',
              '• .autodel <detik>|<pesan>',
              '• .setautodel <detik> (0 = off)',
              '• .aitag on/off',
              '• .fakepay / .stickerpay / .paymsg',
              '• .infobot / .owner / .ping / .echo',
              '',
              'Fitur .adbanner dan .fwdboost tidak menjanjikan pemalsuan metadata pesan.'
            ].join('\n')
          }[selectedMenuRow];

          if (categoryText) {
            await sock.sendMessage(chatId, {
              text: categoryText,
              footer: `Ketik ${db.prefix}menu untuk membuka kategori lagi.`
            }, { quoted: m });
          }
          continue;
        }

        if (!trimmed.startsWith(db.prefix)) {
          if (!isGroup && !m.key.fromMe && db.autoAi && trimmed.length > 1) {
            try {
              const aiRes = await askAi(chatId, trimmed);
              await sendReply(aiRes);
            } catch (e) {
              console.error('[AUTO AI]', e.message);
              await sock.sendMessage(chatId, { text: '⚠️ Auto AI gagal merespons. Coba lagi nanti atau periksa API key.' }).catch(() => {});
            }
          }
          continue;
        }

        const userStats = addXp(sender, 15);
        const withoutPrefix = trimmed.slice(db.prefix.length).trim();
        const spaceIdx = withoutPrefix.indexOf(' ');
        const cmd = (spaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, spaceIdx)).toLowerCase();
        const arg = spaceIdx === -1 ? '' : withoutPrefix.slice(spaceIdx + 1).trim();


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
                    case 'hd':
          case 'kompres':
          case 'fps':
          case 'mp3': {
            const target = getTargetMediaMessage();
            if (!target?.message?.videoMessage) {
              return sendReply(`Kirim atau balas video dengan perintah *.${cmd}*${cmd === 'fps' ? ' 60' : ''}`);
            }

            if (cmd === 'fps' && arg !== '60') {
              return sendReply('Gunakan: *.fps 60* (balas video yang ingin dihaluskan ke 60 FPS)');
            }

            await sock.sendMessage(chatId, { react: { text: '⏳', key: m.key } });

            const id = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            const inPath = path.join(TEMP_DIR, `vid_in_${id}.mp4`);
            const outExt = cmd === 'mp3' ? 'mp3' : 'mp4';
            const outPath = path.join(TEMP_DIR, `vid_out_${id}.${outExt}`);

            try {
              const videoBuf = await downloadMediaMessage(target, 'buffer', {});
              fs.writeFileSync(inPath, videoBuf);

              await sock.sendMessage(chatId, { react: { text: '⚙️', key: m.key } });

              if (cmd === 'hd') {
                await runFfmpeg([
                  '-y', '-i', inPath,
                  '-vf', 'unsharp=5:5:0.8:3:3:0.4',
                  '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
                  '-r', '60', '-pix_fmt', 'yuv420p',
                  '-c:a', 'aac', '-b:a', '192k',
                  '-movflags', '+faststart', outPath
                ]);
              } else if (cmd === 'kompres') {
                await runFfmpeg([
                  '-y', '-i', inPath,
                  '-c:v', 'libx264', '-preset', 'fast', '-crf', '28',
                  '-c:a', 'aac', '-b:a', '128k',
                  '-movflags', '+faststart', outPath
                ]);
              } else if (cmd === 'fps') {
                await runFfmpeg([
                  '-y', '-i', inPath,
                  '-filter:v', 'minterpolate=fps=60:mi_mode=blend',
                  '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
                  '-c:a', 'copy', outPath
                ]);
              } else if (cmd === 'mp3') {
                await runFfmpeg([
                  '-y', '-i', inPath,
                  '-vn', '-acodec', 'libmp3lame', '-b:a', '192k',
                  outPath
                ]);
              }

              const outBuf = fs.readFileSync(outPath);

              if (cmd === 'mp3') {
                await sock.sendMessage(chatId, {
                  audio: outBuf,
                  mimetype: 'audio/mpeg',
                  fileName: `Audio_${id}.mp3`
                }, { quoted: m });
              } else {
                const label = cmd === 'hd' ? 'HD_60fps' : cmd === 'fps' ? '60fps' : 'Kompres';
                await sock.sendMessage(chatId, {
                  document: outBuf,
                  mimetype: 'video/mp4',
                  fileName: `Status_${label}_${id}.mp4`,
                  caption: `✅ *Video ${label.replace('_', ' ')} selesai!*\nUpload file dokumen ini ke Status WA agar tidak dikompresi.`
                }, { quoted: m });
              }

              await sock.sendMessage(chatId, { react: { text: '✅', key: m.key } });
            } catch (e) {
              await sock.sendMessage(chatId, { react: { text: '❌', key: m.key } });
              throw e;
            } finally {
              if (fs.existsSync(inPath)) fs.unlinkSync(inPath);
              if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
            }
            break;
          }

          case 'plugin': {
            if (!isOwner) return sendReply('❌ Perintah plugin hanya untuk owner.');
            const sub = (arg.split(/\s+/)[0] || 'list').toLowerCase();
            const rest = arg.slice(sub.length).trim();
            if (sub === 'list' || !sub) {
              const items=listPlugins();
              const text=items.map(({file,plugin})=>plugin?`• ${plugin.id||file}: ${plugin.enabled?'ON':'OFF'} — ${plugin.name||file}`:`• ${file}: JSON INVALID`).join('\n');
              return sendReply(`🧩 *PLUGIN ROLLEYS*\n${text||'Folder plugin kosong.'}\n\n`.concat('Perintah: .plugin enable <id> | disable <id> | install (reply JSON) | template dog/weather/zen | delete <id>'));
            }
            if (sub === 'reload') return sendReply('🔄 Plugin JSON akan dibaca ulang pada pesan berikutnya.');
            if (sub === 'template') {
              const templateName=rest.toLowerCase();
              const templates={
                dog:{id:'random_dog',name:'Random Dog',enabled:false,rules:{onIncoming:[{command:'.dog',cooldown:5,actions:[{method:'httpRequest',args:{url:'https://dog.ceo/api/breeds/image/random',responseType:'json'},saveAs:'d'},{image:'{d.json.message}',caption:'🐶'}]}]}},
                weather:{id:'weather_line',name:'Weather Line',enabled:false,rules:{onIncoming:[{command:'.weather',requireArgs:true,usage:'.weather <kota>',cooldown:5,actions:[{method:'httpRequest',args:{url:'https://wttr.in/{args|url}?format=3',responseType:'text'},saveAs:'w'},{reply:'{w.body}',quote:true}]}]}},
                zen:{id:'zen_quote',name:'Zen Quote',enabled:false,rules:{onIncoming:[{command:'.zen',actions:[{method:'httpRequest',args:{url:'https://api.github.com/zen',headers:{'User-Agent':'OchildBot'},responseType:'text'},saveAs:'z'},{reply:'{z.body}',quote:true}]}]}},
                formatter:{id:'richtext_formatter',name:'Rich Text Formatter',enabled:false,rules:{textTransform:{prefix:'*「 ROLLEYS 」*\n',suffix:'\n\n_⚡ {time} • {date}_',replace:[{from:':fire:',to:'🔥'},{from:':check:',to:'✅'},{from:':rocket:',to:'🚀'},{from:':heart:',to:'❤️'},{from:':warn:',to:'⚠️'}]},template:{placeholders:true}}}
              };
              if(!templates[templateName]) return sendReply('Template: dog, weather, zen, formatter');
              const t=templates[templateName]; fs.writeFileSync(path.join(PLUGINS_DIR,`${t.id}.json`),JSON.stringify(t,null,2));
              return sendReply(`✅ Template *${t.name}* dibuat (OFF). Aktifkan: .plugin enable ${t.id}`);
            }
            if (sub === 'install' || sub === 'import') {
              let jsonText=rest;
              const target=getTargetMediaMessage();
              if(!jsonText&&target?.message?.documentMessage) {
                const buffer=await downloadMediaMessage(target,'buffer',{}); jsonText=buffer.toString('utf8');
              }
              if(!jsonText&&quotedMsg) jsonText=getMessageText(extractMessageContent(quotedMsg));
              try {
                const plug=JSON.parse(jsonText);
                if(!plug || typeof plug!=='object' || Array.isArray(plug) || !safePluginId(plug.id) || !plug.rules || typeof plug.rules!=='object' || Array.isArray(plug.rules)) {
                  throw new Error('JSON plugin harus berupa object dengan id valid dan rules object.');
                }
                plug.enabled=false; // plugin hasil import selalu OFF sampai diperiksa owner
                const file=path.join(PLUGINS_DIR,`${plug.id}.json`);
                const tempFile=`${file}.tmp`;
                fs.writeFileSync(tempFile,JSON.stringify(plug,null,2));
                fs.renameSync(tempFile,file);
                return sendReply(`📦 Plugin *${plug.name||plug.id}* berhasil diimpor dan disimpan OFF. Aktifkan dengan .plugin enable ${plug.id}`);
              } catch(e) { return sendReply(`❌ JSON plugin invalid: ${e.message}\nReply file JSON atau kirim JSON setelah .plugin install`); }
            }
            if (['enable','disable'].includes(sub)) {
              const id=rest.split(/\s+/)[0]; if(!safePluginId(id)) return sendReply('ID plugin tidak valid.');
              const file=path.join(PLUGINS_DIR,`${id}.json`); if(!fs.existsSync(file)) return sendReply(`Plugin *${id}* tidak ditemukan.`);
              try { const plug=JSON.parse(fs.readFileSync(file,'utf8')); plug.enabled=sub==='enable'; fs.writeFileSync(file,JSON.stringify(plug,null,2)); return sendReply(`✅ Plugin *${plug.name||id}* ${plug.enabled?'diaktifkan':'dinonaktifkan'}.`); } catch(e) { return sendReply(`JSON plugin rusak: ${e.message}`); }
            }
            if (sub==='delete'||sub==='remove') {
              const id=rest.split(/\s+/)[0]; if(!safePluginId(id)) return sendReply('ID plugin tidak valid.');
              const file=path.join(PLUGINS_DIR,`${id}.json`); if(!fs.existsSync(file)) return sendReply('Plugin tidak ditemukan.'); fs.unlinkSync(file); return sendReply(`🗑️ Plugin *${id}* dihapus.`);
            }
            if (sub==='info') {
              const id=rest.split(/\s+/)[0];
              if (!safePluginId(id)) return sendReply('ID plugin tidak valid.');
              const file=path.join(PLUGINS_DIR,`${id}.json`);
              if(!fs.existsSync(file)) return sendReply('Plugin tidak ditemukan.');
              try {
                const plug=JSON.parse(fs.readFileSync(file,'utf8'));
                return sendReply(JSON.stringify({id:plug.id,name:plug.name,enabled:plug.enabled,description:plug.description,rules:plug.rules},null,2));
              } catch(e) { return sendReply(`JSON plugin rusak: ${e.message}`); }
            }
            if (sub==='export') { const id=rest.split(/\s+/)[0]; if(!safePluginId(id))return sendReply('ID plugin tidak valid.');const file=path.join(PLUGINS_DIR,`${id}.json`);if(!fs.existsSync(file))return sendReply('Plugin tidak ditemukan.');const plug=JSON.parse(fs.readFileSync(file,'utf8'));const buffer=Buffer.from(JSON.stringify(plug,null,2));return sock.sendMessage(chatId,{document:buffer,mimetype:'application/json',fileName:`${id}.json`,caption:`📤 Export plugin ${plug.name||id}`},{quoted:m}); }
            return sendReply('Format: .plugin list | enable <id> | disable <id> | import/install | export <id> | template dog/weather/zen | delete <id> | info <id>');
          }
          case 'menu':
          case 'help': {
            const memMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
            const nextXp = userStats.level * 100;
            const menuHeader = [
              '✦ OCHILD BOT AI + ROLLEYS ✦',
              `Halo, ${db.ownerName}`,
              '',
              `◆ ROLE: ${isOwner ? 'OWNER' : 'MEMBER'}`,
              `◆ LEVEL: ${userStats.level} (${userStats.xp}/${nextXp} XP)`,
              '◆ LIMIT: ∞',
              `◆ AUTO AI: ${db.autoAi ? 'ON' : 'OFF'}`,
              `◆ AUTO DEL: ${db.autoDelSeconds > 0 ? db.autoDelSeconds + ' detik' : 'OFF'}`,
              `◆ RUNTIME: ${formatRuntime(process.uptime())}`,
              `◆ MODE: ${db.mode.toUpperCase()}`,
              `◆ RAM: ${memMb} MB`,
              '',
              'Pilih kategori menu untuk melihat perintah yang tersedia.'
            ].join('\n');

            await sock.sendMessage(chatId, {
              title: '📋 Buka Menu',
              text: menuHeader,
              footer: 'Powered by Ochild Bot AI + Rolleys',
              buttonText: 'Pilih',
              sections: [{
                title: 'Pilih Kategori Menu',
                rows: [
                  { title: '🧠 KECERDASAN BUATAN', description: 'AI Groq & Grok, coding, translate, ringkasan', rowId: 'ocmenu_ai' },
                  { title: '📥 DOWNLOADER', description: 'Unduh URL dan preview ZIP', rowId: 'ocmenu_download' },
                  { title: '🎨 MEDIA & STIKER', description: 'Sticker, Brat, AI sticker, konversi media', rowId: 'ocmenu_media' },
                  { title: '👥 MANAJEMEN GRUP', description: 'Admin grup, tag, anti-link, welcome, AFK', rowId: 'ocmenu_group' },
                  { title: '🎮 GAMES & FUN', description: 'Fitur hiburan yang tersedia pada bot', rowId: 'ocmenu_fun' },
                  { title: '🛠️ ALAT & UTILITAS', description: 'Catatan, QR, TTS, cuaca, polling, tabel', rowId: 'ocmenu_tools' },
                  { title: '⚙️ KONTROL BOT', description: 'Mode, AI otomatis, keamanan, konfigurasi', rowId: 'ocmenu_control' }
                ]
              }]
            }, { quoted: m });
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
            if (!Number.isFinite(sec) || sec < 1 || sec > 86400 || !text) return sendReply('Gunakan: .autodel <1-86400 detik> | <pesan>');
            const sent = await sock.sendMessage(chatId, { text }, { quoted: m });
            if (sent?.key) {
              setTimeout(() => sock.sendMessage(chatId, { delete: sent.key }).catch(() => {}), sec * 1000);
            }
            break;
          }

          case 'setcurrency':
          case 'kurs': {
            if (!arg) return sendReply(`Kurs saat ini: *${db.currency}*. Ubah dengan: .setcurrency USD`);
            if (!/^[A-Z]{3}$/.test(arg.toUpperCase())) return sendReply('Kode mata uang harus 3 huruf, contoh IDR atau USD.');
            db.currency = arg.toUpperCase();
            saveDb();
            await sendReply(`💱 Mata uang default diubah ke *${db.currency}*`);
            break;
          }

          case 'fakepay':
          case 'paymsg': {
            if (!isOwner) return sendReply('Khusus Owner!');
            if (!arg) return sendReply(`Gunakan: .${cmd} <nominal> | <catatan>`);
            const parts = arg.split('|');
            const amount = Math.max(0, parseInt(parts[0].replace(/[^0-9]/g, ''), 10) || 0);
            const note = parts[1] ? parts[1].trim() : 'Simulasi pembayaran';
            await sendReply(`🧾 *SIMULASI PEMBAYARAN — BUKAN TRANSAKSI NYATA*\n\nNominal: ${amount.toLocaleString('id-ID')} ${db.currency}\nCatatan: ${note}\n\nPesan ini hanya simulasi, bukan bukti pembayaran.`);
            break;
          }

          case 'stickerpay': {
            const target = getTargetMediaMessage();
            if (!target?.message?.imageMessage) return sendReply('Kirim atau balas gambar dengan .stickerpay <nominal>. Fitur ini hanya membuat stiker simulasi.');
            const buf = await downloadMediaMessage(target, 'buffer', {});
            const webp = await createWebpSticker(buf, false, 'Sticker Simulasi', db.ownerName);
            await sock.sendMessage(chatId, { sticker: webp }, { quoted: m });
            const nominal = arg.replace(/[^0-9]/g, '') || '0';
            await sendReply(`SIMULASI: ${Number(nominal).toLocaleString('id-ID')} ${db.currency}. Bukan transaksi atau bukti pembayaran.`);
            break;
          }

          case 's':
          case 'sticker':
          case 'sprem': {
            const target = getTargetMediaMessage();
            if (!target || !(target.message.imageMessage || target.message.videoMessage)) return sendReply(`Kirim atau balas foto/video pendek dengan perintah *.${cmd}*`);
            const isVid = Boolean(target.message.videoMessage);
            const buf = await downloadMediaMessage(target, 'buffer', {});
            const webp = await createWebpSticker(buf, isVid, cmd === 'sprem' ? 'Premium Sticker' : 'Ochild Bot AI', db.ownerName);
            await sock.sendMessage(chatId, { sticker: webp }, { quoted: m });
            if (cmd === 'sprem') await sendReply('ℹ️ Baileys membuat stiker biasa; metadata premium khusus tidak tersedia pada runtime ini.');
            break;
          }

          case 'swm':
          case 'take': {
            const target = getTargetMediaMessage();
            if (!target || !(target.message.stickerMessage || target.message.imageMessage || target.message.videoMessage)) return sendReply('Balas stiker/foto/video dengan .swm NamaPack|NamaAuthor');
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

            const textPath = path.join(TEMP_DIR, `brat_${id}.txt`);
            fs.writeFileSync(textPath, formattedText, 'utf8');
            try {
              const safeTextPath = textPath.replace(/\\/g, '/').replace(/:/g, '\\:');
              const drawFilter = `drawtext=font='DejaVu Sans':textfile='${safeTextPath}':fontcolor=black:fontsize=46:line_spacing=12:x=(w-text_w)/2:y=(h-text_h)/2`; 
              await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'color=c=white:s=512x512:d=1', '-vf', drawFilter, '-frames:v', '1', '-vcodec', 'libwebp', '-lossless', '1', outWebp]);
              const webpWithExif = addExifToWebp(fs.readFileSync(outWebp), 'Brat Sticker', db.ownerName);
              await sock.sendMessage(chatId, { sticker: webpWithExif }, { quoted: m });
            } finally {
              if (fs.existsSync(outWebp)) fs.unlinkSync(outWebp);
              if (fs.existsSync(textPath)) fs.unlinkSync(textPath);
            }
            break;
          }

          case 'rvo':
          case 'vv':
          case '1x': {
            const target = getTargetMediaMessage();
            if (!target?.message) return sendReply(`Balas pesan foto/video sekali lihat dengan *.${cmd}*`);
            const innerMsg = extractMessageContent(target.message);
            if (innerMsg?.imageMessage) {
              const buf = await downloadMediaMessage(target, 'buffer', {});
              await sock.sendMessage(chatId, { image: buf, caption: innerMsg.imageMessage.caption || 'Media gambar berhasil diproses.' }, { quoted: m });
            } else if (innerMsg?.videoMessage) {
              const buf = await downloadMediaMessage(target, 'buffer', {});
              await sock.sendMessage(chatId, { video: buf, caption: innerMsg.videoMessage.caption || 'Media video berhasil diproses.' }, { quoted: m });
            } else {
              await sendReply('Pesan yang dibalas bukan media gambar/video yang dapat diakses.');
            }
            break;
          }

          case 'dl': {
            if (!arg) return sendReply('Gunakan: .dl <url_media_langsung>');
            let downloadUrl;
            try {
              downloadUrl = new URL(arg);
              if (!['http:', 'https:'].includes(downloadUrl.protocol) || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1|\[?fc[0-9a-f]{2}:|\[?fd[0-9a-f]{2}:|\[?fe80:)/i.test(downloadUrl.hostname)) throw new Error('URL tidak diizinkan');
            } catch { return sendReply('URL tidak valid atau alamat lokal tidak diizinkan.'); }
            if (!pluginPublicUrlAllowed(downloadUrl.toString())) return sendReply('URL tidak valid atau host lokal tidak diizinkan.');
            const res = await axios.get(downloadUrl.toString(), { responseType: 'arraybuffer', timeout: 30000, maxRedirects: 0, maxContentLength: 25 * 1024 * 1024, maxBodyLength: 25 * 1024 * 1024, headers: { 'User-Agent': 'Mozilla/5.0' } });
            const ct = res.headers['content-type'] || '';
            const buf = Buffer.from(res.data);
            if (ct.includes('image')) await sock.sendMessage(chatId, { image: buf, caption: '✅ Berhasil diunduh.' }, { quoted: m });
            else if (ct.includes('video')) await sock.sendMessage(chatId, { video: buf, caption: '✅ Berhasil diunduh.' }, { quoted: m });
            else if (ct.includes('audio')) await sock.sendMessage(chatId, { audio: buf, mimetype: 'audio/mp4' }, { quoted: m });
            else await sock.sendMessage(chatId, { document: buf, fileName: 'download_file', mimetype: ct || 'application/octet-stream' }, { quoted: m });
            break;
          }

          case 'setch': {
            if (!isOwner) return sendReply('Khusus Owner!');
            if (!arg) return sendReply(`Channel JID saat ini: *${db.channelJid || 'Belum diatur'}*\nAtur dengan: .setch 120363xxxxxxxxxx@newsletter`);
            const channelJid = arg.trim();
            if (!/^[0-9]{8,30}@newsletter$/.test(channelJid)) {
              return sendReply('Format Channel JID tidak valid. Gunakan JID WhatsApp Channel yang berakhiran @newsletter, bukan nama channel atau tautan undangan.');
            }
            db.channelJid = channelJid;
            saveDb();
            await sendReply(`✅ Tujuan WhatsApp Channel disimpan: *${channelJid}*`);
            break;
          }

          case 'imgch': {
            if (!isOwner) return sendReply('Khusus Owner!');
            if (!db.channelJid) return sendReply('Atur tujuan channel terlebih dahulu dengan .setch <channel_jid>');
            const target = getTargetMediaMessage();
            if (!target?.message?.imageMessage) return sendReply('Balas/kirim gambar dengan .imgch <caption> untuk menerbitkan ke channel.');
            const buf = await downloadMediaMessage(target, 'buffer', {});
            await sock.sendMessage(db.channelJid, { image: buf, caption: arg || '' });
            await sendReply('✅ Gambar dikirim ke WhatsApp Channel.');
            break;
          }

          case 'stickch':
          case 'sch': {
            if (!isOwner) return sendReply('Khusus Owner!');
            if (!db.channelJid) return sendReply('Atur tujuan channel terlebih dahulu dengan .setch <channel_jid>');
            const target = getTargetMediaMessage();
            if (!target || !(target.message.imageMessage || target.message.videoMessage || target.message.stickerMessage)) return sendReply('Balas gambar, video, atau stiker dengan .sch untuk menerbitkan stiker ke channel.');
            const buf = await downloadMediaMessage(target, 'buffer', {});
            const webp = target.message.stickerMessage ? buf : await createWebpSticker(buf, Boolean(target.message.videoMessage), 'Ochild Channel', db.ownerName);
            await sock.sendMessage(db.channelJid, { sticker: webp });
            await sendReply('✅ Stiker dikirim ke WhatsApp Channel.');
            break;
          }

          case 'poll': {
            const parts = arg.split('|').map(s => s.trim()).filter(Boolean);
            if (parts.length < 3) return sendReply('Gunakan: .poll Judul Polling | Opsi 1 | Opsi 2');
            if (new Set(parts.slice(1)).size < 2) return sendReply('Opsi polling harus berbeda.');
            await sock.sendMessage(chatId, { poll: { name: parts[0].slice(0, 250), values: [...new Set(parts.slice(1, 13))].map(x => x.slice(0, 100)), selectableCount: 1 } });
            break;
          }

          case 'quiz': {
            const parts = arg.split('|').map(s => s.trim()).filter(Boolean);
            if (parts.length < 3) return sendReply('Gunakan: .quiz Pertanyaan | Jawaban 1 | Jawaban 2');
            if (new Set(parts.slice(1)).size < 2) return sendReply('Opsi kuis harus berbeda.');
            await sock.sendMessage(chatId, { poll: { name: '🧠 KUIS: ' + parts[0], values: [...new Set(parts.slice(1, 13))], selectableCount: 1 } });
            break;
          }

          case 'event': {
            const parts = arg.split('|').map(s => s.trim());
            if (!parts[0]) return sendReply('Gunakan: .event Nama Acara | Deskripsi | Lokasi');
            await sendReply(['📅 *UNDANGAN ACARA*',`• *Acara:* ${parts[0]}`,`• *Deskripsi:* ${parts[1] || '-'}`,`• *Lokasi:* ${parts[2] || 'Online / Grup WhatsApp'}`,`• *Dibuat:* ${new Date().toLocaleString('id-ID')}`].join('\n'));
            await sock.sendMessage(chatId,{poll:{name:`RSVP: ${parts[0]}`.slice(0,250),values:['Hadir','Tidak hadir','Belum pasti'],selectableCount:1}});
            break;
          }

          case 'table': {
            const rows = arg.split('|').map(s => s.trim()).filter(Boolean);
            if (rows.length < 2) return sendReply('Gunakan: .table Judul | Kolom1,Kolom2 | Data1,Data2');
            let out = `📊 *${rows[0].toUpperCase()}*\n\`\`\`\n`;
            for (const r of rows.slice(1)) {
              out += r.split(',').map(c => c.trim().padEnd(14, ' ')).join(' | ') + '\n';
            }
            out += '```';
            await sendReply(out);
            break;
          }

          case 'button': {
            const parts = arg.split('|').map(s => s.trim()).filter(Boolean);
            if (parts.length < 3) return sendReply('Gunakan: .button Judul Poll | Opsi 1 | Opsi 2 (min. 2 opsi)');
            const options = [...new Set(parts.slice(1, 13))];
            if (options.length < 2) return sendReply('Opsi tombol/poll harus berbeda.');
            await sock.sendMessage(chatId, { poll: { name: parts[0], values: options, selectableCount: 1 } });
            break;
          }

          case 'listmenu': {
            const parts = arg.split('|').map(s => s.trim()).filter(Boolean);
            if (parts.length < 3) return sendReply('Gunakan: .listmenu Judul | Item 1 | Item 2 (min. 2 item)');
            const options = [...new Set(parts.slice(1, 13))];
            if (options.length < 2) return sendReply('Item menu harus berbeda.');
            await sock.sendMessage(chatId, { poll: { name: `📋 ${parts[0]}`.slice(0, 250), values: options.map(x => x.slice(0, 100)), selectableCount: 1 } });
            break;
          }

          case 'carousel': {
            const cards = arg ? arg.split('|').map(s => s.trim()).filter(Boolean) : ['Kartu 1 - Ochild Bot AI', 'Kartu 2 - Rolleys Suite'];
            if (!cards.length) return sendReply('Masukkan minimal satu item kartu.');
            const output = cards.slice(0, 10).map((card, i) => `╭─ *KARTU ${i + 1}* ─\n│ ${card}\n╰────────────`).join('\n\n');
            await sendReply(`🎠 *CAROUSEL (format kartu)*\n\n${output}\n\n_Maksimal 10 kartu. WhatsApp/Baileys tidak menyediakan carousel native stabil pada versi ini._`);
            break;
          }

          case 'html': {
            if (!arg) return sendReply('Gunakan: .html <b>Teks</b> — tag HTML diubah menjadi teks WhatsApp, bukan dirender sebagai halaman web.');
            const htmlText = arg
              .replace(/<(br|hr)\s*\/?\s*>/gi, '\n')
              .replace(/<\/(p|div|li|h[1-6])\s*>/gi, '\n')
              .replace(/<li\b[^>]*>/gi, '• ')
              .replace(/<[^>]*>/g, '')
              .replace(/&nbsp;/gi, ' ')
              .replace(/&amp;/gi, '&')
              .replace(/&lt;/gi, '<')
              .replace(/&gt;/gi, '>')
              .replace(/&quot;/gi, '"')
              .replace(/&#39;|&apos;/gi, "'")
              .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(0x10FFFF, Number(n))))
              .replace(/\n[ \t]+/g, '\n')
              .replace(/\n{3,}/g, '\n\n')
              .trim();
            await sendReply('🌐 *HTML → Teks WhatsApp:*\n' + htmlText);
            break;
          }

          case 'comment': {
            if (!arg) return sendReply('Gunakan: .comment <isi komentar> (balas pesan yang ingin dikomentari)');
            if (!quotedMsg) return sendReply('Balas pesan target terlebih dahulu, lalu ketik .comment <komentar>.');
            const qctx = actualMsg.extendedTextMessage?.contextInfo || {};
            const original = deletedMessagesCache[qctx.stanzaId] || (qctx.stanzaId ? {
              key: {
                remoteJid: chatId,
                id: qctx.stanzaId,
                ...(qctx.participant ? { participant: qctx.participant } : {}),
                fromMe: Boolean(qctx.fromMe)
              },
              message: quotedMsg
            } : null);
            if (!original?.message) return sendReply('Pesan asli tidak dapat dikutip. Balas pesan yang masih tersedia lalu coba lagi.');
            await sock.sendMessage(chatId, { text: `💬 ${arg}` }, { quoted: original });
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
            const target = getTargetMediaMessage();
            if (!target?.message) return sendReply('Balas pesan yang ingin diteruskan dengan *.fwd*');
            await sock.copyNForward(chatId, target, true);
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
        await sendReply('⌨️ Fake Typing Global AKTIF (berjalan terus setiap 8 detik).');
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
        await sendReply('🎙️ Fake Recording Global AKTIF (berjalan terus setiap 8 detik).');
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
            await sock.sendMessage(chatId, { audio: Buffer.from(res.data), mimetype: 'audio/mpeg', ptt: true }, { quoted: m });
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
                contextInfo: {}
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
            const outTpl = path.join(TEMP_DIR, `audio_${Date.now()}_${Math.floor(Math.random() * 1000)}.%(ext)s`);
            try {
              const { stdout } = await execAsync(`yt-dlp --no-playlist -x --audio-format mp3 --audio-quality 128K -o ${shellQuote(outTpl)} --print after_move:filepath ${shellQuote(`ytsearch1:${arg}`)}`, { timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
              const audioPath = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
              if (!audioPath || !fs.existsSync(audioPath)) return sendReply('❌ Gagal menemukan atau mengunduh audio. Pastikan yt-dlp dan FFmpeg terpasang.');
              try {
                const audioBuffer = fs.readFileSync(audioPath);
                await sock.sendMessage(chatId, { audio: audioBuffer, mimetype: 'audio/mpeg', fileName: path.basename(audioPath) }, { quoted: m });
              } finally {
                if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
              }
            } catch (e) {
              console.error('[PLAY]', e.message);
              await sendReply('❌ Download audio gagal. Pastikan yt-dlp/FFmpeg terbaru dan koneksi internet tersedia.');
            } finally {
              for (const file of fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(path.basename(outTpl).split('.')[0]))) {
                const filePath = path.join(TEMP_DIR, file);
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
              }
            }
            break;
          }

          case 'lyrics': {
            if (!arg) return sendReply('.lyrics <judul lagu>');
            const info = await askAi(chatId, `Berikan ringkasan makna lagu, informasi artis, dan tema lagu (jangan menyalin lirik panjang) untuk: ${arg}`);
            await sendReply(info);
            break;
          }
          case 'ttdl': {
            if (!/^https?:\/\/(www\.)?(tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\//i.test(arg)) return sendReply('Gunakan: .ttdl <link TikTok>');
            await sendReply('⏳ Mengunduh video TikTok…');
            const outputTemplate=path.join(TEMP_DIR,`tiktok_${Date.now()}_%(id)s.%(ext)s`);
            try {
              const {stdout}=await execAsync(`yt-dlp --no-playlist --max-filesize 45M -o ${shellQuote(outputTemplate)} --print after_move:filepath ${shellQuote(arg)}`,{timeout:120000,maxBuffer:2*1024*1024});
              const videoPath=stdout.trim().split(/\r?\n/).filter(Boolean).pop();
              if(!videoPath||!fs.existsSync(videoPath)) return sendReply('❌ Download gagal, video mungkin privat/terbatas atau yt-dlp perlu diperbarui.');
              try { const video=fs.readFileSync(videoPath); if(video.length>45*1024*1024) return sendReply('❌ Video lebih dari 45 MB, tidak dikirim.'); const mime=path.extname(videoPath).toLowerCase()==='.webm'?'video/webm':'video/mp4'; await sock.sendMessage(chatId,{video,mimetype:mime,caption:'✅ Video TikTok'}, {quoted:m}); }
              finally { if(fs.existsSync(videoPath))fs.unlinkSync(videoPath); }
            } catch(e) { console.error('[TTDL]',e.message); await sendReply('❌ Gagal mengunduh TikTok. Perbarui yt-dlp dan coba lagi.'); }
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
          case 'aitag': {
            if (!isOwner) return sendReply('Khusus Owner!');
            const nextState = arg ? arg.toLowerCase() === 'on' : !db[cmd];
            db[cmd] = nextState;
            saveDb();
            await sendReply(`⚙️ Fitur *${cmd.toUpperCase()}* sekarang: *${nextState ? 'ON' : 'OFF'}*`);
            break;
          }
          case 'adbanner': {
            if (!isOwner) return sendReply('Khusus Owner!');
            db.adbanner = false;
            saveDb();
            await sendReply('ℹ️ Metadata iklan tidak tersedia melalui Baileys. Tidak ada perubahan yang dilakukan.');
            break;
          }
          case 'fwdboost': {
            if (!isOwner) return sendReply('Khusus Owner!');
            db.fwdboost = false;
            saveDb();
            await sendReply('ℹ️ Badge forward palsu tidak didukung. Gunakan .fwd untuk meneruskan pesan asli.');
            break;
          }
          case 'ghostmode': {
            if (!isOwner) return sendReply('Khusus Owner!');
            db.ghostmode = arg ? arg.toLowerCase() === 'on' : !db.ghostmode;
            saveDb();
            if (db.ghostmode) {
              for (const jid of (db.presenceChats || [])) await sock.sendPresenceUpdate('paused', jid).catch(() => {});
            } else if (db.globalPresence) {
              for (const jid of (db.presenceChats || [])) await sock.sendPresenceUpdate(db.globalPresence, jid).catch(() => {});
            }
            await sendReply(`👻 Ghostmode sekarang: *${db.ghostmode ? 'ON' : 'OFF'}* (bot menghindari update presence).`);
            break;
          }
      case 'quote': {
        if (!isOwner) return sendReply('Khusus Owner!');
        db.quoteVerified = false;
        saveDb();
        return sendReply('ℹ️ Fake quote/label verifikasi tidak didukung. Bot sekarang menggunakan quote pesan asli bila tersedia.');
      }

          case 'fakequote': {
            if (!isOwner) return sendReply('Khusus Owner!');
            db.fakequoteText = '';
            db.quoteVerified = false;
            saveDb();
            await sendReply('ℹ️ Label quote buatan dinonaktifkan; bot memakai kutipan pesan asli.');
            break;
          }

          case 'react': {
            await sock.sendMessage(chatId, { react: { text: arg || '🔥', key: m.key } });
            break;
          }
        }
      } catch (err) {
        console.error('[ERROR]', err.message);
        if (chatId) {
          sock.sendMessage(chatId, { text: `⚠️ Fitur gagal dijalankan: ${String(err.message || err).slice(0, 300)}` }).catch(() => {});
        }
      }
    }
  });
}

checkFfmpegOnStartup();
startBot();
