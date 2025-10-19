````markdown
# WhatsApp Live Ticker Bot ⚽

A simple and powerful WhatsApp bot that provides real-time game updates from a [liga.nu](http://liga.nu) live ticker directly into your WhatsApp groups. Perfect for keeping your team or friends updated when they can't watch the game!

### Advanced Features
- **Smart Scheduling:** Automatically starts polling a few minutes before the scheduled game time to save resources.
- **AI-Powered Summaries:** At the end of each game, an AI commentator provides a witty, slightly sarcastic, and personalized summary of the match.
- **Stable & Efficient:** Uses a master scheduler and a parallel worker pool to handle multiple games at once without overloading the system.
- **Dynamic Formatting:** The message format adapts to the game event for maximum readability.
- **Persistent & Recoverable:** Remembers scheduled games even after a bot restart.
- **Easy to Use:** Simple commands to start, stop, and reset tickers.

---

## 🤝 Want to Use This Bot? (The Easy Way)

If you don't want to go through the setup process yourself, you can use the bot that I host on my personal Raspberry Pi.

Just add my bot's WhatsApp number to your group and contact me with your group's name and the game you want to follow. I'll start the ticker for you!

You can reach me here:
* **Email:** julianlangschwert@gmail.com

This is a personal project, so please be patient. I'm happy to help!

---

## ⚙️ Setup Instructions (The DIY Way)

If you prefer to host the bot yourself, follow these steps to get it running on a Raspberry Pi.

### Prerequisites
* A Raspberry Pi (Model 4 with 2GB+ RAM is recommended) with Raspberry Pi OS.
* Node.js (version 16 or newer).
* Git installed.
* A dedicated WhatsApp account (it's recommended to use a separate number).
* A Google AI API Key for the game summaries.

### Installation

**1. Clone the Repository**
Open the terminal on your Raspberry Pi and clone the project.
```bash
# Run from your home directory (or wherever you want to store the project)
git clone [https://github.com/nambatu/whatsapp-liveticker-bot.git](https://github.com/nambatu/whatsapp-liveticker-bot.git)

# Move into the newly created folder
cd whatsapp-liveticker-bot
````

**2. Create and Configure `.env` File**
This file will securely store your AI API key.

```bash
# Run from INSIDE the project folder
nano .env
```

Add the following line, replacing the placeholder with your key:

```
GEMINI_API_KEY="YOUR_API_KEY_HERE"
```

Press `Ctrl + O`, `Enter` to save, and `Ctrl + X` to exit.

**3. Install Dependencies**
This installs all the necessary Node.js and system packages.

```bash
# Run from INSIDE the project folder
npm install

# Install Chromium browser for the bot to use
sudo apt update && sudo apt install -y chromium
```

**4. Install PM2 (Process Manager)**
PM2 will keep your bot running 24/7.

```bash
# The -g flag installs it globally
sudo npm install pm2 -g
```

**5. First Time Start & Login**
Start the bot with PM2.

```bash
# Run from INSIDE the project folder
pm2 start app.js --name "whatsapp-ticker"
```

Now, view the logs to get the QR code.

```bash
# View the live logs
pm2 logs whatsapp-ticker
```

A **QR code** will appear in the terminal. Open WhatsApp on your phone, go to **Settings \> Linked Devices \> Link a Device**, and scan the code. Once you see "WhatsApp-Client ist bereit\!", the login is complete\!

**6. Enable Auto-Start on Reboot**
This makes sure your bot starts automatically if the Raspberry Pi restarts.

```bash
# This generates a command...
pm2 startup

# ...copy and run the command it gives you. Then save the process list.
pm2 save
```

Your setup is now complete\!

-----

## 🤖 How to Use the Bot

All commands must be sent in a WhatsApp group where the bot has been added.

### Finding the Ticker URL

The bot now uses the standard URL from your browser's address bar.

1.  Navigate to the live ticker page on the NuLiga website.
2.  Copy the URL directly from your browser's address bar.
3.  It should look like this: `https://hbde-live.liga.nu/nuScoreLive/#/groups/12345/meetings/67890`

### Commands

  * **`!start <URL>`**
    Schedules the live ticker for a game. The bot will figure out the start time and activate itself automatically a few minutes before the match begins.
    *Example:* `!start https://hbde-live.liga.nu/nuScoreLive/#/groups/12345/meetings/67890`

  * **`!stop`**
    Stops the currently running or scheduled ticker for that group.

  * **`!reset`**
    Immediately stops the ticker, cancels any scheduled tasks, and **deletes all game data** for the group. This is necessary before you can start a new ticker in the same group.

-----

## 🔧 Tuning Performance (Advanced)

The bot is configured to run up to 2 parallel browser instances (`MAX_WORKERS = 2`) and adds a new polling job to the queue every 20 seconds.

  * With 2 active games, each game gets polled every \~40 seconds.
  * With 4 active games, each game gets polled every \~80 seconds.

If you have a powerful Raspberry Pi, you can cautiously increase the number of parallel workers by editing the `MAX_WORKERS` constant in `polling.js`.

-----

## 🔄 Updating the Bot

To update the bot with the latest code from your GitHub repository:

```bash
# Navigate to your project folder
cd /path/to/your/whatsapp-liveticker-bot

# Pull the latest changes
git pull origin main

# Install any new dependencies
npm install

# Restart the bot to apply all changes
pm2 restart whatsapp-ticker
```

-----

**Disclaimer:** This bot is a private, open-source project and has no affiliation with NuLiga or any associated company. This project has been programmed with the help of generative AI

```
```
