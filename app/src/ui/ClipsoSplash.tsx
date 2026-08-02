import React, { useCallback, useRef } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import Video from 'react-native-video';

const SPLASH = require('./assets/clipso-splash.mp4');

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');
// The source is square and the wordmark only spans ~85% of it, so oversize the
// stage past the short axis to render the logo full-bleed. The overflow is only
// the source's black padding, and the root clips it.
const STAGE = Math.min(SCREEN_W, SCREEN_H) * 1.18;

type Props = {
  onFinished: () => void;
};

/**
 * Launch splash: the CLIPSO logo animation plays centered on black, then the
 * screen yields to the app.
 */
export function ClipsoSplash({ onFinished }: Props) {
  const done = useRef(false);

  // onEnd and onError can both fire; the app must only advance once.
  const finish = useCallback(() => {
    if (done.current) {
      return;
    }
    done.current = true;
    onFinished();
  }, [onFinished]);

  return (
    <View style={styles.root}>
      <Video
        source={SPLASH}
        style={styles.video}
        resizeMode="contain"
        muted
        repeat={false}
        controls={false}
        playInBackground={false}
        onEnd={finish}
        onError={finish}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    zIndex: 100,
  },
  video: {
    width: STAGE,
    height: STAGE,
    backgroundColor: '#000000',
  },
});
