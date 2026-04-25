# Tacta

Phone-friendly scorekeeping for the card game Tacta.

This repo contains the Node/Express code currently used to serve the Tacta scorekeeper at:

## What It Does

- creates short-lived 4-digit game rooms
- lets each player join a room and pick a color
- tracks score per player color
- tracks cards played out of 18 per player
- supports spectator mode
- supports rejoining a previously chosen color without losing score
- supports undo for the current phone's last scoring action
- ends the game when all joined players have used all 18 cards

## Main Files

- `server.js`
  - main Express app file that serves the Tacta page and API

- `TACTA_APP_NOTES.md`
  - maintenance and deployment notes

## Running It

This app is currently deployed as part of the Pi's `cabin-monitor` service rather than as a separate packaged project.

If you are updating the live app:

```sh
node --check server.js
scp server.js whiteboard-pi:/root/cabin-monitor/server.js
ssh whiteboard-pi 'systemctl restart cabin-monitor && systemctl is-active cabin-monitor'
```

## Current UI Direction

- dark neon look inspired by the Tacta box art
- phone-first layout
- scoring buttons kept near the top of the screen
- minimal extra copy during play
