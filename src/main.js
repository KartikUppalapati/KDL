const { app, BrowserWindow, dialog, globalShortcut, safeStorage } = require('electron');
const { exec, spawn } = require('node:child_process');
var ipc = require('electron').ipcMain;
const nodeid3 = require('node-id3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const yauzl = require('yauzl');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup'))
{
    app.quit();
}

const createWindow = () =>
{
    // Create the browser window.
    mainWindow = new BrowserWindow(
    {
        width: 1250,
        height: 750,
        webPreferences: 
        {
            preload: path.join(__dirname, "preload.js"),
            nodeIntegration: true,
            contextIsolation: false,
            enableRemoteModule: true,
            // nodeIntegration: false,
            // contextIsolation: true,
            // enableRemoteModule: false,
            devTools: !app.isPackaged,
        },
    });

    mainWindow.loadFile(path.join(__dirname, "index.html"));
    mainWindow.setResizable(false);

    // Open the DevTools.
    // mainWindow.webContents.openDevTools();
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);
app.on('browser-window-focus', function ()
{
    // globalShortcut.register("CommandOrControl+R", () =>
    // {
    //     console.log("CommandOrControl+R is pressed: Shortcut Disabled");
    // });
    globalShortcut.register("F5", () =>
    {
        console.log("F5 is pressed: Shortcut Disabled");
    });
});
app.on('browser-window-blur', function ()
{
    globalShortcut.unregister('CommandOrControl+R');
    globalShortcut.unregister('F5');
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () =>
{
    if (process.platform !== 'darwin')
    {
        app.quit();
    }
});
app.on('activate', () =>
{
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0)
    {
        createWindow();
    }
});


// Init vars
const platform = process.platform;
const defaultFolderPath = path.join(os.homedir(), "TempKdlFiles");

// yt-dlp, ffmpeg and deno are downloaded on first use into the user data folder (app bundle may not be writable)
const binName = (name) => platform === "win32" ? name + ".exe" : name;
const binDir = path.join(app.getPath("userData"), "bin");
const ffmpegPath = path.join(binDir, binName("ffmpeg"));
const ytdlpDir = path.join(binDir, "yt-dlp");
const ytdlpVersionFile = path.join(ytdlpDir, "kdl-version.txt");
const denoPath = path.join(binDir, binName("deno"));

// yt-dlp needs a JavaScript runtime for YouTube's challenges, without one some videos fail with 403.
// Electron's own node (18) is too old for it, and apps opened from Finder don't see a deno installed with homebrew
const denoZipName =
{
    "darwin-x64": "deno-x86_64-apple-darwin.zip",
    "darwin-arm64": "deno-aarch64-apple-darwin.zip",
    "win32-x64": "deno-x86_64-pc-windows-msvc.zip",
    "win32-arm64": "deno-aarch64-pc-windows-msvc.zip",
    "linux-x64": "deno-x86_64-unknown-linux-gnu.zip",
    "linux-arm64": "deno-aarch64-unknown-linux-gnu.zip",
}[`${platform}-${process.arch}`];

// yt-dlp's folder builds start in well under a second, its single-file builds take ~6s every launch
const ytdlpZipName =
{
    "darwin-x64": "yt-dlp_macos.zip",
    "darwin-arm64": "yt-dlp_macos.zip",
    "win32-x64": "yt-dlp_win.zip",
    "win32-ia32": "yt-dlp_win_x86.zip",
    "win32-arm64": "yt-dlp_win_arm64.zip",
    "linux-x64": "yt-dlp_linux.zip",
    "linux-arm64": "yt-dlp_linux_aarch64.zip",
}[`${platform}-${process.arch}`];

// The executable is the only top level file in the yt-dlp folder (the rest is in _internal)
function findYtdlp()
{
    try
    {
        const exe = fs.readdirSync(ytdlpDir, { withFileTypes: true }).find(entry => entry.isFile() && entry.name.startsWith("yt-dlp"));
        return exe ? path.join(ytdlpDir, exe.name) : undefined;
    }
    catch (error)
    {
        return undefined;
    }
}

