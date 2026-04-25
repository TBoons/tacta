const express = require('express');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const app = express();

app.use(express.json());

const dataFile = './temps.json';
const whiteboardConfigFile = './whiteboard-config.json';
const whiteboardStocksCacheFile = './whiteboard-stocks-cache.json';
const tactaGamesFile = './tacta-games.json';
const DISPLAY_WIDTH = 250;
const DISPLAY_HEIGHT = 122;
const DISPLAY_BYTES_PER_ROW = Math.ceil(DISPLAY_WIDTH / 8);
const DISPLAY_FRAME_BYTES = DISPLAY_BYTES_PER_ROW * DISPLAY_HEIGHT;
const TACTA_COLORS = [
  { id: 'blue', label: 'Blue', hex: '#2d6cdf' },
  { id: 'orange', label: 'Orange', hex: '#f28a1b' },
  { id: 'pink', label: 'Pink', hex: '#e85ca8' },
  { id: 'green', label: 'Green', hex: '#2f9d69' },
  { id: 'yellow', label: 'Yellow', hex: '#d6a700' },
  { id: 'cyan', label: 'Cyan', hex: '#25b8cf' }
];
const TACTA_GAME_TTL_MS = 6 * 60 * 60 * 1000;
const TACTA_ACTION_LIMIT = 20;
const TACTA_CARDS_PER_PLAYER = 18;
const TACTA_SEAT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_WHITEBOARD_CONFIG = {
  version: 1,
  layout: 'split',
  widgets: {
    clock: {
      enabled: true,
      timezone: 'America/Chicago',
      title: 'Clock'
    },
    weather: {
      enabled: true,
      zip: '37064',
      timezone: 'America/Chicago',
      title: 'Weather',
      location: {
        city: 'Franklin',
        state: 'TN',
        latitude: 35.92506,
        longitude: -86.86889
      }
    },
    stocks: {
      enabled: true,
      title: 'Stocks',
      symbols: ['MSFT', 'TSLA']
    }
  }
};

if (!fs.existsSync(dataFile)) {
  fs.writeFileSync(dataFile, '[]');
}

if (!fs.existsSync(whiteboardConfigFile)) {
  fs.writeFileSync(whiteboardConfigFile, JSON.stringify(DEFAULT_WHITEBOARD_CONFIG, null, 2));
}

if (!fs.existsSync(whiteboardStocksCacheFile)) {
  fs.writeFileSync(whiteboardStocksCacheFile, JSON.stringify({ updatedAt: null, items: [] }, null, 2));
}

if (!fs.existsSync(tactaGamesFile)) {
  fs.writeFileSync(tactaGamesFile, JSON.stringify({ games: {} }, null, 2));
}

const STOCK_CACHE_TTL_MS = 15 * 60 * 1000;

function loadTactaStore() {
  try {
    const raw = fs.readFileSync(tactaGamesFile, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      games: parsed && typeof parsed.games === 'object' && !Array.isArray(parsed.games)
        ? parsed.games
        : {}
    };
  } catch (err) {
    console.error('Failed to load Tacta store:', err);
    return { games: {} };
  }
}

function saveTactaStore(store) {
  fs.writeFileSync(tactaGamesFile, JSON.stringify(store, null, 2));
}

function pruneExpiredTactaGames(store) {
  const now = Date.now();
  let changed = false;

  Object.entries(store.games).forEach(([gameId, game]) => {
    const timestamp = game && (game.updatedAt || game.createdAt);
    const ageMs = timestamp ? now - new Date(timestamp).getTime() : Number.POSITIVE_INFINITY;

    if (!Number.isFinite(ageMs) || ageMs > TACTA_GAME_TTL_MS) {
      delete store.games[gameId];
      changed = true;
    }
  });

  return changed;
}

function loadFreshTactaStore() {
  const store = loadTactaStore();

  if (pruneExpiredTactaGames(store)) {
    saveTactaStore(store);
  }

  return store;
}

function isValidTactaGameId(gameId) {
  return /^\d{4}$/.test(String(gameId || '').trim());
}

function isValidTactaColor(color) {
  return TACTA_COLORS.some((entry) => entry.id === color);
}

function getTactaColor(color) {
  return TACTA_COLORS.find((entry) => entry.id === color) || null;
}

function isValidTactaClientId(clientId) {
  return typeof clientId === 'string' && clientId.trim().length >= 8;
}

function isTactaSeatActive(player) {
  if (!player || !player.lastSeenAt) {
    return false;
  }

  const ageMs = Date.now() - new Date(player.lastSeenAt).getTime();
  return Number.isFinite(ageMs) && ageMs <= TACTA_SEAT_TTL_MS;
}

function tactaSeatHeldByOther(player, clientId) {
  if (!player || !player.holderId || !isTactaSeatActive(player)) {
    return false;
  }

  return !isValidTactaClientId(clientId) || player.holderId !== clientId;
}

function tactaSeatClaimable(player, clientId) {
  if (!player) {
    return true;
  }

  if (!player.holderId || !isTactaSeatActive(player)) {
    return true;
  }

  if (!isValidTactaClientId(clientId)) {
    return false;
  }

  return true;
}

function normalizeTactaGame(game) {
  const safeGame = game && typeof game === 'object' ? game : {};
  const players = safeGame.players && typeof safeGame.players === 'object' && !Array.isArray(safeGame.players)
    ? safeGame.players
    : {};

  Object.keys(players).forEach((color) => {
    if (!isValidTactaColor(color)) {
      delete players[color];
      return;
    }

    const player = players[color] || {};
    const numericScore = Number(player.score);
    const numericCardsPlayed = Number(player.cardsPlayed);
    players[color] = {
      color,
      score: Number.isFinite(numericScore) ? numericScore : 0,
      cardsPlayed: Number.isFinite(numericCardsPlayed) && numericCardsPlayed >= 0 ? Math.floor(numericCardsPlayed) : 0,
      holderId: typeof player.holderId === 'string' ? player.holderId : null,
      lastSeenAt: player.lastSeenAt || null,
      joinedAt: player.joinedAt || safeGame.createdAt || new Date().toISOString(),
      updatedAt: player.updatedAt || player.joinedAt || safeGame.updatedAt || new Date().toISOString()
    };
  });

  return {
    id: String(safeGame.id || ''),
    createdAt: safeGame.createdAt || new Date().toISOString(),
    updatedAt: safeGame.updatedAt || safeGame.createdAt || new Date().toISOString(),
    players,
    actions: Array.isArray(safeGame.actions) ? safeGame.actions.slice(0, TACTA_ACTION_LIMIT) : []
  };
}

function createTactaGame(gameId) {
  const now = new Date().toISOString();
  return {
    id: gameId,
    createdAt: now,
    updatedAt: now,
    players: {},
    actions: []
  };
}

function createTactaGameId(store) {
  for (let attempt = 0; attempt < 5000; attempt += 1) {
    const gameId = String(crypto.randomInt(1000, 10000));
    if (!store.games[gameId]) {
      return gameId;
    }
  }

  for (let gameId = 1000; gameId <= 9999; gameId += 1) {
    const candidate = String(gameId);
    if (!store.games[candidate]) {
      return candidate;
    }
  }

  throw new Error('No Tacta room IDs available');
}

function ensureTactaPlayer(game, color, nowIso, clientId = null) {
  const existing = game.players[color];
  if (existing) {
    const numericScore = Number(existing.score);
    existing.score = Number.isFinite(numericScore) ? numericScore : 0;
    existing.cardsPlayed = Number.isFinite(Number(existing.cardsPlayed)) && Number(existing.cardsPlayed) >= 0
      ? Math.floor(Number(existing.cardsPlayed))
      : 0;
    existing.holderId = typeof existing.holderId === 'string' ? existing.holderId : null;
    existing.lastSeenAt = existing.lastSeenAt || null;
    existing.joinedAt = existing.joinedAt || nowIso;
    existing.updatedAt = nowIso;
    if (isValidTactaClientId(clientId)) {
      existing.holderId = clientId;
      existing.lastSeenAt = nowIso;
    }
    return existing;
  }

  const player = {
    color,
    score: 0,
    cardsPlayed: 0,
    holderId: isValidTactaClientId(clientId) ? clientId : null,
    lastSeenAt: isValidTactaClientId(clientId) ? nowIso : null,
    joinedAt: nowIso,
    updatedAt: nowIso
  };

  game.players[color] = player;
  return player;
}

function appendTactaAction(game, color, delta, nowIso) {
  const colorMeta = getTactaColor(color);
  const sign = delta > 0 ? '+' : '';
  const action = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${nowIso}-${Math.random().toString(16).slice(2)}`,
    color,
    delta,
    at: nowIso,
    description: `${colorMeta ? colorMeta.label : color} ${sign}${delta}`
  };

  game.actions = [action, ...(game.actions || [])].slice(0, TACTA_ACTION_LIMIT);
}

function appendDetailedTactaAction(game, payload) {
  const colorMeta = getTactaColor(payload.color);
  const scoreDelta = Number(payload.scoreDelta) || 0;
  const sign = scoreDelta > 0 ? '+' : '';
  const action = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${payload.at}-${Math.random().toString(16).slice(2)}`,
    color: payload.color,
    clientId: payload.clientId || null,
    kind: payload.kind || 'score',
    delta: scoreDelta,
    scoreDelta,
    points: Math.max(Number(payload.points) || Math.abs(scoreDelta) || 0, 0),
    cardsDelta: Number(payload.cardsDelta) || 0,
    at: payload.at,
    description: `${colorMeta ? colorMeta.label : payload.color} ${sign}${scoreDelta}`
  };

  game.actions = [action, ...(game.actions || [])].slice(0, TACTA_ACTION_LIMIT);
}

function getLastUndoableTactaAction(game, clientId) {
  if (!isValidTactaClientId(clientId)) {
    return null;
  }

  return (game.actions || []).find((action) =>
    action &&
    action.clientId === clientId &&
    (action.kind === 'play' || action.kind === 'penalty')
  ) || null;
}

function isTactaGameOver(game) {
  const joinedPlayers = Object.values((game && game.players) || {});
  return joinedPlayers.length > 0 && joinedPlayers.every((player) => (player.cardsPlayed || 0) >= TACTA_CARDS_PER_PLAYER);
}

function buildTactaGameState(game, viewerColor = null, viewerId = null) {
  const safeGame = normalizeTactaGame(game);
  const joinedPlayers = Object.values(safeGame.players);
  const totalCardsPlayed = joinedPlayers.reduce((sum, player) => sum + (player.cardsPlayed || 0), 0);
  const totalCardsAvailable = joinedPlayers.length * TACTA_CARDS_PER_PLAYER;
  const lastUndoableAction = getLastUndoableTactaAction(safeGame, viewerId);

  return {
    id: safeGame.id,
    createdAt: safeGame.createdAt,
    updatedAt: safeGame.updatedAt,
    viewerColor: isValidTactaColor(viewerColor) ? viewerColor : null,
    gameOver: isTactaGameOver(safeGame),
    viewerCanUndo: Boolean(lastUndoableAction),
    cardsPerPlayer: TACTA_CARDS_PER_PLAYER,
    totalCardsPlayed,
    totalCardsAvailable,
    colors: TACTA_COLORS,
    players: TACTA_COLORS.map((colorMeta) => {
      const player = safeGame.players[colorMeta.id];
      return {
        color: colorMeta.id,
        label: colorMeta.label,
        hex: colorMeta.hex,
        joined: Boolean(player),
        active: isTactaSeatActive(player),
        claimAvailable: tactaSeatClaimable(player, viewerId),
        lockedByViewer: Boolean(player && isValidTactaClientId(viewerId) && player.holderId === viewerId),
        score: player ? player.score : 0,
        cardsPlayed: player ? player.cardsPlayed : 0,
        cardsRemaining: player ? Math.max(TACTA_CARDS_PER_PLAYER - player.cardsPlayed, 0) : TACTA_CARDS_PER_PLAYER,
        joinedAt: player ? player.joinedAt : null,
        updatedAt: player ? player.updatedAt : null
      };
    }),
    actions: safeGame.actions.slice(0, 12)
  };
}

function loadReadings() {
  return JSON.parse(fs.readFileSync(dataFile));
}

function getLatestReading() {
  const data = loadReadings();
  return data.length > 0 ? data[data.length - 1] : null;
}

function loadWhiteboardConfig() {
  const config = JSON.parse(fs.readFileSync(whiteboardConfigFile));
  return {
    ...DEFAULT_WHITEBOARD_CONFIG,
    ...config,
    widgets: {
      ...DEFAULT_WHITEBOARD_CONFIG.widgets,
      ...(config.widgets || {}),
      clock: {
        ...DEFAULT_WHITEBOARD_CONFIG.widgets.clock,
        ...((config.widgets || {}).clock || {})
      },
      weather: {
        ...DEFAULT_WHITEBOARD_CONFIG.widgets.weather,
        ...((config.widgets || {}).weather || {}),
        location: {
          ...DEFAULT_WHITEBOARD_CONFIG.widgets.weather.location,
          ...(((config.widgets || {}).weather || {}).location || {})
        }
      },
      stocks: {
        ...DEFAULT_WHITEBOARD_CONFIG.widgets.stocks,
        ...((config.widgets || {}).stocks || {})
      }
    }
  };
}

function saveWhiteboardConfig(config) {
  fs.writeFileSync(whiteboardConfigFile, JSON.stringify(config, null, 2));
}

function loadStocksCache() {
  return JSON.parse(fs.readFileSync(whiteboardStocksCacheFile));
}

function saveStocksCache(items) {
  fs.writeFileSync(whiteboardStocksCacheFile, JSON.stringify({
    updatedAt: new Date().toISOString(),
    items
  }, null, 2));
}

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-sS', '--max-time', '20', '--ipv4', url];
    Object.entries(headers).forEach(([key, value]) => {
      args.splice(args.length - 1, 0, '-H', `${key}: ${value}`);
    });

    execFile('/usr/bin/curl', args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(stderr || error.message || `curl failed for ${url}`));
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

async function fetchStocks(symbols) {
  const cache = loadStocksCache();
  const cacheFresh = cache.updatedAt &&
    (Date.now() - new Date(cache.updatedAt).getTime() < STOCK_CACHE_TTL_MS) &&
    (cache.items || []).every((item) => item.source === 'yahoo' && item.price !== null);

  if (cacheFresh) {
    return symbols.map((symbol) => {
      const cachedItem = (cache.items || []).find((item) => item.symbol === symbol);
      return cachedItem || {
        symbol,
        price: null,
        previousClose: null,
        high: null,
        low: null,
        delta: null,
        volume: null,
        asOf: null,
        source: 'yahoo',
        delayed: true,
        stale: true
      };
    });
  }
  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0',
      'Accept': 'application/json'
    };
    const sparkPath = `/v7/finance/spark?symbols=${encodeURIComponent(symbols.join(','))}&range=1d&interval=15m`;
    let response = null;
    let lastError = null;

    for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
      try {
        response = await fetchJson(`https://${host}${sparkPath}`, headers);
        if (response?.spark?.result?.length) {
          break;
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (!response?.spark?.result?.length) {
      throw lastError || new Error('Yahoo spark returned no results');
    }

    const results = response?.spark?.result || [];

    const quotes = symbols.map((symbol) => {
      const match = results.find((item) => item.symbol === symbol);
      const meta = match?.response?.[0]?.meta;

      if (!meta || typeof meta.regularMarketPrice !== 'number') {
        throw new Error(`No Yahoo spark data for ${symbol}`);
      }

      const priceValue = Number(Number(meta.regularMarketPrice).toFixed(2));
      const previousCloseValue = typeof meta.previousClose === 'number'
        ? Number(Number(meta.previousClose).toFixed(2))
        : typeof meta.chartPreviousClose === 'number'
          ? Number(Number(meta.chartPreviousClose).toFixed(2))
          : null;
      const highValue = typeof meta.regularMarketDayHigh === 'number'
        ? Number(Number(meta.regularMarketDayHigh).toFixed(2))
        : null;
      const lowValue = typeof meta.regularMarketDayLow === 'number'
        ? Number(Number(meta.regularMarketDayLow).toFixed(2))
        : null;
      const deltaValue = previousCloseValue !== null ? Number((priceValue - previousCloseValue).toFixed(2)) : null;

      return {
        symbol,
        price: priceValue,
        previousClose: previousCloseValue,
        high: highValue,
        low: lowValue,
        delta: deltaValue,
        volume: meta.regularMarketVolume || null,
        asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
        source: 'yahoo',
        delayed: true
      };
    });

    saveStocksCache(quotes);
    return quotes;
  } catch (error) {
    console.error('Yahoo stock fetch failed:', error.message);
    return symbols.map((symbol) => {
      const cachedItem = (cache.items || []).find((item) => item.symbol === symbol);
      if (cachedItem) {
        return {
          ...cachedItem,
          stale: true
        };
      }
      return {
        symbol,
        price: null,
        previousClose: null,
        high: null,
        low: null,
        delta: null,
        volume: null,
        asOf: null,
        source: 'yahoo',
        delayed: true,
        stale: true
      };
    });
  }
}

