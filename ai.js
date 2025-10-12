// ai.js
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize the AI with the API key from the .env file
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function generateGameSummary(events, teamNames) {
    if (!process.env.GEMINI_API_KEY) {
        console.log("GEMINI_API_KEY not found. Skipping AI summary.");
        return "";
    }

    // Find the halftime and final scores
    const finalEvent = events.find(e => e.event === 16) || events[events.length - 1];
    const halftimeEvent = events.find(e => e.event === 14);

    const finalScore = `${finalEvent.pointsHome}:${finalEvent.pointsGuest}`;
    const halftimeScore = halftimeEvent ? `${halftimeEvent.pointsHome}:${halftimeEvent.pointsGuest}` : "N/A";

    // Create a simple score progression
    let scoreProgression = "Start: 0:0";
    // Get score at ~15, 30, 45, 60 minutes
    [15, 30, 45, 60].forEach(minute => {
        const eventAtTime = events.find(e => e.second >= minute * 60);
        if (eventAtTime) {
            scoreProgression += `, ${minute}min: ${eventAtTime.pointsHome}:${eventAtTime.pointsGuest}`;
        }
    });

    const prompt = `Du bist ein kurzer, prägnanter Handball-Sportkommentator. Fasse das folgende Spiel in ein bis zwei fesselnden Sätzen zusammen. Konzentriere dich auf die "Geschichte" des Spiels (z.B. ein knappes Spiel, eine dominante Leistung, ein Comeback).
    
    Heimmannschaft: ${teamNames.home}
    Gastmannschaft: ${teamNames.guest}
    Halbzeitstand: ${halftimeScore}
    Endstand: ${finalScore}
    Score-Verlauf: ${scoreProgression}

    Dein Kommentar:`;

    try {
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return `🤖 KI-Zusammenfassung: ${response.text()}`;
    } catch (error) {
        console.error("Fehler bei der AI-Zusammenfassung:", error);
        return ""; // Return empty string on error
    }
}

module.exports = { generateGameSummary };