import AsyncStorage from '@react-native-async-storage/async-storage';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import React, { useCallback, useEffect, useState } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { clipStore } from './src/core/ClipStore';
import { entitlementStore } from './src/core/EntitlementStore';
import { ClipsoSplash } from './src/ui/ClipsoSplash';
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

const Stack = createNativeStackNavigator<RootStackParamList>();

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
    AsyncStorage.getItem(ONBOARDED_KEY).then(v =>
      setInitialRoute(v ? 'Connect' : 'Onboarding'),
    );
  }, []);

  useEffect(() => {
    // Retention runs at launch as well as on Library focus, so expired clips
    // are reclaimed even if the user never opens the library this session.
    clipStore.sweepExpired().catch(() => {});
    // Upgrading rescues whatever was mid-countdown — Pro should never cost
    // someone a clip that was about to expire as they paid.
    return entitlementStore.subscribe(isPro => {
      if (isPro) {
        clipStore.rescueExpiring().catch(() => {});
      }
    });
  }, []);

  // Native launch storyboard → JS splash (paperclip → CLIPSO wordmark).
  // Unmount the splash only after it finishes so the animation never restarts
  // while AsyncStorage is still resolving the first route.
  if (!splashDone) {
    return (
      <SafeAreaProvider>
        <StatusBar barStyle="light-content" />
        <ClipsoSplash onFinished={onSplashFinished} />
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
            component={ConnectScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Onboarding"
            component={OnboardingScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Library"
            component={LibraryScreen}
            options={{ headerShown: false }}
          />
          <Stack.Screen
            name="Armed"
            component={ArmedScreen}
            options={{ headerShown: false, gestureEnabled: false }}
          />
          <Stack.Screen
            name="Player"
            component={PlayerScreen}
            options={{ title: '' }}
          />
          <Stack.Screen
            name="Settings"
            component={SettingsScreen}
            options={{ title: 'Settings' }}
          />
          <Stack.Screen
            name="Paywall"
            component={PaywallScreen}
            options={{ presentation: 'modal', headerShown: false }}
          />
          <Stack.Screen
            name="Publish"
            component={PublishScreen}
            options={{ title: 'Publish' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
