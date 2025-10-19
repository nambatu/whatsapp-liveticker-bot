// polling.js

const axios = require('axios');
const puppeteer = require('puppeteer');
const { saveSeenTickers, formatEvent, saveScheduledTickers, loadScheduledTickers } = require('./utils.js');
const { generateGameSummary } = require('./ai.js');

// --- SHARED STATE (Initialized by app.js) ---
let activeTickers, jobQueue, client, seenFilePath, scheduleFilePath;

// --- WORKER POOL CONFIG ---
let lastPolledIndex = -1; // Tracks the last ticker index polled by the scheduler
let activeWorkers = 0; // Counts currently running Puppeteer instances
const MAX_WORKERS = 2; // Maximum number of concurrent Puppeteer instances allowed
const PRE_GAME_START_MINUTES = 5; // How many minutes before scheduled start to begin polling
const RECAP_INTERVAL_MINUTES = 5; // Frequency of sending recap messages in recap mode

/**
 * Initializes the polling module with shared state from app.js.
 * @param {Map} tickers - The Map storing active ticker states.
 * @param {Array} queue - The array acting as the job queue.
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
 * @param {string} meetingPageUrl - The URL of the NuLiga live ticker webpage.
 * @param {string} chatId - The WhatsApp chat ID where the ticker runs.
 * @param {string} groupName - The name of the WhatsApp group.
 * @param {('live'|'recap')} mode - The desired ticker mode ('live' or 'recap').
 */
async function scheduleTicker(meetingPageUrl, chatId, groupName, mode) { // Added 'mode' parameter
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
            setTimeout(() => reject(new Error('API-Request wurde nicht innerhalb von 30s abgefangen.')), 30000);
        });
        await page.goto(meetingPageUrl, { waitUntil: 'networkidle0', timeout: 45000 });
        const capturedUrl = await apiCallPromise;
        await browser.close(); browser = null; // Close browser ASAP

        const metaRes = await axios.get(capturedUrl);
        const gameData = metaRes.data;

        // --- Calculate start time and delay ---
        const scheduledTime = new Date(gameData.scheduled);
        const startTime = new Date(scheduledTime.getTime() - (PRE_GAME_START_MINUTES * 60000));
        const delay = startTime.getTime() - Date.now();
        const teamNames = { home: gameData.teamHome, guest: gameData.teamGuest };
        const startTimeLocale = startTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const startDateLocale = startTime.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

        // --- Create or update ticker state ---
        const tickerState = activeTickers.get(chatId) || { seen: new Set() };
        tickerState.meetingPageUrl = meetingPageUrl;
        tickerState.teamNames = teamNames;
        tickerState.groupName = groupName;
        tickerState.halftimeLength = gameData.halftimeLength;
        tickerState.mode = mode; // Store the requested mode
        tickerState.recapMessages = []; // Initialize for recap mode
        activeTickers.set(chatId, tickerState);

        // --- Schedule or start polling ---
        if (delay > 0) {
            // Game is in the future: schedule it
            console.log(`[${chatId}] Spiel beginnt um ${scheduledTime.toLocaleString()}. Polling startet in ${Math.round(delay / 60000)} Minuten.`);
            await client.sendMessage(chatId, `✅ Ticker für *${teamNames.home}* vs *${teamNames.guest}* ist geplant (Modus: ${mode}) und startet automatisch am ${startDateLocale} um ca. ${startTimeLocale} Uhr.`);
            tickerState.isPolling = false;
            tickerState.isScheduled = true;

            // Save the schedule information to the file
            const currentSchedule = loadScheduledTickers(scheduleFilePath);
            currentSchedule[chatId] = {
                meetingPageUrl,
                startTime: startTime.toISOString(), // Use ISO string for consistency
                groupName,
                halftimeLength: gameData.halftimeLength,
                mode
            };
            saveScheduledTickers(currentSchedule, scheduleFilePath);

            // Set the timer to start polling later
            tickerState.scheduleTimeout = setTimeout(() => {
                beginActualPolling(chatId);
            }, delay);

        } else {
            // Game has already started: start polling now
            console.log(`[${chatId}] Spiel hat bereits begonnen. Starte Polling sofort (Modus: ${mode}).`);
            await client.sendMessage(chatId, `▶️ Ticker für *${teamNames.home}* vs *${teamNames.guest}* wird sofort gestartet (Modus: ${mode}).`);
            beginActualPolling(chatId); // This also removes it from schedule file if needed
        }

    } catch (error) {
        console.error(`[${chatId}] Fehler bei der Ticker-Planung:`, error.message);
        await client.sendMessage(chatId, 'Fehler: Konnte die Spieldaten nicht abrufen, um den Ticker zu planen.');
        if (browser) await browser.close();
        activeTickers.delete(chatId); // Clean up failed schedule
    } finally {
        // Robust browser cleanup
        if (browser) {
             console.warn(`[${chatId}] Browser-Instanz in scheduleTicker wurde notfallmäßig geschlossen.`);
             await browser.close();
        }
    }
}

