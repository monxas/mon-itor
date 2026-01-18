/**
 * Generic Web Monitor v3
 *
 * Features:
 * - Retry logic with exponential backoff
 * - Per-watch intervals + cron schedules
 * - Proxy support (global and per-watch)
 * - Custom headers/cookies
 * - Conditional actions
 * - Screenshot on error
 * - Isolated browser contexts
 * - Rate limiting/staggering
 * - Health endpoint + Web UI dashboard
 * - Transform chaining
 * - Notification throttling
 * - JSON extractor with JSONPath
 * - Per-extractor comparators
 * - Error notifications after N failures
 * - Diff in notifications
 * - Config validation
 * - Hot reload
 * - Multiple notification channels per watch
 * - Authentication/login flows
 * - Persistent browser sessions
 * - XPath selector support
 *
 * Configuration via JSON files in /config directory
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

// Config directory
const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const STATE_DIR = process.env.STATE_DIR || '/state';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/state/screenshots';
const SESSION_DIR = process.env.SESSION_DIR || '/state/sessions';
const DEFAULT_CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS) || 5 * 60 * 1000;
const HEALTH_PORT = parseInt(process.env.HEALTH_PORT) || 8080;

// Retry config
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES) || 3;
const RETRY_BASE_DELAY_MS = parseInt(process.env.RETRY_BASE_DELAY_MS) || 5000;

// Rate limiting
const STAGGER_DELAY_MS = parseInt(process.env.STAGGER_DELAY_MS) || 2000;

// Notification throttling
const NOTIFICATION_THROTTLE_MS = parseInt(process.env.NOTIFICATION_THROTTLE_MS) || 60000;

// Error notification threshold
const ERROR_NOTIFY_THRESHOLD = parseInt(process.env.ERROR_NOTIFY_THRESHOLD) || 3;

// Notification config (global defaults)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const NTFY_URL = process.env.NTFY_URL;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

// Global state
let browser = null;
let lastCheckResults = {};
let isRunning = false;
let watchTimers = new Map();
let watchCronJobs = new Map();
let notificationTimestamps = new Map();
let errorCounts = new Map();
let configHashes = new Map();
let persistentContexts = new Map();

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Simple JSONPath implementation
 */
function jsonPath(obj, pathStr) {
  if (!pathStr || !obj) return obj;

  // Remove leading $. if present
  const cleanPath = pathStr.replace(/^\$\.?/, '');
  if (!cleanPath) return obj;

  const parts = cleanPath.split(/\.|\[|\]/).filter(p => p !== '');
  let current = obj;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    // Handle array index
    if (/^\d+$/.test(part)) {
      current = current[parseInt(part)];
    } else {
      current = current[part];
    }
  }

  return current;
}

/**
 * Parse cron expression and check if it should run now
 */
function shouldRunCron(cronExpr, lastRun) {
  // Simple cron parser: "minute hour dayOfMonth month dayOfWeek"
  // Supports: numbers, *, */n
  const parts = cronExpr.split(/\s+/);
  if (parts.length !== 5) return false;

  const now = new Date();
  const checks = [
    { value: now.getMinutes(), part: parts[0] },
    { value: now.getHours(), part: parts[1] },
    { value: now.getDate(), part: parts[2] },
    { value: now.getMonth() + 1, part: parts[3] },
    { value: now.getDay(), part: parts[4] }
  ];

  for (const { value, part } of checks) {
    if (part === '*') continue;
    if (part.startsWith('*/')) {
      const interval = parseInt(part.substring(2));
      if (value % interval !== 0) return false;
    } else if (part.includes(',')) {
      const values = part.split(',').map(Number);
      if (!values.includes(value)) return false;
    } else if (part.includes('-')) {
      const [min, max] = part.split('-').map(Number);
      if (value < min || value > max) return false;
    } else {
      if (parseInt(part) !== value) return false;
    }
  }

  // Don't run if we ran in the same minute
  if (lastRun) {
    const lastRunDate = new Date(lastRun);
    if (lastRunDate.getMinutes() === now.getMinutes() &&
        lastRunDate.getHours() === now.getHours() &&
        lastRunDate.getDate() === now.getDate()) {
      return false;
    }
  }

  return true;
}

/**
 * Retry with exponential backoff
 */
