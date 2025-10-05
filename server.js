// server.js - WhatsApp Bulk Messaging Bot with Telegram Control (Koyeb-optimized)
const { Client, LocalAuth } = require('whatsapp-web.js');
const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');

// Configuration
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AUTHORIZED_USERS = process.env.AUTHORIZED_TELEGRAM_IDS?.split(',') || [];
const PORT = process.env.PORT || 3000;

if (!TELEGRAM_TOKEN) {
    console.error('❌ TELEGRAM_BOT_TOKEN is not set! Please set it in Koyeb environment variables.');
    process.exit(1);
}

if (AUTHORIZED_USERS.length === 0) {
    console.warn('⚠️ WARNING: No AUTHORIZED_TELEGRAM_IDS set. Bot will be accessible by anyone!');
}

// Rate limiting configuration (to avoid WhatsApp bans)
const MESSAGE_DELAY_MIN = parseInt(process.env.MESSAGE_DELAY_MIN) || 5000;
const MESSAGE_DELAY_MAX = parseInt(process.env.MESSAGE_DELAY_MAX) || 10000;
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 5;
const BATCH_DELAY = parseInt(process.env.BATCH_DELAY) || 60000;
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;
const ENABLE_DELIVERY_CHECK = process.env.ENABLE_DELIVERY_CHECK !== 'false';

// Initialize Express for health checks
const app = express();
app.use(express.json());

