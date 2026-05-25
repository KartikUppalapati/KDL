const { app, BrowserWindow, dialog, globalShortcut } = require('electron');
const { exec, spawn } = require('node:child_process');
const ytdlpnodejs = require('ytdlp-nodejs');
const ytdlp = new ytdlpnodejs.YtDlp();
var ipc = require('electron').ipcMain;
const nodeid3 = require('node-id3');
const path = require('path');
const fs = require('fs');

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
const spotify_client_id="6d3c6efcc74b4891981593966033ec76"
const spotify_client_secret="530dcb7cc7dd43e2bf0e5ff4ebad6be2"
const defaultFolderPath = (process.env.HOME || process.env.USERPROFILE) + "/TempKdlFiles";
const ytldpPath = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ytdlp-nodejs', 'bin', 'yt-dlp_macos') : ytdlp.binaryPath;
const ffmpegPath = app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'ytdlp-nodejs', 'bin', 'ffmpeg') : ytdlp.ffmpegPath;

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

    const listOfFiles = [];
    fs.readdir(defaultFolderPath, (err, files) =>
    {
        files.forEach(file =>
        {
            if (file != ".DS_Store")
            {
                listOfFiles.push(file);
            }
        });

        event.sender.send("filesList", listOfFiles);
    });
});

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
    // Go through song file list
    for (let i = 0; i < songFileList.length; i++)
    {
        // Get song data
        var songData = songFileList[i]

        // Skip mp4s
        if (songData.songFileName.endsWith(".mp4"))
        {
            continue;
        }

        // Get image as buffer
        const res = await fetch(songData.albumImage.replaceAll("&amp;", "&"));
        const arrayBuffer = await res.arrayBuffer();
        var tags =
        {
            title: songData.songName.replaceAll("&amp;", "&"),
            artist: songData.artistName.replaceAll("&amp;", "&"),
            album: songData.albumName.replaceAll("&amp;", "&"),
            APIC: {
                mime: "image/jpeg",       // or 'image/png' depending on the URL
                type: { id: 3 },          // 3 = front cover
                description: "Cover",
                imageBuffer: Buffer.from(arrayBuffer)
            }
        }

        // Write
        nodeid3.write(tags, defaultFolderPath + "/" + songData.songFileName.replaceAll("&amp;", "&"), (error) =>
        {
            if (error)
            {
                console.log(error);
                event.sender.send("songsSaved", 1);
            }
            else
            {
                event.sender.send("songsSaved", 0);
            }
        });
    }
});

ipc.on("searchSong", function(event, songName)
{
    // Use spotify api endpoint to get token
    fetch("https://accounts.spotify.com/api/token", 
    {
        method: "POST",
        headers: 
        {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": "Basic " + btoa(`${spotify_client_id}:${spotify_client_secret}`)
        },
        body: "grant_type=client_credentials"
    })
    .then(result => result.json())
    .then(data =>
    {
        // Use spotify api to search by track
        return fetch(`https://api.spotify.com/v1/search?q=${songName.replaceAll(" ", "+")}&type=track`,
        {
            method: "GET",
            headers: {"Authorization": "Bearer " + data.access_token}
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
        if (error.cause.errno == -3008)
        {
            message = "Network connection failed."
        }
        event.sender.send("songSearchFail", message);
    });
});

ipc.on("scanSong", function(event, songName, index)
{
    fetch("https://accounts.spotify.com/api/token", 
    {
        method: "POST",
        headers: 
        {
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": "Basic " + btoa(`${spotify_client_id}:${spotify_client_secret}`)
        },
        body: "grant_type=client_credentials"
    })
    .then(result => result.json())
    .then(data =>
    {
        return fetch(`https://api.spotify.com/v1/search?q=${songName.replaceAll(" ", "+")}&type=track`,
        {
            method: "GET",
            headers: {"Authorization": "Bearer " + data.access_token}
        });
    })
    .then(result => result.json())
    .then(json =>
    {
        event.sender.send("songScan", json, index);
    })
    .catch(error =>
    {
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

    exec(`rm -rf ${defaultFolderPath}/*`).on("close", (status) =>
    {
        event.sender.send("deleteSongs", status);
    });
});

ipc.on("downloadFromLink", function(event, link, audioOnlySetting, noWarningsSetting, ignoreErrorsSetting)
{
    // Check ffmpeg
    exec(ffmpegPath + " -h").on("close", async (code) =>
    {
        if (code == 1)
        {
            event.sender.send("downloadOutput", "Downloading ffmpeg...");
            await ytdlp.downloadFFmpeg();
        }
        else
        {
            event.sender.send("downloadOutput", "Downloading...");
        }
    });

    var commandArray = [ytldpPath, "--ffmpeg-location", ffmpegPath, "--sleep-interval", "5"]
    if (noWarningsSetting == 1) commandArray.push("--no-warnings");
    if (audioOnlySetting == 1) commandArray.push("-t mp3");
    if (audioOnlySetting == 0) commandArray.push("-t mp4");
    if (ignoreErrorsSetting == 1) commandArray.push("-i");
    commandArray.push("-o", defaultFolderPath + "/" + "'%(title)s.%(ext)s'", link);
    const download = exec(commandArray.join(" "));

    download.stdout.on("data", (output) =>
    {
        // console.log(`stdout: ${output}`);
        var cleaned = output.toString().split('\r').filter(Boolean).pop();
        event.sender.send("downloadOutput", cleaned);
    });
    download.stderr.on("data", (error) =>
    {
        // console.error(`stderr: ${error}`);
        event.sender.send("downloadOutput", error.toString());
    });
    download.on("close", (code) =>
    {
        event.sender.send("downloadCompleted", code);
    });
});