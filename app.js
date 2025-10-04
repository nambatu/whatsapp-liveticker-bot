// app.js
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('whatsapp-web.js');

// --- ZENTRALE VERWALTUNG FÜR ALLE AKTIVEN TICKER ---
// Anstelle von globalen Variablen nutzen wir eine Map.
// Der Key ist die Chat-ID, der Wert ist das State-Objekt des Tickers.
const activeTickers = new Map();

// --- KONFIGURATION & PERSISTENZ ---
const SEEN_FILE = path.resolve(__dirname, 'seen_tickers.json');

// --- Event Mapping (unverändert) ---
const EVENT_MAP = {
    0: { label: "Spiel geht weiter", emoji: "🔁" },
    1: { label: "Spiel unterbrochen", emoji: "⏳" },
    2: { label: "Timeout", emoji: "⏳" },
    3: { label: "Timeout", emoji: "⏳" },
    4: { label: "Tor", emoji: "⚽" },
    5: { label: "7-Meter Tor", emoji: "🎯" },
    6: { label: "7-Meter Fehlwurf", emoji: "❌" },
    7: { label: "Rote Karte", emoji: "🟥" },
    8: { label: "Zeitstrafe", emoji: "⛔" },
    9: { label: "Gelbe Karte", emoji: "🟨" },
    14: { label: "Abpfiff (Halbzeit oder Spielende)", emoji: "⏸️" },
    15: { label: "Spielbeginn", emoji: "▶️" },
    16: { label: "Spielende", emoji: "🏁" },
    17: { label: "Teamaufstellung", emoji: "👥" }
};

// --- DATEN-PERSISTENZ (für mehrere Ticker angepasst) ---
function loadSeenTickers() {
    try {
        const raw = fs.readFileSync(SEEN_FILE, 'utf8');
        const data = JSON.parse(raw);
        for (const [chatId, seenArray] of Object.entries(data)) {
            // Wir erstellen keinen Ticker, sondern merken uns nur die 'seen' Events
            // für den Fall, dass ein Ticker nach einem Neustart wieder gestartet wird.
            // Die eigentliche Ticker-Logik startet erst mit !start.
            if (!activeTickers.has(chatId)) {
                activeTickers.set(chatId, { seen: new Set(seenArray) });
            }
        }
        console.log(`Daten für ${Object.keys(data).length} Ticker aus der Datei geladen.`);
    } catch (e) {
        console.log('Keine gespeicherte Ticker-Datei gefunden, starte frisch.');
    }
}

function saveSeenTickers() {
    try {
        const dataToSave = {};
        for (const [chatId, tickerState] of activeTickers.entries()) {
            if (tickerState.seen) {
                dataToSave[chatId] = [...tickerState.seen];
            }
        }
        fs.writeFileSync(SEEN_FILE, JSON.stringify(dataToSave, null, 2), 'utf8');
    } catch (e) {
        console.error('Fehler beim Speichern der Ticker-Daten:', e);
    }
}

// --- HILFSFUNKTIONEN (angepasst, um `teamNames` zu übergeben) ---
function teamName(isHomeTeam, teamNames) {
    return isHomeTeam ? teamNames.home : teamNames.guest;
}