let healthStatus = {
    status: 'starting',
    whatsapp: 'disconnected',
    telegram: 'unknown',
    uptime: 0,
    startTime: Date.now()
};

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Bulk Bot</title>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <style>
                body { 
                    font-family: Arial, sans-serif; 
                    max-width: 800px; 
                    margin: 50px auto; 
                    padding: 20px;
                    background: #f0f2f5;
                }
                .card { 
                    background: white; 
                    padding: 30px; 
                    border-radius: 10px; 
                    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
                }
                h1 { color: #25D366; margin-top: 0; }
                .status { 
                    display: flex; 
                    justify-content: space-between; 
                    margin: 10px 0; 
                    padding: 10px;
                    background: #f8f9fa;
                    border-radius: 5px;
                }
                .status-value { font-weight: bold; }
                .connected { color: #25D366; }
                .disconnected { color: #dc3545; }
                .info { color: #666; margin-top: 20px; }
            </style>
        </head>
        <body>
            <div class="card">
                <h1>🤖 WhatsApp Bulk Messenger Bot</h1>
                <p>Status: <strong>${healthStatus.status}</strong></p>
                <div class="status">
                    <span>WhatsApp:</span>
                    <span class="status-value ${healthStatus.whatsapp === 'connected' ? 'connected' : 'disconnected'}">
                        ${healthStatus.whatsapp === 'connected' ? '✅ Connected' : '❌ Disconnected'}
                    </span>
                </div>
                <div class="status">
                    <span>Telegram:</span>
                    <span class="status-value connected">✅ Active</span>
                </div>
                <div class="status">
                    <span>Uptime:</span>
                    <span class="status-value">${Math.floor((Date.now() - healthStatus.startTime) / 1000 / 60)} minutes</span>
                </div>
                <div class="info">
                    <p>💡 <strong>To use this bot:</strong></p>
                    <ol>
                        <li>Open your Telegram bot</li>
                        <li>Send <code>/start</code> to begin</li>
                        <li>Scan the WhatsApp QR code when prompted</li>
                        <li>Start sending bulk messages!</li>
                    </ol>
                    <p>⚠️ <strong>Note:</strong> On Koyeb, you'll need to re-scan the QR code after each restart due to ephemeral storage.</p>
                </div>
            </div>
        </body>
        </html>
    `);
});

app.get('/health', (req, res) => {
    res.json({
        status: healthStatus.status,
        whatsapp: healthStatus.whatsapp,
        telegram: 'active',
        uptime: Math.floor((Date.now() - healthStatus.startTime) / 1000),
        timestamp: new Date().toISOString()
    });
});

// Initialize Telegram Bot
const telegram = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Initialize WhatsApp Client with optimized settings for cloud
const whatsappClient = new Client({
    authStrategy: new LocalAuth({
        dataPath: './whatsapp_session'
    }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // Critical for low memory
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-sync',
            '--metrics-recording-only',
            '--mute-audio',
            '--safebrowsing-disable-auto-update',
            '--disable-crash-reporter',
            '--disable-web-security',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-blink-features=AutomationControlled',
            '--js-flags=--max-old-space-size=512' // Limit memory usage
        ],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
        timeout: 60000 // Increase timeout to 60 seconds
    }
});

// State management
let state = {
    whatsappReady: false,
    currentCampaign: null,
    campaigns: [],
    contacts: []
};

// Utility Functions
function isAuthorized(userId) {
    if (AUTHORIZED_USERS.length === 0) return true;
    return AUTHORIZED_USERS.includes(userId.toString());
}

function getRandomDelay(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatPhoneNumber(phone) {
    phone = phone.replace(/\D/g, '');
    
    if (!phone.startsWith('212') && !phone.startsWith('1') && phone.length < 12) {
        phone = '212' + phone;
    }
    
    return phone + '@c.us';
}

async function saveState() {
    try {
        await fs.writeFile('bot_state.json', JSON.stringify(state, null, 2));
    } catch (error) {
        console.error('Error saving state:', error);
    }
}

async function loadState() {
    try {
        const data = await fs.readFile('bot_state.json', 'utf8');
        state = { ...state, ...JSON.parse(data) };
    } catch (error) {
        console.log('No previous state found, starting fresh');
    }
}

// WhatsApp Event Handlers
whatsappClient.on('qr', async (qr) => {
    console.log('🎯 QR CODE EVENT TRIGGERED!');
    console.log('QR Code length:', qr.length);
    console.log('Authorized users:', AUTHORIZED_USERS);
    healthStatus.whatsapp = 'waiting_qr';
    
    try {
        console.log('Generating QR code image...');
        const qrImage = await qrcode.toDataURL(qr);
        console.log('✅ QR code image generated successfully');
        
        const message = '📱 *WhatsApp QR Code*\n\n' +
                       'Scan this QR code with your WhatsApp app:\n' +
                       '1. Open WhatsApp\n' +
                       '2. Tap Menu (⋮) or Settings\n' +
                       '3. Tap Linked Devices\n' +
                       '4. Tap Link a Device\n' +
                       '5. Point your phone at this screen\n\n' +
                       '⏱️ QR Code expires in 60 seconds\n\n' +
                       '⚠️ *Important:* On Koyeb, you\'ll need to scan again after each restart.';
        
        if (AUTHORIZED_USERS.length > 0) {
            console.log(`Sending QR to ${AUTHORIZED_USERS.length} authorized user(s)...`);
            for (const userId of AUTHORIZED_USERS) {
                try {
                    console.log(`Attempting to send QR to user: ${userId}`);
                    await telegram.sendPhoto(userId, Buffer.from(qrImage.split(',')[1], 'base64'), {
                        caption: message,
                        parse_mode: 'Markdown'
                    });
                    console.log(`✅ QR code sent successfully to user ${userId}`);
                } catch (err) {
                    console.error(`❌ Failed to send QR to user ${userId}:`, err.message);
                    console.error('Full error:', err);
                    // Try sending as text fallback
                    try {
                        await telegram.sendMessage(userId, `❌ Failed to send QR image. Error: ${err.message}\n\nTry /reconnect`);
                    } catch (e2) {
                        console.error('Could not even send error message:', e2.message);
                    }
                }
            }
        } else {
            console.log('⚠️ NO AUTHORIZED USERS SET! QR code generated but not sent.');
            console.log('Set AUTHORIZED_TELEGRAM_IDS environment variable!');
        }
    } catch (error) {
        console.error('❌ ERROR in QR handler:', error);
        console.error('Full error stack:', error.stack);
    }
});

whatsappClient.on('authenticated', () => {
    console.log('WhatsApp authenticated successfully');
    healthStatus.whatsapp = 'authenticated';
});

whatsappClient.on('ready', async () => {
    console.log('WhatsApp client is ready!');
    state.whatsappReady = true;
    healthStatus.status = 'running';
    healthStatus.whatsapp = 'connected';
    
    const info = whatsappClient.info;
    const message = `✅ *WhatsApp Connected!*\n\n` +
                   `📱 Phone: ${info.wid.user}\n` +
                   `👤 Name: ${info.pushname}\n` +
                   `🔋 Battery: ${info.battery}%\n` +
                   `🖥️ Platform: ${info.platform}\n\n` +
                   `Bot is ready to send bulk messages! Type /help to see available commands.\n\n` +
                   `⚠️ *Note:* Session will reset on bot restart (Koyeb limitation).`;
    
    if (AUTHORIZED_USERS.length > 0) {
        for (const userId of AUTHORIZED_USERS) {
            try {
                await telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
            } catch (err) {
                console.error(`Failed to send ready message to user ${userId}:`, err.message);
            }
        }
    }
});

whatsappClient.on('disconnected', async (reason) => {
    console.log('WhatsApp disconnected:', reason);
    state.whatsappReady = false;
    healthStatus.whatsapp = 'disconnected';
    
    if (AUTHORIZED_USERS.length > 0) {
        for (const userId of AUTHORIZED_USERS) {
            try {
                await telegram.sendMessage(userId, `❌ WhatsApp disconnected: ${reason}\n\nThe bot will try to reconnect automatically.`);
            } catch (err) {
                console.error(`Failed to send disconnect message:`, err.message);
            }
        }
    }
});

whatsappClient.on('auth_failure', async (msg) => {
    console.error('❌ Authentication failure:', msg);
    healthStatus.whatsapp = 'auth_failed';
    
    if (AUTHORIZED_USERS.length > 0) {
        for (const userId of AUTHORIZED_USERS) {
            try {
                await telegram.sendMessage(userId, `❌ WhatsApp authentication failed!\n\nError: ${msg}\n\nTry /reconnect or restart the bot in Koyeb.`);
            } catch (err) {
                console.error('Failed to send auth failure message:', err.message);
            }
        }
    }
});

whatsappClient.on('loading_screen', (percent, message) => {
    console.log(`Loading WhatsApp: ${percent}% - ${message}`);
});

// Add error handler for initialization failures
whatsappClient.on('remote_session_saved', () => {
    console.log('✅ Remote session saved');
});

process.on('unhandledRejection', (error) => {
    console.error('❌ Unhandled rejection:', error);
    if (error.message && error.message.includes('Protocol error')) {
        console.error('🔥 CRITICAL: Puppeteer/Chromium crashed! Check Dockerfile dependencies.');
    }
});

// Telegram Command Handlers
telegram.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(chatId)) {
        return telegram.sendMessage(chatId, '🚫 Unauthorized access. Your Telegram ID is not in the authorized list.');
    }
    
    const welcomeMessage = `🤖 *WhatsApp Bulk Messenger Bot*\n\n` +
                          `Welcome! This bot allows you to send bulk WhatsApp messages.\n\n` +
                          `*Status:*\n` +
                          `WhatsApp: ${state.whatsappReady ? '✅ Connected' : '❌ Disconnected'}\n` +
                          `Contacts: ${state.contacts.length} saved\n\n` +
                          `Type /help to see all available commands.`;
    
    telegram.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
});

telegram.onText(/\/debug/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(chatId)) {
        return telegram.sendMessage(chatId, '🚫 Unauthorized access.');
    }
    
    const debugInfo = `🔧 *Debug Information*\n\n` +
                     `*Bot Status:*\n` +
                     `- Health: ${healthStatus.status}\n` +
                     `- WhatsApp: ${healthStatus.whatsapp}\n` +
                     `- Uptime: ${Math.floor((Date.now() - healthStatus.startTime) / 1000 / 60)} min\n\n` +
                     `*Configuration:*\n` +
                     `- Port: ${PORT}\n` +
                     `- Authorized Users: ${AUTHORIZED_USERS.join(', ') || 'None'}\n` +
                     `- Node: ${process.version}\n` +
                     `- Platform: ${process.platform}\n\n` +
                     `*WhatsApp Client:*\n` +
                     `- Ready: ${state.whatsappReady ? '✅' : '❌'}\n` +
                     `- Puppeteer Path: ${process.env.PUPPETEER_EXECUTABLE_PATH || 'default'}\n\n` +
                     `*State:*\n` +
                     `- Contacts: ${state.contacts.length}\n` +
                     `- Campaigns: ${state.campaigns.length}\n` +
                     `- Current Campaign: ${state.currentCampaign ? 'Running' : 'None'}`;
    
    telegram.sendMessage(chatId, debugInfo, { parse_mode: 'Markdown' });
});

telegram.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(chatId)) {
        return telegram.sendMessage(chatId, '🚫 Unauthorized access.');
    }
    
    const helpMessage = `📚 *Available Commands:*\n\n` +
                       `*Setup:*\n` +
                       `/status - Check bot status\n` +
                       `/reconnect - Reconnect WhatsApp\n\n` +
                       `*Messaging:*\n` +
                       `/send - Start bulk message campaign\n` +
                       `/test - Send test message to yourself\n` +
                       `/campaigns - View campaign history\n` +
                       `/stop - Stop current campaign\n\n` +
                       `*Contacts:*\n` +
                       `/addcontact <number> - Add a contact\n` +
                       `/addcontacts - Add multiple contacts (one per line)\n` +
                       `/contacts - View saved contacts\n` +
                       `/clearcontacts - Clear all contacts\n\n` +
                       `*Example:*\n` +
                       `\`/addcontact +212612345678\`\n` +
                       `\`/send\` then follow the prompts`;
    
    telegram.sendMessage(chatId, helpMessage, { parse_mode: 'Markdown' });
});

telegram.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(chatId)) {
        return telegram.sendMessage(chatId, '🚫 Unauthorized access.');
    }
    
    let statusMessage = `📊 *Bot Status*\n\n`;
    statusMessage += `🔌 WhatsApp: ${state.whatsappReady ? '✅ Connected' : '❌ Disconnected'}\n`;
    
    if (state.whatsappReady) {
        const info = whatsappClient.info;
        statusMessage += `📱 Phone: ${info.wid.user}\n`;
        statusMessage += `👤 Name: ${info.pushname}\n`;
        statusMessage += `🔋 Battery: ${info.battery}%\n`;
    }
    
    statusMessage += `\n📇 Saved Contacts: ${state.contacts.length}\n`;
    statusMessage += `📨 Total Campaigns: ${state.campaigns.length}\n`;
    statusMessage += `⏱️ Uptime: ${Math.floor((Date.now() - healthStatus.startTime) / 1000 / 60)} minutes\n`;
    
    if (state.currentCampaign) {
        statusMessage += `\n🚀 *Current Campaign:*\n`;
        statusMessage += `Progress: ${state.currentCampaign.sent}/${state.currentCampaign.total}\n`;
        statusMessage += `Status: ${state.currentCampaign.status}`;
    }
    
    telegram.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
});

