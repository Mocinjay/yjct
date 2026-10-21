const path = require('path');

module.exports = {
  dependencies: {
    // Local native module: clip stitching, wake-word transcription, on-device
    // captioning and hook-first analysis. It is not in package.json, so it is
    // declared here for autolinking (pod install / Gradle pick it up from here).
    'react-native-clip-stitcher': {
      root: path.join(__dirname, 'modules/clip-stitcher'),
    },
  },
};
