// utils.js

const fs = require('fs');
const path = require('path');
const { EVENT_MAP } = require('./config.js'); // Import event definitions

// --- DATA PERSISTENCE ---

/**
 * Loads the set of seen event IDs for each chat from a JSON file.
 * Populates the activeTickers map with this data on startup.
 * @param {Map} activeTickers - The map storing active ticker states.
 * @param {string} seenFilePath - The path to the 'seen_tickers.json' file.
 */
function loadSeenTickers(activeTickers, seenFilePath) {
    try {
        const raw = fs.readFileSync(seenFilePath, 'utf8');
        const data = JSON.parse(raw);
        // Iterate through saved data (chatId -> array of seen IDs)
        for (const [chatId, seenArray] of Object.entries(data)) {
            // If this chat isn't already in memory, add it with its seen events
            if (!activeTickers.has(chatId)) {
                activeTickers.set(chatId, { seen: new Set(seenArray) });
            }
        }
        console.log(`Daten für ${Object.keys(data).length} Ticker aus der Datei geladen.`);
    } catch (e) {
        // Handle cases where the file doesn't exist (e.g., first run) or is invalid JSON
        console.log('Keine gespeicherte Ticker-Datei gefunden oder Fehler beim Lesen, starte frisch.');
    }
}

/**
 * Saves the current set of seen event IDs for all active tickers to a JSON file.
 * @param {Map} activeTickers - The map storing active ticker states.
 * @param {string} seenFilePath - The path to the 'seen_tickers.json' file.
 */
function saveSeenTickers(activeTickers, seenFilePath) {
    try {
        const dataToSave = {};
        // Convert the Set of seen IDs back to an array for JSON compatibility
        for (const [chatId, tickerState] of activeTickers.entries()) {
            if (tickerState.seen) {
                dataToSave[chatId] = [...tickerState.seen];
            }
        }
        // Write the data to the file, formatted for readability
        fs.writeFileSync(seenFilePath, JSON.stringify(dataToSave, null, 2), 'utf8');
    } catch (e) {
        console.error('Fehler beim Speichern der Ticker-Daten:', e);
    }
}

/**
 * Loads the schedule data (details of tickers waiting to start) from a JSON file.
 * @param {string} scheduleFilePath - The path to the 'scheduled_tickers.json' file.
 * @returns {object} - An object mapping chatId to schedule details, or {} on error/no file.
 */
function loadScheduledTickers(scheduleFilePath) {
    try {
        const raw = fs.readFileSync(scheduleFilePath, 'utf8');
        return JSON.parse(raw); // Return the parsed schedule object
    } catch (e) {
        console.log('Keine gespeicherte Planungsdatei gefunden oder Fehler beim Lesen.');
        return {}; // Return empty object if file is missing or invalid
    }
}

/**
 * Saves the current schedule data (tickers waiting to start) to a JSON file.
 * @param {object} scheduledTickers - An object mapping chatId to schedule details.
 * @param {string} scheduleFilePath - The path to the 'scheduled_tickers.json' file.
 */
function saveScheduledTickers(scheduledTickers, scheduleFilePath) {
    try {
        // Write the schedule object to the file, formatted
        fs.writeFileSync(scheduleFilePath, JSON.stringify(scheduledTickers, null, 2), 'utf8');
    } catch (e) {
        console.error('Fehler beim Speichern der geplanten Ticker:', e);
    }
}

// --- HELPER FUNCTIONS ---

/**
 * Abbreviates a player's name to the format "F. Lastname".
 * @param {string|null} firstName - The player's first name.
 * @param {string|null} lastName - The player's last name.
 * @returns {string} - The abbreviated name, or just the last name, or an empty string.
 */
function abbreviatePlayerName(firstName, lastName) {
    if (!lastName) return ''; // No last name, return empty
    if (!firstName) return lastName; // No first name, return only last name
    return `${firstName.charAt(0)}. ${lastName}`; // Return "F. Lastname"
}