telegram.onText(/\/reconnect/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(chatId)) {
        return telegram.sendMessage(chatId, '🚫 Unauthorized access.');
    }
    
    telegram.sendMessage(chatId, '🔄 Attempting to reconnect WhatsApp...\n\nThis may take up to 30 seconds.');
    
    try {
        // Force destroy existing client
        try {
            await whatsappClient.destroy();
        } catch (e) {
            console.log('Client was not connected, skipping destroy');
        }
        
        // Wait and reinitialize
        setTimeout(async () => {
            try {
                await whatsappClient.initialize();
                await telegram.sendMessage(chatId, '✅ Reconnection initiated. Wait for the QR code (should arrive in 10-20 seconds).');
            } catch (initError) {
                await telegram.sendMessage(chatId, `❌ Failed to initialize WhatsApp: ${initError.message}\n\nCheck Koyeb logs for details.`);
                console.error('WhatsApp initialization error:', initError);
            }
        }, 3000);
    } catch (error) {
        telegram.sendMessage(chatId, `❌ Reconnection failed: ${error.message}\n\nTry restarting the entire bot in Koyeb.`);
        console.error('Reconnect error:', error);
    }
});

// Add contact commands
telegram.onText(/\/addcontact (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(chatId)) {
        return telegram.sendMessage(chatId, '🚫 Unauthorized access.');
    }
    
    const phoneNumber = match[1].trim();
    const formatted = formatPhoneNumber(phoneNumber);
    
    if (!state.contacts.includes(formatted)) {
        state.contacts.push(formatted);
        await saveState();
        telegram.sendMessage(chatId, `✅ Contact added: ${phoneNumber}\n\nTotal contacts: ${state.contacts.length}`);
    } else {
        telegram.sendMessage(chatId, `ℹ️ Contact already exists: ${phoneNumber}`);
    }
});

