// polling.js
const axios = require('axios');
const puppeteer = require('puppeteer');
// Import all necessary utility functions
const { saveSeenTickers, formatEvent, saveScheduledTickers, loadScheduledTickers, formatRecapEventLine } = require('./utils.js');
// Import both AI functions
const { generateGameSummary, extractGameStats } = require('./ai.js');

// --- SHARED STATE (Initialized by app.js) ---
let activeTickers, jobQueue, client, seenFilePath, scheduleFilePath;

// --- WORKER POOL CONFIG ---
let lastPolledIndex = -1;
let activeWorkers = 0;
const MAX_WORKERS = 2; // Tunable: Number of parallel browsers
const PRE_GAME_START_MINUTES = 5; // How early to start polling
const RECAP_INTERVAL_MINUTES = 5; // Recap frequency

/**
 * Initializes the polling module with shared state from app.js.
 * @param {Map} tickers - Map storing active ticker states.
 * @param {Array} queue - The job queue array.
 * @param {Client} whatsappClient - The whatsapp-web.js client.
 * @param {string} seenFile - Path to seen events file.
 * @param {string} scheduleFile - Path to schedule file.
 */
function initializePolling(tickers, queue, whatsappClient, seenFile, scheduleFile) {
    activeTickers = tickers;
    jobQueue = queue;
    client = whatsappClient;
    seenFilePath = seenFile;
    scheduleFilePath = scheduleFile;
}

/**
 * Schedules a ticker or starts it immediately. Called by !start.
 * Fetches initial data via Puppeteer, saves schedule if needed, sets timers.
 * @param {string} meetingPageUrl - The NuLiga ticker page URL.
 * @param {string} chatId - The WhatsApp chat ID.
 * @param {string} groupName - The WhatsApp group name.
 * @param {('live'|'recap')} mode - Ticker mode.
 */
