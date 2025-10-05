// server.js - WhatsApp Bulk Messaging Bot with Telegram Control
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

// Rate limiting configuration (to avoid WhatsApp bans)
const MESSAGE_DELAY_MIN = parseInt(process.env.MESSAGE_DELAY_MIN) || 5000; // 5 seconds minimum
const MESSAGE_DELAY_MAX = parseInt(process.env.MESSAGE_DELAY_MAX) || 10000; // 10 seconds maximum
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 5; // Send 5 messages then take a break
const BATCH_DELAY = parseInt(process.env.BATCH_DELAY) || 60000; // 1 minute break between batches
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3; // Retry failed messages
const ENABLE_DELIVERY_CHECK = process.env.ENABLE_DELIVERY_CHECK !== 'false'; // Check if message delivered

// Initialize Express for Railway health checks
const app = express();
app.get('/', (req, res) => res.send('WhatsApp Bulk Bot is running!'));
app.get('/health', (req, res) => res.json({ status: 'healthy', whatsapp: whatsappClient?.info?.wid?._serialized || 'disconnected' }));

// Initialize Telegram Bot
const telegram = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// Initialize WhatsApp Client
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
            '--disable-gpu'
        ]
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
    // Remove all non-numeric characters
    phone = phone.replace(/\D/g, '');
    
    // Add country code if missing (default to your country)
    if (!phone.startsWith('212') && !phone.startsWith('1') && phone.length < 12) {
        phone = '212' + phone; // Morocco country code as default
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
    console.log('QR Code received');
    
    try {
        const qrImage = await qrcode.toDataURL(qr);
        
        for (const userId of AUTHORIZED_USERS) {
            await telegram.sendPhoto(userId, Buffer.from(qrImage.split(',')[1], 'base64'), {
                caption: '📱 *WhatsApp QR Code*\n\nScan this QR code with your WhatsApp app:\n1. Open WhatsApp\n2. Tap Menu (⋮) or Settings\n3. Tap Linked Devices\n4. Tap Link a Device\n5. Point your phone at this screen\n\n⏱️ QR Code expires in 60 seconds',
                parse_mode: 'Markdown'
            });
        }
    } catch (error) {
        console.error('Error sending QR code:', error);
    }
});

whatsappClient.on('authenticated', () => {
    console.log('WhatsApp authenticated successfully');
});

whatsappClient.on('ready', async () => {
    console.log('WhatsApp client is ready!');
    state.whatsappReady = true;
    
    const info = whatsappClient.info;
    const message = `✅ *WhatsApp Connected!*\n\n` +
                   `📱 Phone: ${info.wid.user}\n` +
                   `👤 Name: ${info.pushname}\n` +
                   `🔋 Battery: ${info.battery}%\n\n` +
                   `Bot is ready to send bulk messages! Type /help to see available commands.`;
    
    for (const userId of AUTHORIZED_USERS) {
        await telegram.sendMessage(userId, message, { parse_mode: 'Markdown' });
    }
});

whatsappClient.on('disconnected', async (reason) => {
    console.log('WhatsApp disconnected:', reason);
    state.whatsappReady = false;
    
    for (const userId of AUTHORIZED_USERS) {
        await telegram.sendMessage(userId, `❌ WhatsApp disconnected: ${reason}\n\nPlease restart the bot.`);
    }
});

