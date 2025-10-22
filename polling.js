// polling.js
const axios = require('axios');
const puppeteer = require('puppeteer');
// Import utility functions, including those for saving/loading schedule data
const { saveSeenTickers, formatEvent, saveScheduledTickers, loadScheduledTickers } = require('./utils.js');
const { generateGameSummary } = require('./ai.js');

// --- SHARED STATE (Initialized by app.js) ---
let activeTickers, jobQueue, client, seenFilePath, scheduleFilePath;

// --- WORKER POOL CONFIG ---
let lastPolledIndex = -1; // Tracks the index of the last ticker polled by the scheduler (for round-robin)
let activeWorkers = 0; // Counts currently running Puppeteer instances
const MAX_WORKERS = 2; // Maximum number of concurrent Puppeteer instances allowed
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
 * Schedules a ticker based on the provided URL.
 * Fetches game metadata (start time, teams) using Puppeteer.
 * If the game is in the future, it saves the schedule and sets a timer to activate polling later.
 * If the game has already started, it activates polling immediately.
 * This function is exported as 'startPolling' for use by app.js.
 * @param {string} meetingPageUrl - The URL of the NuLiga live ticker webpage.
 * @param {string} chatId - The WhatsApp chat ID where the ticker runs.
 * @param {string} groupName - The name of the WhatsApp group (for AI).
 * @param {('live'|'recap')} mode - The desired ticker mode ('live' or 'recap').
 */
async function scheduleTicker(meetingPageUrl, chatId, groupName, mode) { // ** FIX: Added 'mode' parameter here **
    console.log(`[${chatId}] Ticker-Planung wird gestartet (Modus: ${mode}) für Gruppe: ${groupName}`);
    let browser = null; // Define browser outside try for robust cleanup
    try {
        // --- Step 1: Fetch game metadata using Puppeteer ---
        browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        // Promise to capture the first relevant API call triggered by the page's JavaScript
        const apiCallPromise = new Promise((resolve, reject) => {
            page.on('request', request => {
                if (request.url().includes('/nuScoreLiveRestBackend/api/1/meeting/')) resolve(request.url());
                request.continue();
            });
            setTimeout(() => reject(new Error('API-Request wurde nicht innerhalb von 30s abgefangen.')), 30000); // Failsafe timeout
        });
        // Navigate to the page and wait for network activity to settle
        await page.goto(meetingPageUrl, { waitUntil: 'networkidle0', timeout: 45000 });
        const capturedUrl = await apiCallPromise; // Get the URL intercepted by the promise
        await browser.close(); browser = null; // Close browser as soon as URL is captured

        // --- Step 2: Get game details via Axios ---
        const metaRes = await axios.get(capturedUrl);
        const gameData = metaRes.data;

        // --- Step 3: Calculate start time and delay ---
        const scheduledTime = new Date(gameData.scheduled); // API time is UTC
        const startTime = new Date(scheduledTime.getTime() - (PRE_GAME_START_MINUTES * 60000)); // Calculate when polling should start
        const delay = startTime.getTime() - Date.now(); // Milliseconds until polling should start
        const teamNames = { home: gameData.teamHome, guest: gameData.teamGuest };
        // Format times for user messages in local time
        const startTimeLocale = startTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const startDateLocale = startTime.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

        // --- Step 4: Create/Update ticker state in memory ---
        const tickerState = activeTickers.get(chatId) || { seen: new Set() }; // Get existing state or create a new one
        tickerState.meetingPageUrl = meetingPageUrl;
        tickerState.teamNames = teamNames;
        tickerState.groupName = groupName;
        tickerState.halftimeLength = gameData.halftimeLength;
        tickerState.mode = mode; // Store the chosen mode
        tickerState.recapMessages = []; // Initialize/clear recap message buffer
        activeTickers.set(chatId, tickerState); // Store the state in the map

        // --- Step 5: Schedule or start polling ---
        if (delay > 0) {
            // Game is in the future
            console.log(`[${chatId}] Spiel beginnt um ${scheduledTime.toLocaleString()}. Polling startet in ${Math.round(delay / 60000)} Minuten.`);
            const modeDescriptionScheduled = (mode === 'recap') ? "im Recap-Modus (5-Minuten-Zusammenfassungen)" : "mit Live-Updates";
            await client.sendMessage(chatId, `✅ Ticker für *${teamNames.home}* vs *${teamNames.guest}* ist geplant ${modeDescriptionScheduled} und startet automatisch am ${startDateLocale} um ca. ${startTimeLocale} Uhr.`);            
            tickerState.isPolling = false; // Not actively polling yet
            tickerState.isScheduled = true; // Mark as scheduled

            // Save the schedule information to the persistent file
            const currentSchedule = loadScheduledTickers(scheduleFilePath);
            currentSchedule[chatId] = {
                meetingPageUrl,
                startTime: startTime.toISOString(), // Save standardized time string
                groupName,
                halftimeLength: gameData.halftimeLength,
                mode
            };
            saveScheduledTickers(currentSchedule, scheduleFilePath);

            // Set the timer to activate polling later
            tickerState.scheduleTimeout = setTimeout(() => {
                beginActualPolling(chatId);
            }, delay);

        } else {
            // Game has already started (or start time is imminent)
            console.log(`[${chatId}] Spiel hat bereits begonnen. Starte Polling sofort (Modus: ${mode}).`);

            let startMessage = `▶️ Ticker für *${teamNames.home}* vs *${teamNames.guest}* wird sofort gestartet. `;
            if (mode === 'recap') {
                startMessage += `Du erhältst alle ${RECAP_INTERVAL_MINUTES} Minuten eine Zusammenfassung. 📬`;
            } else {
                startMessage += `Du erhältst alle Events live! ⚽`;
            }

            await client.sendMessage(chatId, startMessage);
            beginActualPolling(chatId); // Activate polling immediately
        }

    } catch (error) {
        // Handle errors during scheduling (e.g., website down, invalid URL)
        console.error(`[${chatId}] Fehler bei der Ticker-Planung:`, error.message);
        await client.sendMessage(chatId, 'Fehler: Konnte die Spieldaten nicht abrufen, um den Ticker zu planen.');
        if (browser) await browser.close(); // Ensure browser is closed on error
        activeTickers.delete(chatId); // Remove failed ticker state
    } finally {
        // Final safety check to ensure browser is closed
        if (browser) {
             console.warn(`[${chatId}] Browser-Instanz in scheduleTicker wurde notfallmäßig geschlossen.`);
             await browser.close();
        }
    }
}

