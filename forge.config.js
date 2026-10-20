module.exports = {
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
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
  ],
};
