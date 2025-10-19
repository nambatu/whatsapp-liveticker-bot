// app.js - Main File (Corrected with SEEN_FILE logic)
require('dotenv').config();
const path = require('path'); // Import path module
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { loadSeenTickers, saveSeenTickers } = require('./utils.js');
const { initializePolling, masterScheduler, dispatcherLoop, startPolling } = require('./polling.js');

// --- GLOBAL STATE ---
const activeTickers = new Map();
const jobQueue = [];
const SEEN_FILE = path.resolve(__dirname, 'seen_tickers.json'); // Define SEEN_FILE path

// --- WHATSAPP CLIENT ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: '/usr/bin/chromium'
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
    }
});

// --- INITIALIZE MODULES ---
// Pass SEEN_FILE path to polling module
initializePolling(activeTickers, jobQueue, client, SEEN_FILE);

// --- CLIENT EVENTS ---
client.on('qr', qr => { qrcode.generate(qr, { small: true }); console.log('QR-Code generiert. Scannen Sie diesen mit WhatsApp.'); });
client.on('ready', () => {
    console.log('WhatsApp-Client ist bereit!');
    loadSeenTickers(activeTickers, SEEN_FILE); // Pass path
});
client.on('disconnected', (reason) => {
    console.log('Client getrennt:', reason);
    activeTickers.forEach(ticker => { ticker.isPolling = false; });
    saveSeenTickers(activeTickers, SEEN_FILE); // Pass path
});

// --- MESSAGE LISTENER ---
client.on('message', async msg => {
    if (!msg.body.startsWith('!')) return;
    const chat = await msg.getChat();
    if (!chat.isGroup) {
        await msg.reply('Fehler: Befehle funktionieren nur in Gruppen.');
        return;
    }
    const chatId = chat.id._serialized;
    const args = msg.body.split(' ');
    const command = args[0].toLowerCase();
    const groupName = chat.name;

    if (command === '!start' && args.length >= 2) {
        if (activeTickers.has(chatId) && (activeTickers.get(chatId).isPolling || activeTickers.get(chatId).isScheduled)) {
            await msg.reply('In dieser Gruppe läuft oder ist bereits ein Live-Ticker geplant. Stoppen oder resetten Sie ihn zuerst.');
            return;
        }
        const meetingPageUrl = args[1];
        try {
            await startPolling(meetingPageUrl, chatId, groupName);
        } catch (error) {
            console.error(`[${chatId}] Kritischer Fehler beim Starten des Tickers:`, error);
            await msg.reply('Ein kritischer Fehler ist aufgetreten und der Ticker konnte nicht gestartet werden.');
            activeTickers.delete(chatId);
        }
    } else if (command === '!stop') {
        const tickerState = activeTickers.get(chatId);
        if (tickerState && (tickerState.isPolling || tickerState.isScheduled)) {
            if (tickerState.scheduleTimeout) clearTimeout(tickerState.scheduleTimeout);
            tickerState.isPolling = false;
            tickerState.isScheduled = false;
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);
            await client.sendMessage(chatId, 'Laufender/geplanter Live-Ticker in dieser Gruppe gestoppt.');
            console.log(`Live-Ticker für Gruppe "${groupName}" (${chatId}) gestoppt.`);
            // No save needed here, state will be saved on shutdown or when events processed
        } else {
            await msg.reply('In dieser Gruppe läuft derzeit kein Live-Ticker.');
        }
    } else if (command === '!reset') {
        const tickerState = activeTickers.get(chatId);
        if (tickerState) {
            if (tickerState.scheduleTimeout) clearTimeout(tickerState.scheduleTimeout);
            tickerState.isPolling = false;
            tickerState.isScheduled = false;
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);
        }
        activeTickers.delete(chatId);
        saveSeenTickers(activeTickers, SEEN_FILE); // Pass path
        await msg.reply('Alle Ticker-Daten für diese Gruppe wurden zurückgesetzt.');
        console.log(`Ticker-Daten für Gruppe "${groupName}" (${chatId}) wurden manuell zurückgesetzt.`);
    } else if (command === '!start') {
        await msg.reply(`Fehler: Bitte geben Sie eine gültige URL an.`);
    }
});

// --- MAIN EXECUTION ---
setInterval(masterScheduler, 20000);
setInterval(dispatcherLoop, 500);
client.initialize();

// --- APP SHUTDOWN ---
process.on('SIGINT', async () => {
    console.log('(SIGINT) Empfangen. Bot wird heruntergefahren...');
    activeTickers.forEach(ticker => { ticker.isPolling = false; });
    saveSeenTickers(activeTickers, SEEN_FILE); // Pass path
    if (client) await client.destroy();
    process.exit(0);
});