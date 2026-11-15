#!/bin/bash
cd "$(dirname "$0")"
npm install
npx pm2 start index.js --name "discordVCbot"
