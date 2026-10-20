const { app, BrowserWindow, dialog, globalShortcut, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
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

// Songs are kept in the app's own folder (next to bin/ and the spotify credentials), not in the home folder.
// The "Open song folder" button shows it in Finder/Explorer
const defaultFolderPath = path.join(app.getPath("userData"), "songs");

// Songs used to be in ~/TempKdlFiles, move them in the first time so none go missing.
// If that fails (e.g. a different drive), the old folder is just left where it is
function moveOldSongsFolder()
{
    const oldFolderPath = path.join(os.homedir(), "TempKdlFiles");
    if (!fs.existsSync(oldFolderPath) || fs.existsSync(defaultFolderPath))
    {
        return;
    }
    try
    {
        fs.mkdirSync(path.dirname(defaultFolderPath), { recursive: true });
        fs.renameSync(oldFolderPath, defaultFolderPath);
    }
    catch (error)
    {
        console.error(`Couldn't move ${oldFolderPath} to ${defaultFolderPath}: ${error}`);
    }
}
moveOldSongsFolder();

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

// For playing songs in the page (it builds file:// urls from this)
ipc.handle("getSongsFolder", function()
{
    return defaultFolderPath;
});

// For the credentials dialog, which shows the saved ones (the secret masked until its eye is clicked)
ipc.handle("getSpotifyCredentials", function()
{
    const credentials = loadSpotifyCredentials();
    return { clientId: credentials ? credentials.clientId : "", clientSecret: credentials ? credentials.clientSecret : "" };
});

// Check new credentials with spotify, and only save them if they work
ipc.handle("saveSpotifyCredentials", async function(event, clientId, clientSecret)
{
    clientId = (clientId || "").trim();
    clientSecret = (clientSecret || "").trim();
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

// Save one song's tags (title, artist, album, cover). Resolves "saved", "skipped" (not an mp3, or nothing to save) or "failed"
async function saveSongTags(songData)
{
    // ID3 tags are only for mp3s (they'd corrupt mp4s etc.)
    if (!songData.songFileName.endsWith(".mp3"))
    {
        return "skipped";
    }

    // Only set fields that have a value, update keeps the file's other tags
    var tags = {};
    if (songData.songName) tags.title = songData.songName;
    if (songData.artistName) tags.artist = songData.artistName;
    if (songData.albumName) tags.album = songData.albumName;

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
            return "skipped";
        }

        await nodeid3.Promise.update(tags, path.join(defaultFolderPath, songData.songFileName));
        return "saved";
    }
    catch (error)
    {
        console.error(`Couldn't save ${songData.songFileName}: ${error.message}`);
        return "failed";
    }
}

ipc.on("saveSongs", async function(event, songFileList)
{
    // Each file's result is sent as it finishes (for its icon), counts are sent at the end (for one message).
    // One bad song doesn't stop the rest from saving
    var counts = { saved: 0, skipped: 0, failed: 0 };
    for (const songData of songFileList)
    {
        const status = await saveSongTags(songData);
        counts[status]++;
        event.sender.send("songSaved", songData.songFileName, status);
    }

    event.sender.send("songsSaved", counts);
});

// Where Export goes by default: a folder the music app imports from by itself (Apple Music on macOS, iTunes),
// otherwise the plain Music folder. Only the default locations are checked
function getMusicLibrary()
{
    const music = app.getPath("music");
    const autoImportFolders =
    [
        { folder: path.join(music, "Music", "Media.localized", "Automatically Add to Music.localized"), name: "Music" },
        { folder: path.join(music, "Music", "Media", "Automatically Add to Music.localized"), name: "Music" },
        { folder: path.join(music, "iTunes", "iTunes Media", "Automatically Add to iTunes.localized"), name: "iTunes" },
        { folder: path.join(music, "iTunes", "iTunes Media", "Automatically Add to iTunes"), name: "iTunes" },
    ];
    return autoImportFolders.find(library => fs.existsSync(library.folder)) || { folder: music, name: "your Music folder" };
}

// A path in folder for fileName that isn't taken yet: "Song.mp3", then "Song (1).mp3", ...
function freePath(folder, fileName)
{
    const extension = path.extname(fileName);
    const base = path.basename(fileName, extension);
    var candidate = path.join(folder, fileName);
    for (let i = 1; fs.existsSync(candidate); i++)
    {
        candidate = path.join(folder, `${base} (${i})${extension}`);
    }
    return candidate;
}

// Move a file, copying instead when it's going to another drive (rename can't do that)
function moveFile(source, destination)
{
    try
    {
        fs.renameSync(source, destination);
    }
    catch (error)
    {
        if (error.code != "EXDEV")
        {
            throw error;
        }
        fs.copyFileSync(source, destination);
        fs.unlinkSync(source);
    }
}

// The export modal's starting folder (Apple Music's import folder on macOS), until the user picks another
ipc.handle("getDefaultExportFolder", function()
{
    return getMusicLibrary().folder;
});

// Clicking the export modal's folder: pick a different one, starting from the current. Resolves the new path, or null if cancelled
ipc.handle("chooseExportFolder", async function(event, currentFolder)
{
    const choice = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender),
    {
        title: "Export folder",
        buttonLabel: "Choose",
        defaultPath: currentFolder,
        properties: ["openDirectory", "createDirectory"]
    });
    return choice.canceled || !choice.filePaths.length ? null : choice.filePaths[0];
});

