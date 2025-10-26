// polling.js
const axios = require('axios');
const puppeteer = require('puppeteer');
// Import utility functions, including those for saving/loading schedule data and formatting
const { saveSeenTickers, formatEvent, saveScheduledTickers, loadScheduledTickers, formatRecapEventLine } = require('./utils.js');
const { generateGameSummary, extractGameStats } = require('./ai.js'); // Import AI functions
const { EVENT_MAP } = require('./config.js'); // Import event definitions


// --- SHARED STATE (Initialized by app.js) ---
let activeTickers, jobQueue, client, seenFilePath, scheduleFilePath;

// --- WORKER POOL CONFIG ---
let lastPolledIndex = -1; // Tracks the index of the last ticker polled by the scheduler (for round-robin)
let activeWorkers = 0; // Counts currently running Puppeteer instances
const MAX_WORKERS = 1; // Tunable: Maximum number of concurrent Puppeteer instances allowed
const PRE_GAME_START_MINUTES = 5; // How many minutes before scheduled start time to begin active polling
const RECAP_INTERVAL_MINUTES = 5; // Frequency of sending recap messages in 'recap' mode

/**
 * Initializes the polling module with shared state variables from app.js.
 * This function must be called once when the bot starts.
 * @param {Map} tickers - The Map storing active ticker states (passed by reference).
 * @param {Array} queue - The array acting as the job queue (passed by reference).
 * @param {Client} whatsappClient - The initialized whatsapp-web.js client instance.
 * @param {string} seenFile - The file path for saving seen event IDs.
 * @param {string} scheduleFile - The file path for saving scheduled tickers.
 */
function initializePolling(tickers, queue, whatsappClient, seenFile, scheduleFile) {
    activeTickers = tickers;
    jobQueue = queue;
    client = whatsappClient;
    seenFilePath = seenFile;
    scheduleFilePath = scheduleFile;
}

/**
 * Creates the initial ticker state and adds a 'schedule' job to the queue.
 * This is the entry point called by the !start command. It offloads the
 * heavy Puppeteer work to the worker queue.
 * @param {string} meetingPageUrl - The URL of the NuLiga live ticker webpage.
 * @param {string} chatId - The WhatsApp chat ID where the ticker runs.
 * @param {string} groupName - The name of the WhatsApp group (for AI).
 * @param {('live'|'recap')} mode - The desired ticker mode ('live' or 'recap').
 */
