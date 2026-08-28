import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { runOnJS, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import BookPrompt, { type BookResult } from '@/components/book-prompt';
import { PressableScale } from '@/components/pressable-scale';
import { API_BASE_URL } from '@/constants/api';
import { Fonts, Spacing } from '@/constants/theme';
import { useAuth } from '@/context/auth';
import { useCollection } from '@/context/collection';
import { useTheme } from '@/hooks/use-theme';
import { fetchDefinition } from '@/lib/dictionary';
import { reportError } from '@/lib/report-error';
import type { Entry } from '@/types/dictionary';

const CHAR_LIMIT = 24;
// Shared so the AppState effect below can tell "still showing a stale
// connection error" apart from "not found"/"something went wrong" (which
// aren't connectivity-dependent, so foregrounding the app shouldn't clear
// those the same way).
const CONNECTION_ERROR_MESSAGE = 'please restore connection';
// Distinct from CONNECTION_ERROR_MESSAGE on purpose - a timeout (see
// lib/dictionary.ts's own DEFINITION_TIMEOUT_MS) means the connection
// itself was fine, the dictionary API just didn't respond in time. Telling
// a user with a working connection to go "restore" one was actively
// misleading.
const TIMEOUT_ERROR_MESSAGE = 'lookup timed out';

// Maps a thrown Error's message (from lookupWordAndExamples/fetchDefinition)
// to what actually shows on screen - shared by both lookup call sites below
// so the two never drift out of sync with each other.
function errorMessageFor(message: string, word: string): string {
  switch (message) {
    case 'not found':
      return `no definition found for "${word}"`;
    case 'network error':
      return CONNECTION_ERROR_MESSAGE;
    case 'timeout':
      return TIMEOUT_ERROR_MESSAGE;
    default:
      return 'something went wrong';
  }
}

// Up to the 3 most recent sentences written for this word by any user (see
// api/sentences+api.ts) - failures here are silent (empty list), since a
// definition lookup already succeeded by the time this runs and example
// sentences are a nice-to-have on top of it, not worth surfacing a second
// error state for.
async function fetchExampleSentences(
  word: string,
  token: string | null,
): Promise<string[]> {
  try {
    const res = await fetch(
      `${API_BASE_URL}/api/sentences?word=${encodeURIComponent(word)}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.sentences) ? data.sentences : [];
  } catch {
    return [];
  }
}

// A word only counts as "resolved" once both the definition and its example
// sentences are in hand - the dictionary lookup runs first (there's nothing
// to show examples for if the word itself doesn't exist), then the Neon
// fetch, and only then does the caller update its state, so the word,
// definition, and example usage all appear together in one go rather than
// the definition flashing in first with examples trailing in after.
async function lookupWordAndExamples(
  word: string,
  token: string | null,
): Promise<{ entry: Entry; sentences: string[] }> {
  const entry = await fetchDefinition(word);
  const sentences = await fetchExampleSentences(entry.word, token);
  return { entry, sentences };
}

export default function DiscoverScreen() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<Entry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentenceExamples, setSentenceExamples] = useState<string[]>([]);
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const collection = useCollection();
  const { token } = useAuth();
  const { word: wordParam } = useLocalSearchParams<{ word?: string }>();
  const router = useRouter();
  const inputRef = useRef<TextInput>(null);
  const consumedWordParam = useRef<string | undefined>(undefined);
  // Bumped by every lookup, from either trigger below (typed search or a
  // word-param deep link) - whichever one is still in flight when a newer
  // one starts checks this before applying its own result/error, so an old,
  // slow lookup (eg. a network fallback) can never clobber a newer one that
  // happened to finish first. Without this, searching a second word while
  // the first was still resolving didn't actually get cancelled - both
  // requests ran, and whichever settled *last* silently overwrote whatever
  // was already on screen, sometimes putting the first word's result back
  // up after you'd already moved on to a second search.
  const requestIdRef = useRef(0);

  const performLookup = async (word: string) => {
    const requestId = ++requestIdRef.current;
    setResult(null);
    setSentenceExamples([]);
    setError(null);
    setLoading(true);
    try {
      const { entry, sentences } = await lookupWordAndExamples(word, token);
      if (requestId !== requestIdRef.current) return;
      setResult(entry);
      setSentenceExamples(sentences);
    } catch (e: unknown) {
      if (requestId !== requestIdRef.current) return;
      const message = e instanceof Error ? e.message : 'fetch failed';
      if (
        message !== 'not found' &&
        message !== 'network error' &&
        message !== 'timeout'
      ) {
        reportError('[discover] word lookup failed', e);
      }
      setError(errorMessageFor(message, word));
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  };

  // A connection error otherwise sits there forever once shown - nothing
  // else clears it, so it'd still say "please restore connection" even
  // after the connection's actually back, until the user manually searches
  // again. Foregrounding the app is the natural moment to assume that might
  // have changed and drop back to the idle "look up a word!" state; "not
  // found"/"something went wrong" aren't connectivity issues, so those are
  // deliberately left alone here.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        setError((prev) => (prev === CONNECTION_ERROR_MESSAGE ? null : prev));
      }
    });
    return () => subscription.remove();
  }, []);

  // Clears whatever's on screen (typed search, a result, an open book
  // prompt) whenever the app's been backgrounded long enough to count as
  // freshly reopened - see resetGeneration's own comment in
  // context/collection.tsx. Skipped on the very first render
  // (resetGeneration starts at 0, nothing to clear yet).
  const isFirstResetRef = useRef(true);
  useEffect(() => {
    if (isFirstResetRef.current) {
      isFirstResetRef.current = false;
      return;
    }
    // Invalidates whatever lookup might still be in flight - without this,
    // a slow lookup from before the reset could still resolve afterward and
    // repopulate the screen it just cleared, since performLookup's own
    // requestId check would otherwise see no reason to ignore it.
    requestIdRef.current++;
    setInput('');
    setResult(null);
    setSentenceExamples([]);
    setError(null);
    setLoading(false);
    setPendingEntry(null);
  }, [collection.resetGeneration]);

  useEffect(() => {
    if (!wordParam || wordParam === consumedWordParam.current) return;
    consumedWordParam.current = wordParam;
    router.setParams({ word: undefined });
    performLookup(wordParam);
  }, [wordParam, token]);

  // No loading guard - typing a second word and hitting enter while the
  // first is still resolving now starts a real new lookup immediately
  // (performLookup's own requestId is what makes the stale first one a
  // no-op when it eventually settles), instead of the submit silently doing
  // nothing until the first one finished.
  const submit = () => {
    const word = input.trim();
    if (!word) return;
    setInput('');
    performLookup(word);
  };

  const saved = result ? collection.has(result.word) : false;

  // Holds the word awaiting a book choice - collection.add() doesn't run
  // until the prompt resolves (book picked, or skipped/dismissed), so the
  // word genuinely isn't in the collection while the prompt is open.
  const [pendingEntry, setPendingEntry] = useState<Entry | null>(null);
  const showBookPrompt = pendingEntry !== null;

  // Re-enabling KeyboardAvoidingView the instant the prompt closes fires
  // before the keyboard (opened by the prompt's own search input) has
  // actually finished its close animation - it briefly reacts to a keyboard
  // that's still partway shut, causing a one-frame layout jump. Waiting for
  // the real keyboardDidHide event avoids that; the timeout is just a
  // fallback in case the keyboard was already closed (no event to wait for).
  const [avoidingEnabled, setAvoidingEnabled] = useState(true);
  useEffect(() => {
    if (showBookPrompt) {
      setAvoidingEnabled(false);
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setAvoidingEnabled(true);
    };
    const subscription = Keyboard.addListener('keyboardDidHide', finish);
    const timeout = setTimeout(finish, 400);
    return () => {
      subscription.remove();
      clearTimeout(timeout);
    };
  }, [showBookPrompt]);

  const toggleSave = () => {
    if (!result || showBookPrompt) return;
    if (saved) {
      collection.remove(result.word);
    } else {
      setPendingEntry(result);
    }
  };

  // Shared values so the gesture worklet can read JS state safely
  const hasResult = useSharedValue(false);
  const alreadySaved = useSharedValue(false);

  useEffect(() => {
    hasResult.value = result !== null;
  }, [result]);
  useEffect(() => {
    alreadySaved.value = saved;
  }, [saved]);

  const addFromSwipe = () => {
    if (!result || saved || showBookPrompt) return;
    setPendingEntry(result);
  };

  const pan = Gesture.Pan()
    .activeOffsetX(40)
    .failOffsetY([-15, 15])
    .onEnd((e) => {
      if (e.translationX > 80 && hasResult.value && !alreadySaved.value) {
        runOnJS(addFromSwipe)();
      }
    });

  const handleSelectBook = (book: BookResult) => {
    if (!pendingEntry) return;
    // BookPrompt's own search input may still hold native keyboard focus at
    // this point (the user can search for a book title before tapping a
    // result) - unmounting it below via setPendingEntry(null) without first
    // blurring left the OS auto-transferring focus to this screen's own
    // search input instead, reopening the keyboard right after the add.
    Keyboard.dismiss();
    collection.add(pendingEntry, book);
    setPendingEntry(null);
  };

  // Skip / tap outside the prompt - the word still gets added, just with no
  // book attached, matching "resolve the prompt" either way rather than
  // silently dropping the add.
  const handleDismissBookPrompt = () => {
    if (!pendingEntry) return;
    Keyboard.dismiss();
    collection.add(pendingEntry, null);
    setPendingEntry(null);
  };

  return (
    <GestureDetector gesture={pan}>
      <View style={[styles.container, { backgroundColor: theme.background }]}>
        <KeyboardAvoidingView
          style={styles.container}
          // KeyboardAvoidingView reacts to any keyboard becoming visible
          // globally, not just focus events from its own children - so it
          // still shifts this content when the book prompt's own search
          // input focuses, even though that input now lives outside this
          // tree entirely. Disabled while the prompt is open (its backdrop
          // fully covers this content anyway) and for a moment after it
          // closes, until the keyboard actually finishes hiding - see
          // avoidingEnabled above.
          behavior={avoidingEnabled ? (Platform.OS === 'ios' ? 'padding' : 'height') : undefined}
        >
          <View style={styles.scrollWrapper}>
            <ScrollView
              contentContainerStyle={[
                styles.resultArea,
                // Centered only for the true empty/idle state ("look up a
                // word!", nothing typed or searched yet) - loading and
                // result/error all share the same top alignment, so this
                // flips the instant a search *starts* (loading becomes
                // true), not whenever the result data itself happens to
                // arrive. That used to be the same moment the small spinner
                // popped in became a full-height definition block, so the
                // container's own alignment jumped from centered to
                // top-anchored at an unpredictable time (however long the
                // lookup took) - now it settles into its final position
                // right away, against the near-empty spinner, and nothing
                // shifts again once the real content fills in.
                (loading || !!error || !!result) && styles.resultAreaActive,
              ]}
              keyboardShouldPersistTaps="handled"
              bounces={false}
              overScrollMode="never"
            >
              {loading && <ActivityIndicator color={theme.textSecondary} />}
              {error && <Text style={[styles.error, { color: theme.textSecondary }]}>{error}</Text>}
              {!loading && !error && !result && (
                <Text style={[styles.idleText, { color: theme.textSecondary }]}>
                  look up a word!
                </Text>
              )}
              {result && (
                <View style={styles.definitionBlock}>
                  <View style={styles.wordRow}>
                    <Text
                      style={[styles.word, { color: theme.text }]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.4}
                    >
                      {result.word}
                    </Text>
                    {/* Grouped so phonetic + the save icon wrap to the next
                        line together, for a long word - otherwise just the
                        icon alone could end up orphaned on its own line
                        while the phonetic stays stuck up next to the word. */}
                    <View style={styles.wordMeta}>
                      {result.phonetic && (
                        <Text style={[styles.phonetic, { color: theme.textSecondary }]}>
                          {result.phonetic}
                        </Text>
                      )}
                      <PressableScale
                        style={[
                          styles.saveIcon,
                          {
                            backgroundColor: saved
                              ? theme.backgroundSelected
                              : theme.backgroundElement,
                          },
                        ]}
                        onPress={toggleSave}
                      >
                        <Text style={[styles.saveIconLabel, { color: theme.text }]}>
                          {saved ? '✓' : '+'}
                        </Text>
                      </PressableScale>
                    </View>
                  </View>
                  {result.meanings.map((meaning, i) => (
                    <View key={`${meaning.partOfSpeech}-${i}`} style={styles.meaningBlock}>
                      <Text style={[styles.partOfSpeech, { color: theme.textSecondary }]}>
                        {meaning.partOfSpeech}
                      </Text>
                      {meaning.definitions.map((def, i) => (
                        <Text key={i} style={[styles.definition, { color: theme.text }]}>
                          {meaning.definitions.length > 1 ? `${i + 1}.  ` : ''}
                          {def.definition}
                        </Text>
                      ))}
                    </View>
                  ))}
                  {sentenceExamples.length > 0 && (
                    <View style={[styles.exampleBlock, { borderTopColor: theme.separator }]}>
                      <Text style={[styles.exampleHeader, { color: theme.text }]}>
                        example usage
                      </Text>
                      {sentenceExamples.map((sentence, i) => (
                        <View key={i} style={styles.bulletRow}>
                          <Text style={[styles.exampleText, { color: theme.text }]}>{'•'}</Text>
                          <Text style={[styles.exampleText, { color: theme.text, flex: 1 }]}>
                            {sentence}
                          </Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              )}
            </ScrollView>
            <View
              pointerEvents="none"
              style={[styles.topMask, { height: insets.top, backgroundColor: theme.background }]}
            />
          </View>

          <View
            style={[
              styles.inputRow,
              {
                backgroundColor: theme.backgroundElement,
                borderTopColor: theme.separator,
                paddingBottom: insets.bottom / 2.3,
                paddingTop: Spacing.two + Spacing.one,
              },
            ]}
          >
            <TextInput
              ref={inputRef}
              style={[
                styles.input,
                { backgroundColor: theme.backgroundSelected, color: theme.text },
              ]}
              placeholderTextColor={theme.textSecondary}
              value={input}
              onChangeText={setInput}
              onSubmitEditing={submit}
              maxLength={CHAR_LIMIT}
              returnKeyType="done"
              autoCapitalize="none"
              autoCorrect={false}
            />
          </View>
        </KeyboardAvoidingView>

        {showBookPrompt && (
          <BookPrompt onDismiss={handleDismissBookPrompt} onSelectBook={handleSelectBook} />
        )}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollWrapper: {
    flex: 1,
  },
  topMask: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  resultArea: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.four,
  },
  // Overrides resultArea's own centered justifyContent - see where this is
  // applied for why it's keyed off loading starting, not the result arriving.
  resultAreaActive: {
    justifyContent: 'flex-start',
  },
  definitionBlock: {
    width: '100%',
    gap: Spacing.two,
    paddingTop: Spacing.six,
  },
  wordRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
    flexWrap: 'wrap',
  },
  wordMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  exampleBlock: {
    gap: Spacing.two,
    marginTop: Spacing.four,
    paddingTop: Spacing.three,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  bulletRow: {
    flexDirection: 'row',
    gap: Spacing.two,
  },
  word: {
    fontSize: 36,
    fontWeight: '600',
    fontFamily: Fonts?.mono,
    flexShrink: 1,
  },
  phonetic: {
    fontSize: 16,
    fontFamily: Fonts?.mono,
  },
  meaningBlock: {
    gap: Spacing.two,
    marginTop: Spacing.three,
  },
  partOfSpeech: {
    fontSize: 14,
    fontStyle: 'italic',
    fontFamily: Fonts?.mono,
  },
  exampleHeader: {
    fontSize: 14,
    fontWeight: '700',
    fontFamily: Fonts?.mono,
    textTransform: 'lowercase',
    letterSpacing: 1,
  },
  definition: {
    fontSize: 18,
    lineHeight: 26,
    marginTop: Spacing.one,
  },
  exampleText: {
    fontSize: 16,
    lineHeight: 22,
    marginTop: Spacing.one,
    fontFamily: Fonts?.mono,
  },
  error: {
    fontSize: 16,
    fontFamily: Fonts?.mono,
  },
  idleText: {
    fontSize: 16,
    fontFamily: Fonts?.mono,
  },
  saveIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: Spacing.one,
  },
  saveIconLabel: {
    fontSize: 18,
    lineHeight: 22,
    fontWeight: '400',
  },
  inputRow: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.three,
    paddingTop: 0,
    paddingBottom: 0,
    gap: Spacing.two,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 16,
  },
});
