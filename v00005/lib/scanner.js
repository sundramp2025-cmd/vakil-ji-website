const { chromium } = require('playwright');
const { getState, saveState, getResults, saveResults, getHistory, saveHistory } = require('./store');

let activeRun = null;
let stopRequested = false;
let pauseRequested = false;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function cfg() {
  return {
    batchSize: Math.max(1, Number(process.env.BATCH_SIZE || 300)),
    concurrency: Math.max(1, Math.min(30, Number(process.env.CONCURRENCY || 10))),
    pageTimeout: Number(process.env.PAGE_TIMEOUT || 30000),
    watchTime: Number(process.env.VIDEO_WATCH_TIME || 5000),
    cycleDelay: Number(process.env.CYCLE_DELAY_MS || 1800000),
    maxResults: Number(process.env.MAX_RESULTS || 25000)
  };
}
function genericItemId(index) { return `Item ${String(index + 1).padStart(4, '0')}`; }

async function visibleAdState(page) {
  return await page.evaluate(() => {
    const visible = el => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 20 && r.height > 20 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0;
    };
    const nodes = [...document.querySelectorAll('iframe,[id*="ad" i],[class*="ad-" i],[class*="advert" i],[data-ad],[data-zone]')];
    return nodes.some(visible);
  }).catch(() => false);
}

async function clickLegitimateSkip(page) {
  const selectors = [
    'button[aria-label*="skip" i]',
    'button[title*="skip" i]',
    '[class*="skip" i]:is(button,a,[role="button"])',
    '[id*="skip" i]:is(button,a,[role="button"])',
    'button[aria-label*="close ad" i]',
    '[class*="close" i][class*="ad" i]:is(button,a,[role="button"])'
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      if (await locator.isVisible({ timeout: 700 })) {
        await locator.click({ timeout: 2500 });
        return true;
      }
    } catch {}
  }
  return false;
}

async function startPlayback(page) {
  const video = page.locator('video').first();
  await video.waitFor({ state: 'attached', timeout: 15000 });
  const playButtons = ['button[aria-label="Play"]','button[aria-label*="play video" i]','.vjs-big-play-button','.jw-icon-playback','[class*="play-button" i]'];
  for (const selector of playButtons) {
    try {
      const b = page.locator(selector).first();
      if (await b.isVisible({ timeout: 500 })) { await b.click({ timeout: 2000 }); await sleep(600); break; }
    } catch {}
  }
  await page.evaluate(async () => {
    const v = document.querySelector('video');
    if (!v) throw new Error('Video element not found');
    v.muted = true;
    try { await v.play(); } catch {}
  });
  return video;
}

async function testOne(browser, url, absoluteIndex) {
  const c = cfg();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(c.pageTimeout);
  const startedAt = Date.now();
  const result = { index:absoluteIndex, item:genericItemId(absoluteIndex), pageLoaded:false, pageLoadMs:null, adDetected:false, adDelayMs:null, skipDetected:false, videoFound:false, videoPlayed:false, videoProgressSeconds:0, bufferEvents:0, requestFailureCount:0, consoleErrorCount:0, status:'FAIL', error:null, testedAt:new Date().toISOString() };
  page.on('console', msg => { if (msg.type() === 'error') result.consoleErrorCount += 1; });
  page.on('requestfailed', () => { result.requestFailureCount += 1; });
  try {
    await page.goto(url, { waitUntil:'domcontentloaded', timeout:c.pageTimeout });
    result.pageLoaded = true;
    result.pageLoadMs = Date.now() - startedAt;
    const adStart = Date.now();
    for (let i = 0; i < 20; i++) { if (await visibleAdState(page)) { result.adDetected = true; result.adDelayMs = Date.now() - adStart; break; } await sleep(500); }
    for (let i = 0; i < 20; i++) { if (await clickLegitimateSkip(page)) { result.skipDetected = true; break; } await sleep(500); }
    const video = await startPlayback(page);
    result.videoFound = true;
    const startTime = await video.evaluate(v => Number(v.currentTime || 0));
    let last = startTime; let stalledSamples = 0;
    for (let elapsed = 0; elapsed < c.watchTime; elapsed += 1000) {
      await sleep(1000);
      const now = await video.evaluate(v => Number(v.currentTime || 0));
      if (now <= last + 0.05) stalledSamples += 1; else stalledSamples = 0;
      if (stalledSamples === 2) result.bufferEvents += 1;
      last = now;
    }
    const endTime = await video.evaluate(v => Number(v.currentTime || 0));
    result.videoProgressSeconds = Math.max(0, endTime - startTime);
    result.videoPlayed = result.videoProgressSeconds > 2;
    if (result.pageLoaded && result.videoPlayed) result.status = 'PASS';
    else {
      const p = [];
      if (!result.pageLoaded) p.push('PAGE_LOAD_FAILED');
      if (!result.videoFound) p.push('VIDEO_NOT_FOUND');
      if (!result.videoPlayed) p.push('VIDEO_NOT_PLAYING');
      result.error = p.join(', ') || 'CHECK_FAILED';
    }
  } catch (err) {
    result.error = String(err.message || err).slice(0,240).replace(/https?:\/\/\S+/gi,'[redacted]');
  } finally { await context.close().catch(() => {}); }
  return result;
}