/**
 * Activates the polling loop for a given chat ID.
 * Sets the ticker state to 'polling', removes it from the schedule file,
 * starts the recap timer if needed, and adds the initial job to the queue.
 * @param {string} chatId - The WhatsApp chat ID.
 */
function beginActualPolling(chatId) {
    const tickerState = activeTickers.get(chatId);
    if (!tickerState) {
        console.warn(`[${chatId}] Ticker-Status nicht gefunden beim Versuch, das Polling zu starten.`);
        const currentSchedule = loadScheduledTickers(scheduleFilePath);
         if (currentSchedule[chatId]) {
             delete currentSchedule[chatId];
             saveScheduledTickers(currentSchedule, scheduleFilePath);
         }
        return;
    }

    console.log(`[${chatId}] Aktiviere Polling (Modus: ${tickerState.mode}).`);
    tickerState.isPolling = true;
    tickerState.isScheduled = false;

    // Remove from the schedule file persistence
    const currentSchedule = loadScheduledTickers(scheduleFilePath);
    if (currentSchedule[chatId]) {
        delete currentSchedule[chatId];
        saveScheduledTickers(currentSchedule, scheduleFilePath);
        console.log(`[${chatId}] Aus Planungsdatei entfernt.`);
    }

    // Start recap timer ONLY if in recap mode
    if (tickerState.mode === 'recap') {
        if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId); // Clear previous timer
        tickerState.recapIntervalId = setInterval(() => {
            sendRecapMessage(chatId);
        }, RECAP_INTERVAL_MINUTES * 60 * 1000);
        console.log(`[${chatId}] Recap-Timer gestartet (${RECAP_INTERVAL_MINUTES} min).`);
    }

    // Add initial job to the queue for immediate update
    if (!jobQueue.some(job => job.chatId === chatId)) {
        jobQueue.unshift({ chatId, meetingPageUrl: tickerState.meetingPageUrl, tickerState, jobId: Date.now() });
    }
}

/**
 * Sends a recap message containing accumulated events for a specific chat.
 * @param {string} chatId - The WhatsApp chat ID.
 */
async function sendRecapMessage(chatId) {
    const tickerState = activeTickers.get(chatId);
    // Only send if polling is active and there are messages to send
    if (!tickerState || !tickerState.isPolling || tickerState.recapMessages.length === 0) {
        return;
    }

    console.log(`[${chatId}] Sende ${tickerState.recapMessages.length} Events im Recap.`);
    const now = new Date();
    const startTime = new Date(now.getTime() - (RECAP_INTERVAL_MINUTES * 60000));
    const timeRange = `${startTime.toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'})} - ${now.toLocaleTimeString('de-DE', {hour:'2-digit', minute:'2-digit'})}`;
    const recapText = tickerState.recapMessages.join('\n');

    try {
        await client.sendMessage(chatId, `📬 *Recap ${timeRange} Uhr*\n\n${recapText}`);
        tickerState.recapMessages = []; // Clear messages after sending
    } catch (error) {
        console.error(`[${chatId}] Fehler beim Senden der Recap-Nachricht:`, error);
        // Keep messages in queue if sending failed? Or clear anyway? Clearing for now.
        tickerState.recapMessages = [];
    }
}

/**
 * Master Scheduler: Runs periodically to add jobs to the queue.
 * Uses a round-robin approach to select the next active ticker.
 * Ensures only one job per ticker is queued at a time ('smart queue').
 */
