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
        const raw = fs.readFileSync(seenFilePath, 'utf8'); // Read file content
        const data = JSON.parse(raw); // Parse JSON data
        // Iterate through saved data (chatId -> array of seen IDs)
        for (const [chatId, seenArray] of Object.entries(data)) {
            // If this chat isn't already in memory (e.g., from schedule file), add it with its seen events
            if (!activeTickers.has(chatId)) {
                activeTickers.set(chatId, { seen: new Set(seenArray) }); // Use a Set for efficient lookups
            } else {
                // If ticker state already exists (e.g., loaded from schedule), just add the 'seen' set
                const existingState = activeTickers.get(chatId);
                existingState.seen = new Set(seenArray);
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
        // Iterate through all tickers currently in memory
        for (const [chatId, tickerState] of activeTickers.entries()) {
            // Convert the Set of seen IDs back to an array for JSON compatibility
            if (tickerState.seen) {
                dataToSave[chatId] = [...tickerState.seen];
            }
        }
        // Write the data to the file, formatted with indentation for readability
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
        // Handle file not found or invalid JSON
        console.log('Keine gespeicherte Planungsdatei gefunden oder Fehler beim Lesen.');
        return {}; // Return empty object to prevent errors in calling code
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
    if (!lastName) return ''; // No last name provided
    if (!firstName) return lastName; // No first name provided
    return `${firstName.charAt(0)}. ${lastName}`; // Combine first initial and last name
}

/**
 * Formats a duration in seconds into a MM:SS string.
 * @param {number} sec - The duration in seconds.
 * @returns {string} - The formatted time string (e.g., "05:32").
 */
function formatTimeFromSeconds(sec) {
    const m = Math.floor(sec / 60); // Calculate whole minutes
    const s = sec % 60; // Calculate remaining seconds
    // Pad minutes and seconds with a leading zero if they are single digit
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Formats a game event object into a user-friendly WhatsApp message string for live mode.
 * Applies different layouts based on the event type (goal, penalty, timeout, etc.).
 * Only includes the score line for goal events.
 * @param {object} ev - The event object from the API.
 * @param {object} tickerState - The state object for the current ticker (contains team names).
 * @returns {string} - The formatted message string, or an empty string for ignored events.
 */
function formatEvent(ev, tickerState) {
    // Get basic event info (emoji, label) from config, provide fallback for unknown types
    const eventInfo = EVENT_MAP[ev.event] || { label: `Unbekanntes Event ${ev.event}`, emoji: "📢" };
    // Get full team names from state, provide default fallbacks
    const homeTeamName = tickerState.teamNames ? tickerState.teamNames.home : 'Heim';
    const guestTeamName = tickerState.teamNames ? tickerState.teamNames.guest : 'Gast';
    // Determine the acting team for this specific event
    const team = ev.teamHome ? homeTeamName : guestTeamName;
    // Format the game time if available
    const time = ev.second ? ` (${formatTimeFromSeconds(ev.second)})` : '';
    // Get the abbreviated player name
    const abbreviatedPlayer = abbreviatePlayerName(ev.personFirstname, ev.personLastname);
    // Prepare player string snippet specifically for goal messages
    const playerForGoal = abbreviatedPlayer ? ` durch ${abbreviatedPlayer}` : '';

    // Main logic: Format message differently based on the event type
    switch (ev.event) {
        case 4: { // Tor (regular goal)
            let scoreLine;
            // Create score line, bolding the score of the team that scored
            if (ev.teamHome) {
                scoreLine = `${homeTeamName}  *${ev.pointsHome}*:${ev.pointsGuest}  ${guestTeamName}`;
            } else {
                scoreLine = `${homeTeamName}  ${ev.pointsHome}:*${ev.pointsGuest}* ${guestTeamName}`;
            }
            // Return score line + goal info
            return `${scoreLine}\n${eventInfo.emoji} Tor${playerForGoal}${time}`;
        }
        case 5: { // 7-Meter Tor
            let scoreLine;
            // Create score line, bolding the score of the team that scored
            if (ev.teamHome) {
                scoreLine = `${homeTeamName}  *${ev.pointsHome}*:${ev.pointsGuest}  ${guestTeamName}`;
            } else {
                scoreLine = `${homeTeamName}  ${ev.pointsHome}:*${ev.pointsGuest}* ${guestTeamName}`;
            }
            // Return score line + 7m goal info
            return `${scoreLine}\n${eventInfo.emoji} 7-Meter Tor${playerForGoal}${time}`;
        }
        case 6: // 7-Meter Fehlwurf
             // No score update, just the action. Explicitly name the team.
             return `${eventInfo.emoji} 7-Meter Fehlwurf für *${team}*${playerForGoal}${time}`;

        case 2: // Timeout Heim
        case 3: // Timeout Gast
            // No score update, just the action. Explicitly name the team.
            return `${eventInfo.emoji} Timeout für *${team}*`;

        case 8: // Zeitstrafe
        case 9: // Gelbe Karte
        case 11: // Rote Karte
             // No score update. Format based on whether player name is known.
            if (abbreviatedPlayer) {
                // "Action for Player (Team) (Time)"
                return `${eventInfo.emoji} ${eventInfo.label} für ${abbreviatedPlayer} (*${team}*)${time}`;
            } else {
                // "Action for Team (Time)" (e.g., bench penalty)
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

        // Events to ignore entirely (return empty string -> no message sent)
        case 0: // Spiel geht weiter
        case 1: // Spiel unterbrochen
        case 17: // Teamaufstellung
            return ``;

        // Fallback for any other unknown or unhandled event types
        default:
            // Show basic info without score
            return `${eventInfo.emoji} ${eventInfo.label}`;
    }
}

/**
 * Formats a single event into a line for the recap message using bullet points and separators.
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

    let scoreStr = `${ev.pointsHome}:${ev.pointsGuest}`; // Score is always shown
    let eventLabel = eventInfo.label;
    let detailStr = abbreviatedPlayer || ""; // Default detail is player

    switch (ev.event) {
        case 4: // Tor
        case 5: // 7-Meter Tor
            // Bold the relevant part of the score
            if (ev.teamHome) {
                scoreStr = `*${ev.pointsHome}*:${ev.pointsGuest}`;
            } else {
                scoreStr = `${ev.pointsHome}:*${ev.pointsGuest}*`;
            }
            eventLabel = "Tor"; // Use consistent label
            if (ev.event === 5) eventLabel = "7m-Tor";
            break;
        case 6: // 7-Meter Fehlwurf
            eventLabel = "7m-Fehlwurf";
            // Add team to detail string if player exists, otherwise detail is team
            detailStr = abbreviatedPlayer ? `${abbreviatedPlayer} (*${team}*)` : `*${team}*`;
            break;
        case 2: // Timeout Heim
        case 3: // Timeout Gast
            eventLabel = "Timeout";
            detailStr = `*${team}*`; // Detail is just the team
            break;
        case 8: // Zeitstrafe
        case 9: // Gelbe Karte
        case 11: // Rote Karte
             // Add team in parentheses if player exists, otherwise detail is team
            detailStr = abbreviatedPlayer ? `${abbreviatedPlayer} (*${team}*)` : `*${team}*`;
            break;
        // Ignored events
        case 0: case 1: case 15: case 17: case 14: case 16:
             return ""; // Skip these lines entirely

        default: // Fallback
             detailStr = ""; // No details for unknown events
             break;
    }

    // Construct the line: * Emoji (Time) | Event | Score | Detail
    return `* ${eventInfo.emoji} ${time} | ${scoreStr} | ${eventLabel} | ${detailStr}`;
}

// Export all functions needed by other modules
module.exports = {
    loadSeenTickers,
    saveSeenTickers,
    formatEvent, // For live mode and critical events
    loadScheduledTickers,
    saveScheduledTickers,
    formatRecapEventLine // For recap mode messages
};