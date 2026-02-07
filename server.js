const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- CONFIGURATION ---
const PORT = 5109;
const BROWSER_WS = "CHROME_REMOTE_DEBUG_PORT_HERE";
const EXTENSION_ID = "EXTENSION_ID_HERE";
const MOVIE_SAVE_DIR = "DOWNLOAD_FOLDER_HERE";
const SYSTEM_DOWNLOADS = path.join(process.env.HOME, 'Downloads');

let movieQueue = [];
let isProcessing = false;

// HTML UI (Black & White Style)
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
                <div>Điền slug của phim cần tải về tại đây. Slug lấy tại trang <a style="background-color: white; color: navy; "
   target="_blank" href="https://phim.nguonc.com/"><b>NguonC</b></a> (VD: <i>https://phim.nguonc.com/phim/tinh-yeu-bo-xit</i> => slug: <b>tinh-yeu-bo-xit</b>)</div>
                <input type="text" id="slugInput" placeholder="slug-1, slug-2, slug-3" autofocus>
                <button onclick="submitSlugs()">DOWNLOAD</button>
                <div id="error">Bạn chưa nhập slug nào cả</div>
                <div id="success">Phim của bạn đang được tải xuống. Vui lòng quay lại sau</div>
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

                    const response = await fetch('/add-to-queue', {
                        method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({ slugs: input.value })
                    });

                    if (response.ok) {
                        succ.style.display = 'block';
                        input.value = '';
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// Queue handling
app.post('/add-to-queue', (req, res) => {
    const rawSlugs = req.body.slugs;
    const slugList = rawSlugs.split(',').map(s => s.trim()).filter(s => s !== "");

    movieQueue.push(...slugList);
    console.log(`Added to queue: ${slugList.join(', ')} | Total in queue: ${movieQueue.length}`);

    if (!isProcessing) {
        processQueue();
    }
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
    console.log(`\nStarting Job: ${slug}`);

    try {
        await automateOne(slug);
    } catch (err) {
        console.error(`Failed job ${slug}:`, err.message);
    }

    // Move to next in queue
    processQueue();
}

async function automateOne(slug) {
    let browser = await puppeteer.connect({ browserWSEndpoint: BROWSER_WS, defaultViewport: null });
    const page = await browser.newPage();

    try {
        await page.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);
        await page.waitForSelector('#searchInput');
        await page.type('#searchInput', slug);
        await page.click('#searchBtn');

        await page.waitForSelector('.movie-card', { timeout: 10000 });
        const found = await page.evaluate((target) => {
            const cards = Array.from(document.querySelectorAll('.movie-card'));
            const match = cards.find(c => c.querySelector('small').innerText === target);
            if (match) { match.click(); return true; }
            return false;
        }, slug);

        if (!found) throw new Error(`Slug ${slug} match not found.`);

        await page.waitForSelector('.ep-btn', { timeout: 15000 });
        await page.evaluate(() => {
            const btn = document.getElementById('selectAllBtn');
            if (btn && btn.innerText.includes("Chọn tất cả")) btn.click();
        });

        await page.type('#downloadPath', MOVIE_SAVE_DIR);
        await page.click('#startProcessBtn');

        const downloadedFile = await waitForFile(SYSTEM_DOWNLOADS, 'download.js');
        await runMovieDownloader(downloadedFile, slug);

    } finally {
        await page.close();
    }
}

// Reuse your existing helper functions
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



        // Clean up any old script if it exists before moving the new one

        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);



        fs.renameSync(sourcePath, localPath);



        console.log(`\n Executing script for: ${slug}`);

        const child = exec(`node "${localPath}"`);



        child.stdout.on('data', (data) => process.stdout.write(data));

        child.stderr.on('data', (data) => process.stderr.write(data));



        child.on('close', (code) => {

            // --- CLEANUP LOGIC ---

            try {

                if (fs.existsSync(localPath)) {

                    fs.unlinkSync(localPath);

                    console.log(`\n  Temporary script script-${slug}.js deleted.`);

                }

            } catch (err) {

                console.error(`\n Failed to delete temporary script: ${err.message}`);

            }



            resolve();

        });

    });

}

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