async function withRetry(fn, maxRetries = MAX_RETRIES, baseDelay = RETRY_BASE_DELAY_MS) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`    Attempt ${attempt}/${maxRetries} failed: ${error.message}. Retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/**
 * Calculate hash of config for change detection
 */
function hashConfig(config) {
  const relevant = { ...config };
  delete relevant._file;
  delete relevant._hash;
  return crypto.createHash('md5').update(JSON.stringify(relevant)).digest('hex');
}

/**
 * Validate config structure
 */
function validateConfig(config, filename) {
  const errors = [];

  if (!config.url) {
    errors.push('Missing required field: url');
  }

  if (!config.extractors || !Array.isArray(config.extractors) || config.extractors.length === 0) {
    errors.push('Missing or empty extractors array');
  } else {
    for (let i = 0; i < config.extractors.length; i++) {
      const ext = config.extractors[i];
      if (!ext.name) errors.push(`Extractor ${i}: missing name`);
      if (!ext.type) errors.push(`Extractor ${i}: missing type`);
      if (['text', 'innerText', 'attribute', 'value', 'options', 'html', 'outerHtml', 'count', 'exists', 'xpath'].includes(ext.type) && !ext.selector) {
        errors.push(`Extractor ${i} (${ext.name}): missing selector for type ${ext.type}`);
      }
    }
  }

  if (config.schedule && config.interval) {
    errors.push('Cannot specify both schedule (cron) and interval');
  }

  if (errors.length > 0) {
    console.log(`\nConfig validation errors in ${filename}:`);
    errors.forEach(e => console.log(`  - ${e}`));
    return false;
  }

  return true;
}

// ============================================================================
// ELEMENT/PAGE HELPERS
// ============================================================================

async function elementExists(page, selector, checkFrames = true, isXPath = false) {
  try {
    if (isXPath) {
      const elements = await page.$$(`xpath=${selector}`);
      if (elements.length > 0) return true;
    } else {
      const element = await page.$(selector);
      if (element) return true;
    }
  } catch (e) {}

  if (checkFrames) {
    for (const frame of page.frames()) {
      try {
        if (isXPath) {
          const elements = await frame.$$(`xpath=${selector}`);
          if (elements.length > 0) return true;
        } else {
          const element = await frame.$(selector);
          if (element) return true;
        }
      } catch (e) {}
    }
  }
  return false;
}

// ============================================================================
// ACTIONS
// ============================================================================

async function executeActions(page, actions, context = {}) {
  for (const action of actions) {
    if (action.if) {
      const conditionMet = await evaluateCondition(page, action.if, context);
      if (!conditionMet) {
        console.log(`    Skipping action (condition not met): ${action.type}`);
        continue;
      }
    }

    console.log(`  Action: ${action.type} ${action.selector || action.value || ''}`);

    try {
      switch (action.type) {
        case 'wait':
          await page.waitForTimeout(action.ms || 1000);
          break;

        case 'waitForSelector':
          await page.waitForSelector(action.selector, {
            timeout: action.timeout || 30000,
            state: action.state || 'visible'
          });
          break;

        case 'waitForXPath':
          await page.waitForSelector(`xpath=${action.selector}`, {
            timeout: action.timeout || 30000,
            state: action.state || 'visible'
          });
          break;

        case 'waitForNavigation':
          await page.waitForNavigation({
            timeout: action.timeout || 30000,
            waitUntil: action.waitUntil || 'networkidle'
          });
          break;

        case 'click':
          await executeClick(page, action);
          break;

        case 'type':
          await page.fill(action.selector, action.value);
          break;

        case 'typeSlowly':
          await page.type(action.selector, action.value, { delay: action.delay || 50 });
          break;

        case 'pressKey':
          await page.keyboard.press(action.key);
          break;

        case 'select':
          await page.selectOption(action.selector, action.value);
          break;

        case 'hover':
          await page.hover(action.selector);
          break;

        case 'scroll':
          if (action.selector) {
            await page.locator(action.selector).scrollIntoViewIfNeeded();
          } else {
            await page.evaluate(({ x, y }) => window.scrollBy(x, y), {
              x: action.x || 0,
              y: action.y || 500
            });
          }
          break;

        case 'evaluate':
          context.evalResult = await page.evaluate(action.script);
          break;

        case 'screenshot':
          await page.screenshot({
            path: action.path || path.join(SCREENSHOT_DIR, `debug-${Date.now()}.png`),
            fullPage: action.fullPage || false
          });
          break;

        case 'setVariable':
          context[action.name] = action.value;
          break;

        case 'login':
          // Shorthand for common login flow
          if (action.usernameSelector && action.username) {
            await page.fill(action.usernameSelector, action.username);
          }
          if (action.passwordSelector && action.password) {
            await page.fill(action.passwordSelector, action.password);
          }
          if (action.submitSelector) {
            await page.click(action.submitSelector);
            await page.waitForNavigation({ waitUntil: 'networkidle' }).catch(() => {});
          }
          break;

        default:
          console.log(`    Unknown action type: ${action.type}`);
      }
    } catch (e) {
      if (action.optional) {
        console.log(`    Optional action failed (continuing): ${e.message}`);
      } else {
        throw e;
      }
    }

    if (action.delay) {
      await page.waitForTimeout(action.delay);
    }
  }

  return context;
}

async function executeClick(page, action) {
  let clicked = false;
  const isXPath = action.xpath || action.selector?.startsWith('//');
  const selector = isXPath ? `xpath=${action.selector}` : action.selector;

  try {
    const element = await page.$(selector);
    if (element) {
      await element.click();
      clicked = true;
    }
  } catch (e) {}

  if (!clicked && action.checkFrames !== false) {
    for (const frame of page.frames()) {
      try {
        const element = await frame.$(selector);
        if (element) {
          await element.click();
          clicked = true;
          break;
        }
      } catch (e) {}
    }
  }

  if (!clicked && !action.optional) {
    throw new Error(`Could not click ${action.selector}`);
  }
}

async function evaluateCondition(page, condition, context) {
  switch (condition.type) {
    case 'exists':
      return await elementExists(page, condition.selector, condition.checkFrames, condition.xpath);
    case 'notExists':
      return !(await elementExists(page, condition.selector, condition.checkFrames, condition.xpath));
    case 'textContains':
      const text = await page.textContent(condition.selector).catch(() => '');
      return text && text.includes(condition.value);
    case 'variable':
      return !!context[condition.name];
    case 'evaluate':
      return await page.evaluate(condition.script);
    default:
      return true;
  }
}

// ============================================================================
// TRANSFORMS
// ============================================================================

function applySingleTransform(data, transform, options = {}) {
  if (data === null || data === undefined) return data;

  switch (transform) {
    case 'flatten':
      return Array.isArray(data) ? data.flat(options.depth || 1) : data;

    case 'unique':
      if (!Array.isArray(data)) return data;
      return [...new Map(data.map(v =>
        [typeof v === 'object' ? JSON.stringify(v) : v, v]
      )).values()];

    case 'sort':
      if (!Array.isArray(data)) return data;
      if (options.key) {
        return [...data].sort((a, b) => {
          const aVal = a[options.key];
          const bVal = b[options.key];
          return options.desc ? (bVal > aVal ? 1 : -1) : (aVal > bVal ? 1 : -1);
        });
      }
      return [...data].sort();

    case 'reverse':
      return Array.isArray(data) ? [...data].reverse() : data;

    case 'join':
      return Array.isArray(data) ? data.join(options.separator || ', ') : data;

    case 'split':
      return typeof data === 'string' ? data.split(options.separator || ',').map(s => s.trim()) : data;

    case 'first':
      return Array.isArray(data) ? data[0] : data;

    case 'last':
      return Array.isArray(data) ? data[data.length - 1] : data;

    case 'slice':
      return Array.isArray(data) ? data.slice(options.start || 0, options.end) : data;

    case 'filter':
      if (!Array.isArray(data)) return data;
      let result = data;
      if (options.exclude) {
        result = result.filter(d => !options.exclude.includes(typeof d === 'object' ? (d.value || d.text) : d));
      }
      if (options.include) {
        result = result.filter(d => options.include.includes(typeof d === 'object' ? (d.value || d.text) : d));
      }
      return result;

    case 'map':
      if (!Array.isArray(data) || !options.key) return data;
      return data.map(d => typeof d === 'object' ? d[options.key] : d);

    case 'pluck':
      // Alias for map
      if (!Array.isArray(data) || !options.key) return data;
      return data.map(d => typeof d === 'object' ? d[options.key] : d);

    case 'trim':
      if (typeof data === 'string') return data.trim();
      if (Array.isArray(data)) return data.map(d => typeof d === 'string' ? d.trim() : d);
      return data;

    case 'lowercase':
      if (typeof data === 'string') return data.toLowerCase();
      if (Array.isArray(data)) return data.map(d => typeof d === 'string' ? d.toLowerCase() : d);
      return data;

    case 'uppercase':
      if (typeof data === 'string') return data.toUpperCase();
      if (Array.isArray(data)) return data.map(d => typeof d === 'string' ? d.toUpperCase() : d);
      return data;

    case 'regex':
      if (!options.pattern) return data;
      const regex = new RegExp(options.pattern, options.flags || 'g');
      if (typeof data === 'string') {
        const matches = data.match(regex);
        return matches || [];
      }
      return data;

    case 'replace':
      if (!options.pattern || typeof data !== 'string') return data;
      return data.replace(new RegExp(options.pattern, options.flags || 'g'), options.replacement || '');

    case 'parseNumber':
      if (typeof data === 'string') return parseFloat(data.replace(/[^\d.-]/g, '')) || 0;
      if (Array.isArray(data)) return data.map(d => typeof d === 'string' ? parseFloat(d.replace(/[^\d.-]/g, '')) || 0 : d);
      return data;

    case 'parseJson':
      if (typeof data === 'string') {
        try { return JSON.parse(data); } catch (e) { return data; }
      }
      return data;

    case 'jsonPath':
      return jsonPath(data, options.path);

    case 'compact':
      // Remove null/undefined/empty values
      if (Array.isArray(data)) return data.filter(d => d !== null && d !== undefined && d !== '');
      return data;

    default:
      return data;
  }
}

function applyTransforms(data, extractor) {
  if (!extractor.transform && !extractor.transforms) return data;

  if (extractor.transform && !extractor.transforms) {
    return applySingleTransform(data, extractor.transform, extractor.filter || extractor);
  }

  if (extractor.transforms) {
    let result = data;
    for (const t of extractor.transforms) {
      if (typeof t === 'string') {
        result = applySingleTransform(result, t);
      } else {
        result = applySingleTransform(result, t.type, t);
      }
    }
    return result;
  }

  return data;
}

// ============================================================================
// EXTRACTORS
// ============================================================================

async function extractData(page, extractors, pageContent = null) {
  const results = {};

  for (const extractor of extractors) {
    const { name, type, selector, attribute, checkFrames, xpath } = extractor;
    const actualSelector = xpath ? `xpath=${selector}` : selector;

    let data = null;

    try {
      switch (type) {
        case 'text':
          data = await page.$$eval(actualSelector, els => els.map(el => el.textContent.trim()));
          break;

        case 'innerText':
          data = await page.$$eval(actualSelector, els => els.map(el => el.innerText.trim()));
          break;

        case 'attribute':
          data = await page.$$eval(actualSelector, (els, attr) => els.map(el => el.getAttribute(attr)), attribute);
          break;

        case 'value':
          data = await page.$$eval(actualSelector, els => els.map(el => el.value));
          break;

        case 'options':
          data = await page.$$eval(actualSelector, els => {
            const options = [];
            els.forEach(select => {
              select.querySelectorAll('option').forEach(opt => {
                if (opt.value) {
                  options.push({
                    value: opt.value,
                    text: opt.textContent.trim()
                  });
                }
              });
            });
            return options;
          });
          break;

        case 'html':
          data = await page.$$eval(actualSelector, els => els.map(el => el.innerHTML));
          break;

        case 'outerHtml':
          data = await page.$$eval(actualSelector, els => els.map(el => el.outerHTML));
          break;

        case 'count':
          const elements = await page.$$(actualSelector);
          data = elements.length;
          break;

        case 'exists':
          data = await elementExists(page, selector, checkFrames, xpath);
          break;

        case 'url':
          data = page.url();
          break;

        case 'title':
          data = await page.title();
          break;

        case 'xpath':
          // XPath text extraction
          const xpathElements = await page.$$(`xpath=${selector}`);
          data = await Promise.all(xpathElements.map(el => el.textContent()));
          data = data.map(t => t.trim());
          break;

        case 'evaluate':
          data = await page.evaluate(extractor.script);
          break;

        case 'json':
          // Parse page content as JSON and extract with JSONPath
          const bodyText = await page.evaluate(() => document.body.innerText);
          try {
            const jsonData = JSON.parse(bodyText);
            data = extractor.path ? jsonPath(jsonData, extractor.path) : jsonData;
          } catch (e) {
            console.log(`    JSON parse error: ${e.message}`);
            data = null;
          }
          break;

        case 'jsonFromScript':
          // Extract JSON from a script tag
          const scriptContent = await page.$eval(
            selector || 'script[type="application/json"], script[type="application/ld+json"]',
            el => el.textContent
          ).catch(() => null);
          if (scriptContent) {
            try {
              const jsonData = JSON.parse(scriptContent);
              data = extractor.path ? jsonPath(jsonData, extractor.path) : jsonData;
            } catch (e) {
              data = null;
            }
          }
          break;

        case 'screenshot':
          const screenshotPath = extractor.path || path.join(SCREENSHOT_DIR, `${name}-${Date.now()}.png`);
          if (selector) {
            await page.locator(actualSelector).screenshot({ path: screenshotPath });
          } else {
            await page.screenshot({ path: screenshotPath, fullPage: extractor.fullPage });
          }
          data = screenshotPath;
          break;

        default:
          console.log(`    Unknown extractor type: ${type}`);
      }

      // Try frames if no data found
      if ((!data || (Array.isArray(data) && data.length === 0)) && checkFrames) {
        for (const frame of page.frames()) {
          try {
            if (type === 'text') {
              data = await frame.$$eval(actualSelector, els => els.map(el => el.textContent.trim()));
            } else if (type === 'html') {
              data = await frame.$$eval(actualSelector, els => els.map(el => el.innerHTML));
            } else if (type === 'attribute') {
              data = await frame.$$eval(actualSelector, (els, attr) => els.map(el => el.getAttribute(attr)), attribute);
            }
            if (data && (!Array.isArray(data) || data.length > 0)) break;
          } catch (e) {}
        }
      }

      // Apply transforms
      data = applyTransforms(data, extractor);

    } catch (e) {
      console.log(`    Error extracting ${name}: ${e.message}`);
      if (extractor.default !== undefined) {
        data = extractor.default;
      }
    }

    results[name] = data;
  }

  return results;
}

// ============================================================================
// COMPARATORS
// ============================================================================

function detectChanges(current, previous, config, extractors = []) {
  const changes = [];
  const globalComparator = config.comparator || 'hash';

  for (const [name, value] of Object.entries(current)) {
    const prevValue = previous?.[name];

    // Get per-extractor comparator if defined
    const extractor = extractors.find(e => e.name === name);
    const comparator = extractor?.comparator || globalComparator;
    const threshold = extractor?.threshold || config.threshold || 0;

    let changed = false;
    let details = null;

    switch (comparator) {
      case 'hash':
        const currentHash = crypto.createHash('md5').update(JSON.stringify(value)).digest('hex');
        const prevHash = prevValue !== undefined
          ? crypto.createHash('md5').update(JSON.stringify(prevValue)).digest('hex')
          : null;
        changed = currentHash !== prevHash;
        break;

      case 'length':
        const currentLen = Array.isArray(value) ? value.length : String(value || '').length;
        const prevLen = prevValue ? (Array.isArray(prevValue) ? prevValue.length : String(prevValue).length) : 0;
        changed = currentLen !== prevLen;
        details = { previous: prevLen, current: currentLen, diff: currentLen - prevLen };
        break;

      case 'exact':
        changed = JSON.stringify(value) !== JSON.stringify(prevValue);
        break;

      case 'added':
        if (Array.isArray(value)) {
          const prevArr = Array.isArray(prevValue) ? prevValue : [];
          const prevSet = new Set(prevArr.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)));
          const added = value.filter(v => !prevSet.has(typeof v === 'object' ? JSON.stringify(v) : String(v)));
          changed = added.length > 0;
          details = { added };
        }
        break;

      case 'removed':
        if (Array.isArray(prevValue)) {
          const currArr = Array.isArray(value) ? value : [];
          const currentSet = new Set(currArr.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)));
          const removed = prevValue.filter(v => !currentSet.has(typeof v === 'object' ? JSON.stringify(v) : String(v)));
          changed = removed.length > 0;
          details = { removed };
        }
        break;

      case 'addedOrRemoved':
        if (Array.isArray(value) || Array.isArray(prevValue)) {
          const currArr = Array.isArray(value) ? value : [];
          const prevArr = Array.isArray(prevValue) ? prevValue : [];
          const prevSet = new Set(prevArr.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)));
          const currSet = new Set(currArr.map(v => typeof v === 'object' ? JSON.stringify(v) : String(v)));
          const added = currArr.filter(v => !prevSet.has(typeof v === 'object' ? JSON.stringify(v) : String(v)));
          const removed = prevArr.filter(v => !currSet.has(typeof v === 'object' ? JSON.stringify(v) : String(v)));
          changed = added.length > 0 || removed.length > 0;
          details = { added, removed };
        }
        break;

      case 'numeric':
        const numCurrent = parseFloat(value) || 0;
        const numPrev = parseFloat(prevValue) || 0;
        changed = Math.abs(numCurrent - numPrev) > threshold;
        details = { previous: numPrev, current: numCurrent, diff: numCurrent - numPrev };
        break;

      case 'increased':
        const incCurrent = parseFloat(value) || 0;
        const incPrev = parseFloat(prevValue) || 0;
        changed = incCurrent > incPrev + threshold;
        details = { previous: incPrev, current: incCurrent, diff: incCurrent - incPrev };
        break;

      case 'decreased':
        const decCurrent = parseFloat(value) || 0;
        const decPrev = parseFloat(prevValue) || 0;
        changed = decCurrent < decPrev - threshold;
        details = { previous: decPrev, current: decCurrent, diff: decCurrent - decPrev };
        break;

      case 'none':
        // Never triggers - useful for extractors used only in templates
        changed = false;
        break;

      case 'custom':
        if (config.customComparator) {
          try {
            const fn = new Function('current', 'previous', config.customComparator);
            const result = fn(value, prevValue);
            changed = result.changed;
            details = result.details;
          } catch (e) {
            console.log(`    Custom comparator error: ${e.message}`);
          }
        }
        break;
    }

    if (changed) {
      changes.push({
        name,
        previous: prevValue,
        current: value,
        details,
        comparator
      });
    }
  }

  return changes;
}

// ============================================================================
// NOTIFICATIONS
// ============================================================================

function isThrottled(watchId) {
  const lastNotification = notificationTimestamps.get(watchId);
  if (!lastNotification) return false;
  return Date.now() - lastNotification < NOTIFICATION_THROTTLE_MS;
}

function formatDiff(change) {
  if (!change.previous && change.previous !== 0) return '';

  if (change.details?.diff !== undefined) {
    const sign = change.details.diff >= 0 ? '+' : '';
    return ` (${sign}${change.details.diff})`;
  }

  if (change.details?.added?.length || change.details?.removed?.length) {
    const parts = [];
    if (change.details.added?.length) parts.push(`+${change.details.added.length}`);
    if (change.details.removed?.length) parts.push(`-${change.details.removed.length}`);
    return ` (${parts.join(', ')})`;
  }

  return '';
}

function formatMessage(watchConfig, changes, data, isError = false, errorMsg = '') {
  if (isError) {
    return `⚠️ <b>${watchConfig.name || 'Watch'} - ERROR</b>\n\n` +
           `Failed ${errorCounts.get(watchConfig.id || watchConfig._file) || 1} times\n` +
           `Error: ${errorMsg}\n\n` +
           `🔗 <a href="${watchConfig.url}">View page</a>`;
  }

  if (watchConfig.messageTemplate) {
    let msg = watchConfig.messageTemplate;
    msg = msg.replace(/\{\{name\}\}/g, watchConfig.name || 'Watch');
    msg = msg.replace(/\{\{url\}\}/g, watchConfig.url);
    msg = msg.replace(/\{\{changes\}\}/g, JSON.stringify(changes, null, 2));
    msg = msg.replace(/\{\{data\}\}/g, JSON.stringify(data, null, 2));
    msg = msg.replace(/\{\{timestamp\}\}/g, new Date().toISOString());

    const allAdded = changes.flatMap(c => c.details?.added || []);
    const allRemoved = changes.flatMap(c => c.details?.removed || []);

    const formatItem = item => typeof item === 'object' ? (item.text || item.value || JSON.stringify(item)) : item;

    msg = msg.replace(/\{\{added\}\}/g, allAdded.map(formatItem).join(', ') || 'none');
    msg = msg.replace(/\{\{removed\}\}/g, allRemoved.map(formatItem).join(', ') || 'none');
    msg = msg.replace(/\{\{addedList\}\}/g, allAdded.map(i => `• ${formatItem(i)}`).join('\n') || 'none');
    msg = msg.replace(/\{\{removedList\}\}/g, allRemoved.map(i => `• ${formatItem(i)}`).join('\n') || 'none');
    msg = msg.replace(/\{\{addedCount\}\}/g, String(allAdded.length));
    msg = msg.replace(/\{\{removedCount\}\}/g, String(allRemoved.length));

    // {{diff.fieldname}} - show change with diff
    msg = msg.replace(/\{\{diff\.(\w+)\}\}/g, (match, field) => {
      const change = changes.find(c => c.name === field);
      if (!change) return '';
      const curr = typeof change.current === 'object' ? JSON.stringify(change.current) : change.current;
      const prev = typeof change.previous === 'object' ? JSON.stringify(change.previous) : change.previous;
      if (prev === undefined || prev === null) return String(curr);
      return `${prev} → ${curr}${formatDiff(change)}`;
    });

    msg = msg.replace(/\{\{current\.(\w+)\}\}/g, (match, field) => {
      const val = data[field];
      if (val === undefined || val === null) return '';
      if (Array.isArray(val)) return val.map(v => typeof v === 'object' ? (v.text || v.value) : v).join(', ');
      return typeof val === 'object' ? JSON.stringify(val) : String(val);
    });

    msg = msg.replace(/\{\{previous\.(\w+)\}\}/g, (match, field) => {
      const change = changes.find(c => c.name === field);
      if (!change) return '';
      const val = change.previous;
      if (val === undefined || val === null) return '';
      if (Array.isArray(val)) return val.map(v => typeof v === 'object' ? (v.text || v.value) : v).join(', ');
      return typeof val === 'object' ? JSON.stringify(val) : String(val);
    });

    return msg;
  }

  // Default format with diff
  let msg = `🔔 <b>${watchConfig.name || 'Web Monitor'}</b>\n\n`;

  for (const change of changes) {
    msg += `<b>${change.name}</b>:`;

    if (change.details?.added?.length) {
      msg += `\n  Added: ${change.details.added.map(i => typeof i === 'object' ? (i.text || i.value) : i).join(', ')}`;
    }
    if (change.details?.removed?.length) {
      msg += `\n  Removed: ${change.details.removed.map(i => typeof i === 'object' ? (i.text || i.value) : i).join(', ')}`;
    }
    if (!change.details?.added && !change.details?.removed) {
      const curr = typeof change.current === 'object' ? JSON.stringify(change.current) : change.current;
      const prev = typeof change.previous === 'object' ? JSON.stringify(change.previous) : change.previous;
      if (prev !== undefined && prev !== null) {
        msg += ` ${prev} → ${curr}${formatDiff(change)}`;
      } else {
        msg += ` ${curr}`;
      }
    }
    msg += '\n';
  }

  msg += `\n🔗 <a href="${watchConfig.url}">View page</a>`;

  return msg;
}

async function sendToChannel(channel, message, watchConfig) {
  const type = channel.type || (channel.telegram ? 'telegram' : channel.ntfy ? 'ntfy' : channel.webhook ? 'webhook' : null);

  switch (type) {
    case 'telegram':
      const tgToken = channel.token || channel.telegram?.token || TELEGRAM_BOT_TOKEN;
      const tgChat = channel.chatId || channel.telegram?.chatId || TELEGRAM_CHAT_ID;
      if (!tgToken || !tgChat) return;

      try {
        const response = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: tgChat,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: !watchConfig.enablePreview
          })
        });
        if (response.ok) {
          console.log('  Telegram notification sent');
          return true;
        } else {
          console.log('  Telegram error:', await response.text());
        }
      } catch (e) {
        console.log('  Telegram error:', e.message);
      }
      break;

    case 'ntfy':
      const ntfyUrl = channel.url || channel.ntfy?.url || NTFY_URL;
      if (!ntfyUrl) return;

      try {
        await fetch(ntfyUrl, {
          method: 'POST',
          headers: {
            'Title': watchConfig.name || 'Web Monitor Alert',
            'Priority': channel.priority || watchConfig.priority || 'default',
            'Tags': channel.tags || watchConfig.tags || 'loudspeaker'
          },
          body: message.replace(/<[^>]*>/g, '')
        });
        console.log('  ntfy notification sent');
        return true;
      } catch (e) {
        console.log('  ntfy error:', e.message);
      }
      break;

    case 'webhook':
      const webhookUrl = channel.url || channel.webhook?.url || WEBHOOK_URL;
      if (!webhookUrl) return;

      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(channel.headers || {}) },
          body: JSON.stringify({
            watch: watchConfig.name,
            id: watchConfig.id || watchConfig._file,
            url: watchConfig.url,
            message,
            timestamp: new Date().toISOString()
          })
        });
        console.log('  Webhook notification sent');
        return true;
      } catch (e) {
        console.log('  Webhook error:', e.message);
      }
      break;
  }
  return false;
}

async function notify(watchConfig, changes, data, isError = false, errorMsg = '') {
  const watchId = watchConfig.id || watchConfig._file;

  if (!isError && isThrottled(watchId)) {
    console.log('  Notification throttled (too soon after last notification)');
    return;
  }

  const message = formatMessage(watchConfig, changes, data, isError, errorMsg);
  let sent = false;

  // Per-watch notification channels
  if (watchConfig.notifications && Array.isArray(watchConfig.notifications)) {
    for (const channel of watchConfig.notifications) {
      if (await sendToChannel(channel, message, watchConfig)) {
        sent = true;
      }
    }
  } else {
    // Global notification channels
    if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      if (await sendToChannel({ type: 'telegram' }, message, watchConfig)) sent = true;
    }
    if (NTFY_URL) {
      if (await sendToChannel({ type: 'ntfy' }, message, watchConfig)) sent = true;
    }
    if (WEBHOOK_URL) {
      if (await sendToChannel({ type: 'webhook' }, message, watchConfig)) sent = true;
    }
  }

  if (sent && !isError) {
    notificationTimestamps.set(watchId, Date.now());
  }
}

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

function loadState(watchId) {
  const statePath = path.join(STATE_DIR, `${watchId}.json`);
  if (fs.existsSync(statePath)) {
    try {
      return JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (e) {
      return null;
    }
  }
  return null;
}

function saveState(watchId, data, error = null) {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
  const state = {
    data,
    timestamp: new Date().toISOString(),
    ...(error && { lastError: error })
  };
  fs.writeFileSync(
    path.join(STATE_DIR, `${watchId}.json`),
    JSON.stringify(state, null, 2)
  );
}

async function saveErrorScreenshot(page, watchId, error) {
  try {
    if (!fs.existsSync(SCREENSHOT_DIR)) {
      fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    }
    const filename = `error-${watchId}-${Date.now()}.png`;
    const filepath = path.join(SCREENSHOT_DIR, filename);
    await page.screenshot({ path: filepath, fullPage: true });
    console.log(`  Error screenshot saved: ${filename}`);
    return filepath;
  } catch (e) {
    console.log(`  Could not save error screenshot: ${e.message}`);
    return null;
  }
}

// ============================================================================
// BROWSER CONTEXT
// ============================================================================

async function createContext(config) {
  const contextOptions = {
    userAgent: config.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: config.viewport || { width: 1280, height: 720 },
    locale: config.locale || 'en-US',
    timezoneId: config.timezone || 'America/New_York'
  };

  if (config.headers) {
    contextOptions.extraHTTPHeaders = config.headers;
  }

  if (config.proxy) {
    contextOptions.proxy = typeof config.proxy === 'string'
      ? { server: config.proxy }
      : config.proxy;
  }

  // Persistent session support
  if (config.persistSession) {
    const sessionPath = path.join(SESSION_DIR, config.id || 'default');
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }
    contextOptions.storageState = fs.existsSync(path.join(sessionPath, 'state.json'))
      ? path.join(sessionPath, 'state.json')
      : undefined;
  }

  const context = await browser.newContext(contextOptions);

  if (config.cookies) {
    await context.addCookies(config.cookies);
  }

  return context;
}

async function saveSession(context, config) {
  if (config.persistSession) {
    const sessionPath = path.join(SESSION_DIR, config.id || 'default');
    if (!fs.existsSync(sessionPath)) {
      fs.mkdirSync(sessionPath, { recursive: true });
    }
    await context.storageState({ path: path.join(sessionPath, 'state.json') });
    console.log('  Session saved');
  }
}

// ============================================================================
// WATCH PROCESSING
// ============================================================================

async function processWatch(config) {
  const watchId = config.id || crypto.createHash('md5').update(config.url).digest('hex').substring(0, 8);
  console.log(`\n[${new Date().toISOString()}] Processing: ${config.name || config.url}`);

  let context = null;
  let page = null;
  let result = { success: false, watchId };

  try {
    context = await createContext(config);
    page = await context.newPage();

    if (config.blockResources) {
      await page.route('**/*', route => {
        const resourceType = route.request().resourceType();
        if (config.blockResources.includes(resourceType)) {
          route.abort();
        } else {
          route.continue();
        }
      });
    }

    await withRetry(async () => {
      await page.goto(config.url, {
        waitUntil: config.waitUntil || 'networkidle',
        timeout: config.timeout || 60000
      });
    }, config.retries || MAX_RETRIES);

    const actionContext = {};
    if (config.actions) {
      await executeActions(page, config.actions, actionContext);
    }

    if (config.waitForSelector) {
      await page.waitForSelector(config.waitForSelector, { timeout: 30000 }).catch(() => {});
    }

    if (config.waitMs) {
      await page.waitForTimeout(config.waitMs);
    }

    const data = await extractData(page, config.extractors);
    console.log('  Extracted:', JSON.stringify(data));

    const prevState = loadState(watchId);
    const changes = detectChanges(data, prevState?.data, config, config.extractors);

    saveState(watchId, data);

    // Save session if persistent
    await saveSession(context, config);

    // Reset error count on success
    errorCounts.set(watchId, 0);

    if (changes.length > 0 && prevState !== null) {
      console.log('  Changes detected:', changes.map(c => c.name).join(', '));
      await notify(config, changes, data);
    } else if (changes.length > 0) {
      console.log('  First run - baseline saved');
    } else {
      console.log('  No changes');
    }

    result = { success: true, watchId, data, changes };

  } catch (e) {
    console.log(`  Error: ${e.message}`);
    result = { success: false, watchId, error: e.message };

    // Increment error count
    const currentErrors = (errorCounts.get(watchId) || 0) + 1;
    errorCounts.set(watchId, currentErrors);

    if (page && config.screenshotOnError !== false) {
      result.errorScreenshot = await saveErrorScreenshot(page, watchId, e.message);
    }

    saveState(watchId, null, e.message);

    // Send error notification if threshold reached
    if (config.notifyOnError !== false && currentErrors >= (config.errorThreshold || ERROR_NOTIFY_THRESHOLD)) {
      console.log(`  Error threshold reached (${currentErrors}), sending notification`);
      await notify(config, [], {}, true, e.message);
    }

  } finally {
    if (context) {
      await context.close();
    }
  }

  lastCheckResults[watchId] = {
    ...result,
    timestamp: new Date().toISOString(),
    name: config.name,
    errorCount: errorCounts.get(watchId) || 0
  };

  return result;
}

// ============================================================================
// CONFIG MANAGEMENT
// ============================================================================

function loadConfigs() {
  const configs = [];

  if (!fs.existsSync(CONFIG_DIR)) {
    console.log(`Config directory ${CONFIG_DIR} does not exist`);
    return configs;
  }

  const files = fs.readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8');
      const config = JSON.parse(content);
      config._file = file;
      config._hash = hashConfig(config);

      if (validateConfig(config, file)) {
        configs.push(config);
        console.log(`Loaded config: ${config.name || file}`);
      }
    } catch (e) {
      console.log(`Error loading ${file}: ${e.message}`);
    }
  }

  return configs;
}

function scheduleWatch(config) {
  const watchId = config.id || crypto.createHash('md5').update(config.url).digest('hex').substring(0, 8);

  // Clear existing timer/cron
  if (watchTimers.has(watchId)) {
    clearInterval(watchTimers.get(watchId));
    watchTimers.delete(watchId);
  }
  if (watchCronJobs.has(watchId)) {
    clearInterval(watchCronJobs.get(watchId));
    watchCronJobs.delete(watchId);
  }

  // Store config hash for hot reload detection
  configHashes.set(watchId, config._hash);

  // Run immediately
  processWatch(config);

  // Schedule based on cron or interval
  if (config.schedule) {
    // Cron-based scheduling (check every minute)
    let lastRun = null;
    const cronJob = setInterval(() => {
      if (config.enabled !== false && shouldRunCron(config.schedule, lastRun)) {
        lastRun = new Date().toISOString();
        processWatch(config);
      }
    }, 60000);
    watchCronJobs.set(watchId, cronJob);
    console.log(`  Scheduled: cron ${config.schedule}`);
  } else {
    // Interval-based scheduling
    const interval = config.interval || DEFAULT_CHECK_INTERVAL_MS;
    const timer = setInterval(() => {
      if (config.enabled !== false) {
        processWatch(config);
      }
    }, interval);
    watchTimers.set(watchId, timer);
    const intervalMinutes = interval / 1000 / 60;
    console.log(`  Scheduled: every ${intervalMinutes} minute${intervalMinutes !== 1 ? 's' : ''}`);
  }
}

function checkConfigChanges() {
  const configs = loadConfigs();

  for (const config of configs) {
    const watchId = config.id || config._file;
    const oldHash = configHashes.get(watchId);

    if (!oldHash) {
      // New config
      if (config.enabled !== false) {
        console.log(`\nNew config detected: ${config.name}`);
        scheduleWatch(config);
      }
    } else if (oldHash !== config._hash) {
      // Config changed - reschedule
      console.log(`\nConfig changed: ${config.name} - rescheduling`);
      scheduleWatch(config);
    }
  }
}

// ============================================================================
// HEALTH SERVER + WEB UI
// ============================================================================

function generateDashboardHTML() {
  const watches = Object.values(lastCheckResults);
  const watchRows = watches.map(w => `
    <tr class="${w.success ? '' : 'error'}">
      <td>${w.name || w.watchId}</td>
      <td>${w.success ? '✅' : '❌'}</td>
      <td>${w.lastCheck ? new Date(w.lastCheck).toLocaleString() : '-'}</td>
      <td>${w.error || '-'}</td>
      <td>${w.errorCount || 0}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <title>Web Monitor Dashboard</title>
  <meta http-equiv="refresh" content="30">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 20px; background: #f5f5f5; }
    h1 { color: #333; }
    .status { padding: 10px 20px; border-radius: 5px; display: inline-block; margin-bottom: 20px; }
    .status.healthy { background: #d4edda; color: #155724; }
    .status.unhealthy { background: #f8d7da; color: #721c24; }
    table { width: 100%; border-collapse: collapse; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    th, td { padding: 12px 15px; text-align: left; border-bottom: 1px solid #ddd; }
    th { background: #333; color: white; }
    tr:hover { background: #f5f5f5; }
    tr.error { background: #fff3f3; }
    .uptime { color: #666; font-size: 14px; }
  </style>
</head>
<body>
  <h1>🔍 Web Monitor Dashboard</h1>
  <div class="status ${isRunning ? 'healthy' : 'unhealthy'}">
    Status: ${isRunning ? 'Running' : 'Starting'}
  </div>
  <p class="uptime">Uptime: ${Math.floor(process.uptime() / 60)} minutes | Last refresh: ${new Date().toLocaleString()}</p>

  <table>
    <thead>
      <tr>
        <th>Watch</th>
        <th>Status</th>
        <th>Last Check</th>
        <th>Last Error</th>
        <th>Error Count</th>
      </tr>
    </thead>
    <tbody>
      ${watchRows || '<tr><td colspan="5">No watches configured</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;
}

function startHealthServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${HEALTH_PORT}`);

    if (url.pathname === '/health' || url.pathname === '/api/health') {
      const health = {
        status: isRunning ? 'healthy' : 'starting',
        uptime: process.uptime(),
        watches: Object.values(lastCheckResults).map(r => ({
          id: r.watchId,
          name: r.name,
          success: r.success,
          lastCheck: r.timestamp,
          error: r.error,
          errorCount: r.errorCount || 0
        })),
        timestamp: new Date().toISOString()
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health, null, 2));

    } else if (url.pathname === '/metrics') {
      let metrics = '';
      metrics += `# HELP web_monitor_up Whether the web monitor is running\n`;
      metrics += `# TYPE web_monitor_up gauge\n`;
      metrics += `web_monitor_up ${isRunning ? 1 : 0}\n`;
      metrics += `# HELP web_monitor_uptime_seconds Uptime in seconds\n`;
      metrics += `# TYPE web_monitor_uptime_seconds counter\n`;
      metrics += `web_monitor_uptime_seconds ${Math.floor(process.uptime())}\n`;
      metrics += `# HELP web_monitor_watch_success Whether the last check succeeded\n`;
      metrics += `# TYPE web_monitor_watch_success gauge\n`;
      for (const [id, result] of Object.entries(lastCheckResults)) {
        metrics += `web_monitor_watch_success{watch="${id}",name="${result.name || id}"} ${result.success ? 1 : 0}\n`;
      }
      metrics += `# HELP web_monitor_watch_errors_total Total error count per watch\n`;
      metrics += `# TYPE web_monitor_watch_errors_total counter\n`;
      for (const [id, count] of errorCounts.entries()) {
        const name = lastCheckResults[id]?.name || id;
        metrics += `web_monitor_watch_errors_total{watch="${id}",name="${name}"} ${count}\n`;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(metrics);

    } else if (url.pathname === '/' || url.pathname === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(generateDashboardHTML());

    } else if (url.pathname === '/api/trigger' && req.method === 'POST') {
      // Manual trigger endpoint
      const watchId = url.searchParams.get('id');
      if (watchId) {
        const configs = loadConfigs();
        const config = configs.find(c => (c.id || c._file) === watchId);
        if (config) {
          processWatch(config);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'triggered', watchId }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Watch not found' }));
        }
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing id parameter' }));
      }

    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(HEALTH_PORT, () => {
    console.log(`Dashboard: http://localhost:${HEALTH_PORT}/`);
    console.log(`Health API: http://localhost:${HEALTH_PORT}/health`);
    console.log(`Metrics: http://localhost:${HEALTH_PORT}/metrics`);
  });
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  console.log('Web Monitor v3 starting...');
  console.log(`Config dir: ${CONFIG_DIR}`);
  console.log(`State dir: ${STATE_DIR}`);
  console.log(`Screenshot dir: ${SCREENSHOT_DIR}`);
  console.log(`Session dir: ${SESSION_DIR}`);
  console.log(`Default interval: ${DEFAULT_CHECK_INTERVAL_MS / 1000 / 60} minutes`);
  console.log(`Max retries: ${MAX_RETRIES}`);
  console.log(`Stagger delay: ${STAGGER_DELAY_MS}ms`);
  console.log(`Notification throttle: ${NOTIFICATION_THROTTLE_MS / 1000}s`);
  console.log(`Error notification threshold: ${ERROR_NOTIFY_THRESHOLD}`);
  console.log(`Telegram: ${TELEGRAM_BOT_TOKEN ? 'configured' : 'not configured'}`);
  console.log(`ntfy: ${NTFY_URL ? 'configured' : 'not configured'}`);
  console.log(`Webhook: ${WEBHOOK_URL ? 'configured' : 'not configured'}`);

  // Create directories
  for (const dir of [SCREENSHOT_DIR, SESSION_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Start health server
  startHealthServer();

  // Launch browser
  const launchOptions = { headless: true };

  if (process.env.PROXY_SERVER) {
    launchOptions.proxy = { server: process.env.PROXY_SERVER };
    if (process.env.PROXY_USERNAME) {
      launchOptions.proxy.username = process.env.PROXY_USERNAME;
      launchOptions.proxy.password = process.env.PROXY_PASSWORD;
    }
    console.log(`Global proxy: ${process.env.PROXY_SERVER}`);
  }

  browser = await chromium.launch(launchOptions);
  isRunning = true;

  // Load and schedule watches
  const configs = loadConfigs();

  if (configs.length === 0) {
    console.log('\nNo watch configs found. Add JSON files to ' + CONFIG_DIR);
    console.log('Waiting for configs...');
  } else {
    let delay = 0;
    for (const config of configs) {
      if (config.enabled === false) {
        console.log(`\nSkipping disabled: ${config.name}`);
        continue;
      }
      setTimeout(() => scheduleWatch(config), delay);
      delay += STAGGER_DELAY_MS;
    }
  }

  // Hot reload: check for config changes every 30 seconds
  setInterval(checkConfigChanges, 30000);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    isRunning = false;
    for (const timer of watchTimers.values()) clearInterval(timer);
    for (const cron of watchCronJobs.values()) clearInterval(cron);
    if (browser) await browser.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(console.error);