telegram.onText(/\/addcontacts/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(chatId)) {
        return telegram.sendMessage(chatId, '🚫 Unauthorized access.');
    }
    
    telegram.sendMessage(chatId, `📝 Send me a list of phone numbers (one per line).\n\nExample:\n+212612345678\n+212698765432\n\nSend /done when finished or /cancel to abort.`);
    
    const contactListener = async (contactMsg) => {
        if (contactMsg.chat.id !== chatId) return;
        
        if (contactMsg.text === '/done') {
            telegram.removeListener('message', contactListener);
            await saveState();
            return telegram.sendMessage(chatId, `✅ Finished adding contacts!\n\nTotal contacts: ${state.contacts.length}`);
        }
        
        if (contactMsg.text === '/cancel') {
            telegram.removeListener('message', contactListener);
            return telegram.sendMessage(chatId, '❌ Cancelled adding contacts.');
        }
        
        if (contactMsg.text?.startsWith('/')) return;
        
        const numbers = contactMsg.text.split('\n').map(n => n.trim()).filter(n => n);
        let added = 0;
        
        for (const number of numbers) {
            const formatted = formatPhoneNumber(number);
            if (!state.contacts.includes(formatted)) {
                state.contacts.push(formatted);
                added++;
            }
        }
        
        telegram.sendMessage(chatId, `✅ Added ${added} new contact(s). Total: ${state.contacts.length}\n\nSend more numbers or /done to finish.`);
    };
    
    telegram.on('message', contactListener);
});

