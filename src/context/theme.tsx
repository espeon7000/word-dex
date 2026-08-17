import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SystemUI from 'expo-system-ui';

import { Colors, DEFAULT_HUE, DEFAULT_SATURATION, generatePalette } from '@/constants/theme';
import { animateHueSaturation } from '@/lib/hue-tween';
import { classifyMood } from '@/lib/mood';

const STORAGE_KEY = 'theme-color';
// Separate key, not folded into STORAGE_KEY's own JSON - this is a toggle
// about whether mood shifting is allowed to touch hue/saturation, not part
// of the hue/saturation value itself. Missing (nothing stored yet) reads as
// false/unchecked, which is exactly the "not checked" default a first
// account/first device login should get, with zero special-casing needed.
const MOOD_IMMUTABLE_STORAGE_KEY = 'theme-mood-immutable';

// How long a mood shift's own hue/saturation slide takes.
const MOOD_SHIFT_DURATION_MS = 1900;
// How long to wait after a shift finishes before another one is allowed -
// starts counting from when the animation actually completes, not from
// when it was triggered, so the full gap between two shifts is always at
// least MOOD_SHIFT_DURATION_MS + MOOD_COOLDOWN_MS. A classification that
// comes back with no match doesn't start this cooldown at all (see
// shiftMoodFromText below) - only a real shift does.
const MOOD_COOLDOWN_MS = 10_000;

type ThemeContextValue = {
  palette: typeof Colors;
  hue: number;
  saturation: number;
  setColor: (hue: number, saturation: number) => void;
  // Fire-and-forget, like collection.tsx's own mutators - checks the
  // cooldown, asks Claude whether this text matches one of the 13 wheel
  // moods (see lib/mood.ts), and if so animates the theme over to it.
  // Silently no-ops if nothing matched, the request failed, a shift is
  // already in progress/on cooldown, or moodImmutable is set.
  shiftMoodFromText: (text: string) => void;
  // The color wheel's own "set immutable?" checkbox - when true, mood
  // shifts don't even ask Claude, let alone animate anything. Manually
  // picking a color via the wheel itself (setColor above) still always
  // works regardless of this.
  moodImmutable: boolean;
  setMoodImmutable: (next: boolean) => void;
};

const ThemeContext = createContext<ThemeContextValue>({
  palette: Colors,
  hue: DEFAULT_HUE,
  saturation: DEFAULT_SATURATION,
  setColor: () => {},
  shiftMoodFromText: () => {},
  moodImmutable: false,
  setMoodImmutable: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [hue, setHue] = useState(DEFAULT_HUE);
  const [saturation, setSaturation] = useState(DEFAULT_SATURATION);
  const [moodImmutable, setMoodImmutableState] = useState(false);

  // Loads whatever the user last picked, if anything - silently falls back
  // to the default amber theme on first launch or a corrupt/missing value.
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (typeof parsed.hue === 'number' && typeof parsed.saturation === 'number') {
          setHue(parsed.hue);
          setSaturation(parsed.saturation);
        }
      })
      .catch((error) => console.error('[theme] failed to load', error));
    AsyncStorage.getItem(MOOD_IMMUTABLE_STORAGE_KEY)
      .then((raw) => {
        if (raw === 'true') setMoodImmutableState(true);
      })
      .catch((error) =>
        console.error('[theme] failed to load moodImmutable', error),
      );
  }, []);

  const setMoodImmutable = useCallback((next: boolean) => {
    setMoodImmutableState(next);
    AsyncStorage.setItem(MOOD_IMMUTABLE_STORAGE_KEY, String(next)).catch(
      (error) => console.error('[theme] failed to save moodImmutable', error),
    );
  }, []);

  const setColor = useCallback((nextHue: number, nextSaturation: number) => {
    setHue(nextHue);
    setSaturation(nextSaturation);
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ hue: nextHue, saturation: nextSaturation }),
    ).catch((error) => console.error('[theme] failed to save', error));
  }, []);

  // Live-read by shiftMoodFromText below, which is itself a stable
  // ([]-deps) callback - it needs the *current* hue/saturation as the
  // animation's starting point regardless of how long it's been since this
  // provider last rendered, which a value captured in a plain closure
  // wouldn't reliably give it.
  const hueRef = useRef(hue);
  const saturationRef = useRef(saturation);
  useEffect(() => {
    hueRef.current = hue;
    saturationRef.current = saturation;
  }, [hue, saturation]);
  // Same reasoning, same pattern - shiftMoodFromText needs the live value.
  const moodImmutableRef = useRef(moodImmutable);
  useEffect(() => {
    moodImmutableRef.current = moodImmutable;
  }, [moodImmutable]);

  // Guards against two shifts running at once (eg. a book add and a review
  // submit landing close together) - the second call just no-ops rather
  // than starting a competing animation or classification request.
  const moodShiftBusyRef = useRef(false);
  // Timestamp (Date.now()-scale) before which a new shift won't even ask
  // Claude - see MOOD_COOLDOWN_MS's own comment for why this is set only
  // once a shift actually completes, not when one is merely requested.
  const moodCooldownUntilRef = useRef(0);

  const shiftMoodFromText = useCallback((text: string) => {
    if (moodImmutableRef.current) return;
    if (moodShiftBusyRef.current) return;
    if (Date.now() < moodCooldownUntilRef.current) return;
    moodShiftBusyRef.current = true;
    (async () => {
      try {
        const mood = await classifyMood(text);
        if (!mood) return;
        await animateHueSaturation(
          { hue: hueRef.current, saturation: saturationRef.current },
          { hue: mood.hue, saturation: mood.saturation },
          MOOD_SHIFT_DURATION_MS,
          (h, s) => {
            setHue(h);
            setSaturation(s);
          },
        );
        AsyncStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ hue: mood.hue, saturation: mood.saturation }),
        ).catch((error) => console.error('[theme] failed to save', error));
        moodCooldownUntilRef.current = Date.now() + MOOD_COOLDOWN_MS;
      } catch (error) {
        console.error('[theme] mood shift failed', error);
      } finally {
        moodShiftBusyRef.current = false;
      }
    })();
  }, []);

  const palette = useMemo(() => generatePalette(hue, saturation), [hue, saturation]);

  // Sets the *native* root view's background, not just a React style - a
  // color set purely inside the React tree (eg. on GestureHandlerRootView)
  // only exists once React has actually mounted/painted something there,
  // and this provider's own state can otherwise sit mid-animation (see
  // shiftMoodFromText above) with the native layer never told about any of
  // the intermediate frames.
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(palette.background).catch((error) =>
      console.error('[theme] failed to set native background', error),
    );
  }, [palette.background]);

  const value = useMemo(
    () => ({
      palette,
      hue,
      saturation,
      setColor,
      shiftMoodFromText,
      moodImmutable,
      setMoodImmutable,
    }),
    [
      palette,
      hue,
      saturation,
      setColor,
      shiftMoodFromText,
      moodImmutable,
      setMoodImmutable,
    ],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useThemeContext() {
  return useContext(ThemeContext);
}
