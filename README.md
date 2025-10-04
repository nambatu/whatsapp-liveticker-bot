WhatsApp Live Ticker Bot ⚽

A simple and powerful WhatsApp bot that provides real-time game updates from a liga.nu live ticker directly into your WhatsApp groups. Perfect for keeping your team or friends updated when they can't watch the game!

Features

    Real-Time Updates: Fetches new game events automatically every few seconds.

    Automatic Team Names: Intelligently fetches the correct home and guest team names from the API.

    Multi-Group Support: Can run multiple tickers in different WhatsApp groups at the same time.

    Easy to Use: Simple commands to start and stop the ticker.

    Persistent Login: Only requires you to log in once by scanning a QR code.

    Built for Raspberry Pi: Optimized to run 24/7 in the background using PM2.

🤝 Want to Use This Bot? (The Easy Way)

If you don't want to go through the setup process yourself, you can use the bot that I host on my personal Raspberry Pi.

Just add my bot's WhatsApp number to your group and contact me with your group's name and the game you want to follow. I'll start the ticker for you!

You can reach me here:

    Email: julianlangschwert@gmail.com

This is a personal project, so please be patient. I'm happy to help!

⚙️ Setup Instructions (The DIY Way)

If you prefer to host the bot yourself, follow these steps to get it running on a Raspberry Pi.

Prerequisites

    A Raspberry Pi with Raspberry Pi OS installed.

    Node.js (version 16 or newer).

    Git installed.

    A dedicated WhatsApp account (it's recommended to use a separate number, not your personal one).

Installation

    Clone the Repository
    Open the terminal on your Raspberry Pi. This command will create the project folder. You can run it from your home directory (~).
    Bash

# Run from your home directory (or wherever you want to store the project)
git clone <your-github-repository-url>

# Now, move into the newly created folder
cd whatsapp-ticker # Or your project's folder name

Install Dependencies
This command reads the package.json file and installs the necessary libraries for the project.
Bash

# Run from INSIDE the project folder (e.g., ~/whatsapp-ticker)
npm install

Install Chromium Browser
The bot needs a browser to connect to WhatsApp. The location where you run this command doesn't matter.
Bash

# Directory does not matter for this command
sudo apt update
sudo apt install chromium

Install PM2 Globally
PM2 is a process manager that will keep your bot running. The -g flag installs it globally, so the directory doesn't matter.
Bash

# Directory does not matter for this command
sudo npm install pm2 -g

Start the Bot with PM2
This command starts your bot in the background.
Bash

# Run from INSIDE the project folder
pm2 start app.js --name "whatsapp-ticker"

First Time Login (QR Code)
The bot needs to connect to your WhatsApp account. The directory doesn't matter for viewing logs.

    View the bot's live logs by running:
    Bash

    # Directory does not matter for this command
    pm2 logs whatsapp-ticker

    A QR code will appear in the terminal.

    Open WhatsApp on your phone, go to Settings > Linked Devices > Link a Device, and scan the QR code.

    Once you see "WhatsApp-Client ist bereit!" in the logs, the login is complete!

Enable Auto-Start on Reboot
These commands ensure your bot starts automatically if the Raspberry Pi reboots. The directory doesn't matter.
Bash

    # Directory does not matter for these commands
    pm2 startup
    # PM2 will give you a command to copy and paste. Run it.

    pm2 save

🤖 How to Use the Bot

Using the bot is simple. All commands must be sent in a WhatsApp group where the bot has been added.

How Team Names (Home & Guest) Work

You do not need to set the team names manually! The process is completely automatic. When you use the !start command, the bot contacts the liga.nu server, which provides the official names for the Home and Guest teams. The bot saves these names and uses them in all messages for that game.

Finding the Ticker URL

    Open the live ticker page in your computer's browser.

    Open the Developer Tools (usually by pressing F12).

    Go to the "Network" tab.

    Filter the requests by typing meeting.

    Copy the URL that appears. It will look something like this: https://hbde-live.liga.nu/nuScoreLiveRestBackend/api/1/meeting/123456/time/1728054069.

Starting & Stopping the Ticker

    To Start:

    !start <the-full-api-url-you-found>

    To Stop:

    !stop

🔄 Updating the Bot

When you update your code on GitHub, follow these steps on your Raspberry Pi to apply the changes.

    Navigate to the project directory:
    Bash

# Navigate to the folder where you cloned the project
cd /path/to/your/whatsapp-ticker

Pull, Install, and Restart:
Bash

# All of the following commands must be run from INSIDE the project folder

# Pull the latest changes from GitHub
git pull origin main

# Install any new or updated dependencies
npm install

# Restart the bot to apply all changes
pm2 restart whatsapp-ticker
