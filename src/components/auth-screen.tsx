import { useState } from 'react';
import { Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Fonts, Spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth';
import { useTheme } from '@/hooks/use-theme';
import { reportError } from '@/lib/report-error';

type Mode = 'login' | 'signup';

// Matches the server-side check in api/auth/signup+api.ts - keep in sync.
const USERNAME_MAX_LENGTH = 20;

export default function AuthScreen() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);

  const { login, signup } = useAuth();
  const theme = useTheme();
  const insets = useSafeAreaInsets();

  const shakeX = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shakeX.value }],
  }));

  const shake = () => {
    shakeX.value = withSequence(
      withTiming(-10, { duration: 45 }),
      withTiming(10, { duration: 45 }),
      withTiming(-8, { duration: 45 }),
      withTiming(8, { duration: 45 }),
      withTiming(0, { duration: 45 }),
    );
  };

  const switchMode = (next: Mode) => {
    setMode(next);
    setEmail('');
    setUsername('');
    setPassword('');
  };

  const submit = async () => {
    const trimmedEmail = email.trim();
    const trimmedUsername = username.trim();

    if (!trimmedEmail || !password) {
      shake();
      return;
    }
    if (mode === 'signup' && !trimmedUsername) {
      shake();
      return;
    }

    setLoading(true);
    try {
      if (mode === 'login') {
        await login(trimmedEmail, password);
      } else {
        await signup(trimmedEmail, trimmedUsername, password);
      }
    } catch (error) {
      // callAuthApi already logs the specifics (network failure, bad JSON,
      // or the server's own rejection reason) - this just confirms the
      // shake below is actually reacting to that same failure.
      reportError(`[auth-screen] ${mode} failed`, error);
      shake();
    } finally {
      setLoading(false);
    }
  };

  return (
    <Pressable
      style={[
        styles.container,
        { backgroundColor: theme.background, paddingTop: insets.top + Spacing.four },
      ]}
      onPress={Keyboard.dismiss}
      accessible={false}
    >
      <Text style={[styles.title, { color: theme.text }]}>word-dex</Text>

      <Animated.View style={[styles.form, shakeStyle]}>
        <TextInput
          style={[styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }]}
          placeholderTextColor={theme.textSecondary}
          placeholder={mode === 'login' ? 'email or username' : 'email'}
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={mode === 'signup' ? 'email-address' : 'default'}
          returnKeyType="next"
          textContentType="none"
          autoComplete="off"
        />

        {mode === 'signup' && (
          <TextInput
            style={[styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }]}
            placeholderTextColor={theme.textSecondary}
            placeholder="username"
            value={username}
            onChangeText={setUsername}
            maxLength={USERNAME_MAX_LENGTH}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="next"
            textContentType="none"
            autoComplete="off"
          />
        )}

        <TextInput
          style={[styles.input, { backgroundColor: theme.backgroundElement, color: theme.text }]}
          placeholderTextColor={theme.textSecondary}
          placeholder="password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          returnKeyType="done"
          onSubmitEditing={submit}
          textContentType="none"
          autoComplete="off"
        />

        <Pressable
          style={[styles.submitButton, { backgroundColor: theme.backgroundElement }]}
          onPress={submit}
          disabled={loading}
        >
          <Text style={[styles.submitLabel, { color: theme.text }]}>
            {loading ? '...' : mode === 'login' ? 'log in' : 'sign up'}
          </Text>
        </Pressable>

        <Pressable
          style={styles.toggle}
          onPress={() => switchMode(mode === 'login' ? 'signup' : 'login')}
        >
          <Text style={[styles.toggleText, { color: theme.textSecondary }]}>
            {mode === 'login' ? 'sign up' : 'log in'}
          </Text>
        </Pressable>
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: Spacing.five,
    gap: Spacing.three,
  },
  title: {
    fontSize: 48,
    fontFamily: Fonts?.mono,
    fontWeight: '600',
  },
  form: {
    gap: Spacing.two,
  },
  input: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 16,
  },
  submitButton: {
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.two,
  },
  submitLabel: {
    fontSize: 16,
    fontWeight: '500',
  },
  toggle: {
    alignItems: 'center',
    paddingTop: Spacing.one,
  },
  toggleText: {
    fontSize: 14,
  },
});
