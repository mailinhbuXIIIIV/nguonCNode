const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const http = require('http');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= CONFIG =================
const PORT = 5109;
const EXTENSION_ID = "EXTENSION_ID_HERE";
const MOVIE_SAVE_DIR = "DOWNLOAD_FOLDER_HERE";
const SYSTEM_DOWNLOADS = path.join(process.env.HOME, 'Downloads');
const DEBUG_PORT = 9222;
// ==========================================

let movieQueue = [];
let isProcessing = false;


/* ============================================================
   AUTO GET CHROME WEBSOCKET ENDPOINT
============================================================ */

async function getBrowserWSEndpoint(retries = 20, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            const ws = await new Promise((resolve, reject) => {
                http.get(`http://127.0.0.1:${DEBUG_PORT}/json/version`, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            const json = JSON.parse(data);
                            resolve(json.webSocketDebuggerUrl);
                        } catch (err) {
                            reject(err);
                        }
                    });
                }).on('error', reject);
            });

            if (!ws) throw new Error("No webSocketDebuggerUrl found");
            return ws;

        } catch (err) {
            console.log(`Waiting for Chrome remote debugging... (${i + 1}/${retries})`);
            await new Promise(r => setTimeout(r, delay));
        }
    }

    throw new Error("Chrome remote debugging not available on port 9222.");
}


/* ============================================================
   HTML UI
============================================================ */

app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Movie Downloader</title>
            <style>
                body { background: #000; color: #fff; font-family: monospace; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                .container { width: 80%; max-width: 600px; text-align: center; }
                input { width: 100%; padding: 15px; background: #000; border: 1px solid #fff; color: #fff; font-family: monospace; font-size: 1.2rem; margin-bottom: 10px; outline: none; }
                button { background: #fff; color: #000; border: none; padding: 10px 20px; cursor: pointer; font-weight: bold; font-family: monospace; }
                #error { color: #ff0000; margin-top: 10px; display: none; }
                #success { color: #00ff00; margin-top: 10px; display: none; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>REQUEST PHIM TẠI ĐÂY</h1>
                <input type="text" id="slugInput" placeholder="slug-1, slug-2, slug-3" autofocus>
                <button onclick="submitSlugs()">DOWNLOAD</button>
                <div id="error">Bạn chưa nhập slug nào cả</div>
                <div id="success">Phim của bạn đang được tải xuống.</div>
            </div>
            <script>
                async function submitSlugs() {
                    const input = document.getElementById('slugInput');
                    const err = document.getElementById('error');
                    const succ = document.getElementById('success');

                    err.style.display = 'none';
                    succ.style.display = 'none';

                    if (!input.value.trim()) {
                        err.style.display = 'block';
                        return;
                    }

                    await fetch('/add-to-queue', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ slugs: input.value })
                    });

                    succ.style.display = 'block';
                    input.value = '';
                }
            </script>
        </body>
        </html>
    `);
});


/* ============================================================
   QUEUE SYSTEM
============================================================ */

app.post('/add-to-queue', (req, res) => {
    const slugList = req.body.slugs
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    movieQueue.push(...slugList);

    console.log(`Added: ${slugList.join(', ')} | Queue: ${movieQueue.length}`);

    if (!isProcessing) processQueue();

    res.sendStatus(200);
});


async function processQueue() {
    if (movieQueue.length === 0) {
        isProcessing = false;
        console.log("Queue empty.");
        return;
    }

    isProcessing = true;
    const slug = movieQueue.shift();
    console.log(`Starting job: ${slug}`);

    try {
        await automateOne(slug);
    } catch (err) {
        console.error(`Job failed (${slug}):`, err.message);
    }

    processQueue();
}


/* ============================================================
   MAIN AUTOMATION
============================================================ */

async function automateOne(slug) {

    const wsEndpoint = await getBrowserWSEndpoint();
    console.log("Connecting to:", wsEndpoint);

    const browser = await puppeteer.connect({
        browserWSEndpoint: wsEndpoint,
        defaultViewport: null
    });

    const page = await browser.newPage();

    try {
        await page.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
        await page.waitForSelector('#searchInput');

        await page.type('#searchInput', slug);
        await page.click('#searchBtn');

        await page.waitForSelector('.movie-card', { timeout: 15000 });

        const found = await page.evaluate((target) => {
            const cards = [...document.querySelectorAll('.movie-card')];
            const match = cards.find(c => c.querySelector('small')?.innerText === target);
            if (match) { match.click(); return true; }
            return false;
        }, slug);

        if (!found) throw new Error(`Slug not found: ${slug}`);

        await page.waitForSelector('.ep-btn', { timeout: 20000 });

        await page.evaluate(() => {
            const btn = document.getElementById('selectAllBtn');
            if (btn?.innerText.includes("Chọn tất cả")) btn.click();
        });

        await page.type('#downloadPath', MOVIE_SAVE_DIR);
        await page.click('#startProcessBtn');

        const downloadedFile = await waitForFile(SYSTEM_DOWNLOADS, 'download.js');
        await runMovieDownloader(downloadedFile, slug);

    } finally {
        await page.close();
    }
}


/* ============================================================
   HELPERS
============================================================ */

function waitForFile(dir, filename) {
    return new Promise((resolve) => {
        const filePath = path.join(dir, filename);

        const check = setInterval(() => {
            if (fs.existsSync(filePath)) {
                clearInterval(check);
                setTimeout(() => resolve(filePath), 1500);
            }
        }, 2000);
    });
}


function runMovieDownloader(sourcePath, slug) {
    return new Promise((resolve) => {

        const localPath = path.join(__dirname, `script-${slug}.js`);

        if (fs.existsSync(localPath))
            fs.unlinkSync(localPath);

        fs.renameSync(sourcePath, localPath);

        console.log(`Executing script for: ${slug}`);

        const child = exec(`node "${localPath}"`);

        child.stdout.on('data', data => process.stdout.write(data));
        child.stderr.on('data', data => process.stderr.write(data));

        child.on('close', () => {
            if (fs.existsSync(localPath))
                fs.unlinkSync(localPath);

            console.log(`Finished job: ${slug}`);
            resolve();
        });
    });
}


/* ============================================================
   START SERVER
============================================================ */

app.listen(PORT, () =>
    console.log(`Server running on http://localhost:${PORT}`)
);
