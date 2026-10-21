// The boot path when storage fails: App must still pick a first screen, and
// onboarding's button must still move on.

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => {
      throw new Error('storage unavailable');
    }),
    setItem: jest.fn(async () => {
      throw new Error('disk full');
    }),
  },
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } = require('react-native');
  return {
    SafeAreaProvider: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
});
jest.mock('@react-navigation/native', () => {
  const { View } = require('react-native');
  return { DarkTheme: { colors: {} }, NavigationContainer: View };
});
jest.mock('@react-navigation/native-stack', () => {
  const { Text } = require('react-native');
  return {
    createNativeStackNavigator: () => ({
      // Renders only which screen the stack would open on.
      Navigator: ({ initialRouteName }: { initialRouteName: string }) => (
        <Text testID="initial-route">{initialRouteName}</Text>
      ),
      Screen: () => null,
    }),
  };
});
jest.mock('../src/ui/ClipsoSplash', () => {
  const { useEffect } = require('react');
  return {
    ClipsoSplash: ({ onFinished }: { onFinished: () => void }) => {
      useEffect(onFinished, [onFinished]);
      return null;
    },
  };
});
jest.mock('../src/core/ClipStore', () => ({
  clipStore: { sweepExpired: async () => {}, rescueExpiring: async () => {} },
}));
jest.mock('../src/core/EntitlementStore', () => ({
  entitlementStore: { subscribe: () => () => {} },
}));
jest.mock('../src/phase2/CaptionQueue', () => ({
  captionQueue: { resume: async () => {} },
}));
// Screens other than onboarding are never rendered by the fake navigator.
jest.mock('../src/ui/screens/ArmedScreen', () => ({ ArmedScreen: () => null }));
jest.mock('../src/ui/screens/ConnectScreen', () => ({ ConnectScreen: () => null }));
jest.mock('../src/ui/screens/LibraryScreen', () => ({ LibraryScreen: () => null }));
jest.mock('../src/ui/screens/PaywallScreen', () => ({ PaywallScreen: () => null }));
jest.mock('../src/ui/screens/PlayerScreen', () => ({ PlayerScreen: () => null }));
jest.mock('../src/ui/screens/PublishScreen', () => ({ PublishScreen: () => null }));
jest.mock('../src/ui/screens/SettingsScreen', () => ({ SettingsScreen: () => null }));

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import App from '../App';
import { OnboardingScreen } from '../src/ui/screens/OnboardingScreen';

// The first render loads React Native's lazily required components. On a cold
// transform cache, with suites running in parallel, that alone can outlast
// jest's default 5s, so these render tests get more time.
jest.setTimeout(30_000);

describe('boot when storage fails', () => {
  it('opens onboarding instead of a blank screen when the flag cannot be read', async () => {
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(<App />);
    });
    const route = renderer!.root.findByProps({ testID: 'initial-route' });
    expect(route.props.children).toBe('Onboarding');
    await act(async () => renderer!.unmount());
  });

  it("still leaves onboarding when the flag cannot be written", async () => {
    const navigation = { reset: jest.fn() };
    let renderer: ReactTestRenderer | undefined;
    await act(async () => {
      renderer = create(
        <OnboardingScreen navigation={navigation as any} route={{} as any} />,
      );
    });
    const button = renderer!.root.findByProps({ label: "Let's clip" });
    await act(async () => {
      await button.props.onPress();
    });
    expect(navigation.reset).toHaveBeenCalledWith({
      index: 0,
      routes: [{ name: 'Connect' }],
    });
    await act(async () => renderer!.unmount());
  });
});
