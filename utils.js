// utils.js

const fs = require('fs');
const path = require('path');
const { EVENT_MAP } = require('./config.js'); // Import from our new config file

const SEEN_FILE = path.resolve(__dirname, 'seen_tickers.json');

function loadSeenTickers(activeTickers) {
    try {
        const raw = fs.readFileSync(SEEN_FILE, 'utf8');
        const data = JSON.parse(raw);
        for (const [chatId, seenArray] of Object.entries(data)) {
            if (!activeTickers.has(chatId)) {
                activeTickers.set(chatId, { seen: new Set(seenArray) });
            }
        }
        console.log(`Daten für ${Object.keys(data).length} Ticker aus der Datei geladen.`);
    } catch (e) {
        console.log('Keine gespeicherte Ticker-Datei gefunden, starte frisch.');
    }
}

function saveSeenTickers(activeTickers) {
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

module.exports = {
    loadSeenTickers,
    saveSeenTickers,
    formatEvent
};