// 用 WhatsApp（Baileys）按名单自动发送提醒
//   npm start 名单.xlsx          正式发送
//   npm run preview 名单.xlsx    只预览信息，不登入、不发送
//   npm run listen               只开着等客户回复，自动发 Channel 链接
import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from 'baileys';
import ExcelJS from 'exceljs';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const CONFIG = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));
const TEMPLATE = fs.readFileSync(path.join(DIR, 'message.txt'), 'utf8').trim();
const REPLY_TEMPLATE = fs.readFileSync(path.join(DIR, 'reply.txt'), 'utf8').trim();
const LOG_FILE = path.join(DIR, 'sent-log.csv');
const PHONE_KEYS = ['电话', '号码', '手机', 'phone', 'hp', 'tel', 'mobile', 'nombor'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const randomBetween = (min, max) => min + Math.random() * (max - min);
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD

// Malaysian numbers: 012… → 6012…, +60… / 60… kept as is
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('0')) d = '6' + d;
  else if (!d.startsWith('60') && d.length >= 9 && d.length <= 10) d = '60' + d;
  return /^60\d{8,10}$/.test(d) ? d : null;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

async function readRows(file) {
  if (/\.xlsx$/i.test(file)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const rows = [];
    wb.worksheets[0].eachRow(row => {
      rows.push(row.values.slice(1).map(v => (v && typeof v === 'object' ? (v.text ?? v.result ?? '') : v ?? '').toString().trim()));
    });
    return rows;
  }
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim()).map(parseCsvLine);
}

function readLog() {
  if (!fs.existsSync(LOG_FILE)) return [];
  return fs.readFileSync(LOG_FILE, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map(l => {
    const [time, phone, name, status] = parseCsvLine(l);
    return { time, phone, name, status };
  });
}

function writeLog(phone, name, status) {
  const esc = s => `"${String(s).replace(/"/g, '""')}"`;
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, '﻿time,phone,name,status\n');
  fs.appendFileSync(LOG_FILE, [new Date().toISOString(), phone, name, status].map(esc).join(',') + '\n');
}

function buildJobs(rows) {
  const headers = rows[0];
  const phoneIdx = headers.findIndex(h => PHONE_KEYS.some(k => h.toLowerCase().includes(k)));
  if (phoneIdx < 0) throw new Error(`找不到电话栏，第一行标题是：${headers.join(' | ')}`);
  const nameIdx = headers.findIndex((h, i) => i !== phoneIdx);

  const done = new Set(readLog().filter(r => r.status === 'sent' || r.status === 'not_on_whatsapp').map(r => r.phone));
  const seen = new Set();
  const jobs = [], bad = [];
  let skipped = 0;
  for (const cols of rows.slice(1)) {
    const rec = Object.fromEntries(headers.map((h, i) => [h, cols[i] ?? '']));
    const name = cols[nameIdx] ?? '';
    const phone = normalizePhone(cols[phoneIdx]);
    if (!phone) { bad.push(`${name} (${cols[phoneIdx] || '空'})`); continue; }
    if (seen.has(phone)) continue;
    seen.add(phone);
    if (done.has(phone)) { skipped++; continue; }
    const text = TEMPLATE.replace(/\{([^}]+)\}/g, (m, k) => (k.trim() in rec ? rec[k.trim()] : m));
    jobs.push({ phone, name, text });
  }
  return { jobs, bad, skipped };
}

let SOCK; // 当前连线（断线重连后会换新的）

const autoReplyOn = () => CONFIG.autoReply?.enabled && /^https:\/\/whatsapp\.com\/channel\//.test(CONFIG.autoReply.channelLink || '');
const replyText = () => REPLY_TEMPLATE.replace(/\{链接\}/g, CONFIG.autoReply.channelLink);

// 客户回复关键字（例如 "1"）→ 自动发 Channel 链接，每人只发一次
function attachAutoReply(sock) {
  if (!autoReplyOn()) return;
  const keywords = CONFIG.autoReply.keywords.map(k => k.toLowerCase());
  const replied = new Set(readLog().filter(r => r.status === 'link_sent').map(r => r.phone));
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      const jid = msg.key.remoteJid || '';
      if (msg.key.fromMe || !/@(s\.whatsapp\.net|lid)$/.test(jid)) continue; // 不理群组、频道、状态
      const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim().toLowerCase();
      if (!keywords.includes(text.replace(/[。.!！~\s]+$/, ''))) continue;
      const who = (msg.key.remoteJidAlt || jid).split('@')[0].split(':')[0];
      if (replied.has(who)) continue;
      replied.add(who);
      try {
        await sleep(randomBetween(3000, 8000));
        await sock.sendMessage(jid, { text: replyText() });
        writeLog(who, msg.pushName || '', 'link_sent');
        console.log(`↩ ${msg.pushName || who} 回复了"${text}"，已自动发 Channel 链接`);
      } catch (err) {
        replied.delete(who);
        console.log(`↩ 自动回复 ${who} 失败：${err.message}`);
      }
    }
  });
}