// Download url to filePath, reporting progress through onOutput. Returns the file's sha256
async function downloadFile(url, filePath, label, onOutput)
{
    const res = await fetch(url);
    if (!res.ok)
    {
        throw new Error(`${path.basename(url)}: ${res.status} ${res.statusText}`);
    }

    // Only report when the percent (or MB, if size is unknown) changes
    const total = Number(res.headers.get("content-length")) || 0;
    const hash = crypto.createHash("sha256");
    var received = 0;
    var lastOutput = "";
    const progress = new Transform(
    {
        transform(chunk, encoding, callback)
        {
            received += chunk.length;
            hash.update(chunk);
            const output = total ? `Downloading ${label}... ${Math.floor(received / total * 100)}%`
                                 : `Downloading ${label}... ${Math.floor(received / 1e6)} MB`;
            if (output != lastOutput)
            {
                lastOutput = output;
                onOutput(output);
            }
            callback(null, chunk);
        }
    });

    // Write to a temp file so a partial download isn't mistaken for a finished one
    const tempPath = filePath + ".download";
    await pipeline(Readable.fromWeb(res.body), progress, fs.createWriteStream(tempPath));
    fs.renameSync(tempPath, filePath);
    return hash.digest("hex");
}

// Download ffmpeg and ffprobe (yt-dlp uses both)
async function downloadFFmpeg(onOutput)
{
    const releaseUrl = "https://github.com/iqbal-rashed/ytdlp-nodejs/releases/download/ffmpeg-latest";
    const assetPlatform = { win32: "win", linux: "linux", darwin: "macos" }[platform];
    fs.mkdirSync(binDir, { recursive: true });

    // ffmpeg last, since its existence is what marks the download as done
    for (const tool of ["ffprobe", "ffmpeg"])
    {
        const filePath = path.join(binDir, binName(tool));
        await downloadFile(`${releaseUrl}/${assetPlatform}-${process.arch}-${binName(tool)}`, filePath, tool, onOutput);
        if (platform !== "win32")
        {
            fs.chmodSync(filePath, 0o755);
        }
    }
}

// Unzip zipPath into dir, keeping executable permissions (and symlinks, should a zip ever have them).
// Uses yauzl 3 directly: extract-zip 2 (yauzl 2) silently stalls on newer Node versions
function extractZip(zipPath, dir)
{
    return new Promise((resolve, reject) =>
    {
        yauzl.open(zipPath, { lazyEntries: true }, (error, zip) =>
        {
            if (error) return reject(error);
            zip.on("error", reject);
            zip.on("end", resolve);

            // One entry at a time, the next is read once this one is written
            zip.on("entry", async (entry) =>
            {
                try
                {
                    // Never write outside dir
                    const dest = path.resolve(dir, entry.fileName);
                    if (!dest.startsWith(path.resolve(dir) + path.sep))
                    {
                        throw new Error(`Bad path in zip: ${entry.fileName}`);
                    }

                    // Unix file type and permissions are in the top 16 bits
                    const unixMode = entry.externalFileAttributes >>> 16;
                    const fileType = unixMode & 0o170000;
                    if (entry.fileName.endsWith("/") || fileType == 0o040000)
                    {
                        fs.mkdirSync(dest, { recursive: true });
                        return zip.readEntry();
                    }

                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    const stream = await new Promise((res, rej) => zip.openReadStream(entry, (e, s) => e ? rej(e) : res(s)));
                    if (fileType == 0o120000)
                    {
                        // A symlink's content is the path it points to
                        const chunks = [];
                        for await (const chunk of stream) chunks.push(chunk);
                        fs.symlinkSync(Buffer.concat(chunks).toString(), dest);
                    }
                    else
                    {
                        await pipeline(stream, fs.createWriteStream(dest, { mode: (unixMode & 0o777) || 0o644 }));
                    }
                    zip.readEntry();
                }
                catch (error)
                {
                    zip.close();
                    reject(error);
                }
            });
            zip.readEntry();
        });
    });
}

// Download a zip, check it against expectedHash, and unzip it into a fresh tempDir
async function downloadZip(url, expectedHash, tempDir, label, onOutput)
{
    const zipPath = tempDir + ".zip";
    const hash = await downloadFile(url, zipPath, label, onOutput);
    if (hash !== expectedHash.toLowerCase())
    {
        fs.rmSync(zipPath, { force: true });
        throw new Error(`Checksum mismatch for ${path.basename(url)}, try again`);
    }

    onOutput(`Extracting ${label}...`);
    fs.rmSync(tempDir, { recursive: true, force: true });
    await extractZip(zipPath, tempDir);
    fs.rmSync(zipPath, { force: true });
}