// Telegram Command Handlers
telegram.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    
    if (!isAuthorized(chatId)) {
        return telegram.sendMessage(chatId, '🚫 Unauthorized access.');
    }
    
    const welcomeMessage = `🤖 *WhatsApp Bulk Messenger Bot*\n\n` +
                          `Welcome! This bot allows you to send bulk WhatsApp messages.\n\n` +
                          `*Status:*\n` +
                          `WhatsApp: ${state.whatsappReady ? '✅ Connected' : '❌ Disconnected'}\n\n` +
                          `Type /help to see all available commands.`;
    
    telegram.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
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
    
    if (state.currentCampaign) {
        statusMessage += `\n🚀 *Current Campaign:*\n`;
        statusMessage += `Progress: ${state.currentCampaign.sent}/${state.currentCampaign.total}\n`;
        statusMessage += `Status: ${state.currentCampaign.status}`;
    }
    
    telegram.sendMessage(chatId, statusMessage, { parse_mode: 'Markdown' });
});

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
    
    telegram.sendMessage(chatId, `📝 Send me a list of phone numbers (one per line).\n\nExample:\n+212612345678\n+212698765432\n+1234567890\n\nSend /done when finished or /cancel to abort.`);
    
    // Set up listener for contact list
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
        
        if (contactMsg.text.startsWith('/')) return;
        
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
    
    const contactList = state.contacts.map((c, i) => `${i + 1}. ${c.replace('@c.us', '')}`).join('\n');
    telegram.sendMessage(chatId, `📇 *Saved Contacts (${state.contacts.length}):*\n\n${contactList}`, { parse_mode: 'Markdown' });
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
    
    telegram.sendMessage(chatId, `📝 Send me the message you want to send to all contacts.\n\n📇 Recipients: ${state.contacts.length} contacts\n⏱️ Estimated time: ~${Math.ceil(state.contacts.length * 7 / 60)} minutes\n\n💡 Tip: Use /test to send to yourself first!\n\nSend /cancel to abort.`);
    
    const messageListener = async (messageMsg) => {
        if (messageMsg.chat.id !== chatId) return;
        
        if (messageMsg.text === '/cancel') {
            telegram.removeListener('message', messageListener);
            return telegram.sendMessage(chatId, '❌ Campaign cancelled.');
        }
        
        if (messageMsg.text.startsWith('/')) return;
        
        telegram.removeListener('message', messageListener);
        
        const message = messageMsg.text;
        
        // Confirm before sending
        const confirmMsg = `🚀 *Ready to Send Campaign*\n\n` +
                          `📝 Message Preview:\n"${message.substring(0, 150)}${message.length > 150 ? '...' : ''}"\n\n` +
                          `👥 Recipients: ${state.contacts.length}\n` +
                          `⏱️ Estimated time: ${Math.ceil(state.contacts.length * 7 / 60)} minutes\n` +
                          `✅ Smart delays enabled\n` +
                          `🛡️ Auto-retry on failures\n\n` +
                          `⚠️ *Important:* Messages will be sent with delays to avoid WhatsApp bans.\n\n` +
                          `Reply with "YES" to confirm or /cancel to abort.`;
        
        await telegram.sendMessage(chatId, confirmMsg, { parse_mode: 'Markdown' });
        
        const confirmListener = async (confirmMsg) => {
            if (confirmMsg.chat.id !== chatId) return;
            
            if (confirmMsg.text === '/cancel') {
                telegram.removeListener('message', confirmListener);
                return telegram.sendMessage(chatId, '❌ Campaign cancelled.');
            }
            
            if (confirmMsg.text.toUpperCase() === 'YES') {
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
    
    telegram.sendMessage(chatId, `🧪 *Test Mode*\n\nSend me a test message and I'll send it to YOUR WhatsApp number only.\n\nThis helps verify everything works before sending to contacts.\n\nSend /cancel to abort.`, { parse_mode: 'Markdown' });
    
    const testListener = async (testMsg) => {
        if (testMsg.chat.id !== chatId) return;
        
        if (testMsg.text === '/cancel') {
            telegram.removeListener('message', testListener);
            return telegram.sendMessage(chatId, '❌ Test cancelled.');
        }
        
        if (testMsg.text.startsWith('/')) return;
        
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
    
    await telegram.sendMessage(chatId, '🚀 Campaign started! Sending messages...\n\n✅ Smart rate limiting enabled\n📊 You will receive updates every 10 messages.\n⏸️ Automatic breaks to prevent bans');
    
    let batchCount = 0;
    
    for (let i = 0; i < contacts.length; i++) {
        if (state.currentCampaign.status !== 'running') {
            break;
        }
        
        const contact = contacts[i];
        let attempts = 0;
        let sent = false;
        
        // Retry logic for failed messages
        while (attempts < MAX_RETRIES && !sent) {
            try {
                // Verify contact exists first (prevents failures)
                const contactInfo = await whatsappClient.getNumberId(contact.replace('@c.us', ''));
                
                if (!contactInfo) {
                    console.log(`Invalid number: ${contact}`);
                    state.currentCampaign.failed++;
                    state.currentCampaign.failedContacts.push({ contact, reason: 'Invalid number' });
                    break;
                }
                
                // Send message
                const sentMessage = await whatsappClient.sendMessage(contact, message);
                state.currentCampaign.sent++;
                sent = true;
                console.log(`✅ Message sent to ${contact} (attempt ${attempts + 1})`);
                
                // Check delivery status if enabled
                if (ENABLE_DELIVERY_CHECK && sentMessage) {
                    setTimeout(async () => {
                        try {
                            const msg = await whatsappClient.getMessageById(sentMessage.id._serialized);
                            if (msg && msg.ack >= 2) { // 2 = delivered, 3 = read
                                state.currentCampaign.delivered++;
                            }
                        } catch (e) {
                            console.log('Could not check delivery status');
                        }
                    }, 10000); // Check after 10 seconds
                }
                
                // Send progress updates every 10 messages
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
                    // Wait before retry
                    await new Promise(resolve => setTimeout(resolve, 3000));
                }
            }
        }
        
        // Rate limiting logic
        batchCount++;
        
        if (batchCount >= BATCH_SIZE && i < contacts.length - 1) {
            const breakMinutes = Math.round(BATCH_DELAY / 60000);
            console.log(`⏸️ Taking ${breakMinutes}-minute batch break...`);
            await telegram.sendMessage(chatId, `⏸️ Taking a ${breakMinutes}-minute break to avoid detection...\n\n✅ Safe mode: This prevents WhatsApp from flagging your account.`);
            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
            batchCount = 0;
        } else if (i < contacts.length - 1) {
            const delay = getRandomDelay(MESSAGE_DELAY_MIN, MESSAGE_DELAY_MAX);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    // Campaign completed
    state.currentCampaign.status = 'completed';
    state.currentCampaign.endTime = new Date();
    
    // Calculate success rate
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
    
    // Send failed contacts if any
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
    console.log('Initializing bot...');
    
    await loadState();
    
    // Start Express server
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
    
    // Initialize WhatsApp
    console.log('Initializing WhatsApp client...');
    whatsappClient.initialize();
    
    console.log('Bot initialized! Waiting for WhatsApp connection...');
}

// Error handling
process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection:', error);
});

telegram.on('polling_error', (error) => {
    console.error('Telegram polling error:', error);
});

// Start the bot
initialize();
