// polling.js
const axios = require('axios');
const puppeteer = require('puppeteer');
const { saveSeenTickers, formatEvent, saveScheduledTickers, loadScheduledTickers } = require('./utils.js');
const { generateGameSummary, extractGameStats } = require('./ai.js');

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
 * Schedules a ticker. Fetches game metadata, determines start time,
 * saves the schedule if the game is in the future, and sets a timer
 * to begin polling later, or starts polling immediately if the game already started.
 * This function is exported as 'startPolling' for use by app.js.
 * @param {string} meetingPageUrl - The URL of the NuLiga live ticker webpage.
 * @param {string} chatId - The WhatsApp chat ID where the ticker runs.
 * @param {string} groupName - The name of the WhatsApp group (for AI).
 * @param {('live'|'recap')} mode - The desired ticker mode ('live' or 'recap').
 */
async function scheduleTicker(meetingPageUrl, chatId, groupName, mode) {
    console.log(`[${chatId}] Ticker-Planung wird gestartet (Modus: ${mode}) für Gruppe: ${groupName}`);
    let browser = null;
    try {
        // --- Fetch game metadata using Puppeteer ---
        browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        const apiCallPromise = new Promise((resolve, reject) => {
            page.on('request', request => {
                if (request.url().includes('/nuScoreLiveRestBackend/api/1/meeting/')) resolve(request.url());
                request.continue();
            });
            setTimeout(() => reject(new Error('API-Request wurde nicht innerhalb von 30s abgefangen.')), 30000); // Failsafe timeout
        });
        await page.goto(meetingPageUrl, { waitUntil: 'networkidle0', timeout: 45000 });
        const capturedUrl = await apiCallPromise;
        await browser.close(); browser = null; // Close browser ASAP

        // --- Get game details via Axios ---
        const metaRes = await axios.get(capturedUrl);
        const gameData = metaRes.data;

        // --- Calculate start time and delay ---
        const scheduledTime = new Date(gameData.scheduled); // API time is UTC
        const startTime = new Date(scheduledTime.getTime() - (PRE_GAME_START_MINUTES * 60000)); // Calculate when polling should start
        const delay = startTime.getTime() - Date.now(); // Milliseconds until polling should start
        const teamNames = { home: gameData.teamHome, guest: gameData.teamGuest };
        // Format times for user messages in local time
        const startTimeLocale = startTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const startDateLocale = startTime.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

        // --- Create/Update ticker state in memory ---
        const tickerState = activeTickers.get(chatId) || { seen: new Set() }; // Get existing state or create a new one
        tickerState.meetingPageUrl = meetingPageUrl;
        tickerState.teamNames = teamNames;
        tickerState.groupName = groupName;
        tickerState.halftimeLength = gameData.halftimeLength;
        tickerState.mode = mode; // Store the chosen mode
        tickerState.recapMessages = []; // Initialize/clear recap message buffer
        activeTickers.set(chatId, tickerState); // Store the state in the map

        // --- Schedule or start polling ---
        if (delay > 0) {
            // Game is in the future
            console.log(`[${chatId}] Spiel beginnt um ${scheduledTime.toLocaleString()}. Polling startet in ${Math.round(delay / 60000)} Minuten.`);
            await client.sendMessage(chatId, `✅ Ticker für *${teamNames.home}* vs *${teamNames.guest}* ist geplant (Modus: ${mode}) und startet automatisch am ${startDateLocale} um ca. ${startTimeLocale} Uhr.`);
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
            await client.sendMessage(chatId, `▶️ Ticker für *${teamNames.home}* vs *${teamNames.guest}* wird sofort gestartet (Modus: ${mode}).`);
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
 * Activates the actual polling loop for a given chat ID.
 * Sets the ticker state to 'polling', removes it from the schedule file,
 * starts the recap timer if needed, and adds the initial job to the queue.
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

    // Ensure it's not already marked as polling (safety check)
    if (tickerState.isPolling) {
        console.log(`[${chatId}] Polling ist bereits aktiv.`);
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
    if (!jobQueue.some(job => job.chatId === chatId && job.type !== 'schedule')) {
        jobQueue.unshift({
            type: 'poll', // Explicitly mark as polling job
            chatId,
            meetingPageUrl: tickerState.meetingPageUrl,
            tickerState,
            jobId: Date.now()
        });
    }
}

// polling.js

/**
 * Sends a recap message containing accumulated events for a specific chat.
 * Clears the message buffer after sending. Calculates game time range.
 * @param {string} chatId - The WhatsApp chat ID.
 */
async function sendRecapMessage(chatId) {
    const tickerState = activeTickers.get(chatId);
    // Check if the ticker is active and has events to send
    if (!tickerState || !tickerState.isPolling || !tickerState.recapEvents || tickerState.recapEvents.length === 0) {
        // Clear just in case
        if (tickerState && tickerState.recapEvents) tickerState.recapEvents = [];
        return; // Nothing to do
    }

    console.log(`[${chatId}] Sende ${tickerState.recapEvents.length} Events im Recap.`);

    // --- Calculate Game Time Range ---
    // Sort events just in case they aren't perfectly ordered
    tickerState.recapEvents.sort((a, b) => a.second - b.second);
    const firstEventSecond = tickerState.recapEvents[0].second;
    const lastEventSecond = tickerState.recapEvents[tickerState.recapEvents.length - 1].second;
    // Calculate start minute (floor) and end minute (ceil)
    const startMinute = Math.floor(firstEventSecond / 60);
    const endMinute = Math.ceil(lastEventSecond / 60);
    const timeRangeTitle = `Minute ${startMinute} - ${endMinute}`;

    // --- Build Recap Body ---
    const recapLines = tickerState.recapEvents.map(ev => formatRecapEventLine(ev, tickerState));
    // Filter out any potentially empty lines (e.g., from ignored event types)
    const validLines = recapLines.filter(line => line && line.trim() !== '');

    if (validLines.length === 0) {
        console.log(`[${chatId}] Keine gültigen Events zum Senden im Recap gefunden.`);
        tickerState.recapEvents = []; // Clear buffer even if no valid lines
        return;
    }

    // --- Construct Final Message ---
    const teamHeader = `*${tickerState.teamNames.home}* : *${tickerState.teamNames.guest}*`;
    const recapBody = validLines.join('\n');
    const finalMessage = `📬 *Recap ${timeRangeTitle}*\n\n${teamHeader}\n${recapBody}`; // REMOVED ${separator}\n

    try {
        await client.sendMessage(chatId, finalMessage);
        tickerState.recapEvents = []; // Clear buffer after successful send
    } catch (error) {
        console.error(`[${chatId}] Fehler beim Senden der Recap-Nachricht:`, error);
        // Keep messages? For now, clear to prevent duplicates on next attempt.
        tickerState.recapEvents = [];
    }
}

/**
 * Master Scheduler: Runs periodically (e.g., every 20s).
 * Selects the next active, polling ticker using round-robin.
 * Adds a 'poll' job to the queue for the selected ticker if one doesn't already exist.
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
    if (chatId && tickerStateToPoll.isPolling && !jobQueue.some(job => job.chatId === chatId && job.type === 'poll')) {
        jobQueue.push({
             type: 'poll', // Explicit poll job
             chatId,
             meetingPageUrl: tickerStateToPoll.meetingPageUrl,
             tickerState: tickerStateToPoll,
             jobId: Date.now()
        });
        console.log(`[${chatId}] Poll-Job zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
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
 * Executes a single job (either 'schedule' or 'poll') using Puppeteer/Axios.
 * Handles the resource-intensive browser launch, data fetching, and processing logic.
 * Ensures worker slot is freed using a finally block.
 * @param {object} job - The job object from the queue (contains type, chatId, etc.).
 */
async function runWorker(job) {
    // Extract common data first
    const { chatId, jobId, type } = job;
    // Get the *current* state from the map, as it might have changed since job creation
    const tickerState = activeTickers.get(chatId);
    const timerLabel = `[${chatId}] Job ${jobId} (${type}) Execution Time`;
    console.time(timerLabel);
    let browser = null;

    // Check if ticker is still valid for this job type
    if (!tickerState || (type === 'poll' && !tickerState.isPolling) || (type === 'schedule' && !tickerState.isScheduling)) {
        console.log(`[${chatId}] Job ${jobId} (${type}) wird übersprungen, da Ticker-Status ungültig.`);
        activeWorkers--; // Free worker slot immediately
        console.timeEnd(timerLabel);
        return; // Stop execution
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
            setTimeout(() => reject(new Error('API-Request wurde nicht innerhalb von 30s abgefangen.')), 30000);
        });
        await page.goto(job.meetingPageUrl, { waitUntil: 'networkidle0', timeout: 45000 });
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

            // Update ticker state with fetched data
            tickerState.teamNames = teamNames;
            tickerState.halftimeLength = gameData.halftimeLength;
            // Mode and groupName were already set when job was created

            if (delay > 0) {
                // Still in the future: update user, save schedule, set timer
                console.log(`[${chatId}] Planungs-Job erfolgreich. Spiel beginnt um ${scheduledTime.toLocaleString()}. Polling startet in ${Math.round(delay / 60000)} Minuten.`);
                await client.sendMessage(chatId, `✅ Ticker für *${teamNames.home}* vs *${teamNames.guest}* ist geplant (Modus: ${tickerState.mode}) und startet automatisch am ${startDateLocale} um ca. ${startTimeLocale} Uhr.`);
                // isPolling remains false, isScheduling remains true
                const currentSchedule = loadScheduledTickers(scheduleFilePath);
                currentSchedule[chatId] = {
                    meetingPageUrl: job.meetingPageUrl,
                    startTime: startTime.toISOString(),
                    groupName: tickerState.groupName,
                    halftimeLength: tickerState.halftimeLength,
                    mode: tickerState.mode
                };
                saveScheduledTickers(currentSchedule, scheduleFilePath);
                tickerState.scheduleTimeout = setTimeout(() => {
                    beginActualPolling(chatId);
                }, delay);
            } else {
                // Start time has passed: update user, start polling now
                console.log(`[${chatId}] Planungs-Job erfolgreich. Spiel hat bereits begonnen. Starte Polling sofort.`);
                await client.sendMessage(chatId, `▶️ Ticker für *${teamNames.home}* vs *${teamNames.guest}* wird sofort gestartet (Modus: ${tickerState.mode}).`);
                beginActualPolling(chatId); // Transition to polling state
            }
        }

        // --- Logic for 'poll' job ---
        else if (type === 'poll') {
            // Ensure essential data is present
             if (!tickerState.teamNames && gameData.teamHome) {
                 tickerState.teamNames = { home: gameData.teamHome, guest: gameData.teamGuest };
             }
             if (!tickerState.halftimeLength && gameData.halftimeLength) {
                 tickerState.halftimeLength = gameData.halftimeLength;
             }

            // Check for new version
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

                // Process events and save if needed
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
             activeTickers.delete(chatId); // Remove failed schedule attempt
        }
        if (browser) await browser.close(); // Ensure browser closed on error
    } finally {
        console.timeEnd(timerLabel);
        activeWorkers--; // Free up the worker slot
    }
}