async function queueTickerScheduling(meetingPageUrl, chatId, groupName, mode) {
    // Validate the URL format early
    const urlRegex = /https:\/\/hbde-live\.liga\.nu\/nuScoreLive\/#\/groups\/\d+\/meetings\/\d+/;
    if (!urlRegex.test(meetingPageUrl)) {
        await client.sendMessage(chatId, 'Fehler: Die angegebene URL ist keine gültige Live-Ticker-Seiten-URL.');
        return;
    }

    // Create initial state in memory
    const tickerState = activeTickers.get(chatId) || { seen: new Set() };
    tickerState.isPolling = false; // Not polling yet
    tickerState.isScheduling = true; // Mark as *being* scheduled
    tickerState.meetingPageUrl = meetingPageUrl;
    tickerState.groupName = groupName;
    tickerState.mode = mode;
    tickerState.recapEvents = []; // Initialize array for raw recap events
    activeTickers.set(chatId, tickerState); // Store the initial state

    // Add a 'schedule' job to the queue for the worker
    jobQueue.push({
        type: 'schedule', // Job type identifier
        chatId,
        meetingPageUrl,
        // Pass necessary info for the worker to complete scheduling
        groupName, // Needed for logging/AI if fetch fails before state is fully set
        mode,
        jobId: Date.now() // Unique ID for logging
    });

    console.log(`[${chatId}] Planungs-Job zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
    // Send immediate feedback to the user
    await client.sendMessage(chatId, `⏳ Ticker-Planung für "${groupName}" wird bearbeitet...`);
}


/**
 * Activates the actual polling loop for a ticker.
 * Marks the ticker as 'polling', removes it from the schedule file,
 * starts the recap timer if needed, and adds the initial 'poll' job to the queue.
 * Called either after a schedule timer fires, or directly by the worker if game already started.
 * @param {string} chatId - The WhatsApp chat ID.
 */
async function beginActualPolling(chatId) {
    const tickerState = activeTickers.get(chatId);
    // Safety checks
    if (!tickerState) {
        console.warn(`[${chatId}] Ticker-Status nicht gefunden beim Versuch, das Polling zu starten.`);
        const currentSchedule = loadScheduledTickers(scheduleFilePath);
         if (currentSchedule[chatId]) {
             delete currentSchedule[chatId];
             saveScheduledTickers(currentSchedule, scheduleFilePath);
             console.log(`[${chatId}] Überreste aus Planungsdatei entfernt.`);
         }
        return;
    }
    if (tickerState.isPolling) {
        console.log(`[${chatId}] Polling ist bereits aktiv.`);
        return;
    }

    console.log(`[${chatId}] Aktiviere Polling (Modus: ${tickerState.mode}).`);
    tickerState.isPolling = true; // Mark as actively polling
    tickerState.isScheduled = false; // No longer just scheduled

    // Remove from the schedule file persistence
    const currentSchedule = loadScheduledTickers(scheduleFilePath);
    if (currentSchedule[chatId]) {
        delete currentSchedule[chatId]; // ** Remove the entry **
        saveScheduledTickers(currentSchedule, scheduleFilePath); // ** Save the updated file **
        console.log(`[${chatId}] Aus Planungsdatei entfernt.`);
    }

    // --- Send Emoji Legend (Only in Recap Mode) ---
    if (tickerState.mode === 'recap') { // Check the mode
        try {
            let legendMessage = "ℹ️ *Ticker-Legende:*\n";
            // Iterate through EVENT_MAP to build the legend
            for (const key in EVENT_MAP) {
                // Ensure EVENT_MAP is accessible here, might need import if moved
                const eventDetails = EVENT_MAP[key]; // Assuming EVENT_MAP is accessible
                // Include only relevant, user-facing events
                if ([0, 1, 2, 15, 16, 17].includes(parseInt(key))) continue; // Skip internal/start events
                legendMessage += `${eventDetails.emoji} = ${eventDetails.label}\n`;
            }
            await client.sendMessage(chatId, legendMessage.trim()); // Send the constructed legend
            console.log(`[${chatId}] Emoji-Legende gesendet (Recap-Modus).`);
        } catch (error) {
            console.error(`[${chatId}] Fehler beim Senden der Legende:`, error);
        }
    }
    // --- End Legend ---

    // Start the recap message timer ONLY if in recap mode
    if (tickerState.mode === 'recap') {
        if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId); // Clear old timer if any
        tickerState.recapIntervalId = setInterval(() => {
            sendRecapMessage(chatId);
        }, RECAP_INTERVAL_MINUTES * 60 * 1000); // Convert minutes to ms
        console.log(`[${chatId}] Recap-Timer gestartet (${RECAP_INTERVAL_MINUTES} min).`);
    }

    // Add the *first* polling job immediately for a quick initial update
    // Use unshift to add to the front of the queue
    if (!jobQueue.some(job => job.chatId === chatId && job.type === 'poll')) {
        jobQueue.unshift({
            type: 'poll', // Mark as a polling job
            chatId,
            meetingPageUrl: tickerState.meetingPageUrl, // Get URL from state
            tickerState: tickerState, // Pass the current state reference
            jobId: Date.now() // Unique ID for timing/logging
        });
    }
}

/**
 * Sends a recap message containing accumulated events for a specific chat.
 * Formats the events using formatRecapEventLine and clears the buffer.
 * Calculates game time range for the recap title.
 * @param {string} chatId - The WhatsApp chat ID.
 */
async function sendRecapMessage(chatId) {
    const tickerState = activeTickers.get(chatId);
    // Only proceed if ticker is active and has events stored
    if (!tickerState || !tickerState.isPolling || !tickerState.recapEvents || tickerState.recapEvents.length === 0) {
        if (tickerState && tickerState.recapEvents) tickerState.recapEvents = []; // Clear buffer defensively
        return; // Nothing to do
    }

    console.log(`[${chatId}] Sende ${tickerState.recapEvents.length} Events im Recap.`);

    // --- Calculate Game Time Range ---
    tickerState.recapEvents.sort((a, b) => a.second - b.second); // Ensure order
    const firstEventSecond = tickerState.recapEvents[0].second;
    const lastEventSecond = tickerState.recapEvents[tickerState.recapEvents.length - 1].second;
    const startMinute = Math.floor(firstEventSecond / 60);
    const endMinute = Math.ceil(lastEventSecond / 60);
    const timeRangeTitle = `Minute ${startMinute} - ${endMinute}`;

    // --- Build Recap Body ---
    // Format each stored raw event object into a string line using the specific recap formatter
    const recapLines = tickerState.recapEvents.map(ev => formatRecapEventLine(ev, tickerState));
    // Filter out potential empty lines from ignored event types
    const validLines = recapLines.filter(line => line && line.trim() !== '');

    if (validLines.length === 0) {
        console.log(`[${chatId}] Keine gültigen Events zum Senden im Recap gefunden.`);
        tickerState.recapEvents = []; // Clear buffer anyway
        return;
    }

    // --- Construct Final Message ---
    const teamHeader = `*${tickerState.teamNames.home}* : *${tickerState.teamNames.guest}*`;
    const recapBody = validLines.join('\n'); // Join lines with newline
    const finalMessage = `📬 *Recap ${timeRangeTitle}*\n\n${teamHeader}\n${recapBody}`; // Final recap message format

    try {
        await client.sendMessage(chatId, finalMessage);
        tickerState.recapEvents = []; // Clear buffer after successful send
    } catch (error) {
        console.error(`[${chatId}] Fehler beim Senden der Recap-Nachricht:`, error);
        tickerState.recapEvents = []; // Clear buffer even on error
    }
}

/**
 * Master Scheduler: Runs periodically (e.g., every 20s).
 * Selects the next active, polling ticker using round-robin.
 * Adds a 'poll' job to the queue if one doesn't already exist for that ticker.
 * This controls the overall rate of polling attempts across all tickers.
 */
function masterScheduler() {
    // Only consider tickers that are actively polling
    const pollingTickers = Array.from(activeTickers.values()).filter(t => t.isPolling);
    if (pollingTickers.length === 0) return; // Exit if none are active

    // Round-robin selection
    lastPolledIndex = (lastPolledIndex + 1) % pollingTickers.length;
    const tickerStateToPoll = pollingTickers[lastPolledIndex];
    // Find the chatId for the selected state
    const chatId = [...activeTickers.entries()].find(([key, val]) => val === tickerStateToPoll)?.[0];

    // Add a 'poll' job only if the ticker is valid and not already waiting in the queue
    if (chatId && tickerStateToPoll.isPolling && !jobQueue.some(job => job.chatId === chatId && job.type === 'poll')) {
        jobQueue.push({
             type: 'poll',
             chatId,
             meetingPageUrl: tickerStateToPoll.meetingPageUrl,
             tickerState: tickerStateToPoll, // Pass the state reference
             jobId: Date.now()
        });
        console.log(`[${chatId}] Poll-Job zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
    }
}