/**
 * Activates the actual polling for a ticker.
 * Marks the ticker as 'polling', removes it from the schedule file,
 * starts the recap timer if needed, and adds the first job to the queue.
 * This is called either immediately by scheduleTicker or later by its setTimeout.
 * @param {string} chatId - The WhatsApp chat ID.
 */
function beginActualPolling(chatId) {
    const tickerState = activeTickers.get(chatId);
    if (!tickerState) {
        // Handle edge case where state might be missing (e.g., after manual file edit/deletion)
        console.warn(`[${chatId}] Ticker-Status nicht gefunden beim Versuch, das Polling zu starten.`);
        // Clean up from schedule file just in case
        const currentSchedule = loadScheduledTickers(scheduleFilePath);
         if (currentSchedule[chatId]) {
             delete currentSchedule[chatId];
             saveScheduledTickers(currentSchedule, scheduleFilePath);
         }
        return;
    }

    console.log(`[${chatId}] Aktiviere Polling (Modus: ${tickerState.mode}).`);
    tickerState.isPolling = true; // Mark as actively polling
    tickerState.isScheduled = false; // Mark as no longer just scheduled

    // Remove from the schedule file persistence
    const currentSchedule = loadScheduledTickers(scheduleFilePath);
    if (currentSchedule[chatId]) {
        delete currentSchedule[chatId];
        saveScheduledTickers(currentSchedule, scheduleFilePath);
        console.log(`[${chatId}] Aus Planungsdatei entfernt.`);
    }

    // Start the recap message timer ONLY if in recap mode
    if (tickerState.mode === 'recap') {
        if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId); // Clear old timer if any
        tickerState.recapIntervalId = setInterval(() => {
            sendRecapMessage(chatId);
        }, RECAP_INTERVAL_MINUTES * 60 * 1000); // Convert minutes to ms
        console.log(`[${chatId}] Recap-Timer gestartet (${RECAP_INTERVAL_MINUTES} min).`);
    }

    // Add the first polling job immediately to get initial data quickly
    // Use unshift to add it to the *front* of the queue for priority
    if (!jobQueue.some(job => job.chatId === chatId)) {
        jobQueue.unshift({ chatId, meetingPageUrl: tickerState.meetingPageUrl, tickerState, jobId: Date.now() });
    }
}

