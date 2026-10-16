export default {
  app: {
    name: 'Claude Session Restore',
    identifier: 'io.github.claude-session-restore',
    version: '1.0.0',
    description: 'Restore your Claude Code sessions after a shutdown, and manage every chat.',
  },
  build: {
    buildFolder: 'build',
    artifactFolder: 'artifacts',
    bun: {
      entrypoint: 'src/bun/index.ts',
    },
    views: {
      mainview: {
        entrypoint: 'src/mainview/index.ts',
      },
    },
    copy: {
      'src/mainview/index.html': 'views/mainview/index.html',
      'src/mainview/styles.css': 'views/mainview/styles.css',
      'src/mainview/fonts/Geist-Variable.woff2': 'views/mainview/fonts/Geist-Variable.woff2',
      'src/mainview/fonts/GeistMono-Variable.woff2': 'views/mainview/fonts/GeistMono-Variable.woff2',
    },
    mac: {
      icons: 'assets/icon.iconset',
      codesign: false,
      notarize: false,
      createDmg: false,
    },
  },
};