function appendResult(r) {
  const c = cfg();
  const results = getResults();
  results.push(r);
  saveResults(results.slice(-c.maxResults));
}

async function runBatch(browser, urls, baseIndex) {
  const c = cfg(); let next = 0;
  async function worker() {
    while (!stopRequested) {
      while (pauseRequested && !stopRequested) await sleep(1000);
      const i = next++;
      if (i >= urls.length) return;
      const result = await testOne(browser, urls[i], baseIndex + i);
      appendResult(result);
      const s = getState();
      s.progress.checked += 1;
      if (result.status === 'PASS') s.progress.passed += 1; else s.progress.failed += 1;
      if (result.adDetected) s.progress.adSeen += 1;
      if (result.skipDetected) s.progress.skipped += 1;
      s.nextIndex = baseIndex + i + 1;
      s.progress.lastActivityAt = new Date().toISOString();
      saveState(s);
    }
  }
  await Promise.all(Array.from({ length: Math.min(c.concurrency, urls.length) }, worker));
}

function saveCycleSummary(state) {
  const history = getHistory();
  history.push({ cycle:state.cycle, total:state.progress.total, checked:state.progress.checked, passed:state.progress.passed, failed:state.progress.failed, adSeen:state.progress.adSeen, skipped:state.progress.skipped, startedAt:state.progress.startedAt, finishedAt:state.progress.finishedAt });
  saveHistory(history);
}

async function executeLoop() {
  const c = cfg();
  const browser = await chromium.launch({ headless:true, args:['--disable-dev-shm-usage','--no-sandbox','--disable-gpu'] });
  try {
    while (!stopRequested) {
      let s = getState();
      const urls = s.discoveredVideos || [];
      if (!urls.length) throw new Error('No items discovered');
      if (s.nextIndex >= urls.length || s.nextIndex < 0) {
        s.nextIndex = 0;
        s.cycle = (s.cycle || 0) + 1;
        s.progress = { total:urls.length, checked:0, passed:0, failed:0, adSeen:0, skipped:0, currentBatch:0, totalBatches:Math.ceil(urls.length/c.batchSize), startedAt:new Date().toISOString(), finishedAt:null, lastActivityAt:new Date().toISOString() };
        saveState(s);
      }
      while (s.nextIndex < urls.length && !stopRequested) {
        while (pauseRequested && !stopRequested) await sleep(1000);
        s = getState();
        const start = s.nextIndex;
        const batch = urls.slice(start, start + c.batchSize);
        s.status = pauseRequested ? 'PAUSED' : 'RUNNING';
        s.progress.currentBatch = Math.floor(start / c.batchSize) + 1;
        s.progress.lastActivityAt = new Date().toISOString();
        saveState(s);
        await runBatch(browser, batch, start);
        s = getState();
      }
      if (stopRequested) break;
      s = getState();
      s.progress.finishedAt = new Date().toISOString();
      s.progress.lastActivityAt = new Date().toISOString();
      s.status = 'COMPLETE';
      saveState(s);
      saveCycleSummary(s);
      if (s.mode !== 'CONTINUOUS') break;
      await sleep(c.cycleDelay);
      s = getState(); s.nextIndex = 0; s.status = 'RUNNING'; saveState(s);
    }
  } finally { await browser.close().catch(() => {}); }
}

function launch(mode='ONCE', reset=false) {
  if (activeRun) return false;
  stopRequested = false; pauseRequested = false;
  const s = getState(); s.mode = mode; s.status = 'RUNNING'; if (reset) s.nextIndex = 0; s.lastError = null; saveState(s);
  activeRun = executeLoop().catch(err => { const x=getState(); x.status='ERROR'; x.lastError=String(err.message||err).slice(0,240); x.progress.lastActivityAt=new Date().toISOString(); saveState(x); }).finally(()=>{ activeRun=null; });
  return true;
}
function pause(){ pauseRequested=true; const s=getState(); s.status='PAUSED'; saveState(s); }
function resume(){ pauseRequested=false; const s=getState(); if(!activeRun) launch(s.mode||'ONCE',false); else { s.status='RUNNING'; saveState(s); } }
function stop(){ stopRequested=true; pauseRequested=false; const s=getState(); s.status='STOPPING'; saveState(s); }
function isRunning(){ return Boolean(activeRun); }
function recover(){ const s=getState(); if(['RUNNING','PAUSED','STOPPING'].includes(s.status)&&s.discoveredVideos?.length){ s.status='RUNNING'; saveState(s); setTimeout(()=>launch(s.mode||'ONCE',false),2000); } }

module.exports = { launch, pause, resume, stop, isRunning, recover };