function normalizeStockSymbols(symbolsInput) {
  const symbols = Array.isArray(symbolsInput)
    ? symbolsInput
    : String(symbolsInput || '')
        .split(',')
        .map((value) => value.trim());

  return [...new Set(
    symbols
      .map((symbol) => symbol.toUpperCase())
      .filter((symbol) => /^[A-Z.\-]{1,10}$/.test(symbol))
  )];
}

function isValidTimezone(timezone) {
  try {
    Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date());
    return true;
  } catch (error) {
    return false;
  }
}

async function fetchZipLocation(zip) {
  const result = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(zip)}&count=10&language=en&format=json`);
  const match = (result.results || []).find((item) => Array.isArray(item.postcodes) && item.postcodes.includes(zip));

  if (!match) {
    throw new Error(`No location found for zip ${zip}`);
  }

  return {
    city: match.name,
    state: match.admin1,
    latitude: match.latitude,
    longitude: match.longitude,
    timezone: match.timezone
  };
}

function buildClockData(now, timezone) {
  return {
    timezone,
    date: new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    }).format(now),
    time: new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    }).format(now),
    iso: now.toISOString()
  };
}

function buildWhiteboardPayload(config, now, clockData, weatherData, stocksData) {
  const petData = buildPetData(now, clockData, weatherData, stocksData);
  const widgets = [];

  if (config.widgets.clock.enabled) {
    widgets.push({
      type: 'clock',
      title: config.widgets.clock.title,
      position: 'left-top',
      ...clockData
    });
  }

  if (config.widgets.weather.enabled) {
    widgets.push({
      type: 'weather',
      title: config.widgets.weather.title,
      position: 'left-bottom',
      ...weatherData
    });
  }

  if (config.widgets.stocks.enabled) {
    widgets.push({
      type: 'stocks',
      title: config.widgets.stocks.title,
      position: 'right',
      items: stocksData
    });
  }

  widgets.push({
    type: 'pet',
    title: 'Desk Pet',
    position: 'left-bottom',
    ...petData
  });

  const payload = {
    project: 'whiteboard',
    generatedAt: now.toISOString(),
    layout: config.layout,
    config,
    widgets,
    time: clockData,
    weather: weatherData,
    stocks: stocksData,
    pet: petData
  };

  const revision = createRevision(payload);

  return {
    ...payload,
    display: {
      width: DISPLAY_WIDTH,
      height: DISPLAY_HEIGHT,
      format: '1bit-msb-rows',
      frameBytes: DISPLAY_FRAME_BYTES,
      revision,
      frameUrl: '/api/whiteboard/frame'
    }
  };
}

const FONT_5X7 = {
  ' ': [0x00,0x00,0x00,0x00,0x00],
  '.': [0x00,0x60,0x60,0x00,0x00],
  ',': [0x00,0x02,0x1c,0x18,0x00],
  ':': [0x00,0x36,0x36,0x00,0x00],
  '(': [0x00,0x1c,0x22,0x41,0x00],
  ')': [0x00,0x41,0x22,0x1c,0x00],
  '<': [0x08,0x14,0x22,0x41,0x00],
  '>': [0x00,0x41,0x22,0x14,0x08],
  '?': [0x02,0x01,0x51,0x09,0x06],
  '^': [0x04,0x02,0x01,0x02,0x04],
  '_': [0x40,0x40,0x40,0x40,0x40],
  '\\': [0x20,0x10,0x08,0x04,0x02],
  '~': [0x08,0x10,0x08,0x04,0x08],
  '*': [0x14,0x08,0x3e,0x08,0x14],
  '-': [0x08,0x08,0x08,0x08,0x08],
  '/': [0x02,0x04,0x08,0x10,0x20],
  '$': [0x24,0x2a,0x7f,0x2a,0x12],
  '%': [0x23,0x13,0x08,0x64,0x62],
  '0': [0x3e,0x51,0x49,0x45,0x3e],
  '1': [0x00,0x42,0x7f,0x40,0x00],
  '2': [0x42,0x61,0x51,0x49,0x46],
  '3': [0x21,0x41,0x45,0x4b,0x31],
  '4': [0x18,0x14,0x12,0x7f,0x10],
  '5': [0x27,0x45,0x45,0x45,0x39],
  '6': [0x3c,0x4a,0x49,0x49,0x30],
  '7': [0x01,0x71,0x09,0x05,0x03],
  '8': [0x36,0x49,0x49,0x49,0x36],
  '9': [0x06,0x49,0x49,0x29,0x1e],
  'A': [0x7e,0x11,0x11,0x11,0x7e],
  'B': [0x7f,0x49,0x49,0x49,0x36],
  'C': [0x3e,0x41,0x41,0x41,0x22],
  'D': [0x7f,0x41,0x41,0x22,0x1c],
  'E': [0x7f,0x49,0x49,0x49,0x41],
  'F': [0x7f,0x09,0x09,0x09,0x01],
  'G': [0x3e,0x41,0x49,0x49,0x7a],
  'H': [0x7f,0x08,0x08,0x08,0x7f],
  'I': [0x00,0x41,0x7f,0x41,0x00],
  'J': [0x20,0x40,0x41,0x3f,0x01],
  'K': [0x7f,0x08,0x14,0x22,0x41],
  'L': [0x7f,0x40,0x40,0x40,0x40],
  'M': [0x7f,0x02,0x0c,0x02,0x7f],
  'N': [0x7f,0x04,0x08,0x10,0x7f],
  'O': [0x3e,0x41,0x41,0x41,0x3e],
  'P': [0x7f,0x09,0x09,0x09,0x06],
  'Q': [0x3e,0x41,0x51,0x21,0x5e],
  'R': [0x7f,0x09,0x19,0x29,0x46],
  'S': [0x46,0x49,0x49,0x49,0x31],
  'T': [0x01,0x01,0x7f,0x01,0x01],
  'U': [0x3f,0x40,0x40,0x40,0x3f],
  'V': [0x1f,0x20,0x40,0x20,0x1f],
  'W': [0x7f,0x20,0x18,0x20,0x7f],
  'X': [0x63,0x14,0x08,0x14,0x63],
  'Y': [0x07,0x08,0x70,0x08,0x07],
  'Z': [0x61,0x51,0x49,0x45,0x43]
};

function createFrameBuffer() {
  return Buffer.alloc(DISPLAY_FRAME_BYTES, 0xff);
}

function fillRect(buffer, x, y, w, h) {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      setPixel(buffer, xx, yy);
    }
  }
}

function setPixel(buffer, x, y, black = true) {
  if (!black || x < 0 || y < 0 || x >= DISPLAY_WIDTH || y >= DISPLAY_HEIGHT) {
    return;
  }

  const byteIndex = y * DISPLAY_BYTES_PER_ROW + Math.floor(x / 8);
  const bitMask = 0x80 >> (x % 8);
  buffer[byteIndex] &= ~bitMask;
}

function drawHLine(buffer, x1, x2, y) {
  for (let x = x1; x <= x2; x++) {
    setPixel(buffer, x, y);
  }
}

function drawVLine(buffer, x, y1, y2) {
  for (let y = y1; y <= y2; y++) {
    setPixel(buffer, x, y);
  }
}

function drawRect(buffer, x, y, w, h) {
  drawHLine(buffer, x, x + w - 1, y);
  drawHLine(buffer, x, x + w - 1, y + h - 1);
  drawVLine(buffer, x, y, y + h - 1);
  drawVLine(buffer, x + w - 1, y, y + h - 1);
}

function drawLine(buffer, x1, y1, x2, y2) {
  let dx = Math.abs(x2 - x1);
  let sx = x1 < x2 ? 1 : -1;
  let dy = -Math.abs(y2 - y1);
  let sy = y1 < y2 ? 1 : -1;
  let err = dx + dy;

  while (true) {
    setPixel(buffer, x1, y1);
    if (x1 === x2 && y1 === y2) {
      break;
    }
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x1 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y1 += sy;
    }
  }
}

function drawCircle(buffer, cx, cy, radius) {
  let x = radius;
  let y = 0;
  let err = 0;

  while (x >= y) {
    setPixel(buffer, cx + x, cy + y);
    setPixel(buffer, cx + y, cy + x);
    setPixel(buffer, cx - y, cy + x);
    setPixel(buffer, cx - x, cy + y);
    setPixel(buffer, cx - x, cy - y);
    setPixel(buffer, cx - y, cy - x);
    setPixel(buffer, cx + y, cy - x);
    setPixel(buffer, cx + x, cy - y);
    y++;
    if (err <= 0) {
      err += 2 * y + 1;
    } else {
      x--;
      err -= 2 * x + 1;
    }
  }
}

function fillCircle(buffer, cx, cy, radius) {
  for (let y = -radius; y <= radius; y++) {
    for (let x = -radius; x <= radius; x++) {
      if ((x * x) + (y * y) <= radius * radius) {
        setPixel(buffer, cx + x, cy + y);
      }
    }
  }
}

function drawChar(buffer, x, y, char, scale = 1) {
  const glyph = FONT_5X7[char] || FONT_5X7[' '];
  for (let col = 0; col < 5; col++) {
    const bits = glyph[col];
    for (let row = 0; row < 7; row++) {
      if (bits & (1 << row)) {
        for (let dx = 0; dx < scale; dx++) {
          for (let dy = 0; dy < scale; dy++) {
            setPixel(buffer, x + (col * scale) + dx, y + (row * scale) + dy);
          }
        }
      }
    }
  }
}

function drawText(buffer, x, y, text, scale = 1) {
  const normalized = String(text || '').toUpperCase();
  for (let i = 0; i < normalized.length; i++) {
    drawChar(buffer, x + i * (6 * scale), y, normalized[i], scale);
  }
}

function drawSprite(buffer, x, y, sprite) {
  sprite.forEach((row, rowIndex) => {
    for (let col = 0; col < row.length; col++) {
      if (row[col] !== ' ') {
        setPixel(buffer, x + col, y + rowIndex);
      }
    }
  });
}

function drawSpriteScaled(buffer, x, y, sprite, scale = 1) {
  sprite.forEach((row, rowIndex) => {
    for (let col = 0; col < row.length; col++) {
      if (row[col] === ' ') {
        continue;
      }
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          setPixel(buffer, x + (col * scale) + dx, y + (rowIndex * scale) + dy);
        }
      }
    }
  });
}

function drawDegreeMark(buffer, x, y, scale = 1) {
  const size = 2 * scale;
  drawRect(buffer, x, y, size + 2, size + 2);
}

function shortTimeText(value) {
  return String(value || '').replace(/:\d{2}\s/, ' ').toUpperCase();
}

function hashString(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex');
}

function buildPetData(now, clockData, weatherData, stocksData) {
  const bucket = new Intl.DateTimeFormat('sv-SE', {
    timeZone: clockData.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(now).replace(' ', 'T').slice(0, 15);

  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: clockData.timezone,
    hour: 'numeric',
    hour12: false
  }).format(now));

  const averageDelta = (stocksData || [])
    .filter((item) => typeof item.delta === 'number')
    .reduce((sum, item, _, arr) => sum + (item.delta / arr.length), 0);

  const weatherCode = weatherData?.weatherCode ?? 0;
  const weatherIsGloomy = [51, 53, 55, 61, 63, 65, 71, 73, 75, 95].includes(weatherCode);
  const seed = hashString(`${bucket}-${clockData.date}-${averageDelta.toFixed(2)}-${weatherCode}`);
  const moodRoll = parseInt(seed.slice(0, 2), 16) % 100;

  if (hour >= 22 || hour < 6) {
    return { state: 'sleeping', accessory: 'zzz', mood: 'sleepy' };
  }
  if (averageDelta > 1.5 && moodRoll < 60) {
    return { state: 'smug', accessory: 'money', mood: 'rich' };
  }
  if (averageDelta < -1.5 && moodRoll < 55) {
    return { state: 'judging', accessory: 'none', mood: 'concerned' };
  }
  if (weatherIsGloomy && moodRoll < 50) {
    return { state: 'thinking', accessory: 'cloud', mood: 'gloomy' };
  }

  const cycle = ['staring', 'playing', 'snacking', 'judging', 'thinking', 'idle'];
  const index = parseInt(seed.slice(2, 4), 16) % cycle.length;
  const state = cycle[index];
  const accessory = state === 'playing' ? 'ball' : state === 'snacking' ? 'snack' : 'none';
  return { state, accessory, mood: state };
}

function createRevision(payload) {
  const revisionSource = JSON.stringify({
    layout: payload.layout,
    date: payload.time?.date,
    weather: payload.weather ? {
      temperature: payload.weather.temperature,
      high: payload.weather.high,
      low: payload.weather.low
    } : null,
    stocks: (payload.stocks || []).map((item) => ({
      symbol: item.symbol,
      price: item.price
    })),
    pet: payload.pet
  });

  return crypto.createHash('sha1').update(revisionSource).digest('hex').slice(0, 12);
}

function renderWhiteboardFrame(payload) {
  const buffer = createFrameBuffer();
  const leftWidth = 124;
  const rightStart = 126;
  const dateText = String(payload.time?.date || '').replace(',', '');

  drawRect(buffer, 0, 0, DISPLAY_WIDTH, DISPLAY_HEIGHT);
  drawVLine(buffer, leftWidth, 0, DISPLAY_HEIGHT - 1);

  drawText(buffer, 2, 8, dateText, 2);

  drawHLine(buffer, 8, leftWidth - 8, 34);
  const tempText = `${payload.weather?.temperature ?? '--'}`;
  drawText(buffer, 8, 44, tempText, 3);
  const tempWidth = tempText.length * 18;
  drawDegreeMark(buffer, 12 + tempWidth, 48, 2);
  drawText(buffer, 24 + tempWidth, 44, `HI ${payload.weather?.high ?? '--'}`, 1);
  drawText(buffer, 24 + tempWidth, 56, `LO ${payload.weather?.low ?? '--'}`, 1);

  const stocks = payload.stocks || [];
  stocks.slice(0, 3).forEach((item, index) => {
    const top = 8 + (index * 38);
    drawText(buffer, rightStart + 8, top, item.symbol || '', 1);
    drawText(buffer, rightStart + 8, top + 12, `$${item.price ?? '--'}`, 2);
  });

  drawDeskPet(buffer, 14, 76, payload.pet || {});

  return buffer;
}

function drawDeskPet(buffer, x, y, pet) {
  const faces = {
    idle: '(O_O)',
    staring: '(O_O)',
    sleeping: '(-_-)',
    judging: '(>_<)',
    thinking: '(?_?)',
    smug: '(^_~)',
    playing: '\\(^O^)/'
  };

  let face = faces[pet.state] || faces.idle;
  let accent = '';

  if (pet.accessory === 'money') face = '($_$)';
  if (pet.accessory === 'cloud') face = '(T_T)';
  if (pet.accessory === 'zzz') accent = 'ZZ';
  if (pet.accessory === 'ball') accent = 'O';
  if (pet.accessory === 'snack') accent = '*';

  const faceScale = 3;
  const faceWidth = face.length * (6 * faceScale);
  const faceX = x + Math.max(0, Math.floor((104 - faceWidth) / 2));

  drawText(buffer, faceX, y + 8, face, faceScale);
  if (accent) {
    drawText(buffer, x + 82, y + 2, accent, 1);
  }
}

async function getWhiteboardData() {
  const config = loadWhiteboardConfig();
  const now = new Date();
  const clockData = buildClockData(now, config.widgets.clock.timezone);
  const weatherApi = await fetchJson(`https://api.open-meteo.com/v1/forecast?latitude=${config.widgets.weather.location.latitude}&longitude=${config.widgets.weather.location.longitude}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=${encodeURIComponent(config.widgets.weather.timezone)}`);
    const weatherData = weatherApi.current ? {
      title: config.widgets.weather.title,
      timezone: config.widgets.weather.timezone,
      temperature: Math.round(weatherApi.current.temperature_2m),
      high: weatherApi.daily?.temperature_2m_max?.length ? Math.round(weatherApi.daily.temperature_2m_max[0]) : null,
      low: weatherApi.daily?.temperature_2m_min?.length ? Math.round(weatherApi.daily.temperature_2m_min[0]) : null,
      weatherCode: weatherApi.current.weather_code,
      timestamp: weatherApi.current.time
  } : null;
  const stocksData = await fetchStocks(config.widgets.stocks.symbols);
  return { config, now, clockData, weatherData, stocksData };
}