/**
 * Dispatcher Loop: Runs frequently (e.g., every 0.5s).
 * Checks if there are jobs in the queue and if a worker slot is available (activeWorkers < MAX_WORKERS).
 * If conditions met, takes a job and starts a worker process asynchronously.
 */
function dispatcherLoop() {
    if (jobQueue.length > 0 && activeWorkers < MAX_WORKERS) {
        activeWorkers++; // Reserve a worker slot
        const job = jobQueue.shift(); // Get the oldest job
        runWorker(job); // Start the worker (async, don't await)
    }
}

/**
 * Executes a single job (either 'schedule' or 'poll') using Puppeteer/Axios.
 * This function performs the resource-intensive browser launch and data fetching.
 * It differentiates logic based on the job type.
 * @param {object} job - The job object from the queue (contains type, chatId, etc.).
 */
async function runWorker(job) {
    const { chatId, jobId, type } = job;
    const tickerState = activeTickers.get(chatId); // Get current state from map
    const timerLabel = `[${chatId}] Job ${jobId} (${type}) Execution Time`;
    console.time(timerLabel); // Start timing
    let browser = null; // Define outside try for robust cleanup

    // --- Pre-execution Check ---
    // Verify the ticker is still valid and in the expected state for this job type
    if (!tickerState || (type === 'poll' && !tickerState.isPolling) || (type === 'schedule' && !tickerState.isScheduling)) {
        console.log(`[${chatId}] Job ${jobId} (${type}) wird übersprungen, da Ticker-Status ungültig oder geändert.`);
        activeWorkers--; // Free worker slot immediately since job is skipped
        console.timeEnd(timerLabel);
        return;
    }

    console.log(`[${chatId}] Worker startet Job ${jobId} (${type}). Verbleibende Jobs: ${jobQueue.length}. Aktive Worker: ${activeWorkers}`);

    try {
        // --- Puppeteer Phase (Common for both job types) ---
        browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        const apiCallPromise = new Promise((resolve, reject) => {
             page.on('request', request => {
                 if (request.url().includes('/nuScoreLiveRestBackend/api/1/meeting/')) resolve(request.url());
                 request.continue();
             });
             setTimeout(() => reject(new Error('API-Request wurde nicht innerhalb von 120s abgefangen.')), 12000);
        });
        await page.goto(job.meetingPageUrl, { waitUntil: 'networkidle0', timeout: 90000 });
        const capturedUrl = await apiCallPromise;
        await browser.close(); browser = null; // Close browser

        // --- Axios Phase & Job-Specific Logic ---
        const metaRes = await axios.get(capturedUrl);
        const gameData = metaRes.data;

        // --- Logic for 'schedule' job ---
        if (type === 'schedule') {
            const scheduledTime = new Date(gameData.scheduled);
            const startTime = new Date(scheduledTime.getTime() - (PRE_GAME_START_MINUTES * 60000));
            const delay = startTime.getTime() - Date.now();
            const teamNames = { home: gameData.teamHome, guest: gameData.teamGuest };
            const startTimeLocale = startTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
            const startDateLocale = startTime.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

            tickerState.teamNames = teamNames;
            tickerState.halftimeLength = gameData.halftimeLength;

            if (delay > 0) { // Still in future
                console.log(`[${chatId}] Planungs-Job erfolgreich...`);
                const modeDescriptionScheduled = (tickerState.mode === 'recap') ? `im Recap-Modus (${RECAP_INTERVAL_MINUTES}-Minuten-Zusammenfassungen)` : "mit Live-Updates";
                await client.sendMessage(chatId, `✅ Ticker für *${teamNames.home}* vs *${teamNames.guest}* ist geplant (${modeDescriptionScheduled}) und startet automatisch am ${startDateLocale} um ca. ${startTimeLocale} Uhr.`);                tickerState.isPolling = false; tickerState.isScheduled = true;
                const currentSchedule = loadScheduledTickers(scheduleFilePath);
                // ** Save schedule data **
                currentSchedule[chatId] = {
                    meetingPageUrl: job.meetingPageUrl,
                    startTime: startTime.toISOString(),
                    groupName: tickerState.groupName,
                    halftimeLength: tickerState.halftimeLength,
                    mode: tickerState.mode
                };
                saveScheduledTickers(currentSchedule, scheduleFilePath);
                tickerState.scheduleTimeout = setTimeout(() => beginActualPolling(chatId), delay);
            } else { // Already started
                console.log(`[${chatId}] Planungs-Job erfolgreich. Spiel beginnt sofort...`);
                let startMessage = `▶️ Ticker für *${teamNames.home}* vs *${teamNames.guest}* wird sofort gestartet. `;
                startMessage += (tickerState.mode === 'recap') ? `Du erhältst alle ${RECAP_INTERVAL_MINUTES} Minuten eine Zusammenfassung. 📬` : `Du erhältst alle Events live! ⚽`;
                await client.sendMessage(chatId, startMessage);
                tickerState.isScheduling = false;
                beginActualPolling(chatId);
            }
        }
        // --- Logic for 'poll' job ---
        else if (type === 'poll') {
             if (!tickerState.teamNames && gameData.teamHome) { tickerState.teamNames = { home: gameData.teamHome, guest: gameData.teamGuest }; }
             if (!tickerState.halftimeLength && gameData.halftimeLength) { tickerState.halftimeLength = gameData.halftimeLength; }

            const versionUid = gameData.versionUid;
            if (versionUid && versionUid !== tickerState.lastVersionUid) {
                console.log(`[${chatId}] Neue Version erkannt: ${versionUid}`);
                tickerState.lastVersionUid = versionUid;
                const meetingApiRegex = /api\/1\/meeting\/(\d+)\/time\/(\d+)/;
                const apiMatch = capturedUrl.match(meetingApiRegex);
                if (!apiMatch) throw new Error("Konnte Meeting ID nicht aus URL extrahieren für Events-Abruf.");
                const meetingId = apiMatch[1];
                const eventsUrl = `https:\/\/hbde-live.liga.nu/nuScoreLiveRestBackend/api/1\/events/${meetingId}/versions/${versionUid}`;
                const eventsRes = await axios.get(eventsUrl);
                if (await processEvents(eventsRes.data, tickerState, chatId)) {
                    saveSeenTickers(activeTickers, seenFilePath);
                }
            } else {
                 console.log(`[${chatId}] Keine neue Version erkannt (${versionUid || 'N/A'}).`);
            }
        }
    } catch (error) {
        console.error(`[${chatId}] Fehler im Worker-Job ${jobId} (${type}):`, error.message);
        if (type === 'schedule') {
             await client.sendMessage(chatId, 'Fehler: Die initiale Planung des Tickers ist fehlgeschlagen. Bitte versuchen Sie es erneut.');
             activeTickers.delete(chatId);
             const currentSchedule = loadScheduledTickers(scheduleFilePath);
             if (currentSchedule[chatId]) {
                 delete currentSchedule[chatId];
                 saveScheduledTickers(currentSchedule, scheduleFilePath);
             }
        }
        if (browser) await browser.close();
    } finally {
        console.timeEnd(timerLabel);
        activeWorkers--;
    }
}

