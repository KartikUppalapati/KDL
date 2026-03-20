const { app, BrowserWindow, dialog, globalShortcut } = require('electron');
const { exec, spawn } = require('node:child_process');
var ipc = require('electron').ipcMain;
const path = require('path');
require('dotenv').config();
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
        // width: 900,
        // height: 600,
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

// Disable reload
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
const defaultFolderPath = (process.env.HOME || process.env.USERPROFILE) + "/TempSongHolder";


ipc.on("getFolderPath", function(event, data)
{
    // Create folder if doesn't exist
    if (!fs.existsSync(defaultFolderPath))
    {
        fs.mkdirSync(defaultFolderPath);
    }

    event.sender.send("getFolderPathReply", defaultFolderPath);

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
});

ipc.on("getFilesInFolder", function(event, folderFullPath)
{
    // Create list
    const listOfFiles = [];

    // Read files into list
    fs.readdir(folderFullPath, (err, files) =>
    {
        files.forEach(file =>
        {
            if (file != ".DS_Store")
            {
                listOfFiles.push(file);
            }
        });

        // Send back list
        event.sender.send("getFilesInFolderReply", listOfFiles);
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

ipc.on("saveSongs", function(event, songFileList)
{
    // Go through song file list
    for (let i = 0; i < songFileList.length; i++)
    {
        // Get song data
        var songData = songFileList[i]

        // Save metadata using jar file
        exec(`java -jar src/mp3Editer.jar "${songData.songFullFileName.replaceAll("&amp;", "&")}" "${songData.songName.replaceAll("&amp;", "&")}" "${songData.artistName.replaceAll("&amp;", "&")}" "${songData.albumName.replaceAll("&amp;", "&")}" ${songData.albumImage.replaceAll("&amp;", "&")}`,
        (error, stdout, stderr) =>
        {
            if (error) 
            {
                // console.error(`saving exec error: ${error}`);
                event.sender.send("songsSavedResponse", 1);
            }
            else
            {
                event.sender.send("songsSavedResponse", 0);
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
            "Authorization": "Basic " + btoa(process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET)
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
        // Send back successful response
        event.sender.send("songSearchResults", json);
    })
    .catch(error =>
    {
        event.sender.send("songSearchFail", error.message);
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
            "Authorization": "Basic " + btoa(process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET)
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
        event.sender.send("songScanResult", json, index);
    })
    .catch(error =>
    {
        event.sender.send("songScanFail", error.message);
    });
});

ipc.on("deleteAllSongs", function(event)
{
    fs.readdir(defaultFolderPath, (err, files) =>
    {
        if (err)
        {
            event.sender.send("deleteAllSongsResponse", 1);
            return;
        }

        files.forEach(file =>
        {
            if (file != ".DS_Store")
            {
                fs.unlink(path.join(defaultFolderPath, file), (err) =>
                {
                    if (err) console.error(`Error deleting file: ${err}`);
                });
            }
        });

        event.sender.send("deleteAllSongsResponse", 0);
    });
});

ipc.on("downloadFromLink", function(event, link)
{
    // Spawn child process to download songs using yt-dlp
    var commandArray = ["yt-dlp", "-i", "--ffmpeg-location", "/usr/local/bin/ffmpeg", "-x", "--audio-format", 
    "mp3", "--sleep-interval", "5", "-o", defaultFolderPath + "'/%(title)s.%(ext)s'", link]
    const download = exec(commandArray.join(" "));

    download.stdout.on("data", (output) =>
    {
        // console.log(`stdout: ${outData}`);
        event.sender.send("downloadOutput", output.toString());
    });
  
    download.stderr.on("data", (error) =>
    {
        // console.error(`stderr: ${errData}`);
        event.sender.send("downloadOutput", error.toString());
    });

    download.on("close", (code) =>
    {
        event.sender.send("downloadCompleted", code);
    });
});