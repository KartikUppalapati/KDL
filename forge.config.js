const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

module.exports = {
  hooks: {
    // Electron's binary only has the linker's ad-hoc signature, which doesn't cover the rest of the app,
    // so macOS calls a downloaded KDL "damaged". Re-sign the whole app ad-hoc (no Apple Developer ID needed)
    postPackage: async (forgeConfig, options) => {
      if (options.platform !== 'darwin') return;
      for (const outputPath of options.outputPaths) {
        const appName = fs.readdirSync(outputPath).find((file) => file.endsWith('.app'));
        const appPath = path.join(outputPath, appName);
        execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath]);
        execFileSync('codesign', ['--verify', '--deep', '--strict', appPath]);
      }
    },
  },

  packagerConfig: {
    appBundleId: 'com.karts.kdl',
    asar: true,
    // Spotify credentials are entered in the app now, never ship an old .env with a secret in it
    ignore: [/^\/\.env/],
    extraResource: [
      './src/dependencies',
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  // npm run publish uploads the builds to a GitHub release (needs a GITHUB_TOKEN), which installed copies update from.
  // Not a draft, so the release is "latest" (what the app checks) right away
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: { owner: 'KartikUppalapati', name: 'KDL' },
        draft: false,
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
  ],
};