function formatTimeFromSeconds(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// Nimmt jetzt den Ticker-State (inkl. teamNames) als Argument
function formatEvent(ev, tickerState) {
    const eventInfo = EVENT_MAP[ev.event] || { label: `Unbekanntes Event ${ev.event}`, emoji: "📢" };
    const team = teamName(ev.teamHome, tickerState.teamNames);
    const score = `${ev.pointsHome}:${ev.pointsGuest}`;
    const player = (ev.personFirstname || '') + (ev.personLastname ? ` ${ev.personLastname}` : '');
    const time = ev.second ? ` (${formatTimeFromSeconds(ev.second)})` : '';
    const formattedPlayer = player ? ` durch ${player}` : '';

    switch (ev.event) {
        case 4: return `${eventInfo.emoji} Tor für ${team}${formattedPlayer} - Stand: ${score}${time}`;
        case 5: return `${eventInfo.emoji} 7-Meter Tor für ${team}${formattedPlayer} - Stand: ${score}${time}`;
        case 6: return `${eventInfo.emoji} 7-Meter Fehlwurf (${team}) - Stand: ${score}${time}`;
        case 2: return `${eventInfo.emoji} ${eventInfo.label} ${tickerState.teamNames.home}${time}`;
        case 3: return `${eventInfo.emoji} ${eventInfo.label} ${tickerState.teamNames.guest}${time}`;
        case 8:
        case 7:
        case 9: return `${eventInfo.emoji} ${eventInfo.label} für ${team}${formattedPlayer}${time}`;
        case 14: return `${eventInfo.emoji} Halbzeit - Stand: ${score}`;
        case 16: return `${eventInfo.emoji} Spielende - Endstand: ${score}`;
        case 0:
        case 1:
        case 17: return ``;
        default: return `${eventInfo.emoji} ${eventInfo.label} - Stand: ${score}`;
    }
}

// --- WHATSAPP CLIENT INITIALISIERUNG (unverändert) ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
        executablePath: '/usr/bin/chromium'
    }
});

client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log('QR-Code generiert. Scannen Sie diesen mit WhatsApp, um sich anzumelden.');
});

client.on('ready', () => {
    console.log('WhatsApp-Client ist bereit!');
    loadSeenTickers(); // Lade alte Daten, wenn der Client bereit ist
});

client.on('disconnected', (reason) => {
    console.log('Client getrennt:', reason);
    // Alle Intervalle stoppen, wenn die Verbindung abbricht
    activeTickers.forEach(ticker => {
        if (ticker.intervalId) clearInterval(ticker.intervalId);
    });
    saveSeenTickers(); // Daten sichern
});

// --- NACHRICHTEN-LISTENER (stark überarbeitet) ---
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

        const fullApiUrl = args[1];
        const apiRegex = /api\/1\/meeting\/(\d+)\/time\/(\d+)/;
        const apiMatch = fullApiUrl.match(apiRegex);

        if (!apiMatch || apiMatch.length < 3) {
            await msg.reply('Fehler: Die URL scheint kein gültiger API-Link zu sein.');
            return;
        }

        const meetingId = apiMatch[1];
        const timestamp = apiMatch[2];

        await msg.reply(`Ticker wird für diese Gruppe gestartet...`);
        startPolling(meetingId, timestamp, chatId);

    } else if (command === '!stop') {
        const tickerState = activeTickers.get(chatId);
        if (tickerState && tickerState.isPolling) {
            clearInterval(tickerState.intervalId);
            tickerState.isPolling = false;
            // Wir löschen den Ticker nicht komplett aus der Map, um die `seen` Daten zu behalten.
            // Alternativ könnte man hier auch `activeTickers.delete(chatId);` aufrufen.
            await client.sendMessage(chatId, 'Live-Ticker in dieser Gruppe gestoppt.');
            console.log(`Live-Ticker für Gruppe ${chat.name} (${chatId}) gestoppt.`);
            saveSeenTickers();
        } else {
            await msg.reply('In dieser Gruppe läuft derzeit kein Live-Ticker.');
        }
    } else if (command === '!start') {
        await msg.reply(`Fehler: Bitte geben Sie eine gültige URL an. Format:\n\n!start <vollständige-live-ticker-URL>`);
    }
});

client.initialize();

