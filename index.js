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

const DB_FILE = path.join(__dirname, 'database.json');
const NOTES_DIR = path.join(__dirname, 'notes_storage');
const TEMP_DIR = path.join(__dirname, 'temp');

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
  defaultChannel: 'Ochild Bot AI Channel',
  anticall: false,
  antidelete: false,
  autostory: false,
  ghostmode: false,
  adbanner: false,
  fwdboost: false,
  aitag: false,
  fakequoteText: '',
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
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
  } catch (e) {}
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
  const nextLevelXp = user.level * 100;
  if (user.xp >= nextLevelXp) {
    user.level += 1;
  }
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

  if (db.grokApiKey) {
    try {
      const res = await axios.post(
        'https://api.x.ai/v1/chat/completions',
        { model: 'grok-3-mini', messages },
        { headers: { Authorization: `Bearer ${db.grokApiKey}`, 'Content-Type': 'application/json' }, timeout: 25000 }
      );
      const reply = res.data.choices[0].message.content;
      aiHistories[chatId].push({ role: 'user', content: prompt }, { role: 'assistant', content: reply });
      return reply;
    } catch (e) {
      const resFallback = await axios.post(
        'https://api.x.ai/v1/chat/completions',
        { model: 'grok-2-latest', messages },
        { headers: { Authorization: `Bearer ${db.grokApiKey}`, 'Content-Type': 'application/json' }, timeout: 25000 }
      );
      const reply = resFallback.data.choices[0].message.content;
      aiHistories[chatId].push({ role: 'user', content: prompt }, { role: 'assistant', content: reply });
      return reply;
    }
  }

  if (db.groqApiKey) {
    const res = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      { model: 'llama-3.3-70b-versatile', messages },
      { headers: { Authorization: `Bearer ${db.groqApiKey}`, 'Content-Type': 'application/json' }, timeout: 25000 }
    );
    const reply = res.data.choices[0].message.content;
    aiHistories[chatId].push({ role: 'user', content: prompt }, { role: 'assistant', content: reply });
    return reply;
  }

  const encoded = encodeURIComponent(sys + '\n\nUser: ' + prompt);
  const res = await axios.get(`https://text.pollinations.ai/${encoded}`, { timeout: 20000 });
  const reply = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  aiHistories[chatId].push({ role: 'user', content: prompt }, { role: 'assistant', content: reply });
  return reply;
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
  }
  if (db.aitag) {
    ctx.mentionedJid = [m.key.participant || m.key.remoteJid];
  }
  if (db.adbanner) {
    ctx.externalAdReply = {
      title: 'OCHILD BOT AI + ROLLEYS SUITE',
      body: 'WhatsApp Automation & AI Assistant',
      mediaType: 1,
      showAdAttribution: true,
      renderLargerThumbnail: false,
      sourceUrl: 'https://x.ai'
    };
  }
  return Object.keys(ctx).length > 0 ? ctx : undefined;
}