telegram.onText(/\/contacts/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(chatId)) {
        return telegram.sendMessage(chatId, '🚫 Unauthorized access.');
    }
    
    if (state.contacts.length === 0) {
        return telegram.sendMessage(chatId, '📇 No contacts saved yet.\n\nUse /addcontact or /addcontacts to add contacts.');
    }
    
    const contactList = state.contacts.slice(0, 50).map((c, i) => `${i + 1}. ${c.replace('@c.us', '')}`).join('\n');
    let message = `📇 *Saved Contacts (${state.contacts.length}):*\n\n${contactList}`;
    
    if (state.contacts.length > 50) {
        message += `\n\n... and ${state.contacts.length - 50} more`;
    }
    
    telegram.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

telegram.onText(/\/clearcontacts/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(chatId)) {
        return telegram.sendMessage(chatId, '🚫 Unauthorized access.');
    }
    
    state.contacts = [];
    await saveState();
    telegram.sendMessage(chatId, '🗑️ All contacts cleared!');
});

// Send and Test commands remain the same...
telegram.onText(/\/send/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(chatId)) {
        return telegram.sendMessage(chatId, '🚫 Unauthorized access.');
    }
    
    if (!state.whatsappReady) {
        return telegram.sendMessage(chatId, '❌ WhatsApp is not connected. Please wait for connection or use /reconnect');
    }
    
    if (state.contacts.length === 0) {
        return telegram.sendMessage(chatId, '📇 No contacts available.\n\nUse /addcontact or /addcontacts to add contacts first.');
    }
    
    if (state.currentCampaign && state.currentCampaign.status === 'running') {
        return telegram.sendMessage(chatId, '⚠️ A campaign is already running. Use /stop to stop it first.');
    }
    
    telegram.sendMessage(chatId, `📝 Send me the message you want to send to all contacts.\n\n📇 Recipients: ${state.contacts.length} contacts\n⏱️ Estimated time: ~${Math.ceil(state.contacts.length * 7 / 60)} minutes\n\nSend /cancel to abort.`);
    
    const messageListener = async (messageMsg) => {
        if (messageMsg.chat.id !== chatId) return;
        
        if (messageMsg.text === '/cancel') {
            telegram.removeListener('message', messageListener);
            return telegram.sendMessage(chatId, '❌ Campaign cancelled.');
        }
        
        if (messageMsg.text?.startsWith('/')) return;
        
        telegram.removeListener('message', messageListener);
        
        const message = messageMsg.text;
        
        const confirmMsg = `🚀 *Ready to Send Campaign*\n\n` +
                          `📝 Message Preview:\n"${message.substring(0, 150)}${message.length > 150 ? '...' : ''}"\n\n` +
                          `👥 Recipients: ${state.contacts.length}\n` +
                          `⏱️ Estimated time: ${Math.ceil(state.contacts.length * 7 / 60)} minutes\n\n` +
                          `Reply with "YES" to confirm or /cancel to abort.`;
        
        await telegram.sendMessage(chatId, confirmMsg, { parse_mode: 'Markdown' });
        
        const confirmListener = async (confirmMsg) => {
            if (confirmMsg.chat.id !== chatId) return;
            
            if (confirmMsg.text === '/cancel') {
                telegram.removeListener('message', confirmListener);
                return telegram.sendMessage(chatId, '❌ Campaign cancelled.');
            }
            
            if (confirmMsg.text?.toUpperCase() === 'YES') {
                telegram.removeListener('message', confirmListener);
                await startCampaign(chatId, message, state.contacts);
            }
        };
        
        telegram.on('message', confirmListener);
    };
    
    telegram.on('message', messageListener);
});

