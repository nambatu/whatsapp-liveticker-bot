// in app.js
client.on('message', async msg => {
    if (!msg.body.startsWith('!')) return;
    const chat = await msg.getChat();
    if (!chat.isGroup) {
        await msg.reply('Fehler: Befehle funktionieren nur in Gruppen.');
        return;
    }
    const chatId = chat.id._serialized;
    const args = msg.body.split(' ');
    const command = args[0].toLowerCase();
    const groupName = chat.name; // HIER wird der Gruppenname korrekt erfasst

    if (command === '!start' && args.length >= 2) {
        if (activeTickers.has(chatId) && (activeTickers.get(chatId).isPolling || activeTickers.get(chatId).isScheduled)) {
            await msg.reply('In dieser Gruppe läuft oder ist bereits ein Live-Ticker geplant. Stoppen oder resetten Sie ihn zuerst.');
            return;
        }
        const meetingPageUrl = args[1];
        try {
            // HIER wird der groupName an die polling.js übergeben
            await startPolling(meetingPageUrl, chatId, groupName);
        } catch (error) {
            console.error(`[${chatId}] Kritischer Fehler beim Starten des Tickers:`, error);
            await msg.reply('Ein kritischer Fehler ist aufgetreten und der Ticker konnte nicht gestartet werden.');
            activeTickers.delete(chatId);
        }
    } else if (command === '!stop') {
        const tickerState = activeTickers.get(chatId);
        if (tickerState && (tickerState.isPolling || tickerState.isScheduled)) {
            if (tickerState.scheduleTimeout) clearTimeout(tickerState.scheduleTimeout);
            tickerState.isPolling = false;
            tickerState.isScheduled = false;
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);
            await client.sendMessage(chatId, 'Laufender/geplanter Live-Ticker in dieser Gruppe gestoppt.');
            console.log(`Live-Ticker für Gruppe "${groupName}" (${chatId}) gestoppt.`);
        } else {
            await msg.reply('In dieser Gruppe läuft derzeit kein Live-Ticker.');
        }
    } else if (command === '!reset') {
        const tickerState = activeTickers.get(chatId);
        if (tickerState) {
            if (tickerState.scheduleTimeout) clearTimeout(tickerState.scheduleTimeout);
            tickerState.isPolling = false;
            tickerState.isScheduled = false;
            const index = jobQueue.findIndex(job => job.chatId === chatId);
            if (index > -1) jobQueue.splice(index, 1);
        }
        activeTickers.delete(chatId);
        saveSeenTickers(activeTickers);
        await msg.reply('Alle Ticker-Daten für diese Gruppe wurden zurückgesetzt.');
        console.log(`Ticker-Daten für Gruppe "${groupName}" (${chatId}) wurden manuell zurückgesetzt.`);
    } else if (command === '!start') {
        await msg.reply(`Fehler: Bitte geben Sie eine gültige URL an.`);
    }
});