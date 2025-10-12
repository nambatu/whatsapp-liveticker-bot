// app.js - Final Cleaned Version
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const puppeteer = require('puppeteer');
const { Client, LocalAuth } = require('whatsapp-web.js');

// --- GLOBAL STATE ---
const activeTickers = new Map();
const SEEN_FILE = path.resolve(__dirname, 'seen_tickers.json');
const jobQueue = [];
let isWorkerRunning = false;

// --- EVENT MAPPING ---
const EVENT_MAP = {
    0: { label: "Spiel geht weiter", emoji: "🔁" }, 1: { label: "Spiel unterbrochen", emoji: "⏳" },
    2: { label: "Timeout", emoji: "⏳" }, 3: { label: "Timeout", emoji: "⏳" },
    4: { label: "Tor", emoji: "⚽" }, 5: { label: "7-Meter Tor", emoji: "🎯" },
    6: { label: "7-Meter Fehlwurf", emoji: "❌" }, 7: { label: "Rote Karte", emoji: "🟥" },
    8: { label: "Zeitstrafe", emoji: "⛔" }, 9: { label: "Gelbe Karte", emoji: "🟨" },
    14: { label: "Abpfiff (Halbzeit oder Spielende)", emoji: "⏸️" }, 15: { label: "Spielbeginn", emoji: "▶️" },
    16: { label: "Spielende", emoji: "🏁" }, 17: { label: "Teamaufstellung", emoji: "👥" }
};

// --- DATA PERSISTENCE ---
function loadSeenTickers() {
    try {
        const raw = fs.readFileSync(SEEN_FILE, 'utf8');
        const data = JSON.parse(raw);
        for (const [chatId, seenArray] of Object.entries(data)) {
            if (!activeTickers.has(chatId)) {
                activeTickers.set(chatId, { seen: new Set(seenArray) });
            }
        }
        console.log(`Daten für ${Object.keys(data).length} Ticker aus der Datei geladen.`);
    } catch (e) { console.log('Keine gespeicherte Ticker-Datei gefunden, starte frisch.'); }
}

function saveSeenTickers() {
    try {
        const dataToSave = {};
        for (const [chatId, tickerState] of activeTickers.entries()) {
            if (tickerState.seen) { dataToSave[chatId] = [...tickerState.seen]; }
        }
        fs.writeFileSync(SEEN_FILE, JSON.stringify(dataToSave, null, 2), 'utf8');
    } catch (e) { console.error('Fehler beim Speichern der Ticker-Daten:', e); }
}