telegram.onText(/\/test/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(chatId)) {
        return telegram.sendMessage(chatId, '🚫 Unauthorized access.');
    }
    
    if (!state.whatsappReady) {
        return telegram.sendMessage(chatId, '❌ WhatsApp is not connected.');
    }
    
    telegram.sendMessage(chatId, `🧪 *Test Mode*\n\nSend me a test message and I'll send it to YOUR WhatsApp number only.\n\nSend /cancel to abort.`, { parse_mode: 'Markdown' });
    
    const testListener = async (testMsg) => {
        if (testMsg.chat.id !== chatId) return;
        
        if (testMsg.text === '/cancel') {
            telegram.removeListener('message', testListener);
            return telegram.sendMessage(chatId, '❌ Test cancelled.');
        }
        
        if (testMsg.text?.startsWith('/')) return;
        
        telegram.removeListener('message', testListener);
        
        try {
            const myNumber = whatsappClient.info.wid._serialized;
            await whatsappClient.sendMessage(myNumber, `🧪 TEST MESSAGE:\n\n${testMsg.text}`);
            await telegram.sendMessage(chatId, '✅ Test message sent to your WhatsApp!\n\nCheck your phone to verify it arrived correctly.');
        } catch (error) {
            await telegram.sendMessage(chatId, `❌ Test failed: ${error.message}`);
        }
    };
    
    telegram.on('message', testListener);
});