async function scheduleTicker(meetingPageUrl, chatId, groupName, mode) { // Added 'mode'
    console.log(`[${chatId}] Ticker-Planung wird gestartet (Modus: ${mode}) für Gruppe: ${groupName}`);
    let browser = null;
    try {
        // --- Fetch initial game data ---
        browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        await page.setRequestInterception(true);
        const apiCallPromise = new Promise((resolve, reject) => { /* Intercept API call */ });
        await page.goto(meetingPageUrl, { waitUntil: 'networkidle0', timeout: 90000 });
        const capturedUrl = await apiCallPromise;
        await browser.close(); browser = null;
        const metaRes = await axios.get(capturedUrl);
        const gameData = metaRes.data;

        // --- Calculate timings ---
        const scheduledTime = new Date(gameData.scheduled);
        const startTime = new Date(scheduledTime.getTime() - (PRE_GAME_START_MINUTES * 60000));
        const delay = startTime.getTime() - Date.now();
        const teamNames = { home: gameData.teamHome, guest: gameData.teamGuest };
        const startTimeLocale = startTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const startDateLocale = startTime.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

        // --- Update ticker state ---
        const tickerState = activeTickers.get(chatId) || { seen: new Set() };
        tickerState.meetingPageUrl = meetingPageUrl;
        tickerState.teamNames = teamNames;
        tickerState.groupName = groupName;
        tickerState.halftimeLength = gameData.halftimeLength;
        tickerState.mode = mode;
        tickerState.recapEvents = []; // Use recapEvents for storing raw events
        activeTickers.set(chatId, tickerState);

        // --- Schedule or Start ---
        if (delay > 0) { // Future game
            console.log(`[${chatId}] Spiel beginnt um ${scheduledTime.toLocaleString()}. Polling startet in ${Math.round(delay / 60000)} Minuten.`);
            // Send descriptive message based on mode
            const modeDescriptionScheduled = (mode === 'recap') ? `im Recap-Modus (${RECAP_INTERVAL_MINUTES}-Minuten-Zusammenfassungen)` : "mit Live-Updates";
            await client.sendMessage(chatId, `✅ Ticker für *${teamNames.home}* vs *${teamNames.guest}* ist geplant (${modeDescriptionScheduled}) und startet automatisch am ${startDateLocale} um ca. ${startTimeLocale} Uhr.`);
            tickerState.isPolling = false;
            tickerState.isScheduled = true;
            // Save to schedule file
            const currentSchedule = loadScheduledTickers(scheduleFilePath);
            currentSchedule[chatId] = { /* schedule data */ };
            saveScheduledTickers(currentSchedule, scheduleFilePath);
            // Set timer
            tickerState.scheduleTimeout = setTimeout(() => { beginActualPolling(chatId); }, delay);
        } else { // Game already started
            console.log(`[${chatId}] Spiel hat bereits begonnen. Starte Polling sofort (Modus: ${mode}).`);
            // Send descriptive message based on mode
            let startMessage = `▶️ Ticker für *${teamNames.home}* vs *${teamNames.guest}* wird sofort gestartet. `;
            if (mode === 'recap') {
                startMessage += `Du erhältst alle ${RECAP_INTERVAL_MINUTES} Minuten eine Zusammenfassung. 📬`;
            } else {
                startMessage += `Du erhältst alle Events live! ⚽`;
            }
            await client.sendMessage(chatId, startMessage);
            beginActualPolling(chatId);
        } 
    }   catch (error) {
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
 * Activates the polling loop for a ticker.
 */
function beginActualPolling(chatId) {
    const tickerState = activeTickers.get(chatId);
    if (!tickerState || tickerState.isPolling) { /* Handle missing state or already polling */ return; }

    console.log(`[${chatId}] Aktiviere Polling (Modus: ${tickerState.mode}).`);
    tickerState.isPolling = true;
    tickerState.isScheduled = false;

    // Remove from schedule file
    const currentSchedule = loadScheduledTickers(scheduleFilePath);
    if (currentSchedule[chatId]) { /* remove and save */ }

    // Start recap timer if needed
    if (tickerState.mode === 'recap') {
        if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId);
        tickerState.recapIntervalId = setInterval(() => { sendRecapMessage(chatId); }, RECAP_INTERVAL_MINUTES * 60 * 1000);
        console.log(`[${chatId}] Recap-Timer gestartet (${RECAP_INTERVAL_MINUTES} min).`);
    }

    // Add initial job
    if (!jobQueue.some(job => job.chatId === chatId && job.type === 'poll')) {
        jobQueue.unshift({ type: 'poll', chatId, /* other job data */ });
    }
}

/**
 * Sends a recap message formatted using formatRecapEventLine.
 */
async function sendRecapMessage(chatId) {
    const tickerState = activeTickers.get(chatId);
    if (!tickerState || !tickerState.isPolling || !tickerState.recapEvents || tickerState.recapEvents.length === 0) {
        if (tickerState && tickerState.recapEvents) tickerState.recapEvents = [];
        return;
    }
    console.log(`[${chatId}] Sende ${tickerState.recapEvents.length} Events im Recap.`);

    // --- Calculate Game Time Range ---
    tickerState.recapEvents.sort((a, b) => a.second - b.second);
    const firstEventSecond = tickerState.recapEvents[0].second;
    const lastEventSecond = tickerState.recapEvents[tickerState.recapEvents.length - 1].second;
    const startMinute = Math.floor(firstEventSecond / 60);
    const endMinute = Math.ceil(lastEventSecond / 60);
    const timeRangeTitle = `Minute ${startMinute} - ${endMinute}`;

    // --- Build Recap Body using formatRecapEventLine ---
    const recapLines = tickerState.recapEvents.map(ev => formatRecapEventLine(ev, tickerState)); // Use the correct formatter
    const validLines = recapLines.filter(line => line && line.trim() !== '');

    if (validLines.length === 0) { /* Handle no valid lines */ tickerState.recapEvents = []; return; }

    // --- Construct Final Message ---
    const teamHeader = `*${tickerState.teamNames.home}* : *${tickerState.teamNames.guest}*`;
    const recapBody = validLines.join('\n');
    const finalMessage = `📬 *Recap ${timeRangeTitle}*\n\n${teamHeader}\n${recapBody}`; // Removed separator

    try {
        await client.sendMessage(chatId, finalMessage);
        tickerState.recapEvents = []; // Clear buffer
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
 * Executes a single job (schedule or poll). Contains Puppeteer logic.
 */
async function runWorker(job) {
    const { chatId, jobId, type } = job;
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
            // Send based on mode and event type
            if (ev.event === 14 || ev.event === 16 || ev.event === 15) { /* Send critical */ }
            else if (tickerState.mode === 'live') { /* Send live */ }
            else if (tickerState.mode === 'recap') {
                // Store raw event, not formatted message
                tickerState.recapEvents = tickerState.recapEvents || [];
                tickerState.recapEvents.push(ev);
            }
        }

        if (ev.event === 16) { // Game End
            console.log(`[${chatId}] Spielende-Event empfangen...`);
            tickerState.isPolling = false;
            if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId);

            // Send final recap if needed
            if (tickerState.mode === 'recap' && tickerState.recapEvents && tickerState.recapEvents.length > 0) {
                 await sendRecapMessage(chatId);
            }

            // Remove pending job
            const index = jobQueue.findIndex(job => job.chatId === chatId); if (index > -1) jobQueue.splice(index, 1);

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
            } catch (e) { console.error(`[${chatId}] Fehler beim Senden der Spielstatistiken:`, e); }

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