/**
 * Sends a recap message containing accumulated events for a specific chat.
 * Clears the message buffer after sending.
 * @param {string} chatId - The WhatsApp chat ID.
 */
async function sendRecapMessage(chatId) {
    const tickerState = activeTickers.get(chatId);
    // Check if the ticker is active and has messages to send
    if (!tickerState || !tickerState.isPolling || tickerState.recapMessages.length === 0) {
        return; // Nothing to do
    }

    console.log(`[${chatId}] Sende ${tickerState.recapMessages.length} Events im Recap.`);
    // Create a time range string for the recap title (approximate)
    const now = new Date();
    const startTime = new Date(now.getTime() - (RECAP_INTERVAL_MINUTES * 60000));
    const timeRange = `${startTime.toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'})} - ${now.toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'})}`;
    // Combine all stored messages into one block
    const recapText = tickerState.recapMessages.join('\n');

    try {
        await client.sendMessage(chatId, `📬 *Recap ${timeRange} Uhr*\n\n${recapText}`);
        tickerState.recapMessages = []; // Clear buffer after successful send
    } catch (error) {
        console.error(`[${chatId}] Fehler beim Senden der Recap-Nachricht:`, error);
        // Decide if messages should be kept on error. Currently clearing.
        tickerState.recapMessages = [];
    }
}

/**
 * Master Scheduler: Runs periodically (e.g., every 20s).
 * Selects the next active, polling ticker using round-robin.
 * Adds a job to the queue for the selected ticker if one doesn't already exist.
 * This ensures a constant overall polling rate regardless of the number of tickers.
 */
