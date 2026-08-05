import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { createLogger } from '../core/Logger';
import { AppError, ErrorCode, userMessageFor } from '../core/errors';
import { colors, radius, spacing } from './theme';

const log = createLogger('ui');

interface Props {
  /** Named so a crash report says which screen died, not just "a screen". */
  screen: string;
  children: React.ReactNode;
  /** Extra recovery beyond re-rendering — re-arming capture, refetching. */
  onReset?: () => void;
}

interface State {
  error: AppError | null;
}

/**
 * Catches render-time crashes for one screen.
 *
 * Without this, a single bad render anywhere in the tree unmounts the whole
 * `NavigationContainer` and the wearer gets a blank screen with no way back —
 * and on a device build there is no red box to say what happened. Per-screen
 * rather than one at the root, so a crash in the Library or the player cannot
 * take down a live capture session mounted underneath it.
 *
 * Note the boundary that matters most is the one it CANNOT provide: React error
 * boundaries do not catch errors thrown in event handlers, timers, or promise
 * rejections, which is where nearly every hardware failure in this app
 * surfaces. Those are handled at their call sites through the logger; this is
 * the net under the render path only.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: AppError.from(error, ErrorCode.RenderCrash) };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    log.error(`render crashed in ${this.props.screen}`, error, ErrorCode.RenderCrash);
    // The component stack is the only part that says *where*, and it is not on
    // the error itself.
    log.debug('component stack', {
      screen: this.props.screen,
      stack: info.componentStack,
    });
  }

  private reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <View style={styles.root}>
        <Text style={styles.title}>{userMessageFor(error)}</Text>
        <Text style={styles.detail}>{this.props.screen}</Text>
        <Pressable
          onPress={this.reset}
          style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
          <Text style={styles.buttonLabel}>Try again</Text>
        </Pressable>
      </View>
    );
  }
}

/** Wraps a screen component for the navigator, keeping App.tsx declarative. */
export function withErrorBoundary<P extends object>(
  screen: string,
  Component: React.ComponentType<P>,
): React.ComponentType<P> {
  function Guarded(props: P) {
    return (
      <ErrorBoundary screen={screen}>
        <Component {...props} />
      </ErrorBoundary>
    );
  }
  Guarded.displayName = `withErrorBoundary(${screen})`;
  return Guarded;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.m,
    padding: spacing.l,
  },
  title: {
    color: colors.text,
    fontSize: 17,
    fontWeight: '700',
    textAlign: 'center',
  },
  detail: { color: colors.textDim, fontSize: 12 },
  button: {
    marginTop: spacing.s,
    height: 48,
    minWidth: 160,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.l,
  },
  pressed: { opacity: 0.85 },
  buttonLabel: { color: '#fff', fontSize: 16, fontWeight: '800' },
});
