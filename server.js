// server.js - WhatsApp Bulk Messaging Bot (Fixed for Koyeb)
const { Client, NoAuth } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const express = require('express');
const fs = require('fs');
const { execSync } = require('child_process');

// Configuration
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AUTHORIZED_USERS = process.env.AUTHORIZED_TELEGRAM_IDS?.split(',') || [];
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set!');
    process.exit(1);
}

// Rate limiting
const MESSAGE_DELAY_MIN = parseInt(process.env.MESSAGE_DELAY_MIN) || 5000;
const MESSAGE_DELAY_MAX = parseInt(process.env.MESSAGE_DELAY_MAX) || 10000;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 5;
const BATCH_DELAY = parseInt(process.env.BATCH_DELAY) || 60000;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;

// Express
const app = express();
let healthStatus = {
    status: 'starting',
    whatsapp: 'disconnected',
    startTime: Date.now()
};

app.get('/', (req, res) => res.send('WhatsApp Bot Running'));
app.get('/health', (req, res) => res.json(healthStatus));

// Telegram Bot
const telegram = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// WhatsApp Client - NO AUTH (this is the key!)
let whatsappClient;

function createWhatsAppClient() {
    return new Client({
        authStrategy: new NoAuth(),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                `--user-data-dir=/tmp/chromium-${Date.now()}`
            ],
            executablePath: '/usr/bin/chromium'
        }
    });
}

// State
let state = {
    whatsappReady: false,
    currentCampaign: null,
    campaigns: [],
    contacts: []
};

// Utils
function isAuthorized(userId) {
    if (AUTHORIZED_USERS.length === 0) return true;
    return AUTHORIZED_USERS.includes(userId.toString());
}

function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatPhoneNumber(phone) {
    phone = phone.replace(/\D/g, '');
    if (!phone.startsWith('212') && phone.length < 12) {
        phone = '212' + phone;
    }
    return phone + '@c.us';
}

// WhatsApp Events
function setupWhatsAppEvents() {
    whatsappClient.on('qr', async (qr) => {
        console.log('🎯 QR CODE RECEIVED!');
        healthStatus.whatsapp = 'waiting_qr';
        
        try {
            const qrImage = await qrcode.toDataURL(qr);
            const message = '📱 *Scan QR Code*\n\nOpen WhatsApp → Linked Devices → Link a Device\n\n⏱️ Expires in 60 seconds';
            
            for (const userId of AUTHORIZED_USERS) {
                await telegram.sendPhoto(userId, Buffer.from(qrImage.split(',')[1], 'base64'), {
                    caption: message,
                    parse_mode: 'Markdown'
                }).catch(err => console.error('Failed to send QR:', err.message));
            }
        } catch (error) {
            console.error('QR handler error:', error);
        }
    });

    whatsappClient.on('ready', async () => {
        console.log('✅ WhatsApp Ready!');
        state.whatsappReady = true;
        healthStatus.whatsapp = 'connected';
        
        const info = whatsappClient.info;
        const message = `✅ WhatsApp Connected!\n\n📱 ${info.wid.user}\n👤 ${info.pushname}\n\nType /help for commands`;
        
        for (const userId of AUTHORIZED_USERS) {
            telegram.sendMessage(userId, message).catch(() => {});
        }
    });

    whatsappClient.on('disconnected', () => {
        console.log('❌ WhatsApp Disconnected');
        state.whatsappReady = false;
        healthStatus.whatsapp = 'disconnected';
    });
}

// Telegram Commands
telegram.onText(/\/start/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return telegram.sendMessage(msg.chat.id, '🚫 Unauthorized');
    telegram.sendMessage(msg.chat.id, `🤖 WhatsApp Bulk Bot\n\nWhatsApp: ${state.whatsappReady ? '✅' : '❌'}\nContacts: ${state.contacts.length}\n\nType /help`);
});

telegram.onText(/\/help/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    const help = `/status - Check status\n/reconnect - Reconnect WhatsApp\n/addcontact +212... - Add contact\n/contacts - View contacts\n/send - Start campaign\n/stop - Stop campaign`;
    telegram.sendMessage(msg.chat.id, help);
});

telegram.onText(/\/status/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    const status = `Status: ${healthStatus.status}\nWhatsApp: ${healthStatus.whatsapp}\nContacts: ${state.contacts.length}\nCampaigns: ${state.campaigns.length}`;
    telegram.sendMessage(msg.chat.id, status);
});

telegram.onText(/\/reconnect/, async (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    telegram.sendMessage(msg.chat.id, '🔄 Reconnecting...');
    
    try {
        if (whatsappClient) await whatsappClient.destroy().catch(() => {});
        await new Promise(r => setTimeout(r, 2000));
        initializeWhatsApp();
        telegram.sendMessage(msg.chat.id, '✅ Reconnecting... Wait for QR');
    } catch (error) {
        telegram.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
    }
});

telegram.onText(/\/addcontact (.+)/, (msg, match) => {
    if (!isAuthorized(msg.chat.id)) return;
    const phone = formatPhoneNumber(match[1]);
    if (!state.contacts.includes(phone)) {
        state.contacts.push(phone);
        telegram.sendMessage(msg.chat.id, `✅ Added: ${match[1]}\nTotal: ${state.contacts.length}`);
    } else {
        telegram.sendMessage(msg.chat.id, 'Already exists');
    }
});