// Newest yt-dlp release, e.g. "2026.08.19" (github redirects /latest to /tag/<version>)
async function getLatestYtdlpVersion()
{
    const res = await fetch("https://github.com/yt-dlp/yt-dlp/releases/latest", { method: "HEAD" });
    const version = res.url.split("/tag/")[1];
    if (!res.ok || !version)
    {
        throw new Error(`Couldn't find the latest yt-dlp version (${res.status})`);
    }
    return version;
}

// Version of the downloaded yt-dlp, undefined if it's from before versions were saved
function getInstalledYtdlpVersion()
{
    try
    {
        return fs.readFileSync(ytdlpVersionFile, "utf8").trim();
    }
    catch (error)
    {
        return undefined;
    }
}

// Download and unzip a yt-dlp folder build
async function downloadYtdlp(version, onOutput)
{
    if (!ytdlpZipName)
    {
        throw new Error(`yt-dlp isn't available for ${platform} ${process.arch}`);
    }
    const releaseUrl = `https://github.com/yt-dlp/yt-dlp/releases/download/${version}`;
    fs.mkdirSync(binDir, { recursive: true });

    // Check against the release's checksums so a broken download is never used
    const sumsRes = await fetch(`${releaseUrl}/SHA2-256SUMS`);
    if (!sumsRes.ok)
    {
        throw new Error(`SHA2-256SUMS: ${sumsRes.status} ${sumsRes.statusText}`);
    }
    const sumLine = (await sumsRes.text()).split("\n").map(line => line.trim().split(/\s+/)).find(([, name]) => name === ytdlpZipName);
    if (!sumLine)
    {
        throw new Error(`No checksum found for ${ytdlpZipName}`);
    }

    // Unzip next to the final folder, then swap it in
    const tempDir = ytdlpDir + ".download";
    await downloadZip(`${releaseUrl}/${ytdlpZipName}`, sumLine[0], tempDir, "yt-dlp", onOutput);
    fs.writeFileSync(path.join(tempDir, path.basename(ytdlpVersionFile)), version);
    fs.rmSync(ytdlpDir, { recursive: true, force: true });
    fs.renameSync(tempDir, ytdlpDir);
}

// Download and unzip deno (a single executable)
async function downloadDeno(onOutput)
{
    const releaseUrl = "https://github.com/denoland/deno/releases/latest/download";
    fs.mkdirSync(binDir, { recursive: true });

    // macOS/Linux checksums are "hash  name", Windows ones are PowerShell's "Hash : HASH", so just find the hash
    const sumRes = await fetch(`${releaseUrl}/${denoZipName}.sha256sum`);
    const expectedHash = sumRes.ok ? (await sumRes.text()).match(/\b[0-9a-f]{64}\b/i)?.[0] : undefined;
    if (!expectedHash)
    {
        throw new Error(`No checksum found for ${denoZipName}`);
    }

    const tempDir = path.join(binDir, "deno.download");
    await downloadZip(`${releaseUrl}/${denoZipName}`, expectedHash, tempDir, "deno", onOutput);
    fs.renameSync(path.join(tempDir, binName("deno")), denoPath);
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (platform !== "win32")
    {
        fs.chmodSync(denoPath, 0o755);
    }
}

// yt-dlp processes running now. yt-dlp isn't updated while one is (Windows can't replace files in use)
var runningDownloads = 0;

// YouTube changes often and an old yt-dlp starts failing (403s), so check for a new one once a day
const updateCheckInterval = 24 * 60 * 60 * 1000;
var lastUpdateCheck = 0;