/**
 * Processes events, handles modes, calls AI, sends final stats, schedules cleanup.
 * @param {object} data - The API response containing the events array.
 * @param {object} tickerState - The state object for the specific ticker.
 * @param {string} chatId - The WhatsApp chat ID.
 * @returns {boolean} - True if new, unseen events were processed, false otherwise.
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

        if (msg) { // Only send/log if a message was actually formatted
            // Send critical/live/recap messages based on mode
            if (ev.event === 14 || ev.event === 16 || ev.event === 15) { // Critical events
                console.log(`[${chatId}] Sende kritisches Event sofort:`, msg);
                await client.sendMessage(chatId, msg);
            } else if (tickerState.mode === 'live') { // Live mode
                console.log(`[${chatId}] Sende neues Event (Live):`, msg);
                await client.sendMessage(chatId, msg);
            } else if (tickerState.mode === 'recap') { // Recap mode
                console.log(`[${chatId}] Speichere Event-Objekt für Recap (ID: ${ev.idx}, Typ: ${ev.event})`);
                tickerState.recapEvents = tickerState.recapEvents || [];
                tickerState.recapEvents.push(ev); // Store raw event
            }
        }

        // --- Handle Game End ---
        if (ev.event === 16) {
            console.log(`[${chatId}] Spielende-Event empfangen. Ticker wird gestoppt.`);
            tickerState.isPolling = false;
            if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId);

            // Send final recap if needed
            if (tickerState.mode === 'recap' && tickerState.recapEvents && tickerState.recapEvents.length > 0) {
                 console.log(`[${chatId}] Sende letzten Recap bei Spielende.`);
                 await sendRecapMessage(chatId);
            }

            // Remove pending job
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);

            try {
                // Get the calculated stats
                const gameStats = extractGameStats(events, tickerState.teamNames);
                // Format the stats message
                const statsMessage = `📊 *Statistiken zum Spiel:*\n` +
                                     `-----------------------------------\n` +
                                     `*Topscorer (${tickerState.teamNames.home}):* ${gameStats.homeTopScorer}\n` +
                                     `*Topscorer (${tickerState.teamNames.guest}):* ${gameStats.guestTopScorer}\n` +
                                     `*7-Meter (${tickerState.teamNames.home}):* ${gameStats.homeSevenMeters}\n` +
                                     `*7-Meter (${tickerState.teamNames.guest}):* ${gameStats.guestSevenMeters}\n` +
                                     `*Zeitstrafen (${tickerState.teamNames.home}):* ${gameStats.homePenalties}\n` +
                                     `*Zeitstrafen (${tickerState.teamNames.guest}):* ${gameStats.guestPenalties}`;
                // Send the message after a short delay
                setTimeout(async () => {
                     await client.sendMessage(chatId, statsMessage);
                }, 1000); // 1 second delay after end
            } catch (e) {
                console.error(`[${chatId}] Fehler beim Senden der Spielstatistiken:`, e);
            }

            // Generate and send AI summary
            try {
                const summary = await generateGameSummary(events, tickerState.teamNames, tickerState.groupName, tickerState.halftimeLength);
                setTimeout(async () => {
                     if (summary) await client.sendMessage(chatId, summary);
                }, 1000); // 1 second delay after stats summary
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