function masterScheduler() {
    // Get all tickers that are currently supposed to be polling
    const pollingTickers = Array.from(activeTickers.values()).filter(t => t.isPolling);
    if (pollingTickers.length === 0) return; // Exit if no tickers are active

    // Select the next ticker index in a circular fashion
    lastPolledIndex = (lastPolledIndex + 1) % pollingTickers.length;
    const tickerStateToPoll = pollingTickers[lastPolledIndex];
    // Find the chatId associated with this state object
    const chatId = [...activeTickers.entries()].find(([key, val]) => val === tickerStateToPoll)?.[0];

    // Add job only if polling and not already waiting in the queue
    if (chatId && tickerStateToPoll.isPolling && !jobQueue.some(job => job.chatId === chatId)) {
        jobQueue.push({ chatId, meetingPageUrl: tickerStateToPoll.meetingPageUrl, tickerState: tickerStateToPoll, jobId: Date.now() });
        console.log(`[${chatId}] Job zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
    }
}

/**
 * Dispatcher Loop: Runs frequently (e.g., every 0.5s).
 * Checks if there are jobs in the queue and if a worker slot is available.
 * If both conditions are met, it takes a job from the queue and starts a worker.
 */
function dispatcherLoop() {
    // Check conditions: queue not empty AND worker slots available
    if (jobQueue.length > 0 && activeWorkers < MAX_WORKERS) {
        activeWorkers++; // Increment count *before* starting async worker
        const job = jobQueue.shift(); // Get the oldest job
        runWorker(job); // Start the worker task (don't await it here)
    }
}

/**
 * Executes a single polling job using Puppeteer.
 * This is the resource-intensive part: launches a browser, navigates, intercepts data.
 * Fetches event data via Axios if a new version is detected.
 * Calls processEvents to handle the results.
 * Manages execution timing and ensures worker slot is freed.
 * @param {object} job - The job object containing chatId, URL, and tickerState.
 */
async function runWorker(job) {
    const { chatId, tickerState, jobId } = job;
    const timerLabel = `[${chatId}] Job ${jobId} Execution Time`;
    console.time(timerLabel); // Start measuring execution time
    let browser = null; // Define browser outside try for robust cleanup

    // Double-check if ticker is still valid and polling
    if (!tickerState || !tickerState.isPolling) {
        console.log(`[${chatId}] Job ${jobId} wird übersprungen, da der Ticker gestoppt wurde oder nicht existiert.`);
    } else {
        console.log(`[${chatId}] Worker startet Job ${jobId}. Verbleibende Jobs: ${jobQueue.length}. Aktive Worker: ${activeWorkers}`);
        try {
            // --- Step 1: Launch Puppeteer & Navigate ---
            browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
            const page = await browser.newPage();
            await page.setRequestInterception(true);
            // Promise to intercept the specific API call
            const apiCallPromise = new Promise((resolve, reject) => {
                page.on('request', request => {
                    if (request.url().includes('/nuScoreLiveRestBackend/api/1/meeting/')) resolve(request.url());
                    request.continue();
                });
                setTimeout(() => reject(new Error('API-Request wurde nicht innerhalb von 30s abgefangen.')), 30000);
            });
            await page.goto(job.meetingPageUrl, { waitUntil: 'networkidle0', timeout: 45000 });
            const capturedUrl = await apiCallPromise;
            await browser.close(); browser = null; // Close browser

            // --- Step 2: Extract Info & Get Metadata via Axios ---
            const meetingApiRegex = /api\/1\/meeting\/(\d+)\/time\/(\d+)/;
            const apiMatch = capturedUrl.match(meetingApiRegex);
            if (!apiMatch) throw new Error("Konnte Meeting ID nicht aus URL extrahieren.");
            const meetingId = apiMatch[1];

            const metaRes = await axios.get(capturedUrl);
            // Update state if team names or halftime length were missing (e.g., after restart)
            if (!tickerState.teamNames && metaRes.data.teamHome) {
                tickerState.teamNames = { home: metaRes.data.teamHome, guest: metaRes.data.teamGuest };
                 if (!tickerState.isScheduled) { // Only send "aktiv" if not just scheduled
                     await client.sendMessage(chatId, `*${tickerState.teamNames.home}* vs. *${tickerState.teamNames.guest}* - Ticker aktiv!`);
                 }
            }
             if (!tickerState.halftimeLength && metaRes.data.halftimeLength) {
                 tickerState.halftimeLength = metaRes.data.halftimeLength;
             }

            // --- Step 3: Check for New Version and Fetch Events ---
            const versionUid = metaRes.data.versionUid;
            if (versionUid && versionUid !== tickerState.lastVersionUid) {
                console.log(`[${chatId}] Neue Version erkannt: ${versionUid}`);
                tickerState.lastVersionUid = versionUid; // Update last seen version
                const eventsUrl = `https:\/\/hbde-live.liga.nu/nuScoreLiveRestBackend/api/1/events/${meetingId}/versions/${versionUid}`;
                const eventsRes = await axios.get(eventsUrl);

                // --- Step 4: Process Events ---
                // Pass seenFilePath so processEvents can trigger saving
                if (await processEvents(eventsRes.data, tickerState, chatId)) {
                    // Save the 'seen' state only if new events were actually processed
                    saveSeenTickers(activeTickers, seenFilePath);
                }
            } else {
                 console.log(`[${chatId}] Keine neue Version erkannt (${versionUid}).`);
            }
        } catch (error) {
            // Log errors during the job execution
            console.error(`[${chatId}] Fehler im Worker-Job ${jobId}:`, error.message);
            // Ensure browser is closed even if an error occurred mid-process
            if (browser) await browser.close();
        }
    }

    // --- Step 5: Cleanup ---
    console.timeEnd(timerLabel); // Stop measuring execution time
    activeWorkers--; // Free up this worker slot
}

/**
 * Processes the array of events received from the API.
 * Iterates through events, checks if seen, formats message based on mode,
 * sends/stores messages, handles game end (AI summary, final msg, cleanup).
 * @param {object} data - The API response containing the events array.
 * @param {object} tickerState - The state object for the specific ticker.
 * @param {string} chatId - The WhatsApp chat ID.
 * @returns {boolean} - True if new, unseen events were processed, false otherwise.
 */
async function processEvents(data, tickerState, chatId) {
    if (!data || !Array.isArray(data.events)) return false;
    let newUnseenEventsProcessed = false; // Flag to check if any work was done
    // Sort events by index just in case API order isn't guaranteed
    const events = data.events.slice().sort((a, b) => a.idx - b.idx);

    for (const ev of events) {
        // Skip events already processed
        if (tickerState.seen.has(ev.idx)) continue;

        // Format the event message using the function from utils.js
        const msg = formatEvent(ev, tickerState);
        tickerState.seen.add(ev.idx); // Mark event as seen *before* sending attempt
        newUnseenEventsProcessed = true; // A new event was found

        // --- Handle Sending / Storing based on mode ---
        if (msg) { // Only proceed if formatEvent returned a non-empty string
            // Always send critical events (start, half, end) immediately
            if (ev.event === 14 || ev.event === 16 || ev.event === 15) {
                console.log(`[${chatId}] Sende kritisches Event sofort:`, msg);
                try { await client.sendMessage(chatId, msg); }
                catch (e) { console.error(`[${chatId}] Fehler beim Senden kritischer Nachricht: `, e); }
            }
            // Live mode: send immediately
            else if (tickerState.mode === 'live') {
                console.log(`[${chatId}] Sende neues Event (Live):`, msg);
                 try { await client.sendMessage(chatId, msg); }
                 catch (e) { console.error(`[${chatId}] Fehler beim Senden Live-Nachricht: `, e); }
            }
            // Recap mode: store message in buffer
            else if (tickerState.mode === 'recap') {
                console.log(`[${chatId}] Speichere Event für Recap:`, msg);
                tickerState.recapMessages.push(msg);
            }
        }

        // --- Handle Game End ---
        if (ev.event === 16) {
            console.log(`[${chatId}] Spielende-Event empfangen. Ticker wird gestoppt.`);
            tickerState.isPolling = false; // Stop scheduler from adding new jobs
            if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId); // Stop recap timer

            // Send any remaining recap messages immediately
            if (tickerState.mode === 'recap' && tickerState.recapMessages.length > 0) {
                 console.log(`[${chatId}] Sende letzten Recap bei Spielende.`);
                 await sendRecapMessage(chatId); // Use await to ensure it sends before AI/final
            }

            // Remove any pending job from the queue (shouldn't exist due to smart queue, but belt-and-suspenders)
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);

            // Generate and send AI summary
            try {
                const summary = await generateGameSummary(events, tickerState.teamNames, tickerState.groupName, tickerState.halftimeLength);
                if (summary) await client.sendMessage(chatId, summary);
            } catch (e) { console.error(`[${chatId}] Fehler beim Senden der AI-Zusammenfassung:`, e); }

            // Send the final "Thank you" message after a short delay
            setTimeout(async () => {
                const finalMessage = "Vielen Dank fürs Mitfiebern! 🥳\n\nDen Quellcode für diesen Bot könnt ihr hier einsehen:\nhttps://github.com/nambatu/whatsapp-liveticker-bot/";
                try { await client.sendMessage(chatId, finalMessage); }
                catch (e) { console.error(`[${chatId}] Fehler beim Senden der Abschlussnachricht: `, e); }
            }, 2000); // 2 second delay

            // Schedule the automatic cleanup of seen events and state after 1 hour
            console.log(`[${chatId}] Automatische Bereinigung in 1 Stunde geplant.`);
            setTimeout(() => {
                if (activeTickers.has(chatId)) { // Check if still exists (wasn't manually reset)
                    activeTickers.delete(chatId);
                    saveSeenTickers(activeTickers, seenFilePath); // Pass path
                    console.log(`[${chatId}] Ticker-Daten automatisch bereinigt.`);
                }
            }, 3600000); // 1 hour in milliseconds
            break; // Stop processing further events after game end
        }
    }
    // Return true if any *new* event was processed in this batch
    return newUnseenEventsProcessed;
}

// Export the functions needed by app.js
module.exports = {
    initializePolling,
    masterScheduler,
    dispatcherLoop,
    startPolling: scheduleTicker, // Export scheduleTicker under the alias startPolling
    beginActualPolling // Also export this for rescheduling on startup
};