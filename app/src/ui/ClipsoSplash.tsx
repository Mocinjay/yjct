import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Image,
  StyleSheet,
  View,
} from 'react-native';

const PAPERCLIP = require('./assets/clipso-paperclip.png');
const WORDMARK = require('./assets/clipso-wordmark.png');

const { width: SCREEN_W } = Dimensions.get('window');
const MARK_W = Math.min(SCREEN_W - 48, 340);
const MARK_H = MARK_W * 0.32;
const CLIP_H = 108;

type Props = {
  onFinished: () => void;
};

/**
 * Launch splash: chrome paperclip lands, its ends extend into the CLIPSO
 * wordmark, then the screen yields to the app.
 */
export function ClipsoSplash({ onFinished }: Props) {
  const clipOpacity = useRef(new Animated.Value(0)).current;
  const clipScale = useRef(new Animated.Value(0.55)).current;
  const clipLift = useRef(new Animated.Value(18)).current;
  const glint = useRef(new Animated.Value(0)).current;
  const extend = useRef(new Animated.Value(0)).current;
  const markOpacity = useRef(new Animated.Value(0)).current;
  const markScale = useRef(new Animated.Value(0.92)).current;
  const tagOpacity = useRef(new Animated.Value(0)).current;
  const exit = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const wireGrow = Animated.timing(extend, {
      toValue: 1,
      duration: 1200,
      easing: Easing.bezier(0.22, 1, 0.36, 1),
      useNativeDriver: false,
    });

    Animated.sequence([
      // 1 — paperclip arrives
      Animated.parallel([
        Animated.timing(clipOpacity, {
          toValue: 1,
          duration: 420,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.spring(clipScale, {
          toValue: 1,
          friction: 7,
          tension: 70,
          useNativeDriver: true,
        }),
        Animated.timing(clipLift, {
          toValue: 0,
          duration: 520,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      // 2 — specular glint on the metal
      Animated.sequence([
        Animated.timing(glint, {
          toValue: 1,
          duration: 280,
          useNativeDriver: true,
        }),
        Animated.timing(glint, {
          toValue: 0.35,
          duration: 320,
          useNativeDriver: true,
        }),
      ]),
      Animated.delay(120),
      // 3 — ends extend into the word; wordmark unfurls from the clip
      Animated.parallel([
        wireGrow,
        Animated.timing(markOpacity, {
          toValue: 1,
          duration: 700,
          delay: 280,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(markScale, {
          toValue: 1,
          duration: 900,
          delay: 280,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(clipOpacity, {
          toValue: 0,
          duration: 420,
          delay: 720,
          useNativeDriver: true,
        }),
        Animated.timing(tagOpacity, {
          toValue: 1,
          duration: 500,
          delay: 900,
          useNativeDriver: true,
        }),
      ]),
      Animated.delay(650),
      // 4 — exit into the app
      Animated.timing(exit, {
        toValue: 0,
        duration: 480,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (finished) {
        onFinished();
      }
    });
  }, [
    clipLift,
    clipOpacity,
    clipScale,
    exit,
    extend,
    glint,
    markOpacity,
    markScale,
    onFinished,
    tagOpacity,
  ]);

  const sideReach = (MARK_W - 36) / 2;
  const leftWidth = extend.interpolate({
    inputRange: [0, 1],
    outputRange: [0, sideReach],
  });
  const rightWidth = extend.interpolate({
    inputRange: [0, 1],
    outputRange: [0, sideReach],
  });
  const wireOpacity = extend.interpolate({
    inputRange: [0, 0.08, 0.75, 1],
    outputRange: [0, 1, 1, 0],
  });
  const leftReveal = extend.interpolate({
    inputRange: [0, 1],
    outputRange: [0, MARK_W / 2],
  });
  const rightReveal = extend.interpolate({
    inputRange: [0, 1],
    outputRange: [0, MARK_W / 2],
  });

  return (
    <Animated.View style={[styles.root, { opacity: exit }]}>
      <View style={styles.vignette} />

      <View style={styles.stage}>
        {/* Growing chrome wires from the clip ends */}
        <Animated.View
          pointerEvents="none"
          style={[styles.wireRow, { opacity: wireOpacity }]}>
          <Animated.View style={[styles.wire, styles.wireLeft, { width: leftWidth }]}>
            <View style={styles.wireCore} />
            <View style={styles.wireSheen} />
          </Animated.View>
          <View style={styles.wireGap} />
          <Animated.View style={[styles.wire, styles.wireRight, { width: rightWidth }]}>
            <View style={styles.wireCore} />
            <View style={styles.wireSheen} />
          </Animated.View>
        </Animated.View>

        {/* Wordmark reveals outward from the paperclip (the “l”) */}
        <Animated.View
          style={[
            styles.markWrap,
            {
              opacity: markOpacity,
              transform: [{ scale: markScale }],
            },
          ]}>
          <View style={styles.markRow}>
            {/* Left half grows from the clip: reveals “c” (+ left of the paperclip “l”). */}
            <Animated.View style={[styles.markHalf, { width: leftReveal }]}>
              <Image source={WORDMARK} style={styles.markImage} resizeMode="contain" />
            </Animated.View>
            {/* Right half grows from the clip: reveals “ipso”. */}
            <Animated.View style={[styles.markHalf, { width: rightReveal }]}>
              <Image
                source={WORDMARK}
                style={[styles.markImage, styles.markImageRight]}
                resizeMode="contain"
              />
            </Animated.View>
          </View>
        </Animated.View>

        {/* Solo paperclip — lands first, then dissolves into the wordmark “l” */}
        <Animated.View
          style={[
            styles.clipWrap,
            {
              opacity: clipOpacity,
              transform: [{ translateY: clipLift }, { scale: clipScale }],
            },
          ]}>
          <Image source={PAPERCLIP} style={styles.clip} resizeMode="contain" />
          <Animated.View
            style={[
              styles.glint,
              {
                opacity: glint,
                transform: [
                  {
                    scale: glint.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.6, 1.15],
                    }),
                  },
                ],
              },
            ]}
          />
        </Animated.View>
      </View>

      <Animated.Text style={[styles.tag, { opacity: tagOpacity }]}>
        just say clipso
      </Animated.Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
  },
  vignette: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#000',
    // soft radial feel via layered edges
    opacity: 1,
  },
  stage: {
    width: MARK_W,
    height: Math.max(MARK_H, CLIP_H) + 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  wireRow: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    height: 14,
  },
  wireGap: {
    width: 28,
  },
  wire: {
    height: 11,
    borderRadius: 6,
    overflow: 'hidden',
    backgroundColor: '#3a3a40',
    justifyContent: 'center',
  },
  wireLeft: {
    alignItems: 'flex-end',
  },
  wireRight: {
    alignItems: 'flex-start',
  },
  wireCore: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#c8c8d0',
    opacity: 0.95,
  },
  wireSheen: {
    position: 'absolute',
    top: 2,
    left: 4,
    right: 4,
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.75)',
  },
  markWrap: {
    position: 'absolute',
    width: MARK_W,
    height: MARK_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  markRow: {
    flexDirection: 'row',
    width: MARK_W,
    height: MARK_H,
  },
  markHalf: {
    height: MARK_H,
    overflow: 'hidden',
  },
  markImage: {
    width: MARK_W,
    height: MARK_H,
  },
  markImageRight: {
    // Shift so the growing right window starts at the wordmark midline.
    marginLeft: -MARK_W / 2,
  },
  clipWrap: {
    position: 'absolute',
    width: 72,
    height: CLIP_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clip: {
    width: 72,
    height: CLIP_H,
  },
  glint: {
    position: 'absolute',
    top: 18,
    right: 10,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: 'rgba(255,255,255,0.95)',
    shadowColor: '#fff',
    shadowOpacity: 1,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  tag: {
    position: 'absolute',
    bottom: 72,
    color: 'rgba(245,245,248,0.45)',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.6,
  },
});