async function startCampaign(chatId, message, contacts) {
    state.currentCampaign = {
        id: Date.now(),
        message: message,
        contacts: [...contacts],
        total: contacts.length,
        sent: 0,
        failed: 0,
        delivered: 0,
        failedContacts: [],
        status: 'running',
        startTime: new Date()
    };
    
    await telegram.sendMessage(chatId, '🚀 Campaign started! Sending messages...\n\n✅ Smart rate limiting enabled\n📊 You will receive updates every 10 messages.');
    
    let batchCount = 0;
    
    for (let i = 0; i < contacts.length; i++) {
        if (state.currentCampaign.status !== 'running') {
            break;
        }
        
        const contact = contacts[i];
        let attempts = 0;
        let sent = false;
        
        while (attempts < MAX_RETRIES && !sent) {
            try {
                const contactInfo = await whatsappClient.getNumberId(contact.replace('@c.us', ''));
                
                if (!contactInfo) {
                    console.log(`Invalid number: ${contact}`);
                    state.currentCampaign.failed++;
                    state.currentCampaign.failedContacts.push({ contact, reason: 'Invalid number' });
                    break;
                }
                
                const sentMessage = await whatsappClient.sendMessage(contact, message);
                state.currentCampaign.sent++;
                sent = true;
                console.log(`✅ Message sent to ${contact} (attempt ${attempts + 1})`);
                
                if (ENABLE_DELIVERY_CHECK && sentMessage) {
                    setTimeout(async () => {
                        try {
                            const msg = await whatsappClient.getMessageById(sentMessage.id._serialized);
                            if (msg && msg.ack >= 2) {
                                state.currentCampaign.delivered++;
                            }
                        } catch (e) {
                            console.log('Could not check delivery status');
                        }
                    }, 10000);
                }
                
                if ((i + 1) % 10 === 0 || i === contacts.length - 1) {
                    const percentComplete = Math.round(((i + 1) / contacts.length) * 100);
                    const progress = `📊 *Progress Report*\n\n` +
                                   `🎯 Completed: ${percentComplete}%\n` +
                                   `📨 Progress: ${state.currentCampaign.sent + state.currentCampaign.failed}/${state.currentCampaign.total}\n` +
                                   `✅ Sent: ${state.currentCampaign.sent}\n` +
                                   `❌ Failed: ${state.currentCampaign.failed}\n` +
                                   (ENABLE_DELIVERY_CHECK ? `📬 Delivered: ${state.currentCampaign.delivered}\n` : '') +
                                   `⏱️ Remaining: ~${Math.ceil((contacts.length - i - 1) * 7 / 60)} min`;
                    await telegram.sendMessage(chatId, progress, { parse_mode: 'Markdown' });
                }
                
            } catch (error) {
                attempts++;
                console.error(`❌ Failed to send to ${contact} (attempt ${attempts}/${MAX_RETRIES}):`, error.message);
                
                if (attempts >= MAX_RETRIES) {
                    state.currentCampaign.failed++;
                    state.currentCampaign.failedContacts.push({ 
                        contact, 
                        reason: error.message,
                        attempts: attempts
                    });
                } else {
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }
        }
        
        batchCount++;
        
        if (batchCount >= BATCH_SIZE && i < contacts.length - 1) {
            const breakMinutes = Math.round(BATCH_DELAY / 60000);
            console.log(`⏸️ Taking ${breakMinutes}-minute batch break...`);
            await telegram.sendMessage(chatId, `⏸️ Taking a ${breakMinutes}-minute break to avoid detection...`);
            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
            batchCount = 0;
        } else if (i < contacts.length - 1) {
            const delay = getRandomDelay(MESSAGE_DELAY_MIN, MESSAGE_DELAY_MAX);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    state.currentCampaign.status = 'completed';
    state.currentCampaign.endTime = new Date();
    
    const successRate = Math.round((state.currentCampaign.sent / state.currentCampaign.total) * 100);
    const duration = Math.round((state.currentCampaign.endTime - state.currentCampaign.startTime) / 1000 / 60);
    
    let summary = `✅ *Campaign Completed!*\n\n` +
                   `📨 Total sent: ${state.currentCampaign.sent}/${state.currentCampaign.total}\n` +
                   `✅ Success rate: ${successRate}%\n` +
                   `❌ Failed: ${state.currentCampaign.failed}\n`;
    
    if (ENABLE_DELIVERY_CHECK) {
        const deliveryRate = state.currentCampaign.sent > 0 
            ? Math.round((state.currentCampaign.delivered / state.currentCampaign.sent) * 100) 
            : 0;
        summary += `📬 Delivered: ${state.currentCampaign.delivered} (${deliveryRate}%)\n`;
    }
    
    summary += `⏱️ Duration: ${duration} minutes\n` +
               `⚡ Average: ${Math.round(state.currentCampaign.sent / duration)} messages/min`;
    
    await telegram.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
    
    if (state.currentCampaign.failedContacts.length > 0 && state.currentCampaign.failedContacts.length <= 20) {
        let failedList = '❌ *Failed Contacts:*\n\n';
        state.currentCampaign.failedContacts.forEach((failed, i) => {
            failedList += `${i + 1}. ${failed.contact.replace('@c.us', '')}\n   Reason: ${failed.reason}\n\n`;
        });
        await telegram.sendMessage(chatId, failedList, { parse_mode: 'Markdown' });
    } else if (state.currentCampaign.failedContacts.length > 20) {
        await telegram.sendMessage(chatId, `⚠️ Too many failures (${state.currentCampaign.failedContacts.length}). Check logs for details.`);
    }
    
    state.campaigns.push({ ...state.currentCampaign });
    await saveState();
    
    state.currentCampaign = null;
}

telegram.onText(/\/stop/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(chatId)) {
        return telegram.sendMessage(chatId, '🚫 Unauthorized access.');
    }
    
    if (!state.currentCampaign || state.currentCampaign.status !== 'running') {
        return telegram.sendMessage(chatId, 'ℹ️ No campaign is currently running.');
    }
    
    state.currentCampaign.status = 'stopped';
    telegram.sendMessage(chatId, '🛑 Campaign stopped!\n\nMessages sent so far will be counted.');
});

telegram.onText(/\/campaigns/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(chatId)) {
        return telegram.sendMessage(chatId, '🚫 Unauthorized access.');
    }
    
    if (state.campaigns.length === 0) {
        return telegram.sendMessage(chatId, '📭 No campaigns yet.');
    }
    
    let campaignList = `📊 *Campaign History*\n\n`;
    
    state.campaigns.slice(-5).reverse().forEach((campaign, i) => {
        campaignList += `${i + 1}. ${new Date(campaign.startTime).toLocaleString()}\n`;
        campaignList += `   Sent: ${campaign.sent}/${campaign.total} | Failed: ${campaign.failed}\n\n`;
    });
    
    telegram.sendMessage(chatId, campaignList, { parse_mode: 'Markdown' });
});

