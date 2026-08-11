import AsyncStorage from '@react-native-async-storage/async-storage';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { clipStore } from './src/core/ClipStore';
import { entitlementStore } from './src/core/EntitlementStore';
import { createLogger } from './src/core/Logger';
import { ErrorCode } from './src/core/errors';
import { captionQueue } from './src/captioning/CaptionQueue';
import { installNativeDiagnosticSink } from './src/native/diagnosticSink';
import { glassesImport } from './src/services/glassesImport';
import { settingsStore } from './src/core/SettingsStore';
import { ClypsoSplash } from './src/ui/ClypsoSplash';
import { withErrorBoundary } from './src/ui/ErrorBoundary';
import type { RootStackParamList } from './src/ui/navigation';
import { ArmedScreen } from './src/ui/screens/ArmedScreen';
import { ConnectScreen } from './src/ui/screens/ConnectScreen';
import { LibraryScreen } from './src/ui/screens/LibraryScreen';
import { ONBOARDED_KEY, OnboardingScreen } from './src/ui/screens/OnboardingScreen';
import { PaywallScreen } from './src/ui/screens/PaywallScreen';
import { PlayerScreen } from './src/ui/screens/PlayerScreen';
import { PublishScreen } from './src/ui/screens/PublishScreen';
import { SettingsScreen } from './src/ui/screens/SettingsScreen';
import { colors } from './src/ui/theme';

const log = createLogger('app');

// Installed at module scope so a failure during the first render — before any
// screen mounts — still reaches the on-device diagnostics file.
installNativeDiagnosticSink();

const Stack = createNativeStackNavigator<RootStackParamList>();

// Wrapped once at module scope, not inline in the navigator: a component
// identity that changes every render would remount the screen — and remounting
// Armed tears down capture.
const Screens = {
  Connect: withErrorBoundary('Connect', ConnectScreen),
  Onboarding: withErrorBoundary('Onboarding', OnboardingScreen),
  Library: withErrorBoundary('Library', LibraryScreen),
  Armed: withErrorBoundary('Armed', ArmedScreen),
  Player: withErrorBoundary('Player', PlayerScreen),
  Settings: withErrorBoundary('Settings', SettingsScreen),
  Paywall: withErrorBoundary('Paywall', PaywallScreen),
  Publish: withErrorBoundary('Publish', PublishScreen),
};

const theme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.bg,
    card: colors.surface,
    text: colors.text,
    primary: colors.accent,
  },
};

export default function App() {
  const [initialRoute, setInitialRoute] =
    useState<keyof RootStackParamList | null>(null);
  const [splashDone, setSplashDone] = useState(false);
  const onSplashFinished = useCallback(() => setSplashDone(true), []);

  useEffect(() => {
    // Glasses-first boot: always land on Connect so the link to Meta AI is
    // established (or visibly broken) before anything else.
    AsyncStorage.getItem(ONBOARDED_KEY)
      .then(v => setInitialRoute(v ? 'Connect' : 'Onboarding'))
      .catch(err => {
        // Onboarding is recoverable; a null route is not. Leaving this
        // unhandled meant a failed read hung the app on a blank screen
        // forever, with no route ever set and nothing logged.
        log.error('could not read onboarding flag', err, ErrorCode.StorageIndexUnreadable);
        setInitialRoute('Onboarding');
      });
  }, []);

  useEffect(() => {
    // Retention runs at launch as well as on Library focus, so expired clips
    // are reclaimed even if the user never opens the library this session.
    clipStore
      .sweepExpired()
      .catch(err => log.error('expiry sweep failed', err, ErrorCode.StorageSweepFailed));
    // Captioning jobs cut short by the app being killed have no worker behind
    // them any more; without this they would show "Captioning…" forever.
    captionQueue
      .resume()
      .catch(err =>
        log.error('could not resume captioning', err, ErrorCode.CaptionResumeFailed),
      );
    // Always-on listening lives outside the capture session: the wearer records
    // on the glasses themselves, so there is nothing to arm and no screen to be
    // on. It has to come up at launch or the trigger word goes unheard.
    glassesImport
      .syncWithSettings()
      .catch(err =>
        log.error('could not start glasses import', err, ErrorCode.WakeWordPermissionDenied),
      );
    const unsubscribeSettings = settingsStore.subscribe(() => {
      glassesImport
        .syncWithSettings()
        .catch(err =>
          log.error('could not apply glasses import setting', err, ErrorCode.WakeWordPermissionDenied),
        );
    });
    // Upgrading rescues whatever was mid-countdown — Pro should never cost
    // someone a clip that was about to expire as they paid.
    const unsubscribeEntitlement = entitlementStore.subscribe(isPro => {
      if (isPro) {
        clipStore
          .rescueExpiring()
          .catch(err =>
            log.error('could not rescue expiring clips', err, ErrorCode.StorageWriteFailed),
          );
      }
    });
    return () => {
      unsubscribeSettings();
      unsubscribeEntitlement();
    };
  }, []);

  // Native launch storyboard → JS splash (paperclip → CLYPSO wordmark).
  // Unmount the splash only after it finishes so the animation never restarts
  // while AsyncStorage is still resolving the first route.
  if (!splashDone) {
    return (
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" />
        <ClypsoSplash onFinished={onSplashFinished} />
      </SafeAreaProvider>
    );
  }

  if (!initialRoute) {
    return (
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={theme}>
        <StatusBar barStyle="light-content" />
        <Stack.Navigator
          initialRouteName={initialRoute}
          screenOptions={{
            headerStyle: { backgroundColor: colors.bg },
            headerTintColor: colors.text,
            headerTitleStyle: { fontWeight: '700' },
            headerShadowVisible: false,
            headerBackButtonDisplayMode: 'minimal',
            contentStyle: { backgroundColor: colors.bg },
          }}>
          <Stack.Screen
            name="Connect"
            component={Screens.Connect}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Onboarding"
            component={Screens.Onboarding}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Library"
            component={Screens.Library}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Armed"
            component={Screens.Armed}
            options={{ headerShown: false, gestureEnabled: false }}
          />
          <Stack.Screen
            name="Player"
            component={Screens.Player}
            options={{ title: '' }}
          />
          <Stack.Screen
            name="Settings"
            component={Screens.Settings}
            options={{ title: 'Settings' }}
          />
          <Stack.Screen
            name="Paywall"
            component={Screens.Paywall}
            options={{ presentation: 'modal', headerShown: false }}
          />
          <Stack.Screen
            name="Publish"
            component={Screens.Publish}
            options={{ title: 'Publish' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