// --- POLLING-FUNKTIONEN (angepasst, um mit der `activeTickers`-Map zu arbeiten) ---
async function startPolling(meetingId, timestamp, chatId) {
    // Hole den State für diesen Chat oder erstelle einen neuen.
    const tickerState = activeTickers.get(chatId) || { seen: new Set() };
    tickerState.isPolling = true;
    tickerState.meetingId = meetingId;
    activeTickers.set(chatId, tickerState);

    try {
        const teamsUrl = `https://hbde-live.liga.nu/nuScoreLiveRestBackend/api/1/meeting/${meetingId}/time/${timestamp}`;
        const res = await axios.get(teamsUrl, { timeout: 10000 });

        if (res.data && res.data.teamHome && res.data.teamGuest && res.data.versionUid) {
            tickerState.teamNames = { home: res.data.teamHome, guest: res.data.teamGuest };
            tickerState.versionUid = res.data.versionUid;
            
            console.log(`Teamnamen für Chat ${chatId} geladen: ${tickerState.teamNames.home} vs ${tickerState.teamNames.guest}`);
            await client.sendMessage(chatId, `*${tickerState.teamNames.home}* vs. *${tickerState.teamNames.guest}* - Live-Ticker gestartet!`);

            // Starte das Polling für genau diesen Ticker
            doPoll(chatId); // Sofortiger erster Check
            tickerState.intervalId = setInterval(() => doPoll(chatId), 10000); // z.B. alle 10 Sekunden
            activeTickers.set(chatId, tickerState);
        } else {
            throw new Error('Konnten Teamnamen oder Version-UID nicht abrufen.');
        }
    } catch (err) {
        console.error(`[${chatId}] Fehler beim Starten des Tickers:`, err.message);
        await client.sendMessage(chatId, `Fehler beim Starten des Tickers. Überprüfen Sie die URL. Polling gestoppt.`);
        activeTickers.delete(chatId); // Ticker entfernen, da er nicht gestartet werden konnte
    }
}

async function doPoll(chatId) {
    const tickerState = activeTickers.get(chatId);
    if (!tickerState || !tickerState.isPolling) {
        // Falls Ticker zwischenzeitlich gestoppt wurde
        if (tickerState && tickerState.intervalId) clearInterval(tickerState.intervalId);
        return;
    }

    let newEventsAdded = false;
    try {
        const apiUrl = `https://hbde-live.liga.nu/nuScoreLiveRestBackend/api/1/events/${tickerState.meetingId}/versions/${tickerState.versionUid}`;
        const res = await axios.get(apiUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LiveTickerBot/1.0)' },
            timeout: 5000
        });

        if (!res.data || !Array.isArray(res.data.events)) {
            console.warn(`[${chatId}] Unerwartete API-Antwort.`);
            return;
        }

        const events = res.data.events.slice().sort((a, b) => a.idx - b.idx);

        for (const ev of events) {
            if (tickerState.seen.has(ev.idx)) continue;

            const msg = formatEvent(ev, tickerState);
            console.log(`[${chatId}] Neues Event:`, msg);

            if (msg) {
                await client.sendMessage(chatId, msg);
            }

            tickerState.seen.add(ev.idx);
            newEventsAdded = true;

            // Spielende-Event beendet den Ticker für diese Gruppe
            if (ev.event === 16) {
                console.log(`[${chatId}] Spielende-Event empfangen. Ticker für diese Gruppe wird gestoppt.`);
                clearInterval(tickerState.intervalId);
                tickerState.isPolling = false;
                break; // Schleife beenden
            }
        }

        if (newEventsAdded) {
            saveSeenTickers();
        }
    } catch (err) {
        console.error(`[${chatId}] Fehler beim Abrufen der API:`, err.message);
        // Stoppt nur den fehlerhaften Ticker, nicht den ganzen Bot
        clearInterval(tickerState.intervalId);
        tickerState.isPolling = false;
        await client.sendMessage(chatId, 'Ein Fehler ist beim Abrufen der Live-Daten aufgetreten. Der Ticker für diese Gruppe wurde gestoppt.');
    }
}

// --- APP BEENDEN (SIGINT) ---
process.on('SIGINT', async () => {
    console.log('(SIGINT) Empfangen. Bot wird heruntergefahren...');
    activeTickers.forEach(ticker => {
        if (ticker.intervalId) clearInterval(ticker.intervalId);
    });
    saveSeenTickers();
    if (client) await client.destroy();
    process.exit(0);

});