// Shared while in progress so pressing enter twice doesn't start two downloads.
// forceUpdateCheck checks for a new yt-dlp now, instead of waiting for the daily check
var toolsReady = null;
function ensureTools(onOutput, forceUpdateCheck = false)
{
    if (!toolsReady)
    {
        toolsReady = (async () =>
        {
            if (!findYtdlp())
            {
                onOutput("Downloading yt-dlp...");
                await downloadYtdlp(await getLatestYtdlpVersion(), onOutput);
                lastUpdateCheck = Date.now();
            }
            else if ((forceUpdateCheck || Date.now() - lastUpdateCheck > updateCheckInterval) && runningDownloads == 0)
            {
                // Failing to update isn't fatal, the installed yt-dlp still works for most videos
                lastUpdateCheck = Date.now();
                try
                {
                    const latestVersion = await getLatestYtdlpVersion();
                    if (latestVersion != getInstalledYtdlpVersion())
                    {
                        onOutput(`Updating yt-dlp to ${latestVersion}...`);
                        await downloadYtdlp(latestVersion, onOutput);
                    }
                }
                catch (error)
                {
                    onOutput(`Couldn't update yt-dlp: ${error.message}`);
                }
            }

            if (!fs.existsSync(ffmpegPath))
            {
                onOutput("Downloading ffmpeg...");
                await downloadFFmpeg(onOutput);
            }

            // Not fatal either, most videos still download without it
            if (denoZipName && !fs.existsSync(denoPath))
            {
                try
                {
                    onOutput("Downloading deno...");
                    await downloadDeno(onOutput);
                }
                catch (error)
                {
                    onOutput(`Couldn't download deno, some videos may fail: ${error.message}`);
                }
            }
        })()
        .finally(() =>
        {
            toolsReady = null;
        });
    }
    return toolsReady;
}

// Spotify credentials are entered in the app (key button at the top) and saved in the user data folder,
// so they're never in the code or the packaged app. The secret is encrypted with the OS keychain when it can be (safeStorage)
const credentialsPath = path.join(app.getPath("userData"), "spotify-credentials.json");
var spotifyCredentials = null;

// Saved credentials, { clientId, clientSecret }, or null if there aren't any (or they can't be read)
function loadSpotifyCredentials()
{
    if (!spotifyCredentials)
    {
        try
        {
            const saved = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
            const clientSecret = saved.encrypted ? safeStorage.decryptString(Buffer.from(saved.clientSecret, "base64")) : saved.clientSecret;
            if (saved.clientId && clientSecret)
            {
                spotifyCredentials = { clientId: saved.clientId, clientSecret };
            }
        }
        catch (error) {}
    }
    return spotifyCredentials;
}

function saveSpotifyCredentials(clientId, clientSecret)
{
    const encrypted = safeStorage.isEncryptionAvailable();
    const saved =
    {
        clientId,
        encrypted,
        clientSecret: encrypted ? safeStorage.encryptString(clientSecret).toString("base64") : clientSecret
    };
    fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
    fs.writeFileSync(credentialsPath, JSON.stringify(saved, null, 2), { mode: 0o600 });
    spotifyCredentials = { clientId, clientSecret };
}

// Errors that mean the user needs to (re)enter their credentials, so the page can open the credentials dialog
function credentialsError(message)
{
    const error = new Error(message);
    error.needsCredentials = true;
    return error;
}

// Ask spotify for a token with these credentials. Resolves with { access_token, expires_in }
async function requestSpotifyToken(clientId, clientSecret)
{
    const result = await fetch("https://accounts.spotify.com/api/token",
    {
        method: "POST",
        headers:
        {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": "Basic " + btoa(`${clientId}:${clientSecret}`)
        },
        body: "grant_type=client_credentials"
    });
    const data = await result.json();

    if (data.error == "invalid_client")
    {
        throw credentialsError("Spotify didn't accept the Client ID or Secret.");
    }
    if (!data.access_token)
    {
        throw new Error(data.error_description || "Couldn't get Spotify token.");
    }
    return data;
}

// Reuse the spotify token until it expires
var spotifyToken = null;
function getSpotifyToken()
{
    const credentials = loadSpotifyCredentials();
    if (!credentials)
    {
        return Promise.reject(credentialsError("Add your Spotify credentials first (key button at the top)."));
    }

    if (spotifyToken && Date.now() < spotifyToken.expiresAt)
    {
        return spotifyToken.promise;
    }

    const token = { expiresAt: Infinity };
    token.promise = requestSpotifyToken(credentials.clientId, credentials.clientSecret)
    .then(data =>
    {
        // Refresh a minute early
        token.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
        return data.access_token;
    });

    // Don't cache failures
    token.promise.catch(() =>
    {
        if (spotifyToken === token) spotifyToken = null;
    });

    spotifyToken = token;
    return token.promise;
}