/**
 * Formats a duration in seconds into a MM:SS string.
 * @param {number} sec - The duration in seconds.
 * @returns {string} - The formatted time string (e.g., "05:32").
 */
function formatTimeFromSeconds(sec) {
    const m = Math.floor(sec / 60); // Calculate minutes
    const s = sec % 60; // Calculate remaining seconds
    // Pad with leading zeros if necessary
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Formats a game event object into a user-friendly WhatsApp message string.
 * Applies different layouts based on the event type (goal, penalty, timeout, etc.).
 * @param {object} ev - The event object from the API.
 * @param {object} tickerState - The state object for the current ticker (contains team names).
 * @returns {string} - The formatted message string, or an empty string for ignored events.
 */
function formatEvent(ev, tickerState) {
    // Get basic event info (emoji, label) from the map, provide fallback
    const eventInfo = EVENT_MAP[ev.event] || { label: `Unbekanntes Event ${ev.event}`, emoji: "📢" };
    // Get full team names, provide fallbacks
    const homeTeamName = tickerState.teamNames ? tickerState.teamNames.home : 'Heim';
    const guestTeamName = tickerState.teamNames ? tickerState.teamNames.guest : 'Gast';
    // Determine the acting team for this event
    const team = ev.teamHome ? homeTeamName : guestTeamName;
    // Format time if available
    const time = ev.second ? ` (${formatTimeFromSeconds(ev.second)})` : '';
    // Get abbreviated player name
    const abbreviatedPlayer = abbreviatePlayerName(ev.personFirstname, ev.personLastname);
    // Prepare player string snippet for goals/misses
    const playerForGoal = abbreviatedPlayer ? ` durch ${abbreviatedPlayer}` : '';

    // Main logic: Format message based on event type
    switch (ev.event) {
        case 4: { // Tor (regular goal)
            let scoreLine;
            // Create score line, bolding the score of the scoring team
            if (ev.teamHome) {
                scoreLine = `${homeTeamName}  *${ev.pointsHome}*:${ev.pointsGuest}  ${guestTeamName}`;
            } else {
                scoreLine = `${homeTeamName}  ${ev.pointsHome}:*${ev.pointsGuest}* ${guestTeamName}`;
            }
            // Combine score line with event details
            return `${scoreLine}\n${eventInfo.emoji} Tor${playerForGoal}${time}`;
        }
        case 5: { // 7-Meter Tor
            let scoreLine;
            // Create score line, bolding the score of the scoring team
            if (ev.teamHome) {
                scoreLine = `${homeTeamName}  *${ev.pointsHome}*:${ev.pointsGuest}  ${guestTeamName}`;
            } else {
                scoreLine = `${homeTeamName}  ${ev.pointsHome}:*${ev.pointsGuest}* ${guestTeamName}`;
            }
            // Combine score line with event details
            return `${scoreLine}\n${eventInfo.emoji} 7-Meter Tor${playerForGoal}${time}`;
        }
        case 6: // 7-Meter Fehlwurf
             // No score update needed, just the action
             return `${eventInfo.emoji} 7-Meter Fehlwurf für *${team}*${playerForGoal}${time}`;
        
        case 2: // Timeout Heim
        case 3: // Timeout Gast
            // No score update needed
            return `${eventInfo.emoji} Timeout für *${team}*`;
        
        case 8: // Zeitstrafe
        case 9: // Gelbe Karte
        case 11: // Rote Karte
             // Format specifically for penalties/cards
            if (abbreviatedPlayer) {
                // If player known, format as "Action for Player (Team) (Time)"
                return `${eventInfo.emoji} ${eventInfo.label} für ${abbreviatedPlayer} (*${team}*)${time}`;
            } else {
                // If player unknown (e.g., bench penalty), format as "Action for Team (Time)"
                return `${eventInfo.emoji} ${eventInfo.label} für *${team}*${time}`;
            }
        
        case 14: // Halbzeit
            // Summary event, show score
            return `⏸️ *Halbzeit*\n${homeTeamName}  *${ev.pointsHome}:${ev.pointsGuest}* ${guestTeamName}`;
        
        case 16: // Spielende
            // Summary event, show score
            return `🏁 *Spielende*\n${homeTeamName}  *${ev.pointsHome}:${ev.pointsGuest}* ${guestTeamName}`;
        
        case 15: // Spielbeginn
             // Simple start message
             return `▶️ *Das Spiel hat begonnen!*`;
        
        // Events to ignore (return empty string so no message is sent)
        case 0: // Spiel geht weiter
        case 1: // Spiel unterbrochen
        case 17: // Teamaufstellung
            return ``;
        
        // Fallback for any other unknown event types
        default:
            return `${eventInfo.emoji} ${eventInfo.label}`; // Show basic info without score
    }
}

// utils.js

/**
 * Formats a single event into a line for the recap message.
 * @param {object} ev - The raw event object.
 * @param {object} tickerState - The state object for the ticker.
 * @returns {string} - The formatted recap line string.
 */
function formatRecapEventLine(ev, tickerState) {
    const eventInfo = EVENT_MAP[ev.event] || { label: `Unbekanntes Event ${ev.event}`, emoji: "📢" };
    const homeTeamName = tickerState.teamNames ? tickerState.teamNames.home : 'Heim';
    const guestTeamName = tickerState.teamNames ? tickerState.teamNames.guest : 'Gast';
    const team = ev.teamHome ? homeTeamName : guestTeamName;
    const time = ev.second ? formatTimeFromSeconds(ev.second) : '--:--';
    const abbreviatedPlayer = abbreviatePlayerName(ev.personFirstname, ev.personLastname);

    let scoreStr = " ".repeat(7); // Placeholder for alignment
    let eventStr = `${eventInfo.emoji} ${eventInfo.label}`;
    let playerStr = abbreviatedPlayer || "";
    let teamStr = ""; // Only used when necessary

    switch (ev.event) {
        case 4: // Tor
        case 5: // 7-Meter Tor
            if (ev.teamHome) {
                scoreStr = `*${ev.pointsHome}*:${ev.pointsGuest}`;
            } else {
                scoreStr = `${ev.pointsHome}:*${ev.pointsGuest}*`;
            }
            eventStr = `${eventInfo.emoji} Tor`; // Use consistent label
            break;
        case 6: // 7-Meter Fehlwurf
            eventStr = `${eventInfo.emoji} 7m-Fehlwurf`;
            teamStr = team; // Specify team for clarity
            break;
        case 2: // Timeout Heim
        case 3: // Timeout Gast
            eventStr = `${eventInfo.emoji} Timeout`;
            teamStr = team; // Specify team
            break;
        case 8: // Zeitstrafe
        case 9: // Gelbe Karte
        case 11: // Rote Karte
             teamStr = `(*${team}*)`; // Team in parentheses for player
             if (!abbreviatedPlayer) {
                 playerStr = team; // If no player, show team name here instead
                 teamStr = "";
             }
            break;
        // Ignored events (shouldn't be in recapEvents array, but handle defensively)
        case 0: case 1: case 15: case 17: case 14: case 16:
             return ""; // Return empty string if somehow an ignored event gets here

        default: // Fallback for unknown events
             eventStr = `${eventInfo.emoji} ${eventInfo.label}`;
             break;
    }

    // Combine parts, ensuring some alignment (may vary slightly on phones)
    // Format: SCORE | EVENT | PLAYER | TEAM | TIME
    return `${scoreStr.padEnd(7)} | ${eventStr.padEnd(15)} | ${playerStr.padEnd(15)} | ${teamStr.padEnd(15)} | (${time})`;
}

module.exports = {
    loadSeenTickers,
    saveSeenTickers,
    formatEvent,
    loadScheduledTickers,
    saveScheduledTickers,
    formatRecapEventLine 
};