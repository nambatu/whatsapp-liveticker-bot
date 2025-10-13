// utils.js

const fs = require('fs');
const path = require('path');
const { EVENT_MAP } = require('./config.js');

// --- DATA PERSISTENCE (unverändert) ---
function loadSeenTickers(activeTickers, seenFilePath) { // Nimmt jetzt den Pfad entgegen
    try {
        const raw = fs.readFileSync(seenFilePath, 'utf8'); // Verwendet den übergebenen Pfad
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

function saveSeenTickers(activeTickers, seenFilePath) { // Nimmt jetzt den Pfad entgegen
    try {
        const dataToSave = {};
        for (const [chatId, tickerState] of activeTickers.entries()) {
            if (tickerState.seen) {
                dataToSave[chatId] = [...tickerState.seen];
            }
        }
        fs.writeFileSync(seenFilePath, JSON.stringify(dataToSave, null, 2), 'utf8'); // Verwendet den übergebenen Pfad
    } catch (e) {
        console.error('Fehler beim Speichern der Ticker-Daten:', e);
    }
}

// --- HELPER FUNCTIONS ---

function abbreviatePlayerName(firstName, lastName) {
    if (!lastName) return '';
    if (!firstName) return lastName;
    return `${firstName.charAt(0)}. ${lastName}`;
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
    const time = ev.second ? ` (${formatTimeFromSeconds(ev.second)})` : '';
    const abbreviatedPlayer = abbreviatePlayerName(ev.personFirstname, ev.personLastname);

    const playerForGoal = abbreviatedPlayer ? ` durch ${abbreviatedPlayer}` : '';
    
    switch (ev.event) {
        case 4: // Tor
        case 5: // 7-Meter Tor
            let scoreLine;
            if (ev.teamHome) {
                scoreLine = `${homeTeamName}  *${ev.pointsHome}*:${ev.pointsGuest}  ${guestTeamName}`;
            } else {
                scoreLine = `${homeTeamName}  ${ev.pointsHome}:*${ev.pointsGuest}* ${guestTeamName}`;
            }
            return `${scoreLine}\n${eventInfo.emoji} Tor${playerForGoal}${time}`;
        
        case 6: // 7-Meter Fehlwurf
             return `${eventInfo.emoji} 7-Meter Fehlwurf für *${team}*${playerForGoal}${time}`;
        
        case 2: // Timeout Heim
        case 3: // Timeout Gast
            return `${eventInfo.emoji} Timeout für *${team}*`;
        
        case 8: // Zeitstrafe
        case 9: // Gelbe Karte
        case 11: // Rote Karte

            if (abbreviatedPlayer) {
                return `${eventInfo.emoji} ${eventInfo.label} für ${abbreviatedPlayer} (*${team}*)${time}`;
            } else {
                return `${eventInfo.emoji} ${eventInfo.label} für *${team}*${time}`;
            }
        
        case 14: // Halbzeit
            return `⏸️ *Halbzeit*\n${homeTeamName}  *${ev.pointsHome}:${ev.pointsGuest}* ${guestTeamName}`;
        
        case 16: // Spielende
            return `🏁 *Spielende*\n${homeTeamName}  *${ev.pointsHome}:${ev.pointsGuest}* ${guestTeamName}`;
        
        case 15: // Spielbeginn
             return `▶️ *Das Spiel hat begonnen!*`;
        
        case 0: case 1: case 17: return ``;
        
        default:
            return `${eventInfo.emoji} ${eventInfo.label}`;
    }
}

module.exports = {
    loadSeenTickers,
    saveSeenTickers,
    formatEvent
};