app.post('/api/device/checkin', (req, res) => {
  const { deviceId, temperature, humidity, tempInside, humidityInside, tempOutside, humidityOutside } = req.body;
  
  const data = JSON.parse(fs.readFileSync(dataFile));
  
  // Support both old single sensor and new dual sensor format
  const reading = {
    deviceId,
    timestamp: new Date().toISOString()
  };
  
  if (tempInside !== undefined && tempOutside !== undefined) {
    reading.tempInside = tempInside;
    reading.humidityInside = humidityInside;
    reading.tempOutside = tempOutside;
    reading.humidityOutside = humidityOutside;
    console.log(`Saved: Inside=${tempInside}°F/${humidityInside}% Outside=${tempOutside}°F/${humidityOutside}%`);
  } else {
    reading.temperature = temperature;
    reading.humidity = humidity;
    console.log(`Saved: ${temperature}°F, ${humidity}%`);
  }
  
  data.push(reading);
  
  if (data.length > 1000) {
    data.shift();
  }
  
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));
  res.json({ status: 'success' });
});

app.get('/api/readings', (req, res) => {
  const data = loadReadings();
  res.json(data.slice(-500)); // Last 500 readings (~40 hours at 5min intervals)
});


app.get('/api/current', (req, res) => {
  const latest = getLatestReading();
  if (!latest) {
    return res.json({ error: 'No data available' });
  }
  res.json({
    tempInside: latest.tempInside || latest.temperature,
    humidityInside: latest.humidityInside || latest.humidity,
    timestamp: latest.timestamp,
    lastUpdate: new Date(latest.timestamp).toLocaleString()
  });
});


app.post('/api/reset', (req, res) => {
  fs.writeFileSync(dataFile, '[]');
  console.log('Data reset - all readings cleared');
  res.json({ status: 'reset complete' });
});

// Proxy for Open-Meteo weather API (Hohenwald, TN: 35.4811, -87.5553)
app.get('/api/weather', (req, res) => {
  const url = 'https://api.open-meteo.com/v1/forecast?latitude=35.4811&longitude=-87.5553&current=temperature_2m,relative_humidity_2m&temperature_unit=fahrenheit&timezone=America/Chicago';
  
  https.get(url, (apiRes) => {
    let data = '';
    apiRes.on('data', (chunk) => data += chunk);
    apiRes.on('end', () => {
      res.json(JSON.parse(data));
    });
  }).on('error', (err) => {
    console.error('Weather API error:', err);
    res.status(500).json({ error: 'Failed to fetch weather' });
  });
});

app.get('/api/whiteboard', async (req, res) => {
  try {
    const { config, now, clockData, weatherData, stocksData } = await getWhiteboardData();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.json(buildWhiteboardPayload(config, now, clockData, weatherData, stocksData));
  } catch (err) {
    console.error('Whiteboard API error:', err);
    res.status(500).json({ error: 'Failed to build whiteboard payload' });
  }
});

app.get('/api/whiteboard/frame', async (req, res) => {
  try {
    const { config, now, clockData, weatherData, stocksData } = await getWhiteboardData();
    const payload = buildWhiteboardPayload(config, now, clockData, weatherData, stocksData);
    const frame = renderWhiteboardFrame(payload);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', frame.length);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('X-Whiteboard-Format', payload.display.format);
    res.setHeader('X-Whiteboard-Width', String(payload.display.width));
    res.setHeader('X-Whiteboard-Height', String(payload.display.height));
    res.setHeader('ETag', payload.display.revision);
    res.send(frame);
  } catch (err) {
    console.error('Whiteboard frame error:', err);
    res.status(500).json({ error: 'Failed to render whiteboard frame' });
  }
});

app.get('/api/whiteboard/config', (req, res) => {
  res.json(loadWhiteboardConfig());
});

app.post('/api/whiteboard/config', async (req, res) => {
  try {
    const currentConfig = loadWhiteboardConfig();
    const clockTimezone = req.body.clockTimezone || currentConfig.widgets.clock.timezone;
    const weatherZip = String(req.body.weatherZip || currentConfig.widgets.weather.zip).trim();
    const stockSymbols = normalizeStockSymbols(req.body.stockSymbols || currentConfig.widgets.stocks.symbols);

    if (!isValidTimezone(clockTimezone)) {
      return res.status(400).json({ error: 'Invalid clock timezone' });
    }

    if (!/^\d{5}$/.test(weatherZip)) {
      return res.status(400).json({ error: 'Weather ZIP must be 5 digits' });
    }

    if (stockSymbols.length === 0) {
      return res.status(400).json({ error: 'At least one stock symbol is required' });
    }

    const location = await fetchZipLocation(weatherZip);
    const nextConfig = {
      ...currentConfig,
      widgets: {
        ...currentConfig.widgets,
        clock: {
          ...currentConfig.widgets.clock,
          timezone: clockTimezone
        },
        weather: {
          ...currentConfig.widgets.weather,
          zip: weatherZip,
          timezone: location.timezone,
          location: {
            city: location.city,
            state: location.state,
            latitude: location.latitude,
            longitude: location.longitude
          }
        },
        stocks: {
          ...currentConfig.widgets.stocks,
          symbols: stockSymbols
        }
      }
    };

    saveWhiteboardConfig(nextConfig);
    res.json({ status: 'ok', config: nextConfig });
  } catch (err) {
    console.error('Whiteboard config update error:', err);
    res.status(500).json({ error: 'Failed to update whiteboard config' });
  }
});