// Initialize
async function initialize() {
    console.log('🚀 Initializing bot...');
    console.log('='.repeat(50));
    console.log(`📱 Telegram Token: ${TELEGRAM_TOKEN ? '✅ Set (length: ' + TELEGRAM_TOKEN.length + ')' : '❌ Missing'}`);
    console.log(`👥 Authorized Users: ${AUTHORIZED_USERS.length > 0 ? AUTHORIZED_USERS.join(', ') : '⚠️ None (open access)'}`);
    console.log(`🖥️ Node version: ${process.version}`);
    console.log(`📦 Platform: ${process.platform}`);
    console.log('='.repeat(50));
    
    await loadState();
    
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Server running on port ${PORT}`);
        healthStatus.status = 'running';
    });
    
    console.log('📱 Initializing WhatsApp client...');
    console.log('Puppeteer executable path:', process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium');
    
    try {
        whatsappClient.initialize();
        console.log('✅ WhatsApp initialize() called successfully');
        console.log('⏳ Waiting for QR code event...');
    } catch (error) {
        console.error('❌ FAILED to initialize WhatsApp client:', error);
        console.error('Error stack:', error.stack);
    }
    
    console.log('✅ Bot initialized! Waiting for WhatsApp connection...');
}

// Error handling
process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    await whatsappClient.destroy();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('Shutting down gracefully...');
    await whatsappClient.destroy();
    process.exit(0);
});

telegram.on('polling_error', (error) => {
    console.error('Telegram polling error:', error.code, error.message);
});

// Start the bot
initialize();
