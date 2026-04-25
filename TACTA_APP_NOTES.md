# Tacta App Notes

This file documents the Tacta scorekeeping app that is currently running on the Pi web server.

## Repo Contents

- Main app source in this repo: `/Users/timboonstra/tacta/server.js`
- Notes file in this repo: `/Users/timboonstra/tacta/TACTA_APP_NOTES.md`

## Live Deployment

- Live Pi app file: `/root/cabin-monitor/server.js`
- Live Pi data file: `/root/cabin-monitor/tacta-games.json`
- Public URL: `http://tboons.ddns.net:3000/tacta`
- Service name: `cabin-monitor`

The Tacta app is currently implemented inside the main Express server file as:

- one page route: `/tacta`
- several JSON API routes under `/api/tacta/...`

## What The App Does

The app is a shared scorekeeper for Tacta that players keep open on their phones during play.

Each player:

- joins a game by 4-digit code
- chooses a color
- uses buttons to track score changes on their own phone

There is also a spectator/watch mode for a separate computer or phone that just watches scores update live.

## Current Rules Implemented

These are the behaviors the app currently enforces:

- Game IDs are 4 digits.
- Game IDs expire after 6 hours of inactivity.
- Colors available are:
  - Blue
  - Orange
  - Pink
  - Green
  - Yellow
  - Cyan
- Each player color has a saved score bucket.
- Each player color tracks cards played.
- Each player can play at most 18 cards.
- `Add Points` adds `+1` through `+6`.
- `Lose Points` subtracts `-1` through `-4`.
- Scores never go below `0`.
- Game is over when all joined players have played all 18 cards.
- After game over, scoring buttons are disabled.
- A player can rejoin an already-chosen color and keep that color's saved score/cards.
- `Undo` reverses the most recent scoring action made by that phone only.

## Important Current Behavior

### Rejoining Colors

We intentionally allow a player to choose a color that was already chosen before.

Why:

- if a phone crashes
- if the page reloads
- if someone leaves and comes back

they should be able to choose their color again and keep their saved score.

So the current behavior is:

- taken colors are visually marked as taken
- taken colors still remain selectable
- selecting a taken color reclaims that color and its saved score/cards

### Undo

Undo is phone-specific.

That means:

- it only undoes the most recent scoring action made from that phone
- it does not undo another player's action
- it reverses both score change and card count change when needed

### Spectator Mode

A non-player screen can:

- enter the game code
- choose `Watch`
- auto-refresh and show joined players, scores, and card progress

It does not need a player color.

## Routes

### Page Route

- `GET /tacta`

### API Routes

- `POST /api/tacta/games`
  - creates a new game

- `GET /api/tacta/games/:gameId`
  - returns current game state

- `POST /api/tacta/join`
  - joins or reclaims a color

- `POST /api/tacta/play`
  - applies a positive score from a played card

- `POST /api/tacta/penalty`
  - applies a negative score from being played upon

- `POST /api/tacta/undo`
  - undoes that phone's last scoring action

## Data Stored Per Player

Each color/player currently stores:

- `score`
- `cardsPlayed`
- `holderId`
- `lastSeenAt`
- `joinedAt`
- `updatedAt`

## Data Stored Per Game

Each game currently stores:

- `id`
- `createdAt`
- `updatedAt`
- `players`
- `actions`

## Visual And UX Direction

The app currently uses:

- dark background
- neon and tron-style accents
- per-player tinted background when a color is chosen
- compact controls at the top for phone use

Recent UI decisions:

- serif fonts removed
- header removed
- score controls moved to the top
- score display reduced in size
- helper text heavily trimmed
- undo moved near `Leave Room`
- landing buttons switched away from bright gradients

## Deployment Pattern

When updating the live Pi app, the workflow has been:

1. Edit `/Users/timboonstra/tacta/server.js`
2. Syntax check with `node --check /Users/timboonstra/tacta/server.js`
3. Copy to Pi as `/root/cabin-monitor/server.js`
4. Restart `cabin-monitor.service`

Current deploy command:

```sh
scp /Users/timboonstra/tacta/server.js whiteboard-pi:/root/cabin-monitor/server.js
ssh whiteboard-pi 'systemctl restart cabin-monitor && systemctl is-active cabin-monitor'
```

## Things Still Worth Real-Game Testing

The logic is in decent shape, but these still deserve real play testing:

- whether reclaiming a taken color ever feels confusing
- whether `Undo` is placed in the right spot
- whether spectator mode is enough for a table display
- whether the end-of-game behavior feels right
- whether the current score model matches how you want to track the game in practice