// --- HELPER FUNCTIONS ---
function formatTimeFromSeconds(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatEvent(ev, tickerState) {
    const eventInfo = EVENT_MAP[ev.event] || { label: `Unbekanntes Event ${ev.event}`, emoji: "📢" };
    const homeTeamName = tickerState.teamNames ? tickerState.teamNames.home : 'Heim';
    const guestTeamName = tickerState.teamNames ? tickerState.teamNames.guest : 'Gast';
    const team = ev.teamHome ? homeTeamName : guestTeamName;
    const score = `${ev.pointsHome}:${ev.pointsGuest}`;
    const player = (ev.personFirstname || '') + (ev.personLastname ? ` ${ev.personLastname}` : '');
    const time = ev.second ? ` (${formatTimeFromSeconds(ev.second)})` : '';
    const formattedPlayer = player ? ` durch ${player}` : '';

    switch (ev.event) {
        case 4: return `${eventInfo.emoji} Tor für ${team}${formattedPlayer} - Stand: ${score}${time}`;
        case 5: return `${eventInfo.emoji} 7-Meter Tor für ${team}${formattedPlayer} - Stand: ${score}${time}`;
        case 6: return `${eventInfo.emoji} 7-Meter Fehlwurf (${team}) - Stand: ${score}${time}`;
        case 2: return `${eventInfo.emoji} ${eventInfo.label} ${homeTeamName}${time}`;
        case 3: return `${eventInfo.emoji} ${eventInfo.label} ${guestTeamName}${time}`;
        case 7: case 8: case 9: return `${eventInfo.emoji} ${eventInfo.label} für ${team}${formattedPlayer}${time}`;
        case 14: return `${eventInfo.emoji} Halbzeit - Stand: ${score}`;
        case 16: return `${eventInfo.emoji} Spielende - Endstand: ${score}`;
        case 0: case 1: case 17: return ``;
        default: return `${eventInfo.emoji} ${eventInfo.label} - Stand: ${score}`;
    }
}

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

client.on('qr', qr => { qrcode.generate(qr, { small: true }); console.log('QR-Code generiert. Scannen Sie diesen mit WhatsApp.'); });
client.on('ready', () => { console.log('WhatsApp-Client ist bereit!'); loadSeenTickers(); });
client.on('disconnected', (reason) => {
    console.log('Client getrennt:', reason);
    activeTickers.forEach(ticker => { if (ticker.intervalId) clearInterval(ticker.intervalId); });
    saveSeenTickers();
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

    if (command === '!start' && args.length >= 2) {
        if (activeTickers.has(chatId) && activeTickers.get(chatId).isPolling) {
            await msg.reply('In dieser Gruppe läuft bereits ein Live-Ticker. Stoppen Sie ihn zuerst mit `!stop`.');
            return;
        }
        const meetingPageUrl = args[1];
        try {
            // Added await here to properly catch errors from startPolling
            await startPolling(meetingPageUrl, chatId);
        } catch (error) {
            console.error(`[${chatId}] Kritischer Fehler beim Starten des Tickers:`, error);
            await msg.reply('Ein kritischer Fehler ist aufgetreten und der Ticker konnte nicht gestartet werden.');
            activeTickers.delete(chatId);
        }
    } else if (command === '!stop') {
        const tickerState = activeTickers.get(chatId);
        if (tickerState && tickerState.isPolling) {
            clearInterval(tickerState.intervalId);
            tickerState.isPolling = false;
            await client.sendMessage(chatId, 'Live-Ticker in dieser Gruppe gestoppt.');
            console.log(`Live-Ticker für Gruppe ${chat.name} (${chatId}) gestoppt.`);
            saveSeenTickers();
        } else {
            await msg.reply('In dieser Gruppe läuft derzeit kein Live-Ticker.');
        }
    } else if (command === '!start') {
        await msg.reply(`Fehler: Bitte geben Sie eine gültige URL an. Format:\n\n!start <URL-zur-Live-Ticker-Webseite>`);
    }
});

// --- POLLING LOGIC ---
async function startPolling(meetingPageUrl, chatId) {
    const urlRegex = /https:\/\/hbde-live\.liga\.nu\/nuScoreLive\/#\/groups\/\d+\/meetings\/\d+/;
    if (!urlRegex.test(meetingPageUrl)) {
        await client.sendMessage(chatId, 'Fehler: Die angegebene URL ist keine gültige Live-Ticker-Seiten-URL.');
        return;
    }

    const tickerState = activeTickers.get(chatId) || { seen: new Set() };
    tickerState.isPolling = true;
    tickerState.meetingPageUrl = meetingPageUrl;
    activeTickers.set(chatId, tickerState);

    await client.sendMessage(chatId, `Live-Ticker wird für diese Gruppe gestartet...`);

    const addJobToQueue = () => {
        if (!tickerState.isPolling) {
            clearInterval(tickerState.intervalId);
            return;
        }
        jobQueue.push({ chatId, meetingPageUrl, tickerState });
        console.log(`[${chatId}] Job zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
    };

    addJobToQueue();
    tickerState.intervalId = setInterval(addJobToQueue, 60000); // Add a job every 60 seconds
}

async function runQueueWorker() {
    if (isWorkerRunning || jobQueue.length === 0) {
        return;
    }
    isWorkerRunning = true;

    const job = jobQueue.shift();
    const { chatId, meetingPageUrl, tickerState } = job;
    
    console.log(`[${chatId}] Worker startet Job. Verbleibende Jobs: ${jobQueue.length}`);
    let browser = null;
    try {
        browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setRequestInterception(true);

        const apiCallPromise = new Promise((resolve, reject) => {
            page.on('request', request => {
                if (request.url().includes('/nuScoreLiveRestBackend/api/1/meeting/')) {
                    resolve(request.url());
                }
                request.continue();
            });
            setTimeout(() => reject(new Error('API-Request wurde nicht innerhalb von 30 Sekunden abgefangen.')), 30000);
        });

        await page.goto(meetingPageUrl, { waitUntil: 'networkidle0', timeout: 45000 });
        const capturedUrl = await apiCallPromise;
        await browser.close();
        browser = null;

        const meetingApiRegex = /api\/1\/meeting\/(\d+)\/time\/(\d+)/;
        const apiMatch = capturedUrl.match(meetingApiRegex);
        const meetingId = apiMatch[1];

        const metaRes = await axios.get(capturedUrl);
        if (!tickerState.teamNames && metaRes.data.teamHome) {
            tickerState.teamNames = { home: metaRes.data.teamHome, guest: metaRes.data.teamGuest };
            await client.sendMessage(chatId, `*${tickerState.teamNames.home}* vs. *${tickerState.teamNames.guest}* - Ticker aktiv!`);
        }
        
        const versionUid = metaRes.data.versionUid;
        if (versionUid && versionUid !== tickerState.lastVersionUid) {
            console.log(`[${chatId}] Neue Version erkannt: ${versionUid}`);
            tickerState.lastVersionUid = versionUid;
            
            const eventsUrl = `https://hbde-live.liga.nu/nuScoreLiveRestBackend/api/1/events/${meetingId}/versions/${versionUid}`;
            const eventsRes = await axios.get(eventsUrl);
            
            if (await processEvents(eventsRes.data, tickerState, chatId)) {
                saveSeenTickers();
            }
        }
    } catch (error) {
        console.error(`[${chatId}] Fehler im Worker-Job:`, error.message);
        if (browser) await browser.close();
    } finally {
        isWorkerRunning = false;
    }
}

async function processEvents(data, tickerState, chatId) {
    if (!data || !Array.isArray(data.events)) return false;
    
    let newEventsAdded = false;
    const events = data.events.slice().sort((a, b) => a.idx - b.idx);

    for (const ev of events) {
        if (tickerState.seen.has(ev.idx)) {
            continue;
        }
        const msg = formatEvent(ev, tickerState);
        console.log(`[${chatId}] Sende neues Event:`, msg);
        if (msg) {
            await client.sendMessage(chatId, msg);
        }
        tickerState.seen.add(ev.idx);
        newEventsAdded = true;
        if (ev.event === 16) {
            console.log(`[${chatId}] Spielende-Event empfangen. Ticker wird gestoppt.`);
            clearInterval(tickerState.intervalId);
            tickerState.isPolling = false;
            break;
        }
    }
    return newEventsAdded;
}

// --- MAIN EXECUTION ---
// Start the queue worker to process jobs one by one
setInterval(runQueueWorker, 1000); 

// Initialize the WhatsApp client to start listening for messages
client.initialize();

// --- APP SHUTDOWN ---
process.on('SIGINT', async () => {
    console.log('(SIGINT) Empfangen. Bot wird heruntergefahren...');
    activeTickers.forEach(ticker => { if (ticker.intervalId) clearInterval(ticker.intervalId); });
    saveSeenTickers();
    if (client) await client.destroy();
    process.exit(0);
});
