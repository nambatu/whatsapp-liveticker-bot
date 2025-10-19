// app.js - Main File 
require('dotenv').config();
const path = require('path'); 
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { loadSeenTickers, saveSeenTickers, loadScheduledTickers, saveScheduledTickers } = require('./utils.js');
const { initializePolling, masterScheduler, dispatcherLoop, startPolling, beginActualPolling } = require('./polling.js'); 

// --- GLOBAL STATE ---
const activeTickers = new Map();
const jobQueue = [];
const SEEN_FILE = path.resolve(__dirname, 'seen_tickers.json'); 
const SCHEDULE_FILE = path.resolve(__dirname, 'scheduled_tickers.json');

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
initializePolling(activeTickers, jobQueue, client, SEEN_FILE, SCHEDULE_FILE);

// --- CLIENT EVENTS ---
client.on('qr', qr => { qrcode.generate(qr, { small: true }); console.log('QR-Code generiert. Scannen Sie diesen mit WhatsApp.'); });
client.on('ready', () => {
    console.log('WhatsApp-Client ist bereit!');
    loadSeenTickers(activeTickers, SEEN_FILE);

    // Load and re-schedule tickers
    const scheduledTickersData = loadScheduledTickers(SCHEDULE_FILE);
    const now = Date.now();
    let rescheduledCount = 0;

    for (const chatId in scheduledTickersData) {
        const scheduleData = scheduledTickersData[chatId];
        const startTime = new Date(scheduleData.startTime);
        const delay = startTime.getTime() - now;

        // Ensure ticker state exists or create minimal one
        const tickerState = activeTickers.get(chatId) || { seen: new Set() };
        tickerState.meetingPageUrl = scheduleData.meetingPageUrl;
        tickerState.groupName = scheduleData.groupName;
        tickerState.halftimeLength = scheduleData.halftimeLength;
        tickerState.isPolling = false; // Important: Not polling yet
        activeTickers.set(chatId, tickerState); // Make sure it's in the map

        if (delay > 0) {
            console.log(`[${chatId}] Lade geplante Aufgabe. Startet in ${Math.round(delay / 60000)} Minuten.`);
            tickerState.isScheduled = true;
            tickerState.scheduleTimeout = setTimeout(() => {
                beginActualPolling(chatId); // Use imported function
            }, delay);
            rescheduledCount++;
        } else {
            // Start time has passed while bot was offline, start immediately
            console.log(`[${chatId}] Geplante Startzeit verpasst. Starte Polling sofort.`);
            beginActualPolling(chatId); // Use imported function
        }
    }
    if (rescheduledCount > 0) {
        console.log(`${rescheduledCount} Ticker erfolgreich neu geplant.`);
    }
});
client.on('disconnected', (reason) => {
    console.log('Client getrennt:', reason);
    activeTickers.forEach(ticker => { ticker.isPolling = false; });
    saveSeenTickers(activeTickers, SEEN_FILE); // Pass path
});

// --- MESSAGE LISTENER ---
client.on('message', async msg => {
    // --- Initial checks ---
    if (!msg.body.startsWith('!')) return;
    const chat = await msg.getChat();
    if (!chat.isGroup) {
        await msg.reply('Fehler: Befehle funktionieren nur in Gruppen.');
        return;
    }
    const chatId = chat.id._serialized;
    const args = msg.body.split(' ');
    const command = args[0].toLowerCase();
    const groupName = chat.name; // Get group name for logging and AI

    // --- !start Command ---
    if (command === '!start' && args.length >= 2) {
        // Check if a ticker is already active or scheduled
        if (activeTickers.has(chatId) && (activeTickers.get(chatId).isPolling || activeTickers.get(chatId).isScheduled)) {
            await msg.reply('In dieser Gruppe läuft oder ist bereits ein Live-Ticker geplant. Stoppen oder resetten Sie ihn zuerst.');
            return;
        }
        const meetingPageUrl = args[1];
        try {
            // Call startPolling (which is scheduleTicker in polling.js)
            await startPolling(meetingPageUrl, chatId, groupName);
        } catch (error) {
            console.error(`[${chatId}] Kritischer Fehler beim Starten des Tickers:`, error);
            await msg.reply('Ein kritischer Fehler ist aufgetreten und der Ticker konnte nicht gestartet werden.');
            activeTickers.delete(chatId); // Clean up if start failed
        }
    }
    // --- !stop Command ---
    else if (command === '!stop') {
        const tickerState = activeTickers.get(chatId);
        let wasStopped = false; // Flag to track if something was actually stopped

        if (tickerState) {
            // If it was scheduled, clear the timeout and remove from schedule file
            if (tickerState.isScheduled && tickerState.scheduleTimeout) {
                clearTimeout(tickerState.scheduleTimeout);
                tickerState.isScheduled = false;
                const currentSchedule = loadScheduledTickers(SCHEDULE_FILE);
                if (currentSchedule[chatId]) {
                    delete currentSchedule[chatId];
                    saveScheduledTickers(currentSchedule, SCHEDULE_FILE);
                }
                wasStopped = true;
            }
            // If it was polling, mark as stopped
            if (tickerState.isPolling) {
                tickerState.isPolling = false;
                wasStopped = true;
            }
            // Remove any pending jobs from the queue
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);
        }

        if (wasStopped) {
            await client.sendMessage(chatId, 'Laufender/geplanter Live-Ticker in dieser Gruppe gestoppt.');
            console.log(`Live-Ticker für Gruppe "${groupName}" (${chatId}) gestoppt.`);
            // No need to save seen_tickers here, let the natural save points handle it
        } else {
            await msg.reply('In dieser Gruppe läuft derzeit kein Live-Ticker.');
        }
    }
    // --- !reset Command ---
    else if (command === '!reset') {
        const tickerState = activeTickers.get(chatId);
        let scheduleRemoved = false; // Flag to check if it was removed from schedule

        if (tickerState) {
            // Clear schedule timeout if it exists
            if (tickerState.scheduleTimeout) {
                clearTimeout(tickerState.scheduleTimeout);
            }
            // Mark as not polling/scheduled
            tickerState.isPolling = false;
            tickerState.isScheduled = false;
            // Remove pending jobs
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);
        }

        // Always remove from active tickers map
        activeTickers.delete(chatId);
        // Always save the seen tickers file (to remove the entry)
        saveSeenTickers(activeTickers, SEEN_FILE);

        // Also remove from the schedule file if it exists there
        const currentSchedule = loadScheduledTickers(SCHEDULE_FILE);
        if (currentSchedule[chatId]) {
            delete currentSchedule[chatId];
            saveScheduledTickers(currentSchedule, SCHEDULE_FILE);
            scheduleRemoved = true;
        }

        await msg.reply('Alle Ticker-Daten für diese Gruppe wurden zurückgesetzt.');
        console.log(`Ticker-Daten für Gruppe "${groupName}" (${chatId}) wurden manuell zurückgesetzt.`);
    }
    // --- !start without URL ---
    else if (command === '!start') {
        await msg.reply(`Fehler: Bitte geben Sie eine gültige URL an. Format:\n\n!start <URL-zur-Live-Ticker-Webseite>`);
    }
    // --- Unknown Command ---
    // Optional: Add a message for unknown commands starting with !
    // else {
    //     await msg.reply(`Unbekannter Befehl: ${command}\nVerfügbare Befehle: !start <URL>, !stop, !reset`);
    // }
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