function masterScheduler() {
    const tickers = Array.from(activeTickers.values()).filter(t => t.isPolling);
    if (tickers.length === 0) return; // No active tickers

    // Select next ticker in round-robin fashion
    lastPolledIndex = (lastPolledIndex + 1) % tickers.length;
    const tickerStateToPoll = tickers[lastPolledIndex];
    // Find the chatId associated with the selected state
    const chatId = [...activeTickers.entries()].find(([key, val]) => val === tickerStateToPoll)?.[0];

    // Add job only if polling and not already in queue
    if (chatId && tickerStateToPoll.isPolling && !jobQueue.some(job => job.chatId === chatId)) {
        jobQueue.push({ chatId, meetingPageUrl: tickerStateToPoll.meetingPageUrl, tickerState: tickerStateToPoll, jobId: Date.now() });
        console.log(`[${chatId}] Job zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
    }
}

/**
 * Dispatcher Loop: Runs frequently to check the job queue.
 * If there's a job and a worker slot is free, it starts a worker.
 */
function dispatcherLoop() {
    if (jobQueue.length > 0 && activeWorkers < MAX_WORKERS) {
        activeWorkers++; // Increment worker count *before* starting async task
        const job = jobQueue.shift(); // Get the next job
        runWorker(job); // Start the worker asynchronously (don't await)
    }
}

/**
 * Executes a single polling job using Puppeteer.
 * Launches a browser, navigates to the page, intercepts the API call,
 * fetches metadata and events, and calls processEvents.
 * Ensures the browser is closed and worker count is decremented.
 * @param {object} job - The job object from the queue.
 */
async function runWorker(job) {
    const { chatId, tickerState, jobId } = job;
    const timerLabel = `[${chatId}] Job ${jobId} Execution Time`;
    console.time(timerLabel);
    let browser = null; // Define outside try for finally block

    // Double-check if ticker is still polling before launching browser
    if (!tickerState || !tickerState.isPolling) {
        console.log(`[${chatId}] Job ${jobId} wird übersprungen, da der Ticker gestoppt wurde oder nicht existiert.`);
    } else {
        console.log(`[${chatId}] Worker startet Job ${jobId}. Verbleibende Jobs: ${jobQueue.length}. Aktive Worker: ${activeWorkers}`);
        try {
            // --- Puppeteer Logic ---
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

            // --- API Calls & Processing ---
            const meetingApiRegex = /api\/1\/meeting\/(\d+)\/time\/(\d+)/;
            const apiMatch = capturedUrl.match(meetingApiRegex);
            if (!apiMatch) throw new Error("Konnte Meeting ID nicht aus URL extrahieren.");
            const meetingId = apiMatch[1];

            const metaRes = await axios.get(capturedUrl);
            // Ensure team names are set (important if bot restarted mid-game)
            if (!tickerState.teamNames && metaRes.data.teamHome) {
                tickerState.teamNames = { home: metaRes.data.teamHome, guest: metaRes.data.teamGuest };
                // Optionally send a message confirming activation if it wasn't scheduled
                if (!tickerState.isScheduled) {
                     await client.sendMessage(chatId, `*${tickerState.teamNames.home}* vs. *${tickerState.teamNames.guest}* - Ticker aktiv!`);
                }
            }
            // Update halftime length if missing (e.g., bot restart)
             if (!tickerState.halftimeLength && metaRes.data.halftimeLength) {
                 tickerState.halftimeLength = metaRes.data.halftimeLength;
             }

            const versionUid = metaRes.data.versionUid;
            if (versionUid && versionUid !== tickerState.lastVersionUid) {
                console.log(`[${chatId}] Neue Version erkannt: ${versionUid}`);
                tickerState.lastVersionUid = versionUid;
                const eventsUrl = `https:\/\/hbde-live.liga.nu/nuScoreLiveRestBackend/api/1/events/${meetingId}/versions/${versionUid}`;
                const eventsRes = await axios.get(eventsUrl);

                // Pass seenFilePath to processEvents so it can call saveSeenTickers
                if (await processEvents(eventsRes.data, tickerState, chatId)) {
                    // Save seen state only if new events were actually processed
                    saveSeenTickers(activeTickers, seenFilePath);
                }
            }
        } catch (error) {
            console.error(`[${chatId}] Fehler im Worker-Job:`, error.message);
            // Ensure browser is closed on error
            if (browser) await browser.close();
        }
    }
    
    // --- Cleanup ---
    console.timeEnd(timerLabel);
    activeWorkers--; // Decrement worker count in finally
}

/**
 * Processes the events received from the API for a specific ticker.
 * Formats messages, handles live vs recap mode, sends messages/stores them,
 * triggers AI summary and final message on game end, and schedules cleanup.
 * @param {object} data - The API response data containing the events array.
 * @param {object} tickerState - The state object for the specific ticker.
 * @param {string} chatId - The WhatsApp chat ID.
 * @returns {boolean} - True if new, unseen events were processed, false otherwise.
 */
async function processEvents(data, tickerState, chatId) {
    if (!data || !Array.isArray(data.events)) return false;
    let newUnseenEventsProcessed = false; // Track if we actually processed anything new
    const events = data.events.slice().sort((a, b) => a.idx - b.idx);

    for (const ev of events) {
        if (tickerState.seen.has(ev.idx)) continue; // Skip already seen events

        const msg = formatEvent(ev, tickerState);
        tickerState.seen.add(ev.idx);
        newUnseenEventsProcessed = true; // Mark that we processed a new event

        // --- Handle message sending based on mode ---
        if (msg) {
            // Always send critical events immediately
            if (ev.event === 14 || ev.event === 16 || ev.event === 15) {
                console.log(`[${chatId}] Sende kritisches Event sofort:`, msg);
                await client.sendMessage(chatId, msg);
            }
            // Live mode: send immediately
            else if (tickerState.mode === 'live') {
                console.log(`[${chatId}] Sende neues Event (Live):`, msg);
                await client.sendMessage(chatId, msg);
            }
            // Recap mode: store message
            else if (tickerState.mode === 'recap') {
                console.log(`[${chatId}] Speichere Event für Recap:`, msg);
                tickerState.recapMessages.push(msg);
            }
        }

        // --- Handle game end ---
        if (ev.event === 16) {
            console.log(`[${chatId}] Spielende-Event empfangen. Ticker wird gestoppt.`);
            tickerState.isPolling = false;
            if (tickerState.recapIntervalId) clearInterval(tickerState.recapIntervalId); // Clear recap timer

            // Send final recap if needed
            if (tickerState.mode === 'recap' && tickerState.recapMessages.length > 0) {
                 console.log(`[${chatId}] Sende letzten Recap bei Spielende.`);
                 await sendRecapMessage(chatId);
            }

            // Remove any pending job from queue
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);
            
            // Trigger AI summary
            try {
                const summary = await generateGameSummary(events, tickerState.teamNames, tickerState.groupName, tickerState.halftimeLength);
                if (summary) await client.sendMessage(chatId, summary);
            } catch (e) { console.error(`[${chatId}] Fehler beim Senden der AI-Zusammenfassung:`, e); }
            
            // Send final bot message
            setTimeout(async () => {
                const finalMessage = "Vielen Dank fürs Mitfiebern! 🥳\n\nDen Quellcode für diesen Bot könnt ihr hier einsehen:\nhttps://github.com/nambatu/whatsapp-liveticker-bot/\n\nFalls ihr mich unterstützen wollt, könnt ihr das gerne hier tun:\npaypal.me/julianlangschwert";
                await client.sendMessage(chatId, finalMessage);
            }, 2000);

            // Schedule automatic cleanup
            console.log(`[${chatId}] Automatische Bereinigung in 1 Stunde geplant.`);
            setTimeout(() => {
                if (activeTickers.has(chatId)) {
                    activeTickers.delete(chatId);
                    saveSeenTickers(activeTickers, seenFilePath); // Pass path
                    console.log(`[${chatId}] Ticker-Daten automatisch bereinigt.`);
                }
            }, 3600000); // 1 hour
            break; // Stop processing events after game end
        }
    }
    // Return true only if we processed at least one new event
    return newUnseenEventsProcessed;
}

// Export necessary functions for app.js
module.exports = {
    initializePolling,
    masterScheduler,
    dispatcherLoop,
    startPolling: scheduleTicker,
    beginActualPolling // Needed by app.js for rescheduling on startup
};