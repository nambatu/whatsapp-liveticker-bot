// polling.js
const axios = require('axios');
const puppeteer = require('puppeteer');
const { generateGameSummary } = require('./ai.js');
const { saveSeenTickers, formatEvent } = require('./utils.js');

// This function receives the global state from app.js when it's initialized
let activeTickers, jobQueue, client;
let lastPolledIndex = -1;
let activeWorkers = 0;
const MAX_WORKERS = 2;

function initializePolling(tickers, queue, whatsappClient) {
    activeTickers = tickers;
    jobQueue = queue;
    client = whatsappClient;
}

function masterScheduler() {
    const tickers = Array.from(activeTickers.values()).filter(t => t.isPolling);
    if (tickers.length === 0) return;

    lastPolledIndex = (lastPolledIndex + 1) % tickers.length;
    const tickerStateToPoll = tickers[lastPolledIndex];
    const chatId = [...activeTickers.entries()].find(([key, val]) => val === tickerStateToPoll)?.[0];

    if (chatId && !jobQueue.some(job => job.chatId === chatId)) {
        jobQueue.push({ chatId, meetingPageUrl: tickerStateToPoll.meetingPageUrl, tickerState: tickerStateToPoll, jobId: Date.now() });
        console.log(`[${chatId}] Job zur Warteschlange hinzugefügt. Aktuelle Länge: ${jobQueue.length}`);
    }
}

function dispatcherLoop() {
    if (jobQueue.length > 0 && activeWorkers < MAX_WORKERS) {
        activeWorkers++;
        const job = jobQueue.shift();
        runWorker(job);
    }
}

async function startPolling(meetingPageUrl, chatId) {
    const urlRegex = /https:\/\/hbde-live\.liga\.nu\/nuScoreLive\/#\/groups\/\d+\/meetings\/\d+/;
    if (!urlRegex.test(meetingPageUrl)) {
        await client.sendMessage(chatId, 'Fehler: Die angegebene URL ist keine gültige Live-Ticker-Seiten-URL.');
        return;
    }
    const tickerState = activeTickers.get(chatId) || { seen: new Set() };
    tickerState.isPolling = true;
    tickerState.meetingPageUrl = meetingPageUrl;
    activeTickers.set(chatId, tickerState);
    await client.sendMessage(chatId, `Live-Ticker wird für diese Gruppe gestartet...`);
    if (!jobQueue.some(job => job.chatId === chatId)) {
        jobQueue.unshift({ chatId, meetingPageUrl: tickerState.meetingPageUrl, tickerState, jobId: Date.now() });
    }
}

async function runWorker(job) {
    const { chatId, tickerState, jobId } = job;
    const timerLabel = `[${chatId}] Job ${jobId} Execution Time`;
    console.time(timerLabel);

    if (!tickerState.isPolling) {
        console.log(`[${chatId}] Job wird übersprungen, da der Ticker gestoppt wurde.`);
    } else {
        console.log(`[${chatId}] Worker startet Job. Verbleibende Jobs: ${jobQueue.length}. Aktive Worker: ${activeWorkers}`);
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
            await page.goto(job.meetingPageUrl, { waitUntil: 'networkidle0', timeout: 45000 });
            const capturedUrl = await apiCallPromise;
            await browser.close();
            browser = null;
            const meetingApiRegex = /api\/1\/meeting\/(\d+)\/time\/(\d+)/;
            const apiMatch = capturedUrl.match(meetingApiRegex);
            const meetingId = apiMatch[1];
            const metaRes = await axios.get(capturedUrl);
            if (!tickerState.teamNames && metaRes.data.teamHome) {
                tickerState.teamNames = { home: metaRes.data.teamHome, guest: metaRes.data.teamGuest };
                await client.sendMessage(chatId, `*${tickerState.teamNames.home}* vs. *${tickerState.teamNames.guest}* - Ticker aktiv!`);
            }
            const versionUid = metaRes.data.versionUid;
            if (versionUid && versionUid !== tickerState.lastVersionUid) {
                console.log(`[${chatId}] Neue Version erkannt: ${versionUid}`);
                tickerState.lastVersionUid = versionUid;
                const eventsUrl = `https:\/\/hbde-live.liga.nu/nuScoreLiveRestBackend/api/1/events/${meetingId}/versions/${versionUid}`;
                const eventsRes = await axios.get(eventsUrl);
                if (await processEvents(eventsRes.data, tickerState, chatId)) {
                    saveSeenTickers(activeTickers);
                }
            }
        } catch (error) {
            console.error(`[${chatId}] Fehler im Worker-Job:`, error.message);
            if (browser) await browser.close();
        }
    }
    
    console.timeEnd(timerLabel);
    activeWorkers--;
}

async function processEvents(data, tickerState, chatId) {
    if (!data || !Array.isArray(data.events)) return false;
    let newEventsAdded = false;
    const events = data.events.slice().sort((a, b) => a.idx - b.idx);

    for (const ev of events) {
        if (tickerState.seen.has(ev.idx)) continue;
        
        const msg = formatEvent(ev, tickerState);
        console.log(`[${chatId}] Sende neues Event:`, msg);
        if (msg) await client.sendMessage(chatId, msg);
        
        tickerState.seen.add(ev.idx);
        newEventsAdded = true;

        if (ev.event === 16) { // Game End Event
            console.log(`[${chatId}] Spielende-Event empfangen. Ticker wird gestoppt.`);
            tickerState.isPolling = false;
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);
            
            // --- AI SUMMARY LOGIC ---
            try {
                const summary = await generateGameSummary(events, tickerState.teamNames);
                if (summary) {
                    await client.sendMessage(chatId, summary);
                }
            } catch (e) {
                console.error(`[${chatId}] Fehler beim Senden der AI-Zusammenfassung:`, e);
            }
            
            // --- NEU: Letzte Nachricht mit Links ---
            setTimeout(async () => {
                const finalMessage = "Vielen Dank fürs Mitfiebern! 🥳\n\nDen Quellcode für diesen Bot könnt ihr hier einsehen:\nhttps://github.com/nambatu/whatsapp-liveticker-bot/\n\nFalls ihr mich unterstützen wollt, könnt ihr das gerne hier tun:\npaypal.me/julianlangschwert";
                await client.sendMessage(chatId, finalMessage);
            }, 2000); // 2-second delay

            // --- Automatic Cleanup Logic ---
            console.log(`[${chatId}] Automatische Bereinigung in 1 Stunde geplant.`);
            setTimeout(() => {
                if (activeTickers.has(chatId)) {
                    activeTickers.delete(chatId);
                    saveSeenTickers(activeTickers);
                    console.log(`[${chatId}] Ticker-Daten automatisch bereinigt.`);
                }
            }, 3600000); // 1 hour
            break;
        }
    }
    return newEventsAdded;
}

module.exports = {
    initializePolling,
    masterScheduler,
    dispatcherLoop,
    startPolling
};