// For the credentials dialog. The secret itself stays in the main process
// For playing songs in the page (it builds file:// urls from this)
ipc.handle("getSongsFolder", function()
{
    return defaultFolderPath;
});

ipc.handle("getSpotifyCredentials", function()
{
    const credentials = loadSpotifyCredentials();
    return { clientId: credentials ? credentials.clientId : "", hasSecret: !!credentials };
});

// Check new credentials with spotify, and only save them if they work. An empty secret keeps the saved one
ipc.handle("saveSpotifyCredentials", async function(event, clientId, clientSecret)
{
    clientId = (clientId || "").trim();
    clientSecret = (clientSecret || "").trim() || (loadSpotifyCredentials() || {}).clientSecret;
    if (!clientId || !clientSecret)
    {
        return { ok: false, message: "Enter both the Client ID and the Client Secret." };
    }

    try
    {
        const data = await requestSpotifyToken(clientId, clientSecret);
        saveSpotifyCredentials(clientId, clientSecret);

        // Start using the new credentials right away
        spotifyToken = { expiresAt: Date.now() + (data.expires_in - 60) * 1000, promise: Promise.resolve(data.access_token) };
        return { ok: true };
    }
    catch (error)
    {
        return { ok: false, message: error.cause?.errno == -3008 ? "Network connection failed." : error.message };
    }
});

// The app only makes mp3s and mp4s (see -t in downloadFromLink)
// (not yt-dlp's in progress files: .temp.mp3 while converting, .f137.mp4 / .f251.webm streams before merging)
function isFinishedSong(fileName)
{
    return /\.(mp3|mp4)$/i.test(fileName) && !/\.temp\.(mp3|mp4)$/i.test(fileName) && !/\.f\d+\.\w+$/i.test(fileName);
}

ipc.on("getFilesInFolder", function(event)
{
    // Send back chosen folder
    // var folderPath = dialog.showOpenDialogSync({properties: ['openDirectory']});
    // if (folderPath != undefined)
    // {
    //     event.sender.send("getFolderPathReply", folderPath[0]);
    // }
    // else
    // {
    //     event.sender.send("getFolderPathReply", undefined);
    // }


    if (!fs.existsSync(defaultFolderPath))
    {
        fs.mkdirSync(defaultFolderPath);
    }

    event.sender.send("filesList", listFinishedSongs());
    watchSongsFolder(event.sender);
});

// Only finished songs, not yt-dlp's in progress files (.part, .temp.mp3, .f251.webm...)
function listFinishedSongs()
{
    try
    {
        return fs.readdirSync(defaultFolderPath).filter(isFinishedSong);
    }
    catch (error)
    {
        return [];
    }
}

// Watch the songs folder, so files deleted (or added) outside the app, e.g. in Finder, update the page's list.
// A download writes lots of temp files, so wait for the changes to settle before sending the list.
// The folder's parent is watched too: on macOS deleting the watched folder itself sends no events,
// and it lets the folder watcher start again when the folder is re-created
var folderWatcher = null;
var parentWatcher = null;
function watchSongsFolder(sender)
{
    var settleTimeout = null;
    function changed()
    {
        clearTimeout(settleTimeout);
        settleTimeout = setTimeout(sendList, 300);
    }

    function startFolderWatcher()
    {
        if (folderWatcher || !fs.existsSync(defaultFolderPath))
        {
            return;
        }
        try
        {
            folderWatcher = fs.watch(defaultFolderPath, changed);
            folderWatcher.on("error", () =>
            {
                stopFolderWatcher();
                changed();
            });
        }
        catch (error)
        {
            folderWatcher = null;
        }
    }
    function stopFolderWatcher()
    {
        if (folderWatcher)
        {
            folderWatcher.close();
            folderWatcher = null;
        }
    }

    function sendList()
    {
        if (fs.existsSync(defaultFolderPath))
        {
            startFolderWatcher();
        }
        else
        {
            stopFolderWatcher();
        }
        if (!sender.isDestroyed())
        {
            sender.send("folderChanged", listFinishedSongs());
        }
    }

    startFolderWatcher();
    if (!parentWatcher)
    {
        try
        {
            const folderName = path.basename(defaultFolderPath);
            parentWatcher = fs.watch(path.dirname(defaultFolderPath), (type, name) =>
            {
                if (name == folderName) changed();
            });
            parentWatcher.on("error", () => { parentWatcher = null; });
        }
        catch (error)
        {
            parentWatcher = null;
        }
    }
}

