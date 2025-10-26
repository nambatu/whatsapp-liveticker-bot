// ai.js 
const { GoogleGenAI } = require("@google/genai"); // Use GoogleGenAI

// The client gets the API key from the environment variable `GEMINI_API_KEY`.
const genAI = new GoogleGenAI(process.env.GEMINI_API_KEY); // Use GoogleGenAI

// Funktion zum Extrahieren von detaillierten Statistiken
function extractGameStats(events, teamNames) {
    const stats = {
        home: { name: teamNames.home, goals: new Map(), penalties: 0, sevenMetersMade: 0, sevenMetersMissed: 0 },
        guest: { name: teamNames.guest, goals: new Map(), penalties: 0, sevenMetersMade: 0, sevenMetersMissed: 0 }
    };

    for (const ev of events) {
        const targetTeam = ev.teamHome ? stats.home : stats.guest;
        if (!targetTeam) continue;

        const playerName = `${ev.personFirstname || ''} ${ev.personLastname || ''}`.trim();

        switch (ev.event) {
            case 4: // Tor
            case 5: // 7-Meter Tor
                if (playerName) {
                    targetTeam.goals.set(playerName, (targetTeam.goals.get(playerName) || 0) + 1);
                }
                if (ev.event === 5) targetTeam.sevenMetersMade++;
                break;
            case 6: // 7-Meter Fehlwurf
                targetTeam.sevenMetersMissed++;
                break;
            case 8: // Zeitstrafe
                targetTeam.penalties++;
                break;
        }
    }

    const findTopScorer = (teamStats) => {
        if (teamStats.goals.size === 0) return "Niemand";
        const sortedScorers = [...teamStats.goals.entries()].sort((a, b) => b[1] - a[1]);
        const topScore = sortedScorers[0][1];
        const topScorers = sortedScorers.filter(([_, score]) => score === topScore).map(([name, _]) => name);
        return `${topScorers.join(' & ')} (${topScore} Tore)`;
    };

    return {
        homeTopScorer: findTopScorer(stats.home),
        guestTopScorer: findTopScorer(stats.guest),
        homePenalties: stats.home.penalties,
        guestPenalties: stats.guest.penalties,
        homeSevenMeters: `${stats.home.sevenMetersMade} von ${stats.home.sevenMetersMade + stats.home.sevenMetersMissed}`,
        guestSevenMeters: `${stats.guest.sevenMetersMade} von ${stats.guest.sevenMetersMade + stats.guest.sevenMetersMissed}`
    };
}

async function generateGameSummary(events, teamNames, groupName, halftimeLength) {
    if (!process.env.GEMINI_API_KEY) {
        console.log("GEMINI_API_KEY nicht gefunden. KI-Zusammenfassung wird übersprungen.");
        return "";
    }

    const finalEvent = events.find(e => e.event === 16) || events[events.length - 1];
    const halftimeEvent = events.find(e => e.event === 14);

    // ** 1. USE HALFTIMELENGTH TO DETERMINE GAME DURATION **
    // Use the provided halftimeLength (in minutes) to calculate total duration. Default to 60 if not available.
    const gameDurationMinutes = halftimeLength ? halftimeLength * 2 : 60;

    // Score-Progression based on 5-minute intervals
    let scoreProgression = "Start: 0:0";
    for (let minute = 5; minute <= gameDurationMinutes; minute += 5) {
        const targetSecond = minute * 60;
        const eventAtTime = events.find(e => e.second >= targetSecond);
        if (eventAtTime) {
            scoreProgression += `, ${minute}min: ${eventAtTime.pointsHome}:${eventAtTime.pointsGuest}`;
        }
    }

    // 2. Detaillierte Statistiken extrahieren
    const gameStats = extractGameStats(events, teamNames);

    // 3. & 4. Neuer, kreativer und parteiischer Prompt
    const prompt = `Du bist ein witziger, leicht sarkastischer und fachkundiger deutscher Handball-Kommentator.
    Deine Aufgabe ist es, eine kurze, unterhaltsame Zusammenfassung (ca. 2-4 Sätze) für ein gerade beendetes Spiel zu schreiben.

    WICHTIG: Die WhatsApp-Gruppe, in der du postest, heißt "${groupName}". Analysiere diesen Namen, um herauszufinden, welches Team du unterstützen sollst. Dein Kommentar sollte aus einer leicht parteiischen, aber humorvollen Perspektive für dieses Team geschrieben sein. Wenn du kein Team identifizieren kannst, sei neutral.

    Hier sind die Spieldaten:
    - Heimmannschaft: ${teamNames.home}
    - Gastmannschaft: ${teamNames.guest}
    - Halbzeitstand: ${halftimeEvent ? `${halftimeEvent.pointsHome}:${halftimeEvent.pointsGuest}` : "N/A"}
    - Endstand: ${finalEvent.pointsHome}:${finalEvent.pointsGuest}
    - Spiellänge: ${gameDurationMinutes} Minuten
    - Spielverlauf (ausgewählte Spielstände): ${scoreProgression}, Ende: ${finalEvent.pointsHome}:${finalEvent.pointsGuest}
    - Topscorer ${teamNames.home}: ${gameStats.homeTopScorer}
    - Topscorer ${teamNames.guest}: ${gameStats.guestTopScorer}
    - Zeitstrafen ${teamNames.home}: ${gameStats.homePenalties}
    - Zeitstrafen ${teamNames.guest}: ${gameStats.guestPenalties}
    - 7-Meter ${teamNames.home}: ${gameStats.homeSevenMeters}
    - 7-Meter ${teamNames.guest}: ${gameStats.guestSevenMeters}

    Anweisungen:
    1.  Gib deiner Zusammenfassung eine kreative, reißerische Überschrift in Fett (z.B. *Herzschlagfinale in der Halle West!* oder *Eine Lehrstunde in Sachen Abwehrschlacht.*).
    2.  Verwende die Statistiken für spitze Kommentare. (z.B. "Mit ${gameStats.guestPenalties} Zeitstrafen hat sich Team Gast das Leben selbst schwer gemacht." oder "Am Ende hat die Kaltschnäuzigkeit vom 7-Meter-Punkt den Unterschied gemacht.")
    3.  Sei kreativ, vermeide Standardfloskeln. Gib dem Kommentar Persönlichkeit! Vermeide Sachen aus den Daten zu interpretieren die nicht daraus zu erschließen sind, bleibe lieber bei den Fakten als eine "zu offensive Abwehr" zu erfinden. 
    4.  Falls der Gruppenname keinem Team zuzuordnen ist, ignoriere ihn und erwähne ihn nirgendwo. Falls sich die Gruppe aber definitiv einem Team zuordnen lässt, unterstütze das Team mit Herzblut und roaste auch gerne das gegnerische Team.
    5.  Falls Julian Langschwert, Tiard Brinkmann und/oder Simon Goßmann gespielt hat, lobe ihn sarkastisch bis in den Himmel.

    Deine Zusammenfassung (nur Überschrift und Text, ohne "Zusammenfassung:"):`;

    try {
        //const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        //const result = await model.generateContent(prompt);
        const response = await genAI.models.generateContent({
            model: "gemini-2.5-pro",
            contents: prompt,
        });
        
        return `🤖 *KI-Analyse zum Spiel:*\n\n${response.text}`;
    } catch (error) {
        console.error("Fehler bei der AI-Zusammenfassung:", error);
        return "";
    }
}

module.exports = { generateGameSummary, extractGameStats };