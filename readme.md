# KDL

## Setup

Searching Spotify needs a Client ID and Client Secret. Create an app in the [Spotify developer dashboard](https://developer.spotify.com/dashboard), then click the key button at the top of KDL and paste them in. KDL checks them with Spotify and saves them on that computer only (the secret is encrypted with the OS keychain), so they aren't in the code or the built app.

## Installation & Running

Requires Node.js 22.13 or newer (for Electron Forge 8).

Run the following commands to install dependencies and start the application:

```bash
npm install
npm run start
```


## Download

Then run the following command to create an executable of the application:

```bash
npm run make
```

## Releasing updates

Installed copies check GitHub for a newer release once a day and update themselves. On macOS the new version is downloaded in the background and installed when KDL quits (or right away with the green update button). Windows uses the Squirrel installer's updater, and on Linux the button links to the release.

To release a new version, bump `version` in package.json, then run:

```bash
GITHUB_TOKEN=<token with access to the repo's contents> npm run publish
```

This builds KDL and uploads it to a GitHub release named after the version. Each platform's files have to be built on that platform, so run it on a Mac and on Windows to publish both.
