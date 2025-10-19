// polling.js
const axios = require('axios');
const puppeteer = require('puppeteer');
const { saveSeenTickers, formatEvent, saveScheduledTickers, loadScheduledTickers } = require('./utils.js'); 
const { generateGameSummary } = require('./ai.js');

let activeTickers, jobQueue, client, seenFilePath, scheduleFilePath;
let lastPolledIndex = -1;
let activeWorkers = 0;
const MAX_WORKERS = 2;
const PRE_GAME_START_MINUTES = 5;

function initializePolling(tickers, queue, whatsappClient, seenFile, scheduleFile) {
    activeTickers = tickers;
    jobQueue = queue;
    client = whatsappClient;
    seenFilePath = seenFile;
    scheduleFilePath = scheduleFile;
}

async function scheduleTicker(meetingPageUrl, chatId, groupName) {
    console.log(`[${chatId}] Ticker-Planung wird gestartet für Gruppe: ${groupName}`);
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
        await browser.close(); browser = null;
        const metaRes = await axios.get(capturedUrl);
        const gameData = metaRes.data;
        const scheduledTime = new Date(gameData.scheduled);
        const startTime = new Date(scheduledTime.getTime() - (PRE_GAME_START_MINUTES * 60000));
        const delay = startTime.getTime() - Date.now();
        const teamNames = { home: gameData.teamHome, guest: gameData.teamGuest };
        const startTimeLocale = startTime.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        const startDateLocale = startTime.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
        const tickerState = activeTickers.get(chatId) || { seen: new Set() };
        tickerState.meetingPageUrl = meetingPageUrl;
        tickerState.teamNames = teamNames;
        tickerState.groupName = groupName;
        tickerState.halftimeLength = gameData.halftimeLength;
        activeTickers.set(chatId, tickerState);
        if (delay > 0) {
            console.log(`[${chatId}] Spiel beginnt um ${scheduledTime.toLocaleString()}. Polling startet in ${Math.round(delay / 60000)} Minuten.`);
            await client.sendMessage(chatId, `✅ Ticker für *${teamNames.home}* vs *${teamNames.guest}* ist geplant und startet automatisch am ${startDateLocale} um ca. ${startTimeLocale} Uhr.`);            
            tickerState.isPolling = false;
            tickerState.isScheduled = true;
            const currentSchedule = loadScheduledTickers(scheduleFilePath);
            currentSchedule[chatId] = {
                meetingPageUrl,
                startTime: startTime.toISOString(),
                groupName,
                halftimeLength: gameData.halftimeLength
            };
            saveScheduledTickers(currentSchedule, scheduleFilePath);
            tickerState.scheduleTimeout = setTimeout(() => {
                beginActualPolling(chatId);
            }, delay);
        } else {
            console.log(`[${chatId}] Spiel hat bereits begonnen. Starte Polling sofort.`);
            await client.sendMessage(chatId, `▶️ Ticker für *${teamNames.home}* vs *${teamNames.guest}* wird sofort gestartet.`);
            beginActualPolling(chatId);
        }
    } catch (error) {
        console.error(`[${chatId}] Fehler bei der Ticker-Planung:`, error.message);
        await client.sendMessage(chatId, 'Fehler: Konnte die Spieldaten nicht abrufen, um den Ticker zu planen.');
        if (browser) await browser.close();
        activeTickers.delete(chatId);
    } finally {
        if (browser) {
             console.warn(`[${chatId}] Browser-Instanz in scheduleTicker wurde notfallmäßig geschlossen.`);
             await browser.close();
        }
    }
}

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
    console.log(`[${chatId}] Aktiviere Polling.`);
    tickerState.isPolling = true;
    tickerState.isScheduled = false;
    const currentSchedule = loadScheduledTickers(scheduleFilePath);
    if (currentSchedule[chatId]) {
        delete currentSchedule[chatId];
        saveScheduledTickers(currentSchedule, scheduleFilePath);
        console.log(`[${chatId}] Aus Planungsdatei entfernt.`);
    }
    if (!jobQueue.some(job => job.chatId === chatId)) {
        jobQueue.unshift({ chatId, meetingPageUrl: tickerState.meetingPageUrl, tickerState, jobId: Date.now() });
    }
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

async function runWorker(job) {
    const { chatId, tickerState, jobId } = job;
    const timerLabel = `[${chatId}] Job ${jobId} Execution Time`;
    console.time(timerLabel);
    if (!tickerState || !tickerState.isPolling) { 
        console.log(`[${chatId}] Job wird übersprungen, da der Ticker gestoppt wurde oder nicht existiert.`);
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
            await browser.close(); browser = null;
            const meetingApiRegex = /api\/1\/meeting\/(\d+)\/time\/(\d+)/;
            const apiMatch = capturedUrl.match(meetingApiRegex);
            if (!apiMatch) throw new Error("Konnte Meeting ID nicht aus URL extrahieren.");
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
                    saveSeenTickers(activeTickers, seenFilePath);
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
        if (msg) {
            console.log(`[${chatId}] Sende neues Event:`, msg);
            await client.sendMessage(chatId, msg);
        }
        tickerState.seen.add(ev.idx);
        newEventsAdded = true;
        if (ev.event === 16) {
            console.log(`[${chatId}] Spielende-Event empfangen. Ticker wird gestoppt.`);
            tickerState.isPolling = false;
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);
            try {
                const summary = await generateGameSummary(events, tickerState.teamNames, tickerState.groupName, tickerState.halftimeLength);
                if (summary) await client.sendMessage(chatId, summary);
            } catch (e) { console.error(`[${chatId}] Fehler beim Senden der AI-Zusammenfassung:`, e); }
            setTimeout(async () => {
                const finalMessage = "Vielen Dank fürs Mitfiebern! 🥳\n\nDen Quellcode für diesen Bot könnt ihr hier einsehen:\nhttps://github.com/nambatu/whatsapp-liveticker-bot/\n\nFalls ihr mich unterstützen wollt, könnt ihr das gerne hier tun:\npaypal.me/julianlangschwert";
                await client.sendMessage(chatId, finalMessage);
            }, 2000);
            console.log(`[${chatId}] Automatische Bereinigung in 1 Stunde geplant.`);
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
    return newEventsAdded;
}

module.exports = {
    initializePolling,
    masterScheduler,
    dispatcherLoop,
    startPolling: scheduleTicker
};