function buildQuotedOption(m) {
  if (db.fakequoteText) {
    return {
      quoted: {
        key: {
          remoteJid: m.key.remoteJid,
          fromMe: false,
          id: 'VERIFIED_' + Date.now(),
          participant: '0@s.whatsapp.net'
        },
        message: { extendedTextMessage: { text: db.fakequoteText } }
      }
    };
  }
  return { quoted: m };
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

  if (!sock.authState.creds.registered) {
    const nomorBot = '6281998874899'; // GANTI NOMOR WA BOT ANDA DI SINI
    setTimeout(async () => {
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
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode || 0;
      console.log('[KONEKSI TERPUTUS] Kode:', code);
      if (code !== DisconnectReason.loggedOut) setTimeout(startBot, 3000);
    } else if (connection === 'open') {
      console.log('✅ ochild bot ai + Rolleys Suite (Full & Fast) Berhasil Terhubung!');
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

        deletedMessagesCache[m.key.id] = m;

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
          if (db.autostory && !m.key.fromMe) {
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
          if (quotedMsg) return { key: m.key, message: extractMessageContent(quotedMsg) };
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
            const sec = parseInt(arg, 10) || 0;
            db.autoDelSeconds = sec;
            saveDb();
            await sendReply(sec > 0 ? `⏱️ Auto-Delete pesan bot diatur ke *${sec} detik*.` : '✅ Auto-Delete pesan bot dimatikan.');
            break;
          }

          case 'autodel': {
            const parts = arg.split('|');
            const sec = parseInt(parts[0], 10);
            const text = parts.slice(1).join('|').trim();
            if (!sec || !text) return sendReply('Gunakan: .autodel <detik> | <pesan>');
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
            const amount = parseInt(parts[0].replace(/[^0-9]/g, ''), 10) || 100000;
            const note = parts[1] ? parts[1].trim() : 'Pembayaran via Ochild Bot AI';
            const { generateWAMessageFromContent } = require("@itsliaaa/baileys");
        const payMsg = generateWAMessageFromContent(chatId, {
          requestPaymentMessage: {
            currencyCodeIso4217: db.currency,
            amount1000: amount * 1000,
            requestFrom: sender,
            noteMessage: { extendedTextMessage: { text: note } }
          }
        }, { userJid: sock.user.id });
        await sock.relayMessage(chatId, payMsg.message, { messageId: payMsg.key.id });
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
            const webpWithExif = addExifToWebp(fs.readFileSync(outWebp), 'Brat Sticker', db.ownerName);
            await sock.sendMessage(chatId, { sticker: webpWithExif }, { quoted: m });
            if (fs.existsSync(outWebp)) fs.unlinkSync(outWebp);
            break;
          }

          case 'rvo':
          case 'vv':
          case '1x': {
            if (!quotedMsg) return sendReply(`Balas pesan foto/video sekali lihat dengan *.${cmd}*`);
            const innerMsg = extractMessageContent(quotedMsg);
            if (innerMsg.imageMessage) {
              const buf = await downloadMediaMessage({ key: m.key, message: innerMsg }, 'buffer', {});
              await sock.sendMessage(chatId, { image: buf, caption: innerMsg.imageMessage.caption || '🔓 View Once dibuka.' }, { quoted: m });
            } else if (innerMsg.videoMessage) {
              const buf = await downloadMediaMessage({ key: m.key, message: innerMsg }, 'buffer', {});
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
            if (parts.length < 2) return sendReply('Gunakan: .button Teks Pesan | Tombol 1 | Tombol 2');
            const btnList = parts.slice(1).map((label, idx) => `🔘 *[${idx + 1}]* ${label}`).join('\n');
            await sendReply(`${parts[0]}\n\n${btnList}\n\n_Ochild Bot AI + Rolleys_`);
            break;
          }

          case 'listmenu': {
            const parts = arg.split('|').map(s => s.trim()).filter(Boolean);
            if (parts.length < 2) return sendReply('Gunakan: .listmenu Judul Menu | Item 1 | Item 2');
            const listRows = parts.slice(1).map((item, idx) => `${idx + 1}. *${item}*`).join('\n');
            await sendReply(`📋 *${parts[0].toUpperCase()}*\n\n${listRows}`);
            break;
          }

          case 'carousel': {
            const cards = arg ? arg.split('|').map(s => s.trim()) : ['Kartu 1 - Ochild Bot AI', 'Kartu 2 - Rolleys Suite'];
            await sendReply('🎠 *CAROUSEL CARDS*\n\n' + cards.map((c, i) => `▪ *[Card ${i + 1}]* ${c}`).join('\n'));
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
            await sock.sendPresenceUpdate('composing', chatId);
            await sendReply('⌨️ Status mengetik diaktifkan.');
            break;
          }

          case 'fakerecording': {
            await sock.sendPresenceUpdate('recording', chatId);
            await sendReply('🎙️ Status merekam suara diaktifkan.');
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
            const { stdout } = await execAsync(`yt-dlp -x --audio-format mp3 --audio-quality 128K -o "${outTpl}" --print after_move:filepath "ytsearch1:${arg}"`);
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