/**
 * Processes events, handles modes, calls AI, sends final stats, schedules cleanup.
 */
async function processEvents(data, tickerState, chatId) {
    if (!data || !Array.isArray(data.events)) return false;
    let newUnseenEventsProcessed = false;
    const events = data.events.slice().sort((a, b) => a.idx - b.idx);

    for (const ev of events) {
        if (tickerState.seen.has(ev.idx)) continue;

        const msg = formatEvent(ev, tickerState);
        tickerState.seen.add(ev.idx);
        newUnseenEventsProcessed = true;

        if (msg) {
             try { // Wrap message sending in try...catch
                if (ev.event === 14 || ev.event === 16 || ev.event === 15) { // Critical events
                    console.log(`[${chatId}] Sende kritisches Event sofort:`, msg);
                    await client.sendMessage(chatId, msg);
                } else if (tickerState.mode === 'live') { // Live mode
                    console.log(`[${chatId}] Sende neues Event (Live):`, msg);
                    await client.sendMessage(chatId, msg);
                } else if (tickerState.mode === 'recap') { // Recap mode
                    console.log(`[${chatId}] Speichere Event-Objekt für Recap (ID: ${ev.idx}, Typ: ${ev.event})`);
                    tickerState.recapEvents = tickerState.recapEvents || [];
                    tickerState.recapEvents.push(ev);
                }
             } catch (sendError) {
                 console.error(`[${chatId}] Fehler beim Senden der Nachricht für Event ${ev.idx}:`, sendError);
             }
        }

        if (ev.event === 16) { // Game End
            console.log(`[${chatId}] Spielende-Event empfangen...`);
            tickerState.isPolling = false;
            if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId);

            if (tickerState.mode === 'recap' && tickerState.recapEvents && tickerState.recapEvents.length > 0) {
                 await sendRecapMessage(chatId);
            }

            const index = jobQueue.findIndex(job => job.chatId === chatId); if (index > -1) jobQueue.splice(index, 1);

            // --- Send Final Stats ---
            try {
                const gameStats = extractGameStats(events, tickerState.teamNames);
                const statsMessage = `📊 *Statistiken zum Spiel:*\n` +
                     `\n` +
                     `*Topscorer (${tickerState.teamNames.home}):* ${gameStats.homeTopScorer}\n` +
                     `*Topscorer (${tickerState.teamNames.guest}):* ${gameStats.guestTopScorer}\n` +
                     `*7-Meter (${tickerState.teamNames.home}):* ${gameStats.homeSevenMeters}\n` +
                     `*7-Meter (${tickerState.teamNames.guest}):* ${gameStats.guestSevenMeters}\n` +
                     `*Zeitstrafen (${tickerState.teamNames.home}):* ${gameStats.homePenalties}\n` +
                     `*Zeitstrafen (${tickerState.teamNames.guest}):* ${gameStats.guestPenalties}`;                
                     setTimeout(async () => {
                     try { await client.sendMessage(chatId, statsMessage); }
                     catch(e) { console.error(`[${chatId}] Fehler beim Senden der Spielstatistiken:`, e); }
                }, 1000);
            } catch (e) { console.error(`[${chatId}] Fehler beim Erstellen der Spielstatistiken:`, e); }

            // --- Send AI Summary ---
            try {
                const summary = await generateGameSummary(events, tickerState.teamNames, tickerState.groupName, tickerState.halftimeLength);
                setTimeout(async () => {
                     if (summary) {
                         try { await client.sendMessage(chatId, summary); }
                         catch(e) { console.error(`[${chatId}] Fehler beim Senden der AI-Zusammenfassung:`, e); }
                     }
                }, 2000); // Delay AI summary slightly after stats
            } catch (e) { console.error(`[${chatId}] Fehler beim Generieren der AI-Zusammenfassung:`, e); }

            // --- Send Final Bot Message ---
            setTimeout(async () => {
            const finalMessage = "Vielen Dank fürs Mitfiebern! 🥳\n\nDen Quellcode für diesen Bot könnt ihr hier einsehen:\nhttps://github.com/nambatu/whatsapp-liveticker-bot/";                
            try { await client.sendMessage(chatId, finalMessage); }
                catch (e) { console.error(`[${chatId}] Fehler beim Senden der Abschlussnachricht: `, e); }
            }, 4000); // Delay final message after AI summary

            // --- Schedule Cleanup ---
            setTimeout(() => {
                if (activeTickers.has(chatId)) {
                    activeTickers.delete(chatId);
                    saveSeenTickers(activeTickers, seenFilePath);
                    console.log(`[${chatId}] Ticker-Daten automatisch bereinigt.`);
                }
            }, 3600000);
            break;
        }
    }
    return newUnseenEventsProcessed;
}

// --- Exports ---
module.exports = {
    initializePolling,
    masterScheduler,
    dispatcherLoop,
    startPolling: queueTickerScheduling, // Export queueTickerScheduling as startPolling
    beginActualPolling
};