function connect() {
  return new Promise(async (resolve, reject) => {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(DIR, 'auth'));
    const sock = makeWASocket({ auth: state, logger: pino({ level: 'silent' }), browser: Browsers.windows('Chrome') });
    let pairingRequested = false;
    sock.ev.on('creds.update', saveCreds);
    attachAutoReply(sock);
    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        if (CONFIG.loginWithPairingCode && !pairingRequested) {
          pairingRequested = true;
          const code = await sock.requestPairingCode(normalizePhone(CONFIG.senderPhone));
          console.log(`\n在 ${CONFIG.senderPhone} 的手机：WhatsApp → 已连接的设备 → 连接设备 → 改用电话号码连接，输入配对码：${code}\n`);
        } else if (!CONFIG.loginWithPairingCode) {
          console.log(`\n用 ${CONFIG.senderPhone} 的手机扫描：WhatsApp → 已连接的设备 → 连接设备\n`);
          qrcode.generate(qr, { small: true });
        }
      }
      if (connection === 'open') { SOCK = sock; resolve(sock); }
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code === DisconnectReason.loggedOut) {
          reject(new Error('已被登出。删除 auth 文件夹后重新运行再登入一次。'));
        } else {
          sleep(3000).then(connect).then(resolve, reject); // 断线或登入后重启，自动重连
        }
      }
    });
  });
}

async function listenForever() {
  if (!autoReplyOn()) {
    console.log('自动回复没开：请在 config.json 的 autoReply 填上 channelLink（https://whatsapp.com/channel/...），enabled 设为 true。');
    process.exit(0);
  }
  console.log(`\n自动回复开着：客户回复 ${CONFIG.autoReply.keywords.join(' / ')} 就会收到 Channel 链接。`);
  console.log('程序开着才会回复，按 Ctrl+C 结束。');
  await new Promise(() => {});
}

async function main() {
  const dry = process.argv.includes('--dry');
  const listenOnly = process.argv.includes('--listen');
  const file = process.argv.slice(2).find(a => !a.startsWith('--'));
  if (listenOnly) { await connect(); return listenForever(); }
  if (!file) { console.log('用法：npm start 名单.xlsx   （或 npm run preview 名单.xlsx 先预览）'); process.exit(1); }

  const { jobs, bad, skipped } = buildJobs(await readRows(file));
  const sentToday = readLog().filter(r => r.status === 'sent' && new Date(r.time).toLocaleDateString('en-CA') === today()).length;
  const quota = Math.max(0, CONFIG.dailyLimit - sentToday);
  const batch = jobs.slice(0, quota);

  console.log(`名单：待发 ${jobs.length} 人，之前已发过跳过 ${skipped} 人，号码有问题 ${bad.length} 人`);
  if (bad.length) console.log('  号码有问题：' + bad.join('、'));
  console.log(`今天已发 ${sentToday} 条，每日上限 ${CONFIG.dailyLimit}，这次会发 ${batch.length} 条`);

  if (dry) {
    const r = CONFIG.officialApiRateMYR;
    console.log(`\n如果改用官方 Cloud API 发这 ${jobs.length} 人（估计价，以 Meta 账单为准）：`);
    console.log(`  提醒类 Utility   约 RM ${(jobs.length * r.utility).toFixed(2)}（每条 RM ${r.utility}）`);
    console.log(`  推广类 Marketing 约 RM ${(jobs.length * r.marketing).toFixed(2)}（每条 RM ${r.marketing}）`);
    for (const j of batch.slice(0, 5)) console.log(`\n→ +${j.phone} ${j.name}\n${j.text}`);
    if (batch.length > 5) console.log(`\n……还有 ${batch.length - 5} 条`);
    if (autoReplyOn()) console.log(`\n客户回复 ${CONFIG.autoReply.keywords.join(' / ')} 时，自动回复：\n${replyText()}`);
    else console.log('\n（自动回复还没开：config.json 的 autoReply 要填 channelLink 并把 enabled 设为 true）');
    return;
  }
  if (!batch.length && !autoReplyOn()) return;

  await connect();
  console.log('已登入，开始发送。按 Ctrl+C 可随时停止，下次运行会从没发的继续。\n');

  let sent = 0;
  for (const [i, job] of batch.entries()) {
    const tag = `[${i + 1}/${batch.length}] +${job.phone} ${job.name}`;
    try {
      const sock = SOCK;
      const [result] = await sock.onWhatsApp(job.phone);
      if (!result?.exists) { writeLog(job.phone, job.name, 'not_on_whatsapp'); console.log(`${tag}  ✗ 没有 WhatsApp`); continue; }
      await sock.sendPresenceUpdate('composing', result.jid);
      await sleep(randomBetween(1500, 4000));
      await sock.sendMessage(result.jid, { text: job.text });
      writeLog(job.phone, job.name, 'sent');
      sent++;
      console.log(`${tag}  ✓ 已发送`);
    } catch (err) {
      writeLog(job.phone, job.name, `failed: ${err.message}`);
      console.log(`${tag}  ✗ 失败：${err.message}`);
    }
    if (i === batch.length - 1) break;
    if (sent > 0 && sent % CONFIG.breakEvery === 0) {
      const mins = randomBetween(CONFIG.breakMinutes[0], CONFIG.breakMinutes[1]);
      console.log(`   休息 ${mins.toFixed(1)} 分钟……`);
      await sleep(mins * 60_000);
    } else {
      await sleep(randomBetween(CONFIG.delaySeconds[0], CONFIG.delaySeconds[1]) * 1000);
    }
  }

  console.log(`\n完成：这次发出 ${sent} 条。记录在 sent-log.csv`);
  if (jobs.length > batch.length) console.log(`还有 ${jobs.length - batch.length} 人没发（到了每日上限），明天再运行同一个名单就会继续。`);
  await sleep(3000); // 让最后一条信息送出
  if (autoReplyOn()) return listenForever();
  process.exit(0);
}

main().catch(err => { console.error('出错：' + err.message); process.exit(1); });