// Move songs into folder (they leave KDL), as they are, saved or not
ipc.handle("exportSongs", async function(event, fileNames, folder)
{
    if (!fs.existsSync(folder))
    {
        return { error: "The export folder doesn't exist anymore, choose another." };
    }

    var moved = [];
    var failed = 0;
    for (const fileName of fileNames)
    {
        try
        {
            moveFile(path.join(defaultFolderPath, fileName), freePath(folder, fileName));
            moved.push(fileName);
        }
        catch (error)
        {
            console.error(`Couldn't move ${fileName}: ${error.message}`);
            failed++;
        }
    }

    // "Music" when it's the music app's import folder, otherwise the folder's name
    const library = getMusicLibrary();
    const folderName = path.resolve(folder) == path.resolve(library.folder) ? library.name : path.basename(folder);
    return { moved, failed, folderName };
});

// Dragging a song out of the list drags the real file (into Finder, Music, the desktop...). The drag needs an icon
ipc.on("startDrag", async function(event, fileName)
{
    const filePath = path.join(defaultFolderPath, fileName);
    if (!fs.existsSync(filePath))
    {
        return;
    }
    const icon = await app.getFileIcon(filePath, { size: "normal" });
    event.sender.startDrag({ file: filePath, icon });
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


// App updates, from the GitHub releases (npm run publish uploads them).
// The mac app isn't signed, which Electron's autoUpdater needs there, so KDL replaces its own .app instead:
// the new zip is downloaded and unzipped in the background, then swapped in after KDL quits (relaunching it if
// "Restart to update" was clicked). Windows uses Squirrel's autoUpdater, which doesn't need signing.
// Linux packages need sudo to replace, so there the page just links to the release
const updateRepo = "KartikUppalapati/KDL";
const updateDir = path.join(app.getPath("userData"), "update");

// { status: "ready" | "available", version, url }, kept so a reopened window still shows it
var appUpdate = null;
var appUpdateCheck = null;
const appUpdatePages = new Set();
var lastAppUpdateCheck = 0;

// The new .app waiting to be swapped in, and whether KDL should reopen after
var pendingMacUpdate = null;
var relaunchAfterUpdate = false;

// "v1.2.3" -> [1, 2, 3], to compare release tags with app.getVersion()
function isNewerVersion(version, current)
{
    const parse = (v) => v.replace(/^v/, "").split(/[.-]/).map(n => parseInt(n) || 0);
    const a = parse(version), b = parse(current);
    for (var i = 0; i < Math.max(a.length, b.length); i++)
    {
        if ((a[i] || 0) != (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
    }
    return false;
}

// The running KDL.app, or why it can't be replaced. Run from Downloads, macOS runs a read-only copy of it
// (App Translocation), and an app in a folder the user can't write to can't be replaced either
function getMacAppPath()
{
    const appPath = path.resolve(app.getPath("exe"), "../../..");
    if (!appPath.endsWith(".app"))
    {
        return { error: "KDL isn't running from an app" };
    }
    if (appPath.includes("/AppTranslocation/"))
    {
        return { error: "Move KDL to Applications to get updates" };
    }
    try
    {
        fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
        fs.accessSync(appPath, fs.constants.W_OK);
    }
    catch (error)
    {
        return { error: `KDL can't replace itself in ${path.dirname(appPath)}` };
    }
    return { appPath };
}

// Download and unzip the new mac app into updateDir/<version>. A finished one from before is reused
async function downloadMacUpdate(release, version)
{
    const asset = release.assets.find(a => new RegExp(`-darwin-${process.arch}-.*\\.zip$`).test(a.name));
    const expectedHash = asset?.digest?.startsWith("sha256:") ? asset.digest.slice(7) : undefined;
    if (!asset || !expectedHash)
    {
        throw new Error(`No ${process.arch} mac zip with a checksum in release ${release.tag_name}`);
    }

    // Older downloads are no use anymore
    const versionDir = path.join(updateDir, version);
    fs.mkdirSync(updateDir, { recursive: true });
    for (const file of fs.readdirSync(updateDir))
    {
        if (file !== version) fs.rmSync(path.join(updateDir, file), { recursive: true, force: true });
    }

    const findApp = () => fs.existsSync(versionDir) && fs.readdirSync(versionDir).find(file => file.endsWith(".app"));
    if (!findApp())
    {
        const zipPath = versionDir + ".zip";
        const hash = await downloadFile(asset.browser_download_url, zipPath, `KDL ${version}`, () => {});
        if (hash !== expectedHash.toLowerCase())
        {
            fs.rmSync(zipPath, { force: true });
            throw new Error(`Checksum mismatch for ${asset.name}`);
        }

        // ditto keeps the symlinks and permissions inside the app's frameworks
        const tempDir = versionDir + ".download";
        fs.rmSync(tempDir, { recursive: true, force: true });
        await new Promise((resolve, reject) =>
        {
            const child = spawn("ditto", ["-x", "-k", zipPath, tempDir]);
            child.on("error", reject);
            child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Couldn't unzip ${asset.name}`)));
        });
        fs.rmSync(zipPath, { force: true });
        fs.rmSync(versionDir, { recursive: true, force: true });
        fs.renameSync(tempDir, versionDir);
    }

    const newApp = findApp();
    if (!newApp)
    {
        throw new Error(`No app in ${asset.name}`);
    }
    return path.join(versionDir, newApp);
}

// Squirrel downloads the update itself and installs it when KDL quits
function checkWindowsUpdate()
{
    return new Promise((resolve, reject) =>
    {
        const { autoUpdater } = require("electron");
        const cleanup = () =>
        {
            autoUpdater.removeListener("update-downloaded", onDownloaded);
            autoUpdater.removeListener("update-not-available", onNotAvailable);
            autoUpdater.removeListener("error", onError);
        };
        const onDownloaded = () => { cleanup(); resolve(true); };
        const onNotAvailable = () => { cleanup(); resolve(false); };
        const onError = (error) => { cleanup(); reject(error); };
        autoUpdater.on("update-downloaded", onDownloaded);
        autoUpdater.on("update-not-available", onNotAvailable);
        autoUpdater.on("error", onError);

        // Squirrel reads RELEASES and the .nupkg next to it, github redirects latest/download/<file> to the newest release
        autoUpdater.setFeedURL({ url: `https://github.com/${updateRepo}/releases/latest/download` });
        autoUpdater.checkForUpdates();
    });
}

// Check for a newer release and get it ready. Failing is fine, it's checked again the next day
function checkForAppUpdate()
{
    if (appUpdate || appUpdateCheck || !app.isPackaged || process.argv.includes("--squirrel-firstrun"))
    {
        return;
    }
    lastAppUpdateCheck = Date.now();
    appUpdateCheck = (async () =>
    {
        const res = await fetch(`https://api.github.com/repos/${updateRepo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
        if (!res.ok)
        {
            throw new Error(`${res.status} ${res.statusText}`);
        }
        const release = await res.json();
        const version = release.tag_name.replace(/^v/, "");
        if (!isNewerVersion(version, app.getVersion()))
        {
            return;
        }

        if (platform === "darwin")
        {
            const { appPath, error } = getMacAppPath();
            if (error)
            {
                appUpdate = { status: "available", version, url: release.html_url, reason: error };
                return;
            }
            pendingMacUpdate = { appPath, newAppPath: await downloadMacUpdate(release, version) };
            appUpdate = { status: "ready", version };
        }
        else if (platform === "win32")
        {
            if (await checkWindowsUpdate())
            {
                appUpdate = { status: "ready", version };
            }
        }
        else
        {
            appUpdate = { status: "available", version, url: release.html_url };
        }
    })()
    .catch((error) => console.error(`Couldn't check for a KDL update: ${error.message}`))
    .finally(() =>
    {
        appUpdateCheck = null;
        if (appUpdate)
        {
            appUpdatePages.forEach(contents => contents.send("appUpdate", appUpdate));
        }
    });
}

// Check a few seconds after the page loads (so it doesn't slow down starting), then once a day
app.on("web-contents-created", function(event, contents)
{
    contents.on("destroyed", () => appUpdatePages.delete(contents));
    contents.on("did-finish-load", function()
    {
        appUpdatePages.add(contents);
        if (appUpdate)
        {
            contents.send("appUpdate", appUpdate);
        }
        else
        {
            setTimeout(checkForAppUpdate, 5000);
        }
    });
});
setInterval(function()
{
    if (Date.now() - lastAppUpdateCheck > updateCheckInterval)
    {
        checkForAppUpdate();
    }
}, 60 * 60 * 1000);

// "Restart to update" in the page
ipc.on("installAppUpdate", function()
{
    if (appUpdate?.status !== "ready")
    {
        return;
    }
    if (platform === "win32")
    {
        require("electron").autoUpdater.quitAndInstall();
        return;
    }
    relaunchAfterUpdate = true;
    app.quit();
});

// Swap the new .app in once KDL has exited. If moving the new one in fails, the old one is put back
app.on("will-quit", function()
{
    if (!pendingMacUpdate)
    {
        return;
    }
    const script = `
        while kill -0 "$1" 2>/dev/null; do sleep 0.2; done
        rm -rf "$2.old"
        if mv "$2" "$2.old"; then
            if mv "$3" "$2"; then rm -rf "$2.old" "$(dirname "$3")"; else mv "$2.old" "$2"; fi
        fi
        if [ "$4" = 1 ]; then open "$2"; fi`;
    const { appPath, newAppPath } = pendingMacUpdate;
    pendingMacUpdate = null;
    spawn("/bin/sh", ["-c", script, "sh", String(process.pid), appPath, newAppPath, relaunchAfterUpdate ? "1" : "0"],
          { detached: true, stdio: "ignore" }).unref();
});
