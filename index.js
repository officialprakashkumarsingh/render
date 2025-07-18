// index.js

// 1. Imports & Setup
const express    = require('express');
const axios      = require('axios');
const puppeteer  = require('puppeteer');
const fs         = require('fs');
const path       = require('path');

const app = express();
app.use(express.json());

// Serve screenshots back to users
const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);
app.use('/screenshots', express.static(SCREENSHOT_DIR));

// 2. Config (set this in Render → Environment)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME     = 'gemini-2.5-flash';

// 3. Launch one Chromium browser instance
let browser = null;
async function initBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
    });
  }
}

// 4. Call Gemini over REST
async function callGemini(promptText) {
  const url = `https://generativelanguage.googleapis.com/v1beta2/models/${MODEL_NAME}:generateMessage?key=${GEMINI_API_KEY}`;
  const body = {
    prompt: { messages: [{ author: 'user', content: promptText }] },
    temperature: 0.7,
    maxOutputTokens: 1024
  };
  const resp = await axios.post(url, body);
  return resp.data.candidates[0].content;
}

// 5. Browser "tools"
async function doGoto(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return `✅ Navigated to ${url}`;
}
async function doClick(page, selector) {
  await page.click(selector);
  return `✅ Clicked ${selector}`;
}
async function doExtract(page) {
  const txt = await page.evaluate(() => document.body.innerText);
  return txt.trim().slice(0, 2000) + (txt.length>2000?'…':'');
}
async function doScroll(page) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight));
  return `✅ Scrolled down`;
}
async function doTitle(page) {
  return await page.title();
}
async function doUrl(page) {
  return page.url();
}
async function doGoBack(page) {
  await page.goBack({ waitUntil: 'domcontentloaded' });
  return `✅ Went back`;
}
async function doFillForm(page, selector, value) {
  await page.focus(selector);
  await page.keyboard.type(value);
  return `✅ Filled ${selector}`;
}
async function doScreenshot(page, baseUrl) {
  const filename = `shot_${Date.now()}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: true });
  return `${baseUrl}/screenshots/${filename}`;
}

// 6. Command parser
function parseCommand(text) {
  const [cmd, ...rest] = text.trim().split('\n')[0].split(' ');
  const arg = rest.join(' ');
  switch(cmd.toUpperCase()) {
    case 'GOTO_URL':      return { name:'goto',     args:{ url: arg } };
    case 'CLICK_SELECTOR':return { name:'click',    args:{ sel: arg } };
    case 'EXTRACT_TEXT':  return { name:'extract' };
    case 'SCROLL_DOWN':   return { name:'scroll' };
    case 'GET_TITLE':     return { name:'title' };
    case 'GET_URL':       return { name:'url' };
    case 'GO_BACK':       return { name:'back' };
    case 'FILL_FORM': {
      const [selector, value] = arg.split(' | ');
      return { name:'fill', args:{ sel: selector, val: value||'' } };
    }
    case 'TAKE_SCREENSHOT':
      return { name:'screenshot' };
    case 'ANSWER:':
    case 'ANSWER':        return { name:'answer', text: text.replace(/^ANSWER:?\s*/i,'') };
    default:              return { name:'unknown', text };
  }
}

// 7. /agent endpoint
app.post('/agent', async (req, res) => {
  const userQuery = req.body.query;
  await initBrowser();
  const page = await browser.newPage();
  const baseUrl = `${req.protocol}://${req.get('host')}`;

  // Initial system prompt
  let convo = [
    { role:'system', content:
      `You have browser-control commands:
       GOTO_URL <url>
       CLICK_SELECTOR <CSS selector>
       EXTRACT_TEXT
       SCROLL_DOWN
       GET_TITLE
       GET_URL
       GO_BACK
       FILL_FORM <selector> | <text>
       TAKE_SCREENSHOT
       When done, respond with ANSWER: <your human-friendly answer>.`
    },
    { role:'user', content: userQuery }
  ];

  try {
    while(true) {
      const prompt = convo.map(m=>`${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
      const llmOut = await callGemini(prompt);
      const cmd = parseCommand(llmOut);

      let result;
      switch(cmd.name) {
        case 'goto':
          result = await doGoto(page, cmd.args.url);
          break;
        case 'click':
          result = await doClick(page, cmd.args.sel);
          break;
        case 'extract':
          result = await doExtract(page);
          break;
        case 'scroll':
          result = await doScroll(page);
          break;
        case 'title':
          result = await doTitle(page);
          break;
        case 'url':
          result = await doUrl(page);
          break;
        case 'back':
          result = await doGoBack(page);
          break;
        case 'fill':
          result = await doFillForm(page, cmd.args.sel, cmd.args.val);
          break;
        case 'screenshot': {
          const shotUrl = await doScreenshot(page, baseUrl);
          result = `📷 Screenshot: ${shotUrl}`;
          break;
        }
        case 'answer':
          return res.json({ answer: cmd.text });
        default:
          return res.status(500).json({ error: `Unknown command: ${llmOut}` });
      }

      convo.push({ role:'assistant', content: llmOut });
      convo.push({ role:'tool',      content: result });
    }

  } catch (e) {
    res.status(500).json({ error: e.toString() });
  } finally {
    await page.close();
  }
});

// 8. Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Agent running on port ${PORT}`));