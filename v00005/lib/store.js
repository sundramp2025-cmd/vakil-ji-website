const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.STORE_DIR || path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const RESULTS_FILE = path.join(DATA_DIR, 'results.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  ensureDir();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  fs.renameSync(temp, file);
}

function defaultState() {
  return {
    connectedSite: null,
    discoveredVideos: [],
    discoveryCount: 0,
    status: 'IDLE',
    mode: 'ONCE',
    cycle: 0,
    nextIndex: 0,
    lastError: null,
    progress: {
      total: 0,
      checked: 0,
      passed: 0,
      failed: 0,
      adSeen: 0,
      skipped: 0,
      currentBatch: 0,
      totalBatches: 0,
      startedAt: null,
      finishedAt: null,
      lastActivityAt: null
    }
  };
}

function getState() {
  return { ...defaultState(), ...readJson(STATE_FILE, defaultState()) };
}
function saveState(state) { writeJson(STATE_FILE, state); }
function getResults() { return readJson(RESULTS_FILE, []); }
function saveResults(results) { writeJson(RESULTS_FILE, results); }
function getHistory() { return readJson(HISTORY_FILE, []); }
function saveHistory(history) { writeJson(HISTORY_FILE, history.slice(-200)); }

module.exports = { getState, saveState, getResults, saveResults, getHistory, saveHistory };
