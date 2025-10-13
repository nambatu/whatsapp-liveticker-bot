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
    const scoreLine = `${homeTeamName}  *${ev.pointsHome}:${ev.pointsGuest}* ${guestTeamName}`;
    const player = (ev.personFirstname || '') + (ev.personLastname ? ` ${ev.personLastname}` : '');
    const time = ev.second ? ` (${formatTimeFromSeconds(ev.second)})` : '';
    const formattedPlayer = player.trim() ? ` durch ${player.trim()}` : '';

    switch (ev.event) {
        case 4: // Tor
        case 5: // 7-Meter Tor
            return `${scoreLine}\n${eventInfo.emoji} Tor für *${team}*${formattedPlayer}${time}`;
        case 6: // 7-Meter Fehlwurf
             return `${scoreLine}\n${eventInfo.emoji} 7-Meter Fehlwurf von *${team}*${time}`;
        case 2: // Timeout Heim
        case 3: // Timeout Gast
            return `${scoreLine}\n${eventInfo.emoji} Timeout für *${team}*`;
        case 7: // Rote Karte
        case 8: // Zeitstrafe
        case 9: // Gelbe Karte
            const playerForCard = player.trim() ? ` (${player.trim()})` : '';
            return `${scoreLine}\n${eventInfo.emoji} ${eventInfo.label} für *${team}*${playerForCard}`;
        case 14: // Halbzeit
            return `⏸️ *Halbzeit*\n${homeTeamName}  *${ev.pointsHome}:${ev.pointsGuest}* ${guestTeamName}`;
        case 16: // Spielende
            return `🏁 *Spielende*\n${homeTeamName}  *${ev.pointsHome}:${ev.pointsGuest}* ${guestTeamName}`;
        case 15: // Spielbeginn
             return `▶️ *Das Spiel hat begonnen!*`;
        case 0: case 1: case 17: return ``;
        default:
            return `${scoreLine}\n${eventInfo.emoji} ${eventInfo.label}`;
    }
}

module.exports = {
    loadSeenTickers,
    saveSeenTickers,
    formatEvent
};