ipc.on("openSongsFolder", function(event, data)
{
    // Open folder in system file explorer
    let command;

    if (platform === "win32")
    {
        command = `start "" "${defaultFolderPath}"`;
    }
    else if (platform === "darwin")
    {
        command = `open "${defaultFolderPath}"`;
    }
    else if (platform === "linux")
    {
        command = `xdg-open "${defaultFolderPath}"`;
    }

    exec(command, (error) =>
    {
        if (error)
        {
            console.error(`Error opening folder: ${error}`);
        }
    });
});

ipc.on("saveSongs", async function(event, songFileList)
{
    // Each file's result is sent as it finishes (for its icon), counts are sent at the end (for one message)
    var saved = 0;
    var skipped = 0;
    var failed = 0;

    // Go through song file list
    for (const songData of songFileList)
    {
        // ID3 tags are only for mp3s (they'd corrupt mp4s etc.)
        if (!songData.songFileName.endsWith(".mp3"))
        {
            skipped++;
            event.sender.send("songSaved", songData.songFileName, "skipped");
            continue;
        }

        // Only set fields that have a value, update keeps the file's other tags
        var tags = {};
        if (songData.songName) tags.title = songData.songName;
        if (songData.artistName) tags.artist = songData.artistName;
        if (songData.albumName) tags.album = songData.albumName;

        // One bad song shouldn't stop the rest from saving
        try
        {
            // Spotify covers are http(s), anything else (e.g. an empty img src) means no cover
            if (/^https?:\/\//.test(songData.albumImage))
            {
                const res = await fetch(songData.albumImage);
                if (!res.ok)
                {
                    throw new Error(`Cover download failed: ${res.status} ${res.statusText}`);
                }
                tags.APIC =
                {
                    mime: res.headers.get("content-type") || "image/jpeg",
                    type: { id: 3 },          // 3 = front cover
                    description: "Cover",
                    imageBuffer: Buffer.from(await res.arrayBuffer())
                };
            }

            // Nothing to save if the song was never scanned or edited
            if (Object.keys(tags).length == 0)
            {
                skipped++;
                event.sender.send("songSaved", songData.songFileName, "skipped");
                continue;
            }

            await nodeid3.Promise.update(tags, path.join(defaultFolderPath, songData.songFileName));
            saved++;
            event.sender.send("songSaved", songData.songFileName, "saved");
        }
        catch (error)
        {
            console.error(`Couldn't save ${songData.songFileName}: ${error.message}`);
            failed++;
            event.sender.send("songSaved", songData.songFileName, "failed");
        }
    }

    event.sender.send("songsSaved", { saved, skipped, failed });
});

ipc.on("searchSong", function(event, songName)
{
    // Get a token, then search
    getSpotifyToken()
    .then(token =>
    {
        // Use spotify api to search by track
        return fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(songName)}&type=track`,
        {
            method: "GET",
            headers: {"Authorization": "Bearer " + token}
        });
    })
    .then(result => result.json())
    .then(json =>
    {
        event.sender.send("songSearch", json);
    })
    .catch(error =>
    {
        var message = error.message;
        if (error.cause?.errno == -3008)
        {
            message = "Network connection failed."
        }
        // The credentials dialog shows the message, so the fail only stops the page's spinner
        if (error.needsCredentials)
        {
            event.sender.send("spotifyCredentialsNeeded", message);
            message = "";
        }
        event.sender.send("songSearchFail", message);
    });
});

ipc.on("scanSong", function(event, songName, fileName)
{
    getSpotifyToken()
    .then(token =>
    {
        // Top 10, the page picks the best match from them
        return fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(songName)}&type=track&limit=10`,
        {
            method: "GET",
            headers: {"Authorization": "Bearer " + token}
        });
    })
    .then(result => result.json())
    .then(json =>
    {
        event.sender.send("songScan", json, fileName);
    })
    .catch(error =>
    {
        // The credentials dialog shows the message instead
        if (error.needsCredentials)
        {
            event.sender.send("spotifyCredentialsNeeded", error.message);
            return;
        }
        event.sender.send("songScanFail", error.message);
    });
});