telegram.onText(/\/contacts/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    if (state.contacts.length === 0) return telegram.sendMessage(msg.chat.id, 'No contacts');
    const list = state.contacts.slice(0, 20).map((c, i) => `${i+1}. ${c.replace('@c.us', '')}`).join('\n');
    telegram.sendMessage(msg.chat.id, `Contacts (${state.contacts.length}):\n\n${list}`);
});

telegram.onText(/\/send/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    if (!state.whatsappReady) return telegram.sendMessage(msg.chat.id, '❌ WhatsApp not connected');
    if (state.contacts.length === 0) return telegram.sendMessage(msg.chat.id, '❌ No contacts');
    if (state.currentCampaign?.status === 'running') return telegram.sendMessage(msg.chat.id, '⚠️ Campaign running');
    
    telegram.sendMessage(msg.chat.id, `Send message to ${state.contacts.length} contacts\n\nType your message or /cancel:`);
    
    const listener = (msgObj) => {
        if (msgObj.chat.id !== msg.chat.id) return;
        if (msgObj.text === '/cancel') {
            telegram.removeListener('message', listener);
            return telegram.sendMessage(msg.chat.id, '❌ Cancelled');
        }
        if (msgObj.text?.startsWith('/')) return;
        
        telegram.removeListener('message', listener);
        telegram.sendMessage(msg.chat.id, `Send to ${state.contacts.length} contacts?\n\nReply YES to confirm`);
        
        const confirmListener = (confirmObj) => {
            if (confirmObj.chat.id !== msg.chat.id) return;
            if (confirmObj.text?.toUpperCase() === 'YES') {
                telegram.removeListener('message', confirmListener);
                startCampaign(msg.chat.id, msgObj.text, state.contacts);
            }
        };
        telegram.on('message', confirmListener);
    };
    telegram.on('message', listener);
});

async function startCampaign(chatId, message, contacts) {
    state.currentCampaign = {
        total: contacts.length,
        sent: 0,
        failed: 0,
        status: 'running',
        startTime: new Date()
    };
    
    telegram.sendMessage(chatId, '🚀 Campaign started!');
    
    for (let i = 0; i < contacts.length; i++) {
        if (state.currentCampaign.status !== 'running') break;
        
        const contact = contacts[i];
        try {
            await whatsappClient.sendMessage(contact, message);
            state.currentCampaign.sent++;
            
            if ((i + 1) % 10 === 0) {
                telegram.sendMessage(chatId, `📊 Progress: ${i+1}/${contacts.length}\n✅ Sent: ${state.currentCampaign.sent}\n❌ Failed: ${state.currentCampaign.failed}`);
            }
        } catch (error) {
            state.currentCampaign.failed++;
        }
        
        if ((i + 1) % BATCH_SIZE === 0) {
            await new Promise(r => setTimeout(r, BATCH_DELAY));
        } else {
            await new Promise(r => setTimeout(r, getRandomDelay(MESSAGE_DELAY_MIN, MESSAGE_DELAY_MAX)));
        }
    }
    
    state.currentCampaign.status = 'completed';
    telegram.sendMessage(chatId, `✅ Campaign Complete!\n\nSent: ${state.currentCampaign.sent}/${state.currentCampaign.total}\nFailed: ${state.currentCampaign.failed}`);
    state.campaigns.push({...state.currentCampaign});
    state.currentCampaign = null;
}

telegram.onText(/\/stop/, (msg) => {
    if (!isAuthorized(msg.chat.id)) return;
    if (state.currentCampaign?.status === 'running') {
        state.currentCampaign.status = 'stopped';
        telegram.sendMessage(msg.chat.id, '🛑 Campaign stopped');
    } else {
        telegram.sendMessage(msg.chat.id, 'No campaign running');
    }
});

// Initialize WhatsApp
function initializeWhatsApp() {
    console.log('🔧 Cleaning up...');
    try {
        execSync('pkill -9 chromium 2>/dev/null || true');
        execSync('rm -rf /tmp/.org.chromium.Chromium.* 2>/dev/null || true');
        execSync('rm -rf /tmp/chromium-* 2>/dev/null || true');
    } catch (e) {}
    
    console.log('📱 Creating WhatsApp client...');
    whatsappClient = createWhatsAppClient();
    setupWhatsAppEvents();
    
    console.log('🚀 Initializing...');
    whatsappClient.initialize().catch(err => {
        console.error('❌ Init failed:', err.message);
        healthStatus.whatsapp = 'failed';
    });
}

// Start
async function start() {
    console.log('🚀 Starting bot...');
    console.log(`Token: ${TELEGRAM_TOKEN ? '✅' : '❌'}`);
    console.log(`Authorized: ${AUTHORIZED_USERS.join(',') || 'None'}`);
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Server on port ${PORT}`);
        healthStatus.status = 'running';
    });
    
    await new Promise(r => setTimeout(r, 2000));
    initializeWhatsApp();
}

process.on('SIGTERM', async () => {
    if (whatsappClient) await whatsappClient.destroy().catch(() => {});
    process.exit(0);
});

telegram.on('polling_error', err => console.error('Telegram error:', err.code));

start();
