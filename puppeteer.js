const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

// --- CONFIGURATION ---
const BROWSER_WS = "ENTER_BROWSER_WS";
const EXTENSION_ID = "ENTER_EXTENSION_ID"; // <--- Replace with your actual ID
const MOVIE_SAVE_DIR = "FILE_PATH_TO_SAVE";   // <--- Where you want the MP4s
const MOVIE_SLUGS = [
    "hac-nguyet-te-dan-cua-trang",
    "nhiem-vu-tuyet-mat"
];

// Path to your system's default download folder
const SYSTEM_DOWNLOADS = path.join(process.env.USERPROFILE || process.env.HOME, 'Downloads');

async function automate() {
    let browser;
    try {
        browser = await puppeteer.connect({
            browserWSEndpoint: BROWSER_WS,
            defaultViewport: null
        });
    } catch (err) {
        console.error(" Could not connect to Chrome. Make sure it's running with --remote-debugging-port=9222");
        return;
    }

    const page = await browser.newPage();

    for (const slug of MOVIE_SLUGS) {
        console.log(`\n==========================================`);
        console.log(`Start: ${slug}`)
        console.log(`==========================================`);

        try {
            // 1. Navigate to sidepanel
            await page.goto(`chrome-extension://${EXTENSION_ID}/sidepanel.html`);

            // 2. Search
            await page.waitForSelector('#searchInput');
            await page.type('#searchInput', slug);
            await page.click('#searchBtn');

            // 3. Find and Click the exact movie card
            await page.waitForSelector('.movie-card', { timeout: 10000 });
            const found = await page.evaluate((targetSlug) => {
                const cards = Array.from(document.querySelectorAll('.movie-card'));
                const match = cards.find(c => c.querySelector('small').innerText === targetSlug);
                if (match) {
                    match.click();
                    return true;
                }
                return false;
            }, slug);

            if (!found) {

                console.log(` [SKIP] No exact slug match found for: ${slug}`);

                continue;

            }

            // 4. Wait for Episodes and Select All
            await page.waitForSelector('.ep-btn', { timeout: 15000 });
            await page.evaluate(() => {
                const btn = document.getElementById('selectAllBtn');
                if (btn && btn.innerText.includes("Chọn tất cả")) {
                    btn.click();
                }
            });

            const count = await page.evaluate(() => document.querySelectorAll('.ep-btn.selected').length);
            console.log(` Selected ${count} episodes.`);



            // 5. Input Download Path and Start Capture

            await page.type('#downloadPath', MOVIE_SAVE_DIR);

            await page.click('#startProcessBtn');



            console.log(` Capturing M3U8 links... (Background tabs will open/close)`);



            // 6. Wait for download.js to appear in system Downloads

            const downloadedFile = await waitForFile(SYSTEM_DOWNLOADS, 'download.js');



            // 7. Execute the Node script (ffmpeg)

            await runMovieDownloader(downloadedFile, slug);



        } catch (err) {

            console.error(`Error during ${slug}:`, err.message);

        }

    }



    console.log(`\n All tasks in the slug array are complete!`);

    await page.close();

}

function waitForFile(dir, filename) {

    return new Promise((resolve) => {

        const filePath = path.join(dir, filename);

        console.log(` Watching for ${filename} in system Downloads...`);



        const check = setInterval(() => {

            if (fs.existsSync(filePath)) {

                clearInterval(check);

                // Tiny delay to ensure the file stream is fully closed by Chrome

                setTimeout(() => resolve(filePath), 1500);

            }

        }, 2000);

    });

}

/**



 * Moves the script to the local folder and executes it



 */function runMovieDownloader(sourcePath, slug) {



    return new Promise((resolve) => {



        const localScriptName = `script-${slug}.js`;



        const localPath = path.join(__dirname, localScriptName);







        // Move file to current directory to avoid name collisions



        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);



        fs.renameSync(sourcePath, localPath);







        console.log(` Running FFMPEG download process...`);



        const child = exec(`node "${localPath}"`);







        child.stdout.on('data', (data) => process.stdout.write(data));



        child.stderr.on('data', (data) => process.stderr.write(data));







        child.on('close', (code) => {



            console.log(` Finished processing ${slug} (Exit Code: ${code})`);



            resolve();



        });



    });



}







automate();
