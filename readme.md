## Setup

Searching Spotify needs a Client ID and Client Secret. Create an app in the [Spotify developer dashboard](https://developer.spotify.com/dashboard), then click the key button at the top of the app and paste them in. The keys are checked with Spotify and saved locally only (the secret is encrypted with the OS keychain).


## Install app via terminal (apple silicon macs only)

```bash
curl -sL https://api.github.com/repos/KartikUppalapati/KDL/releases/latest | grep -o 'https://[^"]*darwin-arm64[^"]*\.zip' | head -1 | xargs curl -L -o /tmp/KDL.zip && ditto -x -k /tmp/KDL.zip /Applications && rm /tmp/KDL.zip
```

## Clone repo and run via npm

Requires Node.js 22.13 or newer (for Electron Forge 8).

Run the following commands to install dependencies and start the application:

```bash
npm install
npm run start
```