app.get('/whiteboard', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Whiteboard Config</title>
      <style>
        :root {
          --bg: #f4f1ea;
          --card: #fffdf8;
          --ink: #1f1f1f;
          --muted: #6c665f;
          --line: #d9d1c7;
          --accent: #1f6f5f;
          --accent-2: #d9895b;
        }
        body {
          margin: 0;
          font-family: Georgia, "Times New Roman", serif;
          color: var(--ink);
          background:
            radial-gradient(circle at top left, #fff7ea 0, transparent 28%),
            linear-gradient(180deg, #f7f2e8 0%, #efe8dc 100%);
        }
        .wrap {
          max-width: 1100px;
          margin: 0 auto;
          padding: 32px 20px 48px;
        }
        h1, h2 {
          margin: 0 0 12px;
          font-weight: 700;
        }
        p {
          color: var(--muted);
          line-height: 1.5;
        }
        .grid {
          display: grid;
          grid-template-columns: 1.1fr 0.9fr;
          gap: 20px;
          margin-top: 24px;
        }
        .card {
          background: var(--card);
          border: 1px solid var(--line);
          border-radius: 18px;
          padding: 20px;
          box-shadow: 0 8px 28px rgba(38, 32, 24, 0.08);
        }
        label {
          display: block;
          margin: 14px 0 6px;
          font-size: 14px;
          font-weight: 700;
        }
        input, select, button {
          font: inherit;
        }
        input, select {
          width: 100%;
          box-sizing: border-box;
          padding: 12px 14px;
          border-radius: 12px;
          border: 1px solid var(--line);
          background: #fff;
        }
        .stocks-row {
          display: flex;
          gap: 8px;
          margin-top: 10px;
        }
        .stocks-list {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 12px;
        }
        .chip {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 10px;
          border-radius: 999px;
          background: #f1ebe1;
          border: 1px solid var(--line);
          font-size: 14px;
        }
        .chip button {
          border: none;
          background: transparent;
          cursor: pointer;
          color: #8b3a2d;
          padding: 0;
        }
        .actions {
          display: flex;
          gap: 10px;
          margin-top: 20px;
          flex-wrap: wrap;
        }
        .btn {
          border: none;
          border-radius: 999px;
          padding: 12px 18px;
          cursor: pointer;
        }
        .btn-primary {
          background: var(--accent);
          color: white;
        }
        .btn-secondary {
          background: #e9e1d5;
          color: var(--ink);
        }
        .status {
          min-height: 24px;
          margin-top: 12px;
          font-size: 14px;
          color: var(--muted);
        }
        .preview {
          display: flex;
          justify-content: center;
          align-items: center;
          border: 2px solid #222;
          border-radius: 10px;
          background: linear-gradient(180deg, #fbfbf7 0%, #f1f0ea 100%);
          padding: 24px;
          min-height: 0;
        }
        .epaper-shell {
          background: #d8d7d0;
          width: min(100%, 560px);
          padding: 12px;
          border-radius: 18px;
          box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
        }
        .epaper-canvas {
          display: block;
          width: 100%;
          max-width: 100%;
          height: auto;
          aspect-ratio: 250 / 122;
          background: white;
          border: 2px solid #222;
          image-rendering: pixelated;
          image-rendering: crisp-edges;
        }
        .preview-meta {
          font-size: 13px;
          color: var(--muted);
          margin-top: 12px;
        }
        @media (max-width: 900px) {
          .grid {
            grid-template-columns: 1fr;
          }
        }
      </style>
    </head>
    <body>
      <div class="wrap">
        <h1>Whiteboard Widget Editor</h1>
        <p>Manage the whiteboard from the Pi. Update stocks, ZIP code, and timezones here and the NodeMCU can keep fetching the same payload.</p>

        <div class="grid">
          <section class="card">
            <h2>Controls</h2>

            <label for="weatherZip">Weather ZIP</label>
            <input id="weatherZip" maxlength="5" inputmode="numeric" placeholder="37064">

            <label for="clockTimezone">Clock Timezone</label>
            <select id="clockTimezone">
              <option>America/Chicago</option>
              <option>America/New_York</option>
              <option>America/Denver</option>
              <option>America/Los_Angeles</option>
              <option>UTC</option>
            </select>

            <label for="stockSymbolInput">Stocks</label>
            <div class="stocks-row">
              <input id="stockSymbolInput" placeholder="Add symbol like AAPL">
              <button class="btn btn-secondary" type="button" id="addStockBtn">Add</button>
            </div>
            <div class="stocks-list" id="stocksList"></div>

            <div class="actions">
              <button class="btn btn-primary" type="button" id="saveBtn">Save Changes</button>
              <button class="btn btn-secondary" type="button" id="refreshBtn">Reload</button>
            </div>

            <div class="status" id="status"></div>
          </section>

          <section class="card">
            <h2>Whiteboard Preview</h2>
            <div class="preview">
              <div class="epaper-shell">
                <canvas id="previewCanvas" class="epaper-canvas" width="250" height="122"></canvas>
              </div>
            </div>
            <div class="preview-meta" id="previewMeta"></div>
          </section>
        </div>
      </div>

      <script>
        const stocks = [];

        function renderStocks() {
          const list = document.getElementById('stocksList');
          list.innerHTML = '';
          stocks.forEach((symbol, index) => {
            const chip = document.createElement('div');
            chip.className = 'chip';
            chip.innerHTML = '<span>' + symbol + '</span><button type="button" data-index="' + index + '">x</button>';
            list.appendChild(chip);
          });

          list.querySelectorAll('button').forEach((button) => {
            button.addEventListener('click', () => {
              stocks.splice(Number(button.dataset.index), 1);
              renderStocks();
            });
          });
        }

        function setStatus(message, isError) {
          const status = document.getElementById('status');
          status.textContent = message;
          status.style.color = isError ? '#8b1e1e' : '#5f5a54';
        }

        function updatePreview(payload) {
          document.getElementById('previewMeta').textContent =
            'Payload generated at ' + (payload.generatedAt || '--') +
            ' | Revision ' + ((payload.display && payload.display.revision) || '--');
        }

        async function renderFramePreview(payload) {
          const canvas = document.getElementById('previewCanvas');
          const ctx = canvas.getContext('2d');
          const display = payload.display || {};
          const width = Number(display.width || 250);
          const height = Number(display.height || 122);
          const revision = display.revision || String(Date.now());
          const frameUrl = (display.frameUrl || '/api/whiteboard/frame') + '?revision=' + encodeURIComponent(revision);

          canvas.width = width;
          canvas.height = height;
          canvas.style.aspectRatio = width + ' / ' + height;
          ctx.imageSmoothingEnabled = false;

          const response = await fetch(frameUrl);
          const frame = new Uint8Array(await response.arrayBuffer());
          const image = ctx.createImageData(width, height);
          const bytesPerRow = Math.ceil(width / 8);

          for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
              const byteIndex = y * bytesPerRow + Math.floor(x / 8);
              const bitMask = 0x80 >> (x % 8);
              const isBlack = (frame[byteIndex] & bitMask) === 0;
              const pixelIndex = (y * width + x) * 4;
              const shade = isBlack ? 0 : 255;
              image.data[pixelIndex] = shade;
              image.data[pixelIndex + 1] = shade;
              image.data[pixelIndex + 2] = shade;
              image.data[pixelIndex + 3] = 255;
            }
          }

          ctx.putImageData(image, 0, 0);
        }

        async function loadConfig() {
          setStatus('Loading current config...', false);
          const configResponse = await fetch('/api/whiteboard/config', { cache: 'no-store' });
          const config = await configResponse.json();
          document.getElementById('weatherZip').value = config.widgets.weather.zip;
          document.getElementById('clockTimezone').value = config.widgets.clock.timezone;
          stocks.length = 0;
          (config.widgets.stocks.symbols || []).forEach((symbol) => stocks.push(symbol));
          renderStocks();

          const payloadResponse = await fetch('/api/whiteboard', { cache: 'no-store' });
          const payload = await payloadResponse.json();
          updatePreview(payload);
          await renderFramePreview(payload);
          setStatus('Config loaded.', false);
        }

        async function saveConfig() {
          setStatus('Saving changes...', false);
          const response = await fetch('/api/whiteboard/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              weatherZip: document.getElementById('weatherZip').value,
              clockTimezone: document.getElementById('clockTimezone').value,
              stockSymbols: stocks
            })
          });

          const result = await response.json();
          if (!response.ok) {
            setStatus(result.error || 'Save failed.', true);
            return;
          }

          const payloadResponse = await fetch('/api/whiteboard', { cache: 'no-store' });
          const payload = await payloadResponse.json();
          updatePreview(payload);
          await renderFramePreview(payload);
          setStatus('Saved. Whiteboard payload updated.', false);
        }

        document.getElementById('addStockBtn').addEventListener('click', () => {
          const input = document.getElementById('stockSymbolInput');
          const symbol = input.value.trim().toUpperCase();
          if (!symbol) {
            return;
          }
          if (!stocks.includes(symbol)) {
            stocks.push(symbol);
            renderStocks();
          }
          input.value = '';
          input.focus();
        });

        document.getElementById('saveBtn').addEventListener('click', saveConfig);
        document.getElementById('refreshBtn').addEventListener('click', loadConfig);
        loadConfig().catch((error) => {
          console.error(error);
          setStatus('Failed to load whiteboard config.', true);
        });
      </script>
    </body>
    </html>
  `);
});

function renderTactaPage() {
  return `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Tacta Scorekeeper</title>
      <style>
        :root {
          --bg: #070609;
          --bg-2: #120d14;
          --card: rgba(18, 14, 22, 0.88);
          --card-2: rgba(27, 20, 31, 0.92);
          --panel-black: rgba(6, 6, 10, 0.94);
          --ink: #f6f2ff;
          --muted: #b8acc8;
          --line: rgba(186, 162, 255, 0.28);
          --accent: #ff4eb8;
          --accent-dark: #6df2d2;
          --success: #7cff6f;
          --danger: #ff6840;
          --glow-cyan: rgba(82, 215, 255, 0.34);
          --glow-pink: rgba(255, 78, 184, 0.26);
          --glow-yellow: rgba(255, 182, 46, 0.24);
          --shadow: 0 22px 60px rgba(0, 0, 0, 0.38);
          --radius: 22px;
        }

        * {
          box-sizing: border-box;
        }

        body {
          margin: 0;
          font-family: "Avenir Next", "Trebuchet MS", sans-serif;
          color: var(--ink);
          background:
            radial-gradient(circle at 16% 14%, rgba(255, 78, 184, 0.28), transparent 18%),
            radial-gradient(circle at 82% 16%, rgba(82, 215, 255, 0.24), transparent 16%),
            radial-gradient(circle at 56% 74%, rgba(164, 139, 255, 0.18), transparent 20%),
            radial-gradient(circle at 22% 86%, rgba(255, 182, 46, 0.18), transparent 14%),
            linear-gradient(180deg, var(--bg) 0%, var(--bg-2) 100%);
          min-height: 100vh;
          transition: background 180ms ease, color 180ms ease;
        }

        body.player-theme-active {
          background:
            radial-gradient(circle at 18% 16%, rgba(var(--player-rgb), 0.24), transparent 24%),
            radial-gradient(circle at 82% 14%, rgba(var(--player-rgb), 0.16), transparent 22%),
            radial-gradient(circle at 50% 76%, rgba(var(--player-rgb), 0.18), transparent 28%),
            linear-gradient(180deg, rgba(var(--player-rgb), 0.18) 0%, rgba(15, 11, 18, 0.96) 28%, var(--bg-2) 100%);
        }

        .page {
          position: relative;
          max-width: 820px;
          margin: 0 auto;
          padding: 24px 18px 40px;
        }

        .page::before {
          content: "";
          position: fixed;
          inset: 0;
          pointer-events: none;
          background-image:
            linear-gradient(rgba(255, 255, 255, 0.018) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255, 255, 255, 0.018) 1px, transparent 1px);
          background-size: 38px 38px;
          mask-image: radial-gradient(circle at center, black 40%, transparent 100%);
          opacity: 0.22;
        }

        .page::after {
          content: "";
          position: fixed;
          inset: 0;
          pointer-events: none;
          background:
            linear-gradient(124deg, transparent 0 18%, rgba(255, 78, 184, 0.28) 18.6%, transparent 19.2%) 7% 18% / 250px 200px no-repeat,
            linear-gradient(304deg, transparent 0 18%, rgba(255, 78, 184, 0.18) 18.6%, transparent 19.2%) 18% 68% / 240px 180px no-repeat,
            linear-gradient(124deg, transparent 0 18%, rgba(82, 215, 255, 0.24) 18.6%, transparent 19.2%) 80% 11% / 270px 220px no-repeat,
            linear-gradient(304deg, transparent 0 17%, rgba(124, 255, 111, 0.2) 17.6%, transparent 18.2%) 74% 75% / 250px 210px no-repeat,
            linear-gradient(304deg, transparent 0 17%, rgba(255, 182, 46, 0.18) 17.6%, transparent 18.2%) 10% 86% / 220px 180px no-repeat,
            linear-gradient(124deg, transparent 0 17%, rgba(164, 139, 255, 0.18) 17.6%, transparent 18.2%) 88% 54% / 220px 180px no-repeat;
          opacity: 0.82;
        }

        h1, h2, h3 {
          margin: 0;
          font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
          font-weight: 700;
        }

        h2 {
          font-size: 1.18rem;
          margin-bottom: 8px;
        }

        p {
          margin: 0;
          color: var(--muted);
          line-height: 1.55;
        }

        .status {
          margin-bottom: 12px;
          padding: 10px 12px;
          border-radius: 16px;
          background: rgba(16, 13, 21, 0.88);
          border: 1px solid var(--line);
          color: var(--ink);
          font-size: 0.85rem;
          width: 100%;
        }

        .status[data-kind="success"] {
          border-color: rgba(124, 255, 111, 0.44);
          color: #d8ffd3;
          background: rgba(18, 40, 22, 0.9);
        }

        .status[data-kind="error"] {
          border-color: rgba(255, 104, 64, 0.44);
          color: #ffd8d0;
          background: rgba(47, 18, 14, 0.92);
        }

        .score-flash {
          position: fixed;
          left: 50%;
          top: 50%;
          transform: translate(-50%, -50%) scale(0.9);
          min-width: 150px;
          padding: 16px 20px;
          border-radius: 22px;
          background:
            linear-gradient(180deg, rgba(10, 10, 14, 0.98), rgba(7, 7, 11, 0.96)),
            rgba(8, 8, 12, 0.96);
          border: 1px solid rgba(201, 189, 255, 0.24);
          box-shadow:
            0 20px 48px rgba(0, 0, 0, 0.5),
            0 0 28px rgba(82, 215, 255, 0.14);
          text-align: center;
          pointer-events: none;
          z-index: 60;
          opacity: 0;
          transition: opacity 140ms ease, transform 140ms ease;
        }

        .score-flash.visible {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1);
        }

        .score-flash::before {
          content: "";
          position: absolute;
          inset: 8px;
          pointer-events: none;
          border-radius: 16px;
          background:
            linear-gradient(135deg, transparent 0 16%, rgba(255, 255, 255, 0.28) 16.8%, transparent 17.6%) top left / 38% 40% no-repeat,
            linear-gradient(315deg, transparent 0 16%, rgba(255, 255, 255, 0.22) 16.8%, transparent 17.6%) bottom right / 38% 40% no-repeat,
            linear-gradient(90deg, rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.05));
          mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
          -webkit-mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
          padding: 1px;
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          opacity: 0.86;
        }

        .score-flash-value {
          position: relative;
          font-size: 2rem;
          font-weight: 800;
          line-height: 1;
          letter-spacing: 0.04em;
        }

        .score-flash-label {
          position: relative;
          margin-top: 6px;
          font-size: 0.78rem;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--muted);
        }

        .score-flash.play {
          color: #d8ffea;
          border-color: rgba(102, 255, 187, 0.7);
          box-shadow:
            0 20px 48px rgba(0, 0, 0, 0.5),
            0 0 28px rgba(102, 255, 187, 0.22);
        }

        .score-flash.penalty {
          color: #ffd8d2;
          border-color: rgba(255, 109, 87, 0.72);
          box-shadow:
            0 20px 48px rgba(0, 0, 0, 0.5),
            0 0 28px rgba(255, 109, 87, 0.22);
        }

        .view {
          margin-top: 12px;
        }

        .grid {
          display: grid;
          gap: 18px;
        }

        .landing-grid {
          grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
        }

        .room-grid {
          grid-template-columns: 1fr;
          align-items: start;
        }

        .card {
          position: relative;
          overflow: hidden;
          background:
            linear-gradient(180deg, rgba(16, 13, 21, 0.98), rgba(7, 7, 12, 0.98)),
            var(--card);
          border: 1px solid rgba(201, 189, 255, 0.22);
          border-radius: var(--radius);
          padding: 18px;
          box-shadow:
            0 18px 40px rgba(0, 0, 0, 0.42),
            0 0 0 1px rgba(255, 255, 255, 0.03) inset,
            0 0 28px rgba(82, 215, 255, 0.06),
            0 0 30px rgba(255, 78, 184, 0.05);
        }

        .card::before {
          content: "";
          position: absolute;
          inset: 10px;
          border-radius: 16px;
          pointer-events: none;
          background:
            linear-gradient(140deg, rgba(255, 255, 255, 0) 0 18%, rgba(255, 255, 255, 0.22) 18.6%, rgba(255, 255, 255, 0) 19.2%) top left / 44% 46% no-repeat,
            linear-gradient(320deg, rgba(255, 255, 255, 0) 0 18%, rgba(255, 255, 255, 0.16) 18.6%, rgba(255, 255, 255, 0) 19.2%) bottom right / 44% 46% no-repeat,
            linear-gradient(90deg, rgba(82, 215, 255, 0.3), rgba(255, 78, 184, 0.24));
          mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
          -webkit-mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
          padding: 1px;
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          opacity: 0.86;
        }

        .card::after {
          content: "";
          position: absolute;
          inset: 16px;
          pointer-events: none;
          border-radius: 14px;
          background:
            linear-gradient(124deg, transparent 0 13%, rgba(255, 78, 184, 0.48) 13.8%, transparent 14.6%) top left / 34% 26% no-repeat,
            linear-gradient(304deg, transparent 0 13%, rgba(82, 215, 255, 0.44) 13.8%, transparent 14.6%) bottom right / 34% 26% no-repeat,
            linear-gradient(124deg, transparent 0 13%, rgba(255, 182, 46, 0.34) 13.8%, transparent 14.6%) top right / 26% 24% no-repeat,
            linear-gradient(304deg, transparent 0 13%, rgba(124, 255, 111, 0.34) 13.8%, transparent 14.6%) bottom left / 26% 24% no-repeat;
          opacity: 0.7;
        }

        .card + .card {
          margin-top: 18px;
        }

        .stack {
          display: grid;
          gap: 18px;
        }

        .muted {
          color: var(--muted);
        }

        .label {
          display: block;
          margin-bottom: 8px;
          font-size: 0.82rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          font-weight: 700;
          color: var(--muted);
        }

        input, button, select {
          font: inherit;
        }

        input {
          width: 100%;
          padding: 14px 16px;
          border-radius: 16px;
          border: 1px solid rgba(186, 162, 255, 0.3);
          background: rgba(10, 8, 14, 0.92);
          color: var(--ink);
          box-shadow: 0 0 0 1px rgba(82, 215, 255, 0.06) inset;
        }

        .actions-row {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: 14px;
        }

        button {
          border: 0;
          border-radius: 16px;
          padding: 13px 16px;
          cursor: pointer;
          transition: transform 0.14s ease, box-shadow 0.14s ease, opacity 0.14s ease;
        }

        button:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 0 22px rgba(82, 215, 255, 0.18);
        }

        button:disabled {
          cursor: not-allowed;
          opacity: 0.55;
        }

        .primary-btn {
          background:
            linear-gradient(180deg, rgba(10, 10, 14, 0.98), rgba(7, 7, 11, 0.96)),
            var(--panel-black);
          color: var(--ink);
          border: 1px solid rgba(82, 215, 255, 0.34);
          font-weight: 700;
          box-shadow:
            0 0 0 1px rgba(255, 255, 255, 0.04) inset,
            0 0 18px rgba(82, 215, 255, 0.14),
            0 0 22px rgba(255, 78, 184, 0.08);
        }

        .secondary-btn {
          background: rgba(18, 14, 22, 0.92);
          color: var(--ink);
          border: 1px solid var(--line);
          box-shadow: 0 0 16px rgba(164, 139, 255, 0.08);
        }

        .pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 8px 12px;
          border-radius: 999px;
          background: rgba(18, 14, 22, 0.82);
          border: 1px solid var(--line);
          font-size: 0.92rem;
          color: var(--ink);
          box-shadow: 0 0 18px rgba(164, 139, 255, 0.08);
        }

        .compact-top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 12px;
          flex-wrap: wrap;
        }

        .room-meta {
          margin-top: 12px;
        }

        .room-label {
          font-size: 11px;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: #ffe18d;
          font-weight: 700;
          margin-bottom: 4px;
        }

        .compact-code {
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
        }

        .compact-code strong {
          font-size: clamp(1.15rem, 4.8vw, 1.75rem);
          line-height: 1;
          letter-spacing: 0.05em;
          font-family: "Avenir Next", "Segoe UI", "Helvetica Neue", sans-serif;
          font-weight: 700;
        }

        .room-top {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
          flex-wrap: wrap;
        }

        .room-code {
          font-size: clamp(2.1rem, 8vw, 4rem);
          line-height: 0.9;
          letter-spacing: 0.08em;
          margin-top: 10px;
        }

        .summary-row {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          margin-top: 16px;
        }

        .summary-row .pill {
          font-size: 0.84rem;
          padding: 7px 10px;
        }

        .scoreboard {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(165px, 1fr));
          gap: 12px;
          margin-top: 12px;
        }

        .player-card {
          --seat-color: #52d7ff;
          position: relative;
          overflow: hidden;
          border-radius: 18px;
          padding: 14px;
          border: 1px solid rgba(201, 189, 255, 0.18);
          background:
            linear-gradient(180deg, rgba(10, 10, 14, 0.98), rgba(7, 7, 11, 0.96)),
            rgba(12, 10, 17, 0.9);
          box-shadow:
            0 0 0 1px rgba(255, 255, 255, 0.03) inset,
            0 0 18px rgba(164, 139, 255, 0.08),
            0 0 18px color-mix(in srgb, var(--seat-color) 18%, transparent);
        }

        .player-card::before,
        .seat-btn::before,
        .score-focus::before,
        .point-btn::before {
          content: "";
          position: absolute;
          inset: 8px;
          pointer-events: none;
          border-radius: 12px;
          background:
            linear-gradient(135deg, transparent 0 16%, rgba(255, 255, 255, 0.28) 16.8%, transparent 17.6%) top left / 38% 40% no-repeat,
            linear-gradient(315deg, transparent 0 16%, rgba(255, 255, 255, 0.22) 16.8%, transparent 17.6%) bottom right / 38% 40% no-repeat,
            linear-gradient(90deg, rgba(255, 255, 255, 0.24), rgba(255, 255, 255, 0.05));
          mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
          -webkit-mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
          padding: 1px;
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          opacity: 0.78;
        }

        .player-card::after,
        .seat-btn::after,
        .point-btn::after {
          content: "";
          position: absolute;
          inset: 11px;
          pointer-events: none;
          border-radius: 12px;
          background:
            linear-gradient(124deg, transparent 0 18%, var(--seat-color, currentColor) 18.8%, transparent 19.6%) top left / 42% 34% no-repeat,
            linear-gradient(304deg, transparent 0 18%, var(--seat-color, currentColor) 18.8%, transparent 19.6%) bottom right / 42% 34% no-repeat,
            linear-gradient(90deg, transparent 0 44%, color-mix(in srgb, var(--seat-color, currentColor) 90%, white 10%) 44.8%, transparent 45.6%) center / 100% 100% no-repeat;
          opacity: 0.72;
        }

        .player-card.current {
          border-width: 2px;
          box-shadow:
            0 0 20px rgba(109, 242, 210, 0.22),
            0 16px 34px rgba(0, 0, 0, 0.32);
        }

        .player-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }

        .swatch {
          width: 14px;
          height: 14px;
          border-radius: 999px;
          display: inline-block;
          margin-right: 8px;
          border: 1px solid rgba(0, 0, 0, 0.12);
          vertical-align: middle;
          box-shadow: 0 0 12px rgba(255, 255, 255, 0.28);
        }

        .player-name {
          font-weight: 700;
          display: flex;
          align-items: center;
        }

        .player-score {
          font-size: clamp(2.25rem, 9vw, 3.2rem);
          font-weight: 800;
          line-height: 1;
          margin-top: 10px;
        }

        .player-meta {
          margin-top: 6px;
          font-size: 0.82rem;
          color: var(--muted);
        }

        .seat-grid {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
          margin-top: 16px;
        }

        .seat-btn {
          --seat-color: #52d7ff;
          position: relative;
          overflow: hidden;
          text-align: left;
          padding: 14px;
          border-radius: 18px;
          background:
            linear-gradient(180deg, rgba(10, 10, 14, 0.98), rgba(8, 7, 12, 0.96)),
            rgba(12, 10, 17, 0.94);
          border: 2px solid rgba(255, 255, 255, 0.08);
          color: var(--ink);
          box-shadow:
            0 14px 26px rgba(0, 0, 0, 0.28),
            0 0 16px color-mix(in srgb, var(--seat-color) 16%, transparent);
        }

        .seat-btn.taken {
          background:
            linear-gradient(135deg, rgba(255, 182, 46, 0.14), rgba(255, 104, 64, 0.12)),
            rgba(12, 10, 17, 0.96);
          border-style: solid;
          box-shadow:
            0 0 0 1px rgba(255, 182, 46, 0.18) inset,
            0 0 18px rgba(255, 104, 64, 0.08);
        }

        .seat-btn.active {
          box-shadow:
            0 0 22px color-mix(in srgb, var(--seat-color) 34%, transparent),
            0 12px 28px rgba(0, 0, 0, 0.28);
        }

        .seat-status {
          display: inline-block;
          margin-top: 8px;
          padding: 3px 8px;
          border-radius: 999px;
          font-size: 0.72rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          font-weight: 700;
        }

        .seat-status.open {
          color: #d8ffd3;
          background: rgba(30, 82, 44, 0.48);
        }

        .seat-status.taken {
          color: #ffe2b5;
          background: rgba(120, 52, 22, 0.52);
        }

        .seat-btn small {
          display: block;
          margin-top: 6px;
          color: var(--muted);
        }

        .score-controls {
          display: grid;
          gap: 16px;
        }

        .score-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }

        .mini-btn {
          padding: 8px 12px;
          border-radius: 12px;
          font-size: 0.82rem;
          font-weight: 700;
        }

        .points-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 10px;
          margin-top: 14px;
        }

        .point-btn {
          --seat-color: #52d7ff;
          position: relative;
          overflow: hidden;
          padding: 13px 8px;
          border-radius: 18px;
          background:
            linear-gradient(180deg, rgba(10, 10, 14, 0.98), rgba(7, 7, 11, 0.96)),
            var(--panel-black);
          color: #fff;
          font-weight: 800;
          font-size: 1.02rem;
          border: 1px solid rgba(255, 255, 255, 0.12);
        }

        .point-btn.play {
          --seat-color: #66ffbb;
          color: #d8ffea;
          border-color: rgba(102, 255, 187, 0.72);
          box-shadow:
            0 0 0 1px rgba(102, 255, 187, 0.18) inset,
            0 0 20px rgba(102, 255, 187, 0.24);
        }

        .point-btn.penalty {
          --seat-color: #ff6d57;
          color: #ffd8d2;
          border-color: rgba(255, 109, 87, 0.72);
          box-shadow:
            0 0 0 1px rgba(255, 109, 87, 0.18) inset,
            0 0 20px rgba(255, 109, 87, 0.24);
        }

        .score-focus {
          position: relative;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
          padding: 10px 12px;
          border-radius: 16px;
          background:
            linear-gradient(135deg, rgba(255, 78, 184, 0.12), rgba(82, 215, 255, 0.08)),
            rgba(10, 10, 14, 0.92);
          border: 1px solid rgba(186, 162, 255, 0.32);
          box-shadow:
            0 0 20px rgba(164, 139, 255, 0.08) inset,
            0 0 18px rgba(82, 215, 255, 0.08);
        }

        .score-focus-meta {
          display: grid;
          gap: 2px;
          min-width: 0;
        }

        .score-focus-label {
          font-size: 0.72rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
        }

        .score-focus strong {
          display: block;
          font-size: 0.9rem;
          line-height: 1.1;
        }

        .score-focus-value {
          display: grid;
          justify-items: end;
          gap: 2px;
          text-align: right;
        }

        .score-focus .big-score {
          font-size: 0.98rem;
          font-weight: 800;
          line-height: 1;
        }

        .score-sub {
          font-size: 0.72rem;
          color: var(--muted);
          line-height: 1.1;
        }

        .score-card {
          padding-top: 18px;
        }

        .score-card.joined {
          box-shadow:
            0 22px 50px rgba(0, 0, 0, 0.36),
            0 0 26px rgba(82, 215, 255, 0.1);
        }

        body.player-theme-active .score-card.joined {
          border-color: rgba(var(--player-rgb), 0.5);
          box-shadow:
            0 22px 50px rgba(0, 0, 0, 0.34),
            0 0 28px rgba(var(--player-rgb), 0.18);
        }

        body.player-theme-active .score-focus {
          border-color: rgba(var(--player-rgb), 0.42);
          box-shadow:
            0 0 18px rgba(var(--player-rgb), 0.14) inset,
            0 0 18px rgba(var(--player-rgb), 0.08);
        }

        body.leader-theme-active {
          background:
            radial-gradient(circle at 16% 14%, rgba(var(--leader-rgb), 0.24), transparent 20%),
            radial-gradient(circle at 82% 16%, rgba(var(--leader-rgb), 0.16), transparent 18%),
            radial-gradient(circle at 56% 74%, rgba(var(--leader-rgb), 0.14), transparent 22%),
            linear-gradient(180deg, rgba(var(--leader-rgb), 0.18) 0%, rgba(15, 11, 18, 0.96) 28%, var(--bg-2) 100%);
        }

        body.leader-theme-active .score-card.joined,
        body.leader-theme-active .scores-panel {
          border-color: rgba(var(--leader-rgb), 0.44);
          box-shadow:
            0 22px 50px rgba(0, 0, 0, 0.34),
            0 0 28px rgba(var(--leader-rgb), 0.16);
        }

        .control-copy {
          display: none;
        }

        .watch-note {
          margin-top: 12px;
        }

        .game-over-note {
          margin-top: 12px;
          border-color: rgba(255, 182, 46, 0.45);
          background: rgba(60, 35, 10, 0.82);
          color: #ffe2a9;
        }

        .watch-last-points {
          margin-top: 12px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 10px 12px;
          border-radius: 16px;
          background: rgba(18, 14, 22, 0.72);
          border: 1px solid rgba(186, 162, 255, 0.22);
        }

        .watch-last-points-copy {
          min-width: 0;
        }

        .watch-last-points-label {
          font-size: 0.68rem;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--muted);
        }

        .watch-last-points-detail {
          margin-top: 4px;
          font-size: 0.88rem;
          color: var(--ink);
          line-height: 1.15;
        }

        .watch-last-points-value {
          flex: 0 0 auto;
          font-size: 1.2rem;
          font-weight: 800;
          letter-spacing: 0.05em;
          line-height: 1;
        }

        .watch-last-points.play .watch-last-points-value {
          color: #d8ffea;
        }

        .watch-last-points.penalty .watch-last-points-value {
          color: #ffd8d2;
        }

        .last-points {
          position: relative;
          overflow: hidden;
          margin-top: 12px;
          padding: 12px 14px;
          border-radius: 18px;
          background:
            linear-gradient(180deg, rgba(10, 10, 14, 0.98), rgba(7, 7, 11, 0.96)),
            rgba(8, 8, 12, 0.96);
          border: 1px solid rgba(201, 189, 255, 0.2);
          box-shadow:
            0 14px 32px rgba(0, 0, 0, 0.26),
            0 0 22px rgba(82, 215, 255, 0.08);
        }

        .last-points::before {
          content: "";
          position: absolute;
          inset: 8px;
          pointer-events: none;
          border-radius: 14px;
          background:
            linear-gradient(135deg, transparent 0 16%, rgba(255, 255, 255, 0.24) 16.8%, transparent 17.6%) top left / 34% 38% no-repeat,
            linear-gradient(315deg, transparent 0 16%, rgba(255, 255, 255, 0.18) 16.8%, transparent 17.6%) bottom right / 34% 38% no-repeat,
            linear-gradient(90deg, rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.05));
          mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
          -webkit-mask:
            linear-gradient(#000 0 0) content-box,
            linear-gradient(#000 0 0);
          padding: 1px;
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          opacity: 0.76;
        }

        .last-points-row {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
        }

        .last-points-copy {
          min-width: 0;
        }

        .last-points-label {
          font-size: 0.68rem;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--muted);
        }

        .last-points-detail {
          margin-top: 4px;
          font-size: 0.9rem;
          color: var(--ink);
          line-height: 1.2;
        }

        .last-points-time {
          margin-top: 4px;
          font-size: 0.74rem;
          color: var(--muted);
        }

        .last-points-value {
          position: relative;
          flex: 0 0 auto;
          font-size: 1.4rem;
          font-weight: 800;
          letter-spacing: 0.05em;
          line-height: 1;
        }

        .last-points.play {
          border-color: rgba(102, 255, 187, 0.38);
          box-shadow:
            0 14px 32px rgba(0, 0, 0, 0.26),
            0 0 22px rgba(102, 255, 187, 0.14);
        }

        .last-points.play .last-points-value {
          color: #d8ffea;
        }

        .last-points.penalty {
          border-color: rgba(255, 109, 87, 0.38);
          box-shadow:
            0 14px 32px rgba(0, 0, 0, 0.26),
            0 0 22px rgba(255, 109, 87, 0.14);
        }

        .last-points.penalty .last-points-value {
          color: #ffd8d2;
        }

        .scores-panel {
          margin-top: 16px;
        }

        .scores-panel h2 {
          margin-bottom: 0;
        }

        .scoreboard-empty {
          margin-top: 14px;
        }

        .player-progress {
          margin-top: 12px;
        }

        .progress-meta {
          display: flex;
          justify-content: space-between;
          gap: 10px;
          font-size: 0.86rem;
          color: var(--muted);
        }

        .progress-bar {
          margin-top: 8px;
          width: 100%;
          height: 10px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.08);
          overflow: hidden;
        }

        .progress-fill {
          height: 100%;
          border-radius: inherit;
          background: linear-gradient(90deg, rgba(37, 118, 200, 0.85), rgba(37, 184, 207, 0.9));
        }

        .empty {
          margin-top: 14px;
          padding: 16px;
          border-radius: 16px;
          border: 1px dashed rgba(186, 162, 255, 0.3);
          color: var(--muted);
          background: rgba(18, 14, 22, 0.72);
        }

        [hidden] {
          display: none !important;
        }

        @media (max-width: 820px) {
          .room-grid {
            grid-template-columns: 1fr;
          }
        }

        @media (max-width: 560px) {
          .page {
            padding: 10px 10px 24px;
          }

          .hero,
          .card {
            padding: 14px;
            border-radius: 18px;
          }

          .seat-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }

          .points-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
            gap: 8px;
          }

          .score-card.joined {
            position: sticky;
            top: 8px;
            z-index: 20;
          }

          .status {
            padding: 8px 10px;
          }

          .compact-top {
            gap: 10px;
          }

          .compact-code {
            gap: 8px;
          }

          .compact-code strong {
            font-size: 1.35rem;
          }

          .summary-row {
            gap: 8px;
            margin-top: 12px;
          }

          .summary-row .pill {
            font-size: 0.76rem;
            padding: 6px 8px;
          }

          .control-copy,
          .watch-note,
          .scoreboard-empty,
          .empty,
          .player-meta,
          .progress-meta {
            font-size: 0.84rem;
          }

          .player-score {
            font-size: 2rem;
          }

          .point-btn {
            padding: 11px 6px;
            font-size: 0.98rem;
          }

          .score-focus {
            padding: 8px 10px;
            gap: 8px;
          }

          .score-focus-label,
          .score-sub {
            font-size: 0.66rem;
          }

          .score-focus strong {
            font-size: 0.78rem;
          }

          .score-focus .big-score {
            font-size: 0.9rem;
          }

          .actions-row {
            flex-direction: column;
          }

          .actions-row button {
            width: 100%;
          }

          .score-actions {
            justify-content: stretch;
          }

          .score-actions .mini-btn {
            width: 100%;
          }
        }
      </style>
    </head>
    <body>
      <div class="page">
        <div id="status" class="status" hidden></div>
        <div id="scoreFlash" class="score-flash" hidden>
          <div id="scoreFlashValue" class="score-flash-value"></div>
          <div id="scoreFlashLabel" class="score-flash-label"></div>
        </div>

        <section id="landingView" class="view">
          <div class="grid landing-grid">
            <div class="card">
              <h2>Start a new game</h2>
              <div class="actions-row">
                <button id="createGameBtn" class="primary-btn" type="button">New Game</button>
              </div>
            </div>

            <div class="card">
              <h2>Join or Watch</h2>
              <label class="label" for="joinGameInput">4-digit game code</label>
              <input id="joinGameInput" inputmode="numeric" maxlength="4" placeholder="1234" autocomplete="off">
              <div class="actions-row">
                <button id="joinGameBtn" class="primary-btn" type="button">Join Game</button>
                <button id="watchGameBtn" class="secondary-btn" type="button">Watch</button>
              </div>
            </div>
          </div>
        </section>

        <section id="roomView" class="view" hidden>
          <div class="grid room-grid">
            <div class="stack">
              <div id="scoreCard" class="card score-card">
                <div id="scoreControls" class="score-controls" hidden>
                  <div class="score-focus">
                    <div class="score-focus-meta">
                      <span class="score-focus-label">Your score</span>
                      <strong id="currentPlayerLabel">Blue</strong>
                    </div>
                    <div class="score-focus-value">
                      <div class="big-score" id="currentScore">0</div>
                      <div id="currentCardsProgress" class="score-sub">0 of 18 cards</div>
                    </div>
                  </div>

                  <div>
                    <div class="label">Add Points</div>
                    <div class="points-grid">
                      <button class="point-btn play" type="button" data-play="1">+1</button>
                      <button class="point-btn play" type="button" data-play="2">+2</button>
                      <button class="point-btn play" type="button" data-play="3">+3</button>
                      <button class="point-btn play" type="button" data-play="4">+4</button>
                      <button class="point-btn play" type="button" data-play="5">+5</button>
                      <button class="point-btn play" type="button" data-play="6">+6</button>
                    </div>
                  </div>

                  <div>
                    <div class="label">Lose Points</div>
                    <div class="points-grid">
                      <button class="point-btn penalty" type="button" data-penalty="1">-1</button>
                      <button class="point-btn penalty" type="button" data-penalty="2">-2</button>
                      <button class="point-btn penalty" type="button" data-penalty="3">-3</button>
                      <button class="point-btn penalty" type="button" data-penalty="4">-4</button>
                    </div>
                  </div>
                </div>

                <div class="card scores-panel">
                  <h2>Scores</h2>
                  <div id="watchLastPoints" class="watch-last-points" hidden>
                    <div class="watch-last-points-copy">
                      <div class="watch-last-points-label">Last Points</div>
                      <div id="watchLastPointsDetail" class="watch-last-points-detail"></div>
                    </div>
                    <div id="watchLastPointsValue" class="watch-last-points-value"></div>
                  </div>
                  <div id="scoreboard" class="scoreboard"></div>
                  <div id="scoreboardEmpty" class="empty scoreboard-empty" hidden>Waiting for other players to join this game.</div>
                </div>
                <div id="lastPointsCard" class="last-points" hidden>
                  <div class="last-points-row">
                    <div class="last-points-copy">
                      <div class="last-points-label">Last Points</div>
                      <div id="lastPointsDetail" class="last-points-detail"></div>
                      <div id="lastPointsTime" class="last-points-time"></div>
                    </div>
                    <div id="lastPointsValue" class="last-points-value"></div>
                  </div>
                </div>
                <div id="scorePrompt" class="empty">Pick your color below.</div>
                <div id="gameOverNote" class="empty game-over-note" hidden>Game Over</div>

                <div class="room-meta">
                  <div class="compact-top">
                    <div>
                      <div class="room-label">Code</div>
                      <div class="compact-code">
                        <strong id="roomCode">0000</strong>
                      </div>
                    </div>
                    <div class="score-actions" style="margin-top: 0;">
                      <button id="undoBtn" class="secondary-btn mini-btn" type="button">Undo</button>
                      <button id="leaveRoomBtn" class="secondary-btn" type="button">Leave Room</button>
                    </div>
                  </div>

                  <div class="summary-row">
                    <div id="viewerBadge" class="pill">Pick your color</div>
                    <div id="joinedCount" class="pill">0 joined</div>
                    <div id="cardsProgressBadge" class="pill">0 of 0 cards played</div>
                    <div id="updatedBadge" class="pill">Waiting for updates</div>
                  </div>

                  <p id="controlCopy" class="control-copy"></p>
                </div>
              </div>

              <div id="pickerCard" class="card">
                <h2>Choose your color</h2>
                <div id="seatPicker" class="seat-grid"></div>
              </div>

            </div>
          </div>
        </section>
      </div>

      <script>
        const COLORS = ${JSON.stringify(TACTA_COLORS)};
        const colorMap = Object.fromEntries(COLORS.map(function(color) {
          return [color.id, color];
        }));

        const state = {
          clientId: null,
          gameId: null,
          color: null,
          mode: 'player',
          game: null,
          poller: null,
          scoreBusy: false,
          statusTimer: null,
          flashTimer: null
        };

        function sanitizeGameId(value) {
          return String(value || '').replace(/\\D/g, '').slice(0, 4);
        }

        function isValidGameId(value) {
          return /^\\d{4}$/.test(value);
        }

        function isValidColor(value) {
          return COLORS.some(function(color) {
            return color.id === value;
          });
        }

        function getColor(colorId) {
          return colorMap[colorId] || { id: colorId, label: colorId, hex: '#7a6e63' };
        }

        function hexToRgb(hex) {
          const value = String(hex || '').replace('#', '');
          if (value.length !== 6) {
            return '122, 110, 99';
          }

          const r = parseInt(value.slice(0, 2), 16);
          const g = parseInt(value.slice(2, 4), 16);
          const b = parseInt(value.slice(4, 6), 16);
          return [r, g, b].join(', ');
        }

        function applyPlayerTheme(colorId) {
          const body = document.body;
          body.classList.remove('leader-theme-active');
          if (!colorId) {
            body.classList.remove('player-theme-active');
            body.style.removeProperty('--player-rgb');
            return;
          }

          const color = getColor(colorId);
          body.style.setProperty('--player-rgb', hexToRgb(color.hex));
          body.classList.add('player-theme-active');
        }

        function applyLeaderTheme(colorId) {
          const body = document.body;
          body.classList.remove('player-theme-active');
          body.style.removeProperty('--player-rgb');

          if (!colorId) {
            body.classList.remove('leader-theme-active');
            body.style.removeProperty('--leader-rgb');
            return;
          }

          const color = getColor(colorId);
          body.style.setProperty('--leader-rgb', hexToRgb(color.hex));
          body.classList.add('leader-theme-active');
        }

        function getClientId() {
          const existing = localStorage.getItem('tactaClientId');
          if (existing && existing.length >= 8) {
            return existing;
          }

          const nextId = 'tacta-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
          localStorage.setItem('tactaClientId', nextId);
          return nextId;
        }

        function setStatus(message, kind) {
          const status = document.getElementById('status');
          if (state.statusTimer) {
            clearTimeout(state.statusTimer);
            state.statusTimer = null;
          }
          status.hidden = !message;
          status.textContent = message || '';
          status.dataset.kind = kind || '';

          if (message && kind !== 'error') {
            state.statusTimer = setTimeout(function() {
              status.hidden = true;
              status.textContent = '';
              status.dataset.kind = '';
              state.statusTimer = null;
            }, 1400);
          }
        }

        function clearStatus() {
          const status = document.getElementById('status');
          if (state.statusTimer) {
            clearTimeout(state.statusTimer);
            state.statusTimer = null;
          }
          status.hidden = true;
          status.textContent = '';
          status.dataset.kind = '';
        }

        function showScoreFlash(kind, points) {
          const flash = document.getElementById('scoreFlash');
          const value = document.getElementById('scoreFlashValue');
          const label = document.getElementById('scoreFlashLabel');

          if (state.flashTimer) {
            clearTimeout(state.flashTimer);
            state.flashTimer = null;
          }

          flash.classList.remove('play', 'penalty', 'visible');
          flash.hidden = false;
          flash.classList.add(kind);
          value.textContent = (kind === 'play' ? '+' : '-') + String(points);
          label.textContent = kind === 'play' ? 'Points Added' : 'Points Lost';

          requestAnimationFrame(function() {
            flash.classList.add('visible');
          });

          state.flashTimer = setTimeout(function() {
            flash.classList.remove('visible');
            state.flashTimer = setTimeout(function() {
              flash.hidden = true;
              flash.classList.remove('play', 'penalty');
              state.flashTimer = null;
            }, 150);
          }, 4000);
        }

        function syncUrl() {
          const url = new URL(window.location.href);

          if (state.gameId) {
            url.searchParams.set('game', state.gameId);
          } else {
            url.searchParams.delete('game');
          }

          if (state.color) {
            url.searchParams.set('color', state.color);
          } else {
            url.searchParams.delete('color');
          }

          if (state.mode === 'spectator') {
            url.searchParams.set('view', 'spectator');
          } else {
            url.searchParams.delete('view');
          }

          history.replaceState(null, '', url.pathname + url.search);
        }

        function persistSelection() {
          if (state.gameId) {
            localStorage.setItem('tactaGameId', state.gameId);
          } else {
            localStorage.removeItem('tactaGameId');
          }

          if (state.color) {
            localStorage.setItem('tactaColor', state.color);
          } else {
            localStorage.removeItem('tactaColor');
          }

          localStorage.setItem('tactaMode', state.mode);

          syncUrl();
        }

        function hydrateSelection() {
          state.clientId = getClientId();
          const params = new URLSearchParams(window.location.search);
          const paramGame = sanitizeGameId(params.get('game'));
          const paramColor = String(params.get('color') || '').trim().toLowerCase();
          const paramMode = String(params.get('view') || '').trim().toLowerCase();
          const storedGame = sanitizeGameId(localStorage.getItem('tactaGameId'));
          const storedColor = String(localStorage.getItem('tactaColor') || '').trim().toLowerCase();
          const storedMode = String(localStorage.getItem('tactaMode') || '').trim().toLowerCase();

          state.gameId = isValidGameId(paramGame) ? paramGame : (isValidGameId(storedGame) ? storedGame : null);
          state.color = isValidColor(paramColor) ? paramColor : (isValidColor(storedColor) ? storedColor : null);
          state.mode = state.color
            ? 'player'
            : (paramMode === 'spectator' || storedMode === 'spectator' ? 'spectator' : 'player');

          document.getElementById('joinGameInput').value = state.gameId || '';
        }

        function showView(name) {
          document.getElementById('landingView').hidden = name !== 'landing';
          document.getElementById('roomView').hidden = name !== 'room';
          if (name !== 'room') {
            applyPlayerTheme(null);
          }
        }

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }

        function formatTime(value) {
          if (!value) {
            return 'Waiting for updates';
          }

          try {
            return new Date(value).toLocaleTimeString([], {
              hour: 'numeric',
              minute: '2-digit'
            });
          } catch (err) {
            return 'Waiting for updates';
          }
        }

        function getLatestScoreAction(game) {
          return (game.actions || []).find(function(action) {
            return action && (action.kind === 'play' || action.kind === 'penalty');
          }) || null;
        }

        function getLatestRelevantScoreAction(game) {
          if (!game) {
            return null;
          }

          if (state.color) {
            return (game.actions || []).find(function(action) {
              return action &&
                action.color === state.color &&
                (action.kind === 'play' || action.kind === 'penalty');
            }) || null;
          }

          if (state.mode === 'spectator') {
            return getLatestScoreAction(game);
          }

          return null;
        }

        function getLeaderState(game) {
          const joinedPlayers = (game.players || []).filter(function(player) {
            return player.joined;
          });

          if (!joinedPlayers.length) {
            return null;
          }

          const topScore = joinedPlayers.reduce(function(max, player) {
            return Math.max(max, Number(player.score) || 0);
          }, Number.NEGATIVE_INFINITY);

          const leaders = joinedPlayers.filter(function(player) {
            return (Number(player.score) || 0) === topScore;
          });

          return {
            topScore,
            leaders,
            isTie: leaders.length > 1
          };
        }

        function renderLastPoints(game) {
          const card = document.getElementById('lastPointsCard');
          const detail = document.getElementById('lastPointsDetail');
          const time = document.getElementById('lastPointsTime');
          const value = document.getElementById('lastPointsValue');
          const action = getLatestRelevantScoreAction(game);

          if (!action) {
            card.hidden = true;
            card.classList.remove('play', 'penalty');
            detail.textContent = '';
            time.textContent = '';
            value.textContent = '';
            return;
          }

          const actor = getColor(action.color);
          const points = Math.max(Number(action.points) || Math.abs(Number(action.scoreDelta) || 0), 0);
          const prefix = action.kind === 'play' ? '+' : '-';
          const isViewer = Boolean(state.color && action.color === state.color);

          card.hidden = false;
          card.classList.remove('play', 'penalty');
          card.classList.add(action.kind === 'play' ? 'play' : 'penalty');
          value.textContent = prefix + String(points);

          if (state.mode === 'spectator' && !state.color) {
            detail.textContent = actor.label + (action.kind === 'play'
              ? ' added ' + points + ' points'
              : ' took -' + points + ' points');
          } else if (isViewer) {
            detail.textContent = action.kind === 'play'
              ? 'You added ' + points + ' points'
              : 'You took -' + points + ' points';
          } else {
            detail.textContent = actor.label + (action.kind === 'play'
              ? ' added ' + points + ' points'
              : ' took -' + points + ' points');
          }

          time.textContent = 'Updated ' + formatTime(action.at);
        }

        function renderWatchLastPoints(game) {
          const card = document.getElementById('watchLastPoints');
          const detail = document.getElementById('watchLastPointsDetail');
          const value = document.getElementById('watchLastPointsValue');

          if (!(state.mode === 'spectator' && !state.color)) {
            card.hidden = true;
            card.classList.remove('play', 'penalty');
            detail.textContent = '';
            value.textContent = '';
            return;
          }

          const action = getLatestScoreAction(game);
          if (!action) {
            card.hidden = true;
            card.classList.remove('play', 'penalty');
            detail.textContent = '';
            value.textContent = '';
            return;
          }

          const actor = getColor(action.color);
          const points = Math.max(Number(action.points) || Math.abs(Number(action.scoreDelta) || 0), 0);
          const prefix = action.kind === 'play' ? '+' : '-';

          card.hidden = false;
          card.classList.remove('play', 'penalty');
          card.classList.add(action.kind === 'play' ? 'play' : 'penalty');
          detail.textContent = actor.label + ' ' + prefix + points;
          value.textContent = prefix + String(points);
        }

        function updateActionButtons() {
          const disabled = !state.color || state.scoreBusy || !state.game || state.game.gameOver;
          document.querySelectorAll('[data-play], [data-penalty]').forEach(function(button) {
            button.disabled = disabled;
          });
          const undoBtn = document.getElementById('undoBtn');
          if (undoBtn) {
            undoBtn.disabled = !state.color || state.scoreBusy || !state.game || !state.game.viewerCanUndo;
          }
        }

        function renderSeatPicker(game) {
          const picker = document.getElementById('seatPicker');
          picker.innerHTML = game.players.map(function(player) {
            const activeClass = player.color === state.color ? 'active' : '';
            const takenClass = player.joined ? ' taken' : '';
            const seatStatusClass = player.joined ? 'taken' : 'open';
            const seatStatusLabel = player.joined ? 'Taken' : 'Open';
            const seatMeta = player.joined
              ? 'Already chosen - ' + player.score + ' pts saved'
              : 'Available';

            return '<button class="seat-btn ' + activeClass + takenClass + '" type="button" data-color="' + player.color + '" style="border-color:' + player.hex + '; --seat-color:' + player.hex + ';">'
              + '<strong><span class="swatch" style="background:' + player.hex + ';"></span>' + escapeHtml(player.label) + '</strong>'
              + '<span class="seat-status ' + seatStatusClass + '">' + seatStatusLabel + '</span>'
              + '<small>' + escapeHtml(seatMeta) + '</small>'
              + '</button>';
          }).join('');

          picker.querySelectorAll('[data-color]').forEach(function(button) {
            button.addEventListener('click', function() {
              chooseColor(button.getAttribute('data-color'));
            });
          });
        }

        function renderScoreboard(game) {
          const scoreboard = document.getElementById('scoreboard');
          const empty = document.getElementById('scoreboardEmpty');
          const players = game.players.filter(function(player) {
            if (!player.joined) {
              return false;
            }

            if (state.mode === 'spectator') {
              return true;
            }

            return player.color !== state.color;
          });

          if (!players.length) {
            scoreboard.innerHTML = '';
            empty.hidden = false;
            return;
          }

          empty.hidden = true;
          scoreboard.innerHTML = players.map(function(player) {
            const currentClass = player.color === state.color ? ' current' : '';
            const progressPercent = Math.max(0, Math.min(100, (player.cardsPlayed / game.cardsPerPlayer) * 100));

            return '<div class="player-card' + currentClass + '" style="border-color:' + player.hex + '; --seat-color:' + player.hex + ';">'
              + '<div class="player-head">'
              + '<div class="player-name"><span class="swatch" style="background:' + player.hex + ';"></span>' + escapeHtml(player.label) + '</div>'
              + '<span class="muted">' + player.cardsPlayed + '/' + game.cardsPerPlayer + ' cards</span>'
              + '</div>'
              + '<div class="player-score">' + player.score + '</div>'
              + '<div class="player-meta">Current score</div>'
              + '<div class="player-progress">'
              + '<div class="progress-meta"><span>' + player.cardsPlayed + ' played</span><span>' + player.cardsRemaining + ' left</span></div>'
              + '<div class="progress-bar"><div class="progress-fill" style="width:' + progressPercent + '%; background:' + player.hex + ';"></div></div>'
              + '</div>'
              + '</div>';
          }).join('');
        }

        function renderCurrentPlayer(game) {
          const prompt = document.getElementById('scorePrompt');
          const gameOverNote = document.getElementById('gameOverNote');
          const controls = document.getElementById('scoreControls');
          const pickerCard = document.getElementById('pickerCard');
          const scoreCard = document.getElementById('scoreCard');
          const leaderState = getLeaderState(game);

          if (state.mode === 'spectator' && !state.color) {
            applyLeaderTheme(leaderState && !leaderState.isTie ? leaderState.leaders[0].color : null);
            prompt.hidden = true;
            gameOverNote.hidden = !game.gameOver;
            controls.hidden = true;
            pickerCard.hidden = true;
            scoreCard.classList.add('joined');
            updateActionButtons();
            return;
          }

          if (!state.color) {
            applyPlayerTheme(null);
            prompt.hidden = false;
            gameOverNote.hidden = !game.gameOver;
            controls.hidden = true;
            pickerCard.hidden = false;
            scoreCard.classList.remove('joined');
            updateActionButtons();
            return;
          }

          const player = game.players.find(function(entry) {
            return entry.color === state.color;
          });
          const color = getColor(state.color);

          applyPlayerTheme(state.color);
          prompt.hidden = true;
          gameOverNote.hidden = !game.gameOver;
          controls.hidden = false;
          pickerCard.hidden = true;
          scoreCard.classList.add('joined');
          document.getElementById('currentPlayerLabel').textContent = color.label;
          document.getElementById('currentScore').textContent = player ? player.score : 0;
          document.getElementById('currentCardsProgress').textContent = (player ? player.cardsPlayed : 0) + ' of ' + game.cardsPerPlayer + ' cards';
          updateActionButtons();
        }

        function renderGame(game) {
          state.game = game;
          document.getElementById('roomCode').textContent = game.id;
          document.getElementById('joinGameInput').value = game.id;
          document.getElementById('joinedCount').textContent = game.players.filter(function(player) {
            return player.joined;
          }).length + ' joined';
          document.getElementById('cardsProgressBadge').textContent = game.totalCardsPlayed + ' of ' + game.totalCardsAvailable + ' cards played';
          document.getElementById('updatedBadge').textContent = 'Updated ' + formatTime(game.updatedAt);

          if (state.color) {
            const currentColor = getColor(state.color);
            document.getElementById('viewerBadge').innerHTML = '<span class="swatch" style="background:' + currentColor.hex + ';"></span>You are ' + escapeHtml(currentColor.label);
          } else if (state.mode === 'spectator') {
            document.getElementById('viewerBadge').textContent = 'Watching scores';
          } else {
            document.getElementById('viewerBadge').textContent = 'Pick your color';
          }

          renderSeatPicker(game);
          renderWatchLastPoints(game);
          renderScoreboard(game);
          renderLastPoints(game);
          renderCurrentPlayer(game);
          showView('room');
        }

        function clearLocalSelection() {
          state.game = null;
          state.gameId = null;
          state.color = null;
          state.mode = 'player';
          persistSelection();
        }

        function stopPolling() {
          if (state.poller) {
            clearInterval(state.poller);
            state.poller = null;
          }
        }

        function startPolling() {
          stopPolling();
          if (!state.gameId) {
            return;
          }

          state.poller = setInterval(function() {
            if (!state.gameId || state.scoreBusy) {
              return;
            }
            refreshGame(true);
          }, 3000);
        }

        async function apiJson(url, options) {
          const response = await fetch(url, Object.assign({ cache: 'no-store' }, options || {}));
          const data = await response.json().catch(function() {
            return {};
          });

          if (!response.ok) {
            throw new Error(data.error || 'Request failed');
          }

          return data;
        }

        async function refreshGame(silent) {
          if (!state.gameId) {
            return;
          }

          try {
            const params = new URLSearchParams();
            if (state.color) {
              params.set('color', state.color);
            }
            params.set('viewerId', state.clientId);
            const suffix = params.toString() ? '?' + params.toString() : '';
            const data = await apiJson('/api/tacta/games/' + encodeURIComponent(state.gameId) + suffix);
            renderGame(data.game);
            if (!silent) {
              setStatus('Room ' + state.gameId + ' is ready.', 'success');
            }
          } catch (err) {
            stopPolling();
            clearLocalSelection();
            showView('landing');
            document.getElementById('joinGameInput').value = '';
            setStatus(err.message === 'Game not found'
              ? 'That game code is gone or expired. Rooms only stick around for about a day.'
              : err.message, 'error');
          }
        }

        async function createGame() {
          try {
            setStatus('Creating a new game room...');
            const data = await apiJson('/api/tacta/games', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({})
            });

            state.gameId = data.game.id;
            state.color = null;
            state.mode = 'player';
            persistSelection();
            renderGame(data.game);
            startPolling();
            clearStatus();
          } catch (err) {
            setStatus(err.message, 'error');
          }
        }

        async function joinGame(watchOnly) {
          const gameId = sanitizeGameId(document.getElementById('joinGameInput').value);
          document.getElementById('joinGameInput').value = gameId;

          if (!isValidGameId(gameId)) {
            setStatus('Enter a 4-digit game code.', 'error');
            return;
          }

          state.gameId = gameId;
          state.mode = watchOnly ? 'spectator' : 'player';
          if (watchOnly) {
            state.color = null;
          }
          persistSelection();
          await refreshGame(false);
          if (state.gameId) {
            startPolling();
          }
        }

        async function chooseColor(color) {
          if (!state.gameId || !isValidColor(color)) {
            return;
          }

          try {
            setStatus('Joining ' + getColor(color).label + '...');
            const data = await apiJson('/api/tacta/join', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                gameId: state.gameId,
                color: color,
                clientId: state.clientId
              })
            });

            state.color = color;
            state.mode = 'player';
            persistSelection();
            renderGame(data.game);
            clearStatus();
          } catch (err) {
            setStatus(err.message, 'error');
          }
        }

        async function applyScore(kind, points) {
          if (!state.gameId || !state.color) {
            return;
          }

          state.scoreBusy = true;
          updateActionButtons();

          try {
            const endpoint = kind === 'play' ? '/api/tacta/play' : '/api/tacta/penalty';
            const data = await apiJson(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                gameId: state.gameId,
                color: state.color,
                clientId: state.clientId,
                points: points
              })
            });

            renderGame(data.game);
            showScoreFlash(kind, points);
            clearStatus();
          } catch (err) {
            setStatus(err.message, 'error');
          } finally {
            state.scoreBusy = false;
            updateActionButtons();
          }
        }

        async function undoLastAction() {
          if (!state.gameId || !state.color || !state.game || !state.game.viewerCanUndo) {
            return;
          }

          state.scoreBusy = true;
          updateActionButtons();

          try {
            const data = await apiJson('/api/tacta/undo', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                gameId: state.gameId,
                color: state.color,
                clientId: state.clientId
              })
            });

            renderGame(data.game);
            clearStatus();
          } catch (err) {
            setStatus(err.message, 'error');
          } finally {
            state.scoreBusy = false;
            updateActionButtons();
          }
        }

        function leaveRoom() {
          stopPolling();
          clearLocalSelection();
          showView('landing');
          document.getElementById('joinGameInput').value = '';
          clearStatus();
        }

        document.getElementById('createGameBtn').addEventListener('click', createGame);
        document.getElementById('joinGameBtn').addEventListener('click', function() {
          joinGame(false);
        });
        document.getElementById('watchGameBtn').addEventListener('click', function() {
          joinGame(true);
        });
        document.getElementById('joinGameInput').addEventListener('input', function(event) {
          event.target.value = sanitizeGameId(event.target.value);
        });
        document.getElementById('joinGameInput').addEventListener('keydown', function(event) {
          if (event.key === 'Enter') {
            joinGame(false);
          }
        });
        document.getElementById('leaveRoomBtn').addEventListener('click', leaveRoom);
        document.getElementById('undoBtn').addEventListener('click', undoLastAction);

        document.querySelectorAll('[data-play]').forEach(function(button) {
          button.addEventListener('click', function() {
            applyScore('play', Number(button.getAttribute('data-play')));
          });
        });

        document.querySelectorAll('[data-penalty]').forEach(function(button) {
          button.addEventListener('click', function() {
            applyScore('penalty', Number(button.getAttribute('data-penalty')));
          });
        });

        hydrateSelection();
        updateActionButtons();

        if (state.gameId) {
          showView('room');
          refreshGame(true);
          startPolling();
        } else {
          showView('landing');
        }
      </script>
    </body>
    </html>
  `;
}

app.post('/api/tacta/games', (req, res) => {
  try {
    const store = loadFreshTactaStore();
    const gameId = createTactaGameId(store);
    const game = createTactaGame(gameId);

    store.games[gameId] = game;
    saveTactaStore(store);

    res.setHeader('Cache-Control', 'no-store');
    res.json({ game: buildTactaGameState(game) });
  } catch (err) {
    console.error('Tacta create game error:', err);
    res.status(500).json({ error: 'Failed to create a game' });
  }
});

app.get('/api/tacta/games/:gameId', (req, res) => {
  const gameId = String(req.params.gameId || '').trim();
  const viewerColor = String(req.query.color || '').trim().toLowerCase();
  const viewerId = String(req.query.viewerId || '').trim();

  if (!isValidTactaGameId(gameId)) {
    return res.status(400).json({ error: 'Game code must be 4 digits' });
  }

  const store = loadFreshTactaStore();
  const game = store.games[gameId];

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  const safeGame = normalizeTactaGame(game);
  let changed = false;
  if (isValidTactaColor(viewerColor) && isValidTactaClientId(viewerId)) {
    const player = safeGame.players[viewerColor];
    if (player && player.holderId === viewerId) {
      const nowIso = new Date().toISOString();
      player.lastSeenAt = nowIso;
      player.updatedAt = nowIso;
      safeGame.updatedAt = nowIso;
      store.games[gameId] = safeGame;
      changed = true;
    }
  }
  if (changed) {
    saveTactaStore(store);
  }

  res.setHeader('Cache-Control', 'no-store');
  res.json({ game: buildTactaGameState(changed ? safeGame : game, viewerColor, viewerId) });
});

app.post('/api/tacta/join', (req, res) => {
  const gameId = String(req.body.gameId || '').trim();
  const color = String(req.body.color || '').trim().toLowerCase();
  const clientId = String(req.body.clientId || '').trim();

  if (!isValidTactaGameId(gameId)) {
    return res.status(400).json({ error: 'Game code must be 4 digits' });
  }

  if (!isValidTactaColor(color)) {
    return res.status(400).json({ error: 'Pick a valid player color' });
  }

  if (!isValidTactaClientId(clientId)) {
    return res.status(400).json({ error: 'Missing phone identity for this color pick' });
  }

  const store = loadFreshTactaStore();
  const game = store.games[gameId];

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  const safeGame = normalizeTactaGame(game);
  const nowIso = new Date().toISOString();
  ensureTactaPlayer(safeGame, color, nowIso, clientId);
  safeGame.updatedAt = nowIso;

  store.games[gameId] = safeGame;
  saveTactaStore(store);

  res.setHeader('Cache-Control', 'no-store');
  res.json({ game: buildTactaGameState(safeGame, color, clientId) });
});

app.post('/api/tacta/play', (req, res) => {
  const gameId = String(req.body.gameId || '').trim();
  const color = String(req.body.color || '').trim().toLowerCase();
  const clientId = String(req.body.clientId || '').trim();
  const points = Number(req.body.points);

  if (!isValidTactaGameId(gameId)) {
    return res.status(400).json({ error: 'Game code must be 4 digits' });
  }

  if (!isValidTactaColor(color)) {
    return res.status(400).json({ error: 'Pick a valid player color' });
  }

  if (!isValidTactaClientId(clientId)) {
    return res.status(400).json({ error: 'Missing phone identity for this score update' });
  }

  if (!Number.isInteger(points) || points < 1 || points > 6) {
    return res.status(400).json({ error: 'Playing Card points must be between 1 and 6' });
  }

  const store = loadFreshTactaStore();
  const game = store.games[gameId];

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  const safeGame = normalizeTactaGame(game);
  if (isTactaGameOver(safeGame)) {
    return res.status(409).json({ error: 'Game over' });
  }

  const nowIso = new Date().toISOString();
  const existing = safeGame.players[color];
  if (tactaSeatHeldByOther(existing, clientId)) {
    return res.status(409).json({ error: 'That color is in use on another phone' });
  }

  const player = ensureTactaPlayer(safeGame, color, nowIso, clientId);
  const scoreDelta = points;
  const cardsDelta = 1;
  player.score += scoreDelta;
  player.cardsPlayed += cardsDelta;
  player.lastSeenAt = nowIso;
  player.updatedAt = nowIso;
  safeGame.updatedAt = nowIso;
  appendDetailedTactaAction(safeGame, {
    color,
    clientId,
    kind: 'play',
    points,
    scoreDelta,
    cardsDelta,
    at: nowIso
  });

  store.games[gameId] = safeGame;
  saveTactaStore(store);

  res.setHeader('Cache-Control', 'no-store');
  res.json({ game: buildTactaGameState(safeGame, color, clientId) });
});

app.post('/api/tacta/penalty', (req, res) => {
  const gameId = String(req.body.gameId || '').trim();
  const color = String(req.body.color || '').trim().toLowerCase();
  const clientId = String(req.body.clientId || '').trim();
  const points = Number(req.body.points);

  if (!isValidTactaGameId(gameId)) {
    return res.status(400).json({ error: 'Game code must be 4 digits' });
  }

  if (!isValidTactaColor(color)) {
    return res.status(400).json({ error: 'Pick a valid player color' });
  }

  if (!isValidTactaClientId(clientId)) {
    return res.status(400).json({ error: 'Missing phone identity for this score update' });
  }

  if (!Number.isInteger(points) || points < 1 || points > 4) {
    return res.status(400).json({ error: 'Being Played Upon points must be between 1 and 4' });
  }

  const store = loadFreshTactaStore();
  const game = store.games[gameId];

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  const safeGame = normalizeTactaGame(game);
  if (isTactaGameOver(safeGame)) {
    return res.status(409).json({ error: 'Game over' });
  }

  const nowIso = new Date().toISOString();
  const existing = safeGame.players[color];
  if (tactaSeatHeldByOther(existing, clientId)) {
    return res.status(409).json({ error: 'That color is in use on another phone' });
  }

  const player = ensureTactaPlayer(safeGame, color, nowIso, clientId);
  const nextScore = Math.max(0, player.score - points);
  const scoreDelta = nextScore - player.score;
  player.score = nextScore;
  player.lastSeenAt = nowIso;
  player.updatedAt = nowIso;
  safeGame.updatedAt = nowIso;
  appendDetailedTactaAction(safeGame, {
    color,
    clientId,
    kind: 'penalty',
    points,
    scoreDelta,
    cardsDelta: 0,
    at: nowIso
  });

  store.games[gameId] = safeGame;
  saveTactaStore(store);

  res.setHeader('Cache-Control', 'no-store');
  res.json({ game: buildTactaGameState(safeGame, color, clientId) });
});

app.post('/api/tacta/undo', (req, res) => {
  const gameId = String(req.body.gameId || '').trim();
  const color = String(req.body.color || '').trim().toLowerCase();
  const clientId = String(req.body.clientId || '').trim();

  if (!isValidTactaGameId(gameId)) {
    return res.status(400).json({ error: 'Game code must be 4 digits' });
  }

  if (!isValidTactaColor(color)) {
    return res.status(400).json({ error: 'Pick a valid player color' });
  }

  if (!isValidTactaClientId(clientId)) {
    return res.status(400).json({ error: 'Missing phone identity for this undo' });
  }

  const store = loadFreshTactaStore();
  const game = store.games[gameId];

  if (!game) {
    return res.status(404).json({ error: 'Game not found' });
  }

  const safeGame = normalizeTactaGame(game);
  const player = safeGame.players[color];

  if (!player) {
    return res.status(404).json({ error: 'No saved score for that color' });
  }

  if (tactaSeatHeldByOther(player, clientId)) {
    return res.status(409).json({ error: 'That color is in use on another phone' });
  }

  const actionIndex = (safeGame.actions || []).findIndex((action) =>
    action &&
    action.clientId === clientId &&
    action.color === color &&
    (action.kind === 'play' || action.kind === 'penalty')
  );

  if (actionIndex === -1) {
    return res.status(409).json({ error: 'Nothing to undo' });
  }

  const action = safeGame.actions[actionIndex];
  const nowIso = new Date().toISOString();
  player.score = Math.max(0, player.score - (Number(action.scoreDelta) || 0));
  player.cardsPlayed = Math.max(0, player.cardsPlayed - (Number(action.cardsDelta) || 0));
  player.lastSeenAt = nowIso;
  player.updatedAt = nowIso;
  safeGame.updatedAt = nowIso;
  safeGame.actions.splice(actionIndex, 1);

  store.games[gameId] = safeGame;
  saveTactaStore(store);

  res.setHeader('Cache-Control', 'no-store');
  res.json({ game: buildTactaGameState(safeGame, color, clientId) });
});

app.get('/tacta', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.send(renderTactaPage());
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Cabin Temps</title>
      <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns"></script>
      <script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-annotation@2.2.1"></script>
      <style>
        body { font-family: Arial; margin: 20px; background: #f0f0f0; }
        .container { max-width: 1400px; margin: 0 auto; }
        .card { background: white; padding: 20px; margin: 10px 0; border-radius: 8px; }
        .chart-container { position: relative; height: 400px; }
        .filters { display: flex; gap: 10px; margin-bottom: 20px; flex-wrap: wrap; }
        button { padding: 10px 20px; cursor: pointer; border: 1px solid #ccc; background: white; border-radius: 4px; }
        button.active { background: #007bff; color: white; border-color: #007bff; }
        .current { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .sensor { text-align: center; }
        .sensor h2 { margin: 0 0 10px 0; font-size: 20px; color: #333; }
        .sensor-data { display: flex; gap: 20px; font-size: 32px; font-weight: bold; justify-content: center; }
        .temp { color: #d9534f; }
        .hum { color: #5bc0de; }
        .diff { font-size: 18px; color: #666; margin-top: 10px; text-align: center; }
        .weather-credit { font-size: 11px; color: #999; text-align: center; margin-top: 5px; }
        .last-updated { font-size: 14px; color: #999; text-align: center; margin-top: 10px; }
        .trend { font-size: 20px; font-weight: bold; text-align: center; margin-top: 15px; padding: 10px; }
        .trend.rising { color: #d9534f; }
        .trend.falling { color: #5bc0de; }
        .trend.steady { color: #999; }
        .charts-section { max-height: 0; overflow: hidden; transition: max-height 0.3s ease; }
        .charts-section.expanded { max-height: 2000px; }
        .toggle-btn { width: 100%; padding: 12px; margin-bottom: 10px; background: #6c757d; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 16px; }
        .toggle-btn:hover { background: #5a6268; }
        
        @media (max-width: 768px) {
          body { margin: 10px; }
          .container { padding: 0; }
          .card { padding: 15px; margin: 5px 0; }
          .chart-container { height: 250px; }
          .current { grid-template-columns: 1fr; gap: 15px; }
          .sensor h2 { font-size: 18px; }
          .sensor-data { font-size: 28px; gap: 15px; }
          .filters { gap: 5px; }
          button { padding: 8px 12px; font-size: 14px; flex: 1 1 calc(33.333% - 5px); min-width: 80px; }
          h1 { font-size: 24px; margin: 10px 0; }
          h3 { font-size: 16px; }
        }
        
        @media (max-width: 480px) {
          .sensor-data { font-size: 24px; gap: 10px; }
          .button { flex: 1 1 calc(50% - 5px); }
          .chart-container { height: 220px; }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🏠 Cabin Monitor</h1>
        
        <div class="card">
          <div class="current">
            <div class="sensor">
              <h2>🏠 Inside</h2>
              <div class="sensor-data">
                <div class="temp" id="currentTempIn">--°F</div>
                <div class="hum" id="currentHumIn">--%</div>
              </div>
            </div>
            <div class="sensor">
              <h2>🌲 Outside</h2>
              <div class="sensor-data">
                <div class="temp" id="currentTempOut">--°F</div>
                <div class="hum" id="currentHumOut">--%</div>
              </div>
            </div>
          </div>
          <div class="diff" id="tempDiff"></div>
          <div class="last-updated" id="lastUpdated">Last updated: --</div>
          <div class="trend" id="trend">Trend: --</div>
          <div class="last-updated" id="trendDetail">--</div>
        </div>

        <button class="toggle-btn" onclick="toggleCharts()">📊 Show Detailed Charts</button>

        <div class="charts-section" id="chartsSection">
          <div class="card">
            <div class="filters">
              <button onclick="filter('1h')">1 Hour</button>
              <button onclick="filter('6h')">6 Hours</button>
              <button onclick="filter('24h')" class="active">24 Hours</button>
              <button onclick="filter('3d')">3 Days</button>
              <button onclick="filter('all')">All</button>
              <button onclick="resetData()" style="margin-left: auto; background: #dc3545; color: white; border-color: #dc3545;">Reset Data</button>
            </div>
          </div>

          <div class="card">
            <h3 style="margin-top: 0;">Inside Temperature</h3>
            <div class="chart-container">
              <canvas id="tempChart"></canvas>
            </div>
          </div>

          <div class="card">
            <h3 style="margin-top: 0;">Inside Humidity</h3>
            <div class="chart-container">
              <canvas id="humChart"></canvas>
            </div>
          </div>
        </div>
      </div>

      <script>
        let allData = [];
        let tempChart, humChart;
        let chartsExpanded = false;

        function toggleCharts() {
          const section = document.getElementById('chartsSection');
          const btn = document.querySelector('.toggle-btn');
          chartsExpanded = !chartsExpanded;
          
          if (chartsExpanded) {
            section.classList.add('expanded');
            btn.textContent = '📊 Hide Detailed Charts';
          } else {
            section.classList.remove('expanded');
            btn.textContent = '📊 Show Detailed Charts';
          }
        }

        function calculateTrend(data) {
          if (data.length < 10) return { text: 'Trend: Not enough data', class: 'steady', diff: 0 };
          
          // Get current temp
          const latest = data[data.length - 1];
          const currentTemp = latest.tempInside !== undefined ? latest.tempInside : latest.temperature;
          
          // Calculate 3-hour average (36 readings at 5min intervals) - EXCLUDING current reading
          const threeHoursAgo = Date.now() - (3 * 60 * 60 * 1000);
          const recentData = data.slice(0, -1).filter(r => new Date(r.timestamp).getTime() > threeHoursAgo);
          
          if (recentData.length < 5) return { text: 'Trend: Steady →', class: 'steady', diff: 0 };
          
          const avgTemp = recentData.reduce((sum, r) => {
            const temp = r.tempInside !== undefined ? r.tempInside : r.temperature;
            return sum + temp;
          }, 0) / recentData.length;
          
          const diff = currentTemp - avgTemp;
          
          if (diff > 1.0) {
            return { text: '↗️ Rising (' + diff.toFixed(1) + '°F in 3h)', class: 'rising', diff: diff };
          } else if (diff < -1.0) {
            return { text: '↘️ Falling (' + Math.abs(diff).toFixed(1) + '°F in 3h)', class: 'falling', diff: diff };
          } else {
            return { text: '→ Steady', class: 'steady', diff: diff };
          }
        }

        // Fetch sensor data
        fetch('/api/readings')
          .then(r => r.json())
          .then(data => {
            allData = data;
            filter('24h');
          });

        // Fetch outside weather
        function updateOutsideWeather() {
          fetch('/api/weather')
            .then(r => r.json())
            .then(data => {
              const temp = data.current.temperature_2m;
              const hum = data.current.relative_humidity_2m;
              document.getElementById('currentTempOut').textContent = temp.toFixed(1) + '°F';
              document.getElementById('currentHumOut').textContent = hum.toFixed(0) + '%';
              
              // Update temperature difference
              const insideTempEl = document.getElementById('currentTempIn').textContent;
              if (insideTempEl !== '--°F') {
                const insideTemp = parseFloat(insideTempEl);
                const diff = insideTemp - temp;
                document.getElementById('tempDiff').textContent = 
                  'Temperature difference: ' + Math.abs(diff).toFixed(1) + '°F ' + 
                  (diff > 0 ? '(warmer inside)' : '(warmer outside)');
              }
            })
            .catch(err => console.error('Weather fetch error:', err));
        }
        
        updateOutsideWeather();
        setInterval(updateOutsideWeather, 300000); // Update every 5 minutes

        function filter(period) {
          document.querySelectorAll('button').forEach(b => b.classList.remove('active'));
          document.querySelectorAll('button').forEach(b => {
            if (b.textContent.includes(period.replace('h', ' Hour').replace('d', ' Day').replace('all', 'All'))) {
              b.classList.add('active');
            }
          });

          const now = Date.now();
          const periods = {
            '1h': 60 * 60 * 1000,
            '6h': 6 * 60 * 60 * 1000,
            '24h': 24 * 60 * 60 * 1000,
            '3d': 3 * 24 * 60 * 60 * 1000,
            'all': Infinity
          };

          const filtered = allData.filter(r => 
            now - new Date(r.timestamp).getTime() < periods[period]
          );

          updateCharts(filtered);
          updateCurrent(filtered);
          
          // Update trend with all data (not just filtered)
          const trend = calculateTrend(allData);
          const trendEl = document.getElementById('trend');
          trendEl.textContent = trend.text;
          trendEl.className = 'trend ' + trend.class;
          
          // Show exact difference
          const trendDetailEl = document.getElementById('trendDetail');
          const sign = trend.diff >= 0 ? '+' : '';
          trendDetailEl.textContent = sign + trend.diff.toFixed(1) + '° from 3h average';
        }

        function resetData() {
          if (confirm('Are you sure you want to delete all temperature data? This cannot be undone.')) {
            fetch('/api/reset', { method: 'POST' })
              .then(r => r.json())
              .then(() => {
                alert('Data reset complete!');
                allData = [];
                updateCharts([]);
                document.getElementById('currentTempIn').textContent = '--°F';
                document.getElementById('currentHumIn').textContent = '--%';
                document.getElementById('tempDiff').textContent = '';
              });
          }
        }

        function updateCurrent(data) {
          if (data.length === 0) return;
          const latest = data[data.length - 1];
          
          // Update last updated timestamp
          const lastUpdate = new Date(latest.timestamp);
          const now = new Date();
          const diffMinutes = Math.floor((now - lastUpdate) / 60000);
          let timeAgo;
          if (diffMinutes < 1) {
            timeAgo = 'just now';
          } else if (diffMinutes === 1) {
            timeAgo = '1 minute ago';
          } else if (diffMinutes < 60) {
            timeAgo = diffMinutes + ' minutes ago';
          } else {
            const hours = Math.floor(diffMinutes / 60);
            timeAgo = hours === 1 ? '1 hour ago' : hours + ' hours ago';
          }
          document.getElementById('lastUpdated').textContent = 'Last updated: ' + timeAgo;
          
          // Check if we have dual sensor data
          if (latest.tempInside !== undefined) {
            document.getElementById('currentTempIn').textContent = latest.tempInside.toFixed(1) + '°F';
            document.getElementById('currentHumIn').textContent = latest.humidityInside.toFixed(0) + '%';
          } else {
            // Fallback to old single sensor data
            document.getElementById('currentTempIn').textContent = latest.temperature.toFixed(1) + '°F';
            document.getElementById('currentHumIn').textContent = latest.humidity.toFixed(0) + '%';
          }
        }

        function aggregateData(data, minutes) {
          if (data.length === 0) return [];
          
          const buckets = {};
          data.forEach(point => {
            const time = new Date(point.x);
            const bucketTime = new Date(Math.floor(time.getTime() / (minutes * 60000)) * (minutes * 60000));
            const key = bucketTime.getTime();
            
            if (!buckets[key]) {
              buckets[key] = { temps: [], hums: [], time: bucketTime };
            }
            buckets[key].temps.push(point.temp);
            buckets[key].hums.push(point.hum);
          });
          
          return Object.values(buckets).map(bucket => ({
            x: bucket.time,
            temp: bucket.temps.reduce((a, b) => a + b, 0) / bucket.temps.length,
            hum: bucket.hums.reduce((a, b) => a + b, 0) / bucket.hums.length
          })).sort((a, b) => a.x - b.x);
        }

        function updateCharts(data) {
          // Check if we have dual sensor data
          const hasDualSensor = data.some(r => r.tempInside !== undefined);
          
          let rawData;
          if (hasDualSensor) {
            rawData = data
              .filter(r => r.tempInside !== undefined)
              .map(r => ({
                x: new Date(r.timestamp),
                temp: r.tempInside,
                hum: r.humidityInside
              }));
          } else {
            rawData = data.map(r => ({
              x: new Date(r.timestamp),
              temp: r.temperature,
              hum: r.humidity
            }));
          }
          
          // Aggregate based on time range
          const activeBtn = document.querySelector('button.active').textContent;
          let chartData;
          if (activeBtn.includes('1 Hour')) {
            chartData = rawData; // No aggregation for 1 hour
          } else if (activeBtn.includes('6 Hours')) {
            chartData = aggregateData(rawData, 10); // 10 min averages
          } else if (activeBtn.includes('24 Hours')) {
            chartData = aggregateData(rawData, 30); // 30 min averages
          } else if (activeBtn.includes('3 Days')) {
            chartData = aggregateData(rawData, 60); // 1 hour averages
          } else {
            chartData = aggregateData(rawData, 120); // 2 hour averages for "All"
          }

          // Calculate temperature range
          const temps = chartData.map(d => d.temp);
          const minTemp = Math.min(...temps);
          const maxTemp = Math.max(...temps);
          const tempMin = minTemp < 30 ? Math.floor(minTemp / 5) * 5 : 30;
          const tempMax = maxTemp > 85 ? Math.ceil(maxTemp / 5) * 5 : 85;

          // Temperature Chart
          if (tempChart) tempChart.destroy();
          tempChart = new Chart(document.getElementById('tempChart'), {
            type: 'line',
            data: {
              datasets: [{
                label: '🏠 Inside',
                data: chartData.map(d => ({ x: d.x, y: d.temp })),
                borderColor: '#d9534f',
                backgroundColor: 'rgba(217, 83, 79, 0.1)',
                tension: 0.4,
                pointRadius: 2,
                borderWidth: 2
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              interaction: {
                intersect: false,
                mode: 'index'
              },
              scales: {
                x: {
                  type: 'time',
                  time: {
                    displayFormats: {
                      hour: 'MMM d, ha',
                      day: 'MMM d'
                    }
                  },
                  ticks: {
                    maxTicksLimit: 8
                  }
                },
                y: {
                  min: tempMin,
                  max: tempMax,
                  title: {
                    display: true,
                    text: 'Temperature (°F)'
                  }
                }
              },
              plugins: {
                legend: {
                  display: true,
                  labels: {
                    font: { size: 14 }
                  }
                },
                annotation: {
                  annotations: tempMin < 32 ? {
                    freezing: {
                      type: 'box',
                      yMin: tempMin,
                      yMax: 32,
                      backgroundColor: 'rgba(173, 216, 230, 0.3)',
                      borderWidth: 0
                    }
                  } : {}
                }
              }
            }
          });

          // Humidity Chart
          if (humChart) humChart.destroy();
          humChart = new Chart(document.getElementById('humChart'), {
            type: 'line',
            data: {
              datasets: [{
                label: '🏠 Inside',
                data: chartData.map(d => ({ x: d.x, y: d.hum })),
                borderColor: '#5bc0de',
                backgroundColor: 'rgba(91, 192, 222, 0.1)',
                tension: 0.4,
                pointRadius: 2,
                borderWidth: 2
              }]
            },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              interaction: {
                intersect: false,
                mode: 'index'
              },
              scales: {
                x: {
                  type: 'time',
                  time: {
                    displayFormats: {
                      hour: 'MMM d, ha',
                      day: 'MMM d'
                    }
                  },
                  ticks: {
                    maxTicksLimit: 8
                  }
                },
                y: {
                  min: 0,
                  max: 100,
                  title: {
                    display: true,
                    text: 'Humidity (%)'
                  }
                }
              },
              plugins: {
                legend: {
                  display: true,
                  labels: {
                    font: { size: 14 }
                  }
                }
              }
            }
          });
        }

        setInterval(() => {
          fetch('/api/readings')
            .then(r => r.json())
            .then(data => {
              allData = data;
              const activeBtn = document.querySelector('button.active').textContent;
              const period = activeBtn.includes('1 Hour') ? '1h' : 
                            activeBtn.includes('6 Hours') ? '6h' :
                            activeBtn.includes('24 Hours') ? '24h' :
                            activeBtn.includes('3 Days') ? '3d' : 'all';
              
              const now = Date.now();
              const periods = {
                '1h': 60 * 60 * 1000,
                '6h': 6 * 60 * 60 * 1000,
                '24h': 24 * 60 * 60 * 1000,
                '3d': 3 * 24 * 60 * 60 * 1000,
                'all': Infinity
              };
              
              const filtered = data.filter(r => 
                now - new Date(r.timestamp).getTime() < periods[period]
              );
              
              updateCharts(filtered);
              updateCurrent(filtered);
            });
        }, 60000);
      </script>
    </body>
    </html>
  `);
});

app.listen(3000, () => console.log('Server running on port 3000'));
