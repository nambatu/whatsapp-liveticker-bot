// polling.js
const axios = require('axios');
const puppeteer = require('puppeteer');
const { saveSeenTickers, formatEvent } = require('./utils.js');

// --- SHARED STATE (from app.js) ---
let activeTickers, jobQueue, client;

// --- WORKER POOL CONFIG ---
let lastPolledIndex = -1;
let activeWorkers = 0;
const MAX_WORKERS = 2;
const PRE_GAME_START_MINUTES = 5; // Start polling 5 minutes before the game

function initializePolling(tickers, queue, whatsappClient) {
    activeTickers = tickers;
    jobQueue = queue;
    client = whatsappClient;
}

// --- SCHEDULING & POLLING LOGIC ---

// This is the new entry point, it schedules the polling to start later
async function scheduleTicker(meetingPageUrl, chatId) {
    console.log(`[${chatId}] Ticker-Planung wird gestartet...`);
    
    // Step 1: Run Puppeteer once to get the scheduled time
    let browser = null;
    try {
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
        await browser.close();
        browser = null;

        const metaRes = await axios.get(capturedUrl);
        const gameData = metaRes.data;

        // Step 2: Calculate the delay
        const scheduledTime = new Date(gameData.scheduled);
        const startTime = new Date(scheduledTime.getTime() - (PRE_GAME_START_MINUTES * 60000)); // 5 minutes before
        const delay = startTime.getTime() - Date.now();

        const teamNames = { home: gameData.teamHome, guest: gameData.teamGuest };
        const startTimeLocale = startTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

        if (delay > 0) {
            // Game is in the future
            console.log(`[${chatId}] Spiel beginnt um ${scheduledTime.toLocaleString()}. Polling startet in ${Math.round(delay / 60000)} Minuten.`);
            await client.sendMessage(chatId, `✅ Ticker für *${teamNames.home}* vs *${teamNames.guest}* ist geplant und startet automatisch um ca. ${startTimeLocale} Uhr.`);
            
            const tickerState = activeTickers.get(chatId) || { seen: new Set() };
            tickerState.isPolling = false; // Not polling yet
            tickerState.isScheduled = true;
            tickerState.meetingPageUrl = meetingPageUrl;
            tickerState.teamNames = teamNames;
            activeTickers.set(chatId, tickerState);
            
            // Step 3: Use setTimeout to "sleep" and then start the actual polling
            tickerState.scheduleTimeout = setTimeout(() => {
                beginActualPolling(chatId);
            }, delay);

        } else {
            // Game has already started, begin polling immediately
            console.log(`[${chatId}] Spiel hat bereits begonnen. Starte Polling sofort.`);
            await client.sendMessage(chatId, `▶️ Ticker für *${teamNames.home}* vs *${teamNames.guest}* wird sofort gestartet.`);
            const tickerState = activeTickers.get(chatId) || { seen: new Set() };
            activeTickers.set(chatId, tickerState); // Ensure it's in the map
            beginActualPolling(chatId, meetingPageUrl);
        }

    } catch (error) {
        console.error(`[${chatId}] Fehler bei der Ticker-Planung:`, error);
        await client.sendMessage(chatId, 'Fehler: Konnte die Spieldaten nicht abrufen, um den Ticker zu planen.');
        if (browser) await browser.close();
    }
}

// This function starts the real polling by adding jobs to the master scheduler
function beginActualPolling(chatId, meetingPageUrl) {
    const tickerState = activeTickers.get(chatId);
    if (!tickerState) return;

    console.log(`[${chatId}] Die geplante Zeit ist erreicht. Aktiviere Polling.`);
    tickerState.isPolling = true;
    tickerState.isScheduled = false;
    if(meetingPageUrl) tickerState.meetingPageUrl = meetingPageUrl;

    // Immediately add the first job to get a fast initial update
    if (!jobQueue.some(job => job.chatId === chatId)) {
        jobQueue.unshift({ chatId, meetingPageUrl: tickerState.meetingPageUrl, tickerState, jobId: Date.now() });
    }
}

function masterScheduler() {
    // ... (This function remains unchanged)
}
function dispatcherLoop() {
    // ... (This function remains unchanged)
}
async function runWorker(job) {
    // ... (This function remains unchanged)
}
async function processEvents(data, tickerState, chatId) {
    // ... (This function remains unchanged)
}

module.exports = {
    initializePolling,
    masterScheduler,
    dispatcherLoop,
    startPolling: scheduleTicker // IMPORTANT: We export scheduleTicker as startPolling
};