ipc.on("deleteSongs", function(event)
{
    // fs.readdir(defaultFolderPath, (err, files) =>
    // {
    //     if (err)
    //     {
    //         event.sender.send("deleteSong", 1);
    //         return;
    //     }

    //     files.forEach(file =>
    //     {
    //         if (file != ".DS_Store")
    //         {
    //             fs.unlink(path.join(defaultFolderPath, file), (err) =>
    //             {
    //                 if (err) console.error(`Error deleting file: ${err}`);
    //             });
    //         }
    //     });

    //     event.sender.send("deleteSong", 0);
    // });

    var status = 0;
    try
    {
        fs.readdirSync(defaultFolderPath).forEach(file =>
        {
            fs.rmSync(path.join(defaultFolderPath, file), { recursive: true, force: true });
        });
    }
    catch (error)
    {
        console.error(`Error deleting files: ${error}`);
        status = 1;
    }

    event.sender.send("deleteSongs", status);
});

// yt-dlp prints this before each finished file's path (see --print in downloadFromLink)
const finishedPrefix = "KDL_FILE:";

// Downloads in progress, { stopped, process }, so the stop button (and quitting) can end them
const activeDownloads = new Set();

// Stop a download: kill yt-dlp and the ffmpeg it started (its whole process group, or tree on Windows)
function stopDownload(download)
{
    download.stopped = true;
    const child = download.process;
    if (!child || child.exitCode !== null)
    {
        return;
    }

    try
    {
        if (platform === "win32")
        {
            spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
        }
        else
        {
            process.kill(-child.pid, "SIGTERM");
        }
    }
    catch (error)
    {
        child.kill();
    }
}

ipc.on("stopDownload", function()
{
    activeDownloads.forEach(stopDownload);
});

// Don't leave yt-dlp downloading in the background after the app closes
app.on("before-quit", function()
{
    activeDownloads.forEach(stopDownload);
});

// After a stop, remove the partial files yt-dlp leaves (.part, .ytdl, .temp.mp3, unmerged streams...).
// Only files changed since this download started, so nothing older is touched
function removePartialFiles(since)
{
    try
    {
        for (const file of fs.readdirSync(defaultFolderPath))
        {
            const filePath = path.join(defaultFolderPath, file);
            if (!file.startsWith(".") && !isFinishedSong(file) && fs.statSync(filePath).mtimeMs >= since)
            {
                fs.rmSync(filePath, { force: true });
            }
        }
    }
    catch (error)
    {
        console.error(`Error removing partial files: ${error}`);
    }
}

// Run yt-dlp once. Finished files go to the page's file list, the rest of the output to its download log.
// Resolves with the exit code, and whether YouTube refused a download with a 403
function runYtdlp(args, event, download)
{
    return new Promise((resolve) =>
    {
        // Its own process group (not on Windows), so stopping can kill ffmpeg along with it
        const child = spawn(findYtdlp(), args, { detached: platform !== "win32" });
        download.process = child;
        runningDownloads++;
        var forbidden = false;

        // A finished file goes to the file list, anything else to the download log
        function handleLine(line)
        {
            if (line.startsWith(finishedPrefix))
            {
                event.sender.send("songDownloaded", path.basename(line.slice(finishedPrefix.length)));
            }
            else if (line)
            {
                event.sender.send("downloadOutput", line);
            }
        }

        // Output can arrive cut mid line, so keep the unfinished end until the rest comes
        var unfinishedLine = "";
        child.stdout.on("data", (output) =>
        {
            var lines = (unfinishedLine + output.toString()).split(/\r?\n|\r/);
            unfinishedLine = lines.pop();
            lines.forEach(handleLine);
        });
        child.stderr.on("data", (error) =>
        {
            const text = error.toString();
            if (/HTTP Error 403/i.test(text))
            {
                forbidden = true;
            }
            event.sender.send("downloadOutput", text);
        });

        // Only finish once, error can fire with or without close
        var finished = false;
        child.on("error", (error) =>
        {
            if (finished) return;
            finished = true;
            runningDownloads--;
            event.sender.send("downloadOutput", `Couldn't start yt-dlp: ${error.message}`);
            resolve({ code: 1, forbidden: false });
        });
        child.on("close", (code) =>
        {
            if (finished) return;
            finished = true;
            runningDownloads--;
            handleLine(unfinishedLine);
            resolve({ code, forbidden });
        });
    });
}

