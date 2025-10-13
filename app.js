// app.js - Main File
require('dotenv').config(); // Loads the .env file
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { loadSeenTickers, saveSeenTickers } = require('./utils.js');
const { initializePolling, masterScheduler, dispatcherLoop, startPolling } = require('./polling.js');

// --- GLOBAL STATE ---
const activeTickers = new Map();
const jobQueue = [];

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
// Pass the shared state variables to the polling module
initializePolling(activeTickers, jobQueue, client);

// --- CLIENT EVENTS ---
client.on('qr', qr => { qrcode.generate(qr, { small: true }); console.log('QR-Code generiert. Scannen Sie diesen mit WhatsApp.'); });
client.on('ready', () => { console.log('WhatsApp-Client ist bereit!'); loadSeenTickers(activeTickers); });
client.on('disconnected', (reason) => {
    console.log('Client getrennt:', reason);
    activeTickers.forEach(ticker => { ticker.isPolling = false; });
    saveSeenTickers(activeTickers);
});

// --- MESSAGE LISTENER ---
// in app.js
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

    // The !start command now calls the scheduleTicker function
    if (command === '!start' && args.length >= 2) {
        if (activeTickers.has(chatId) && (activeTickers.get(chatId).isPolling || activeTickers.get(chatId).isScheduled)) {
            await msg.reply('In dieser Gruppe läuft oder ist bereits ein Live-Ticker geplant. Stoppen oder resetten Sie ihn zuerst.');
            return;
        }
        const meetingPageUrl = args[1];
        try {
            await startPolling(meetingPageUrl, chatId); // This now calls scheduleTicker
        } catch (error) {
            console.error(`[${chatId}] Kritischer Fehler beim Starten des Tickers:`, error);
            await msg.reply('Ein kritischer Fehler ist aufgetreten und der Ticker konnte nicht gestartet werden.');
            activeTickers.delete(chatId);
        }
    } else if (command === '!stop' || command === '!reset') {
        const tickerState = activeTickers.get(chatId);
        if (!tickerState) {
            await msg.reply('Für diese Gruppe gibt es keine gespeicherten Ticker-Daten.');
            return;
        }

        // Cancel scheduled tickers
        if (tickerState.scheduleTimeout) {
            clearTimeout(tickerState.scheduleTimeout);
        }

        // Stop polling tickers
        tickerState.isPolling = false;
        const index = jobQueue.findIndex(job => job.chatId === chatId);
        if (index > -1) jobQueue.splice(index, 1);

        if (command === '!stop') {
            await client.sendMessage(chatId, 'Laufender/geplanter Live-Ticker in dieser Gruppe gestoppt.');
            console.log(`Live-Ticker für Gruppe ${chat.name} (${chatId}) gestoppt.`);
        } else { // !reset
            activeTickers.delete(chatId);
            saveSeenTickers(activeTickers);
            await msg.reply('Alle Ticker-Daten für diese Gruppe wurden zurückgesetzt.');
            console.log(`Ticker-Daten für Gruppe ${chat.name} (${chatId}) wurden manuell zurückgesetzt.`);
        }
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
    saveSeenTickers(activeTickers);
    if (client) await client.destroy();
    process.exit(0);
});