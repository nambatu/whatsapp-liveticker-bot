// config.js

const EVENT_MAP = {
    //0: { label: "Spiel geht weiter", emoji: "🔁" },
    1: { label: "Spiel unterbrochen", emoji: "⏱️" },
    2: { label: "Timeout", emoji: "⏱️" },
    3: { label: "Timeout", emoji: "⏱️" },
    4: { label: "Tor", emoji: "🤾‍♀️" },
    5: { label: "7-Meter Tor", emoji: "7️⃣✅" },
    6: { label: "7-Meter Fehlwurf", emoji: "7️⃣❌" },
    8: { label: "Zeitstrafe", emoji: "✌🏼" },
    9: { label: "Gelbe Karte", emoji: "🟨" },
    11: { label: "Rote Karte", emoji: "🟥" },
    14: { label: "Abpfiff (Halbzeit oder Spielende)", emoji: "⏸️" },
    15: { label: "Spielbeginn", emoji: "▶️" },
    16: { label: "Spielende", emoji: "🏁" },
    //17: { label: "Teamaufstellung", emoji: "👥" }
};

// This makes the EVENT_MAP available to other files
module.exports = { EVENT_MAP };