const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const P = require('pino');
const fs = require('fs');

// --- 1. الأرقام المستبعدة (تجاهل تام لرسائلها) ---
const ignoredNumbers = [
    "201140301940@s.whatsapp.net",
    "201141993937@s.whatsapp.net",
    "201128676860@s.whatsapp.net",
    "201103239747@s.whatsapp.net",
    "201140301850@s.whatsapp.net",
    "201019929844@s.whatsapp.net"
];

// --- 2. إعدادات جوجل شيت الخاص بك ---
const SPREADSHEET_ID = '1uf4NfGOgT4Xh1m0JHznw4T4tqsaAHy4_qAZCzDg5eaI';
const CREDENTIALS = require('./google-credentials.json');

async function appendToGoogleSheet(rowdata) {
    try {
        const serviceAccountAuth = new JWT({
            email: CREDENTIALS.client_email,
            key: CREDENTIALS.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });

        const doc = new GoogleSpreadsheet(SPREADSHEET_ID, serviceAccountAuth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        
        await sheet.addRow({
            "اسم الجروب": rowdata.groupName,
            "اسم المرسل": rowdata.senderName,
            "الوقت والتاريخ": rowdata.timestamp,
            "نوع المحتوى": rowdata.messageType,
            "رابط/اسم الملف": rowdata.fileUrlOrName,
            "نص الرسالة": rowdata.messageBody
        });
    } catch (error) {
        console.error('خطأ في حفظ البيانات بجوجل شيت:', error);
    }
}

const STATE_FILE = './last_messages.json';
let lastMessagesState = {};
if (fs.existsSync(STATE_FILE)) {
    lastMessagesState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}

function saveState() {
    fs.writeFileSync(STATE_FILE, JSON.stringify(lastMessagesState, null, 2));
}

async function startWhatsAppBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: P({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('انقطع الاتصال، يتم إعادة المحاولة...', shouldReconnect);
            if (shouldReconnect) startWhatsAppBot();
        } else if (connection === 'open') {
            console.log('تم الاتصال بنجاح بواتساب وجاهز لاستقبال الرسائل وترحيلها لجوجل شيت!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            if (!msg.message) continue;

            const remoteJid = msg.key.remoteJid;
            if (!remoteJid.endsWith('@g.us')) continue;

            const senderJid = msg.key.participant || msg.participant;

            if (ignoredNumbers.includes(senderJid)) continue;

            const messageId = msg.key.id;
            
            if (!lastMessagesState[remoteJid]) {
                lastMessagesState[remoteJid] = [];
            }
            
            if (lastMessagesState[remoteJid].includes(messageId)) continue;

            const groupMetadata = await sock.groupMetadata(remoteJid).catch(() => ({ subject: 'مجموعة واتساب' }));
            const groupName = groupMetadata.subject || 'مجموعة';
            const senderName = msg.pushName || 'مستخدم';
            const timestamp = new Date(msg.messageTimestamp * 1000).toLocaleString('ar-EG');

            let messageType = 'نص';
            let messageBody = '';
            let fileUrlOrName = '-';

            if (msg.message.conversation) {
                messageBody = msg.message.conversation;
            } else if (msg.message.extendedTextMessage) {
                messageBody = msg.message.extendedTextMessage.text;
            } else if (msg.message.imageMessage) {
                messageType = 'صورة';
                messageBody = msg.message.imageMessage.caption || '';
                fileUrlOrName = 'صورة مرفقة';
            } else if (msg.message.documentMessage) {
                messageType = 'ملف (Document)';
                fileUrlOrName = msg.message.documentMessage.fileName || 'ملف';
                messageBody = msg.message.documentMessage.caption || '';
            } else if (msg.message.audioMessage) {
                messageType = 'رسالة صوتية';
                fileUrlOrName = 'مقطع صوتي';
            }

            lastMessagesState[remoteJid].push(messageId);
            if (lastMessagesState[remoteJid].length > 50) lastMessagesState[remoteJid].shift();
            saveState();

            await appendToGoogleSheet({
                groupName,
                senderName,
                timestamp,
                messageType,
                fileUrlOrName,
                messageBody
            });

            console.log(`تم تسجيل رسالة جديدة من جروب: ${groupName}`);
        }
    });
}

startWhatsAppBot();