// settings come from the page's download settings dropdown (downloadSettings in index.html)
ipc.on("downloadFromLink", async function(event, link, settings)
{
    const onOutput = (output) => event.sender.send("downloadOutput", output);
    const download = { stopped: false, process: null, startedAt: Date.now() };
    activeDownloads.add(download);

    // Get yt-dlp, ffmpeg and deno before downloading
    try
    {
        await ensureTools(onOutput);
    }
    catch (error)
    {
        activeDownloads.delete(download);
        onOutput(`Couldn't download yt-dlp/ffmpeg: ${error.message}`);
        event.sender.send("downloadCompleted", 1);
        return;
    }

    // Stopped while the tools were downloading
    if (download.stopped)
    {
        activeDownloads.delete(download);
        event.sender.send("downloadCompleted", 1, true);
        return;
    }
    onOutput("Downloading...");

    // Videos that finish are listed here, so a retry skips them.
    // Only kept for this download, so a song can still be downloaded again later
    const archivePath = path.join(os.tmpdir(), `kdl-archive-${crypto.randomUUID()}.txt`);

    // Args go straight to yt-dlp (no shell), so links with & etc. stay intact
    var args = ["--ffmpeg-location", ffmpegPath, "--sleep-interval", "5", "--download-archive", archivePath];
    if (fs.existsSync(denoPath)) args.push("--js-runtimes", `deno:${denoPath}`);
    if (settings.noWarnings) args.push("--no-warnings");
    if (settings.ignoreErrors) args.push("-i");

    // mp3 VBR quality: high is yt-dlp's 0 (~260 kbps), medium is 5, its default (~140 kbps), low is 9 (~75 kbps)
    if (settings.audioOnly) args.push("-t", "mp3", "--audio-quality", { high: "0", medium: "5", low: "9" }[settings.audioQuality] || "0");
    else args.push("-t", "mp4");

    // A link copied from a playing mix/playlist has &list= in it, which would otherwise download the whole list (hundreds of videos for a mix)
    args.push(settings.wholePlaylist ? "--yes-playlist" : "--no-playlist");

    // Cut the parts SponsorBlock users marked as sponsored or not music (intros, outros, skits). Does nothing for videos nobody marked
    if (settings.cutSponsored) args.push("--sponsorblock-remove", "sponsor,music_offtopic");

    // Print each file's final path once it's converted and moved, so the page can show it right away.
    // --print turns on quiet mode, --progress --newline keep the progress lines (one per line)
    args.push("--print", `after_move:${finishedPrefix}%(filepath)s`, "--progress", "--newline");
    args.push("-o", path.join(defaultFolderPath, "%(title)s.%(ext)s"), "--", link.trim());

    try
    {
        var result = await runYtdlp(args, event, download);

        // A 403 usually means yt-dlp is behind YouTube's latest changes, or the video's links expired.
        // Update yt-dlp if there's a new one and retry once, the archive skips videos that already finished
        if (result.code !== 0 && result.forbidden && !download.stopped)
        {
            onOutput("YouTube refused the download (403), checking for a yt-dlp update and retrying...");
            try
            {
                await ensureTools(onOutput, true);
            }
            catch (error)
            {
                onOutput(`Couldn't update yt-dlp: ${error.message}`);
            }
            if (!download.stopped)
            {
                result = await runYtdlp(args, event, download);
            }
        }

        // Songs that finished before the stop are kept, only the partial ones are removed
        if (download.stopped)
        {
            removePartialFiles(download.startedAt);
        }
        event.sender.send("downloadCompleted", result.code, download.stopped);
    }
    finally
    {
        activeDownloads.delete(download);
        fs.rmSync(archivePath, { force: true });
    }
});
