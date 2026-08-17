import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from "react-native-reanimated";

import { DEFINITION_QUIZ_WORDS } from "@/constants/definition-quiz-words";
import { Fonts, Spacing } from "@/constants/theme";
import {
  MASTERED_MASTERY_THRESHOLD,
  todayISO,
  useCollection,
  type CollectionEntry,
} from "@/context/collection";
import { useThemeContext } from "@/context/theme";
import { useTheme } from "@/hooks/use-theme";

// Picks randomly among the lowest-mastery words instead of always the single
// lowest, so the same word doesn't come up first every time the list is stale.
function pickNext<T>(masterySorted: T[]): T {
  const pool = masterySorted.slice(0, 5);
  return pool[Math.floor(Math.random() * pool.length)];
}

// Picks the next word to show: prefers words that haven't been skipped or
// gotten wrong this session, and only dips into that deprioritized pile once
// every other word has actually been answered correctly. `exclude` keeps a
// swipe from re-picking the word you just skipped, unless it's the only
// option left.
function pickFromPool(
  entriesByMastery: CollectionEntry[],
  attempted: string[],
  deprioritized: string[],
  exclude?: string,
): CollectionEntry | null {
  const remaining = entriesByMastery.filter((e) => !attempted.includes(e.word));
  if (remaining.length === 0) return null;
  const fresh = remaining.filter((e) => !deprioritized.includes(e.word));
  const pool = fresh.length > 0 ? fresh : remaining;
  const withoutExcluded = exclude
    ? pool.filter((e) => e.word !== exclude)
    : pool;
  return pickNext(withoutExcluded.length > 0 ? withoutExcluded : pool);
}

type PromptMode = "sentence" | "definition";

// Which quiz mode a freshly-picked word uses: a completely new word
// (mastery 0) always starts as multiple choice - asking someone to produce
// a sentence for a word they've never even seen defined is backwards, so
// show them the definition first instead. Once it's actually being
// "learned" (attempted at least once, not yet mastered), it's an even
// toss-up between reinforcing the definition again or testing production
// via a sentence. Past MASTERED_MASTERY_THRESHOLD, only the harder
// sentence-writing mode - multiple choice stops being much of a test by
// then.
function choosePromptMode(entry: CollectionEntry): PromptMode {
  if (!entry.definition) return "sentence"; // nothing to build a quiz against
  if (entry.mastery === 0) return "definition";
  if (entry.mastery >= MASTERED_MASTERY_THRESHOLD) return "sentence";
  return Math.random() < 0.5 ? "definition" : "sentence";
}

function shuffled<T>(items: T[]): T[] {
  return [...items].sort(() => Math.random() - 0.5);
}

// DEFINITION_QUIZ_WORDS' entries are written lowercase-first (matching each
// other), unlike a real dictionary-API definition which starts a sentence
// properly - capitalized here rather than in the source list itself, since
// this only ever needs to happen for entries actually used as distractors,
// and never for entry.definition (the correct answer), whose own casing is
// left exactly as the dictionary API returned it.
function capitalizeFirst(text: string): string {
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const DEFINITION_OPTION_COUNT = 4;

// The word's own real definition plus 3 distractors drawn from
// DEFINITION_QUIZ_WORDS, all shuffled together. Excludes any distractor
// entry that happens to share this exact word (case-insensitively) - if
// this word is itself one of the 100 hardcoded ones, its own definition
// there would either duplicate the correct answer outright or just be a
// second, confusingly-worded restatement of it; picking from the remaining
// 99 avoids that entirely.
function buildQuizOptions(entry: CollectionEntry): string[] {
  const pool = DEFINITION_QUIZ_WORDS.filter(
    (w) => w.word.toLowerCase() !== entry.word.toLowerCase(),
  );
  const distractors = shuffled(pool)
    .slice(0, DEFINITION_OPTION_COUNT - 1)
    .map((w) => capitalizeFirst(w.definition));
  return shuffled([...distractors, entry.definition]);
}

// How long to hold on the reveal animation (correct-color pop, or the wrong
// shake) before actually moving the screen on to success/failure - long
// enough to register as feedback, not just a flicker.
const DEFINITION_CORRECT_REVEAL_MS = 500;
const DEFINITION_INCORRECT_REVEAL_MS = 900;
// Long enough for the 225ms shake (5 steps of 45ms, see shakeWord) to
// finish playing before advancePastWord actually moves the screen on.
const SENTENCE_INCORRECT_SHAKE_MS = 320;
// Same order of magnitude as a long-ish sentence actually needs - just a
// backstop against someone pasting in a wall of text, not a tight limit.
const SENTENCE_MAX_LENGTH = 500;

// Absolute timestamp (ms since epoch) of the next UTC midnight after now -
// matches todayISO()'s own day boundary exactly (UTC, not local), otherwise
// this countdown could hit 00:00:00 while todayISO() still insists it's the
// same day, which would make the "come back tomorrow" promise a lie for
// anyone not in UTC.
function nextUTCDayBoundary(): number {
  const now = new Date();
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor((totalSeconds % 3600) / 60))}:${pad(totalSeconds % 60)}`;
}

async function verifyWithClaude(
  word: string,
  sentence: string,
): Promise<{ correct: boolean; reason: string }> {
  const apiKey = process.env.EXPO_PUBLIC_ANTHROPIC_API_KEY;
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 256,
        messages: [
          {
            role: "user",
            content: `Does this phrase/sentence(s) use the word "${word}" correctly in context? If the word is not included, it is incorrect. Doesn't have to be a complete sentence or have perfect grammar, as long as the word's meaning is conveyed accurately. Reply ONLY with a JSON object with two fields: "correct" (boolean) and "reason" (a very short explanation why, 8 words max).\n\nSentence: ${sentence}`,
          },
        ],
      }),
    });
  } catch {
    // fetch() itself throwing (rather than resolving with some status) means
    // the request never reached the network at all - almost always no
    // connection, not the same "the API rejected this" case api error covers.
    throw new Error("network error");
  }

  if (!res.ok) throw new Error("api error");
  const data = await res.json();
  const raw: string = data.content?.[0]?.text ?? "{}";
  const text = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    return JSON.parse(text);
  } catch {
    return { correct: false, reason: "could not parse response" };
  }
}

type ScreenState =
  | "loading"
  | "empty"
  | "done"
  | "active"
  | "verifying"
  | "success"
  | "error";

// idle: nothing picked yet, plain themed background.
// correct: the tapped option, and it was the right answer - darkens
// (correctColor, a step further down the same hue-family palette everything
// else in the app already uses) rather than turning some universal green.
// incorrect: the tapped option, and it was wrong - the actual correct
// answer is deliberately NOT revealed here (no other option ever gets
// "correct"). No color change at all; the shake is the only "wrong" signal.
// dim: every other option, faded out of focus - only used when the tapped
// one was correct, to draw focus to it. A wrong pick leaves the rest at
// "idle" instead - the shake on the tapped option is the only signal there,
// nothing about the others should change.
type OptionState = "idle" | "correct" | "incorrect" | "dim";

function DefinitionOptionButton({
  text,
  state,
  onPress,
  disabled,
  textColor,
  idleColor,
  correctColor,
}: {
  text: string;
  state: OptionState;
  onPress: () => void;
  disabled: boolean;
  textColor: string;
  idleColor: string;
  correctColor: string;
}) {
  const translateX = useSharedValue(0);
  const scale = useSharedValue(1);

  useEffect(() => {
    if (state === "correct") {
      scale.value = withSequence(
        withTiming(1.04, { duration: 120, easing: Easing.out(Easing.quad) }),
        withTiming(1, { duration: 120 }),
      );
    } else if (state === "incorrect") {
      // Wider amplitude than the password/sentence shake elsewhere - this
      // is the only "wrong" signal now (no red background anymore), so it
      // needs to read as unmistakable on its own rather than a subtle
      // wobble.
      translateX.value = withSequence(
        withTiming(-11, { duration: 45 }),
        withTiming(11, { duration: 45 }),
        withTiming(-9, { duration: 45 }),
        withTiming(9, { duration: 45 }),
        withTiming(0, { duration: 45 }),
      );
    }
  }, [state]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }, { scale: scale.value }],
  }));

  const backgroundColor = state === "correct" ? correctColor : idleColor;

  return (
    <Pressable onPress={onPress} disabled={disabled}>
      <Animated.View
        style={[
          styles.quizOption,
          { backgroundColor },
          state === "dim" && styles.quizOptionDim,
          animatedStyle,
        ]}
      >
        <Text style={[styles.quizOptionText, { color: textColor }]}>
          {text}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

export default function LearnScreen() {
  const theme = useTheme();
  const { shiftMoodFromText } = useThemeContext();
  const insets = useSafeAreaInsets();
  const {
    entries,
    entriesByMastery,
    loaded,
    recordSentence,
    recordActivity,
    attemptedToday,
    recordAttempt,
    clearAttemptedToday,
    getTodaysActivity,
    resetGeneration,
  } = useCollection();

  const [screen, setScreen] = useState<ScreenState>("loading");
  const [currentWord, setCurrentWord] = useState<string | null>(null);
  const [sentence, setSentence] = useState("");
  const [promptMode, setPromptMode] = useState<PromptMode>("sentence");
  const [quizOptions, setQuizOptions] = useState<string[]>([]);
  // Which option (if any) the user's already tapped for the current
  // definition quiz - null means "still answerable"; non-null both locks
  // out further taps and drives the reveal (see the render below).
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  // A ref, not derived from selectedOption above - two taps landing on
  // different options within the same JS tick (before React has re-rendered
  // with disabled=true) would both still see selectedOption as null from
  // the same stale closure and both pass that check. A ref is read/written
  // synchronously with no batching, so it actually closes the race.
  const answeringRef = useRef(false);
  const inputRef = useRef<TextInput>(null);
  // The timeout that carries a wrong answer (a definition-quiz pick, or a
  // sentence's shake) from its own feedback animation into the real
  // advancePastWord call - held here so a new word picked mid-animation
  // (eg. a swipe-down skip) can cancel it instead of letting it fire later
  // against whatever word/mode is on screen by then. See applyPickedEntry
  // below.
  const revealTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (revealTimeoutRef.current) clearTimeout(revealTimeoutRef.current);
    };
  }, []);
  // Skipped-away and wrong-answer words for today, purely local to this
  // screen - unlike attemptedToday (a correct answer), neither creates a
  // learn_events row anymore, so there's nothing to sync and nothing else in
  // the app needs to know about it. Both get the same treatment: deprioritize
  // to the back of today's queue rather than block the word outright, so it
  // still comes back up once everything else today has been tried.
  const [deprioritizedToday, setDeprioritizedToday] = useState<string[]>([]);

  // Clears whatever's mid-attempt (a half-typed sentence, a locked-in quiz
  // answer) whenever the app's been backgrounded long enough to count as
  // freshly reopened - see resetGeneration's own comment in
  // context/collection.tsx. Only resets screen/currentWord/deprioritizedToday
  // directly; setting screen back to "loading" lets the "recompute screen
  // state" effect below pick a genuinely fresh word itself, which already
  // resets sentence/promptMode/quizOptions/selectedOption per-word via
  // applyPickedEntry - no need to duplicate that here. Skipped on the very
  // first render (resetGeneration starts at 0, nothing to clear yet).
  const isFirstResetRef = useRef(true);
  useEffect(() => {
    if (isFirstResetRef.current) {
      isFirstResetRef.current = false;
      return;
    }
    if (revealTimeoutRef.current) {
      clearTimeout(revealTimeoutRef.current);
      revealTimeoutRef.current = null;
    }
    answeringRef.current = false;
    setScreen("loading");
    setCurrentWord(null);
    setDeprioritizedToday([]);
  }, [resetGeneration]);

  // Only ticks while the "done" card is actually on screen - no point
  // running a per-second interval the rest of the time.
  const [countdownMs, setCountdownMs] = useState(() =>
    Math.max(0, nextUTCDayBoundary() - Date.now()),
  );
  useEffect(() => {
    if (screen !== "done") return;
    // Captured once per "done" visit, not recomputed from "now" on every
    // tick - recomputing would silently roll over into a fresh ~24h
    // countdown for the *following* day the instant real time crosses this
    // boundary while the screen just sits open, instead of freezing at
    // 00:00:00 the way "come back tomorrow" should read once tomorrow's
    // actually arrived.
    const target = nextUTCDayBoundary();
    const tick = () => setCountdownMs(Math.max(0, target - Date.now()));
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [screen]);
  // Which calendar day attemptedToday/deprioritizedToday actually reflect.
  // Both are normally only refreshed by a reload or the swipe-down-on-done
  // gesture - if the app instead stays open and foregrounded straight
  // through midnight while a word just sits on screen, neither of those
  // fires, so acting on that word (skip or attempt) would otherwise get
  // appended onto yesterday's now-stale lists. ensureCurrentDay, called at
  // the top of every place the user acts on the current word, catches that:
  // if the real date has moved on since this was last checked, it resets
  // both lists first - same as a fresh reload would - so that action becomes
  // the first event of the new day instead.
  const trackedDayRef = useRef(todayISO());
  const ensureCurrentDay = useCallback(() => {
    const today = todayISO();
    if (trackedDayRef.current === today) return false;
    trackedDayRef.current = today;
    clearAttemptedToday();
    setDeprioritizedToday([]);
    return true;
  }, [clearAttemptedToday]);

  // Holds on the success checkmark next to the word briefly before moving on
  // - same pacing as the old center-screen animation, just without an
  // animation to hang the "advance" timing off of.
  useEffect(() => {
    if (screen !== "success") return;
    const timeout = setTimeout(() => advanceToNext(), 650);
    return () => clearTimeout(timeout);
  }, [screen]);

  // The one place every "here's the next word" path below funnels through -
  // resets everything scoped to a single attempt (typed sentence, failure
  // text, quiz selection) and decides this word's quiz mode/options fresh,
  // rather than each call site duplicating that. Also cancels any
  // definition-quiz reveal still pending from whatever word was on screen
  // before - see revealTimeoutRef's own comment for why that matters.
  const applyPickedEntry = useCallback((picked: CollectionEntry) => {
    if (revealTimeoutRef.current) {
      clearTimeout(revealTimeoutRef.current);
      revealTimeoutRef.current = null;
    }
    answeringRef.current = false;
    setCurrentWord(picked.word);
    setSentence("");
    setSelectedOption(null);
    const mode = choosePromptMode(picked);
    setPromptMode(mode);
    setQuizOptions(mode === "definition" ? buildQuizOptions(picked) : []);
  }, []);

  // Recompute screen state whenever data changes
  useEffect(() => {
    if (!loaded) {
      setScreen("loading");
      return;
    }
    if (entries.length === 0) {
      setScreen("empty");
      return;
    }
    // Don't yank the word away mid-verification/animation, or while the current
    // word is still a valid, unattempted pick. This intentionally does not
    // depend on attemptedToday/deprioritizedToday - a day rolling over (both
    // naturally emptying/resetting since they're scoped to "today") shouldn't
    // by itself change what's on screen; a fresh word is only picked when the
    // collection itself changes, or when there's genuinely no current word to
    // keep showing.
    if (screen === "verifying" || screen === "success" || screen === "error")
      return;

    const remaining = entriesByMastery.filter(
      (e) => !attemptedToday.includes(e.word),
    );

    if (remaining.length === 0) {
      setScreen("done");
      return;
    }
    if (
      screen === "active" &&
      currentWord &&
      remaining.some((e) => e.word === currentWord)
    )
      return;

    const picked = pickFromPool(
      entriesByMastery,
      attemptedToday,
      deprioritizedToday,
    );
    if (!picked) return;
    applyPickedEntry(picked);
    setScreen("active");
  }, [loaded, entriesByMastery, screen, currentWord, applyPickedEntry]);

  const currentEntry = entries.find((e) => e.word === currentWord) ?? null;

  const advanceToNext = useCallback(() => {
    const picked = pickFromPool(
      entriesByMastery,
      attemptedToday,
      deprioritizedToday,
    );
    if (!picked) {
      setScreen("done");
    } else {
      applyPickedEntry(picked);
      setScreen("active");
      inputRef.current?.focus();
    }
  }, [entriesByMastery, attemptedToday, deprioritizedToday, applyPickedEntry]);

  // Adds a word to today's deprioritized (skipped/wrong-answer) pile, purely
  // local - no learn_events row, nothing pushed. Idempotent, since a word can
  // reach this from both a swipe and a wrong answer in the same session.
  const deprioritizeWord = useCallback((word: string) => {
    setDeprioritizedToday((prev) =>
      prev.includes(word) ? prev : [...prev, word],
    );
  }, []);

  // Deprioritizes `word` and immediately moves on to whatever's next in the
  // pool, excluding it - shared by a wrong answer (sentence or definition
  // quiz) and a swipe-down skip, all of which need the exact same "don't
  // just re-show the word that was just wrong/skipped" handling. `isNewDay`
  // mirrors ensureCurrentDay's own return value: its caller already called
  // that first, and if it reset attemptedToday/deprioritizedToday, that
  // reset hasn't reached these closures yet (setState is async) - passing
  // it through here means empty arrays get used instead of the stale ones,
  // the same trick skipCurrentWord always used before this was factored out.
  const advancePastWord = useCallback(
    (word: string, isNewDay: boolean) => {
      deprioritizeWord(word);
      const baseAttempted = isNewDay ? [] : attemptedToday;
      const baseDeprioritized = isNewDay ? [] : deprioritizedToday;
      const nextDeprioritized = baseDeprioritized.includes(word)
        ? baseDeprioritized
        : [...baseDeprioritized, word];
      const picked = pickFromPool(
        entriesByMastery,
        baseAttempted,
        nextDeprioritized,
        word,
      );
      if (!picked) {
        setScreen("done");
        return;
      }
      applyPickedEntry(picked);
      setScreen("active");
    },
    [
      entriesByMastery,
      attemptedToday,
      deprioritizedToday,
      deprioritizeWord,
      applyPickedEntry,
    ],
  );

  const submit = async () => {
    if (!currentEntry || !sentence.trim() || screen === "verifying") return;
    setScreen("verifying");
    const word = currentEntry.word;
    const isNewDay = ensureCurrentDay();

    try {
      const result = await verifyWithClaude(word, sentence.trim());
      if (result.correct) {
        recordAttempt(word);
        recordSentence(word, sentence.trim());
        recordActivity();
        shiftMoodFromText(sentence.trim());
        setScreen("success");
      } else {
        shakeWord();
        revealTimeoutRef.current = setTimeout(() => {
          revealTimeoutRef.current = null;
          advancePastWord(word, isNewDay);
        }, SENTENCE_INCORRECT_SHAKE_MS);
      }
    } catch (e: unknown) {
      // Network-down specifically isn't a real verdict on this word - it
      // never actually got checked, so it doesn't go on the deprioritized
      // pile like a genuine wrong answer does. sentence is left as-is (not
      // cleared) - see returnToActiveFromError below for what picks this
      // back up once the connection's back.
      if (e instanceof Error && e.message === "network error") {
        setScreen("error");
        return;
      }
      advancePastWord(word, isNewDay);
    }
  };

  // Definition-quiz sibling of submit() above - no network call at all (the
  // "verifying" state doesn't apply here), just an instant local check
  // against currentEntry.definition. Locks out further taps immediately
  // (answeringRef's own comment explains why that's a ref, not just
  // selectedOption) and holds on the reveal animation - see
  // DefinitionOptionButton's own state-driven styling - before actually
  // moving on, same success/advancePastWord endpoints submit() uses.
  const submitDefinitionChoice = (choice: string) => {
    if (!currentEntry || screen !== "active" || answeringRef.current) return;
    answeringRef.current = true;
    const isNewDay = ensureCurrentDay();
    setSelectedOption(choice);
    const word = currentEntry.word;
    const isCorrect = choice === currentEntry.definition;

    if (isCorrect) {
      revealTimeoutRef.current = setTimeout(() => {
        revealTimeoutRef.current = null;
        recordAttempt(word);
        recordActivity();
        setScreen("success");
      }, DEFINITION_CORRECT_REVEAL_MS);
    } else {
      revealTimeoutRef.current = setTimeout(() => {
        revealTimeoutRef.current = null;
        advancePastWord(word, isNewDay);
      }, DEFINITION_INCORRECT_REVEAL_MS);
    }
  };

  // The error screen's own swipe-down handler - deliberately does NOT
  // re-attempt verification itself (that failed request is exactly what put
  // us on this screen in the first place, so silently resubmitting is just
  // guessing "is it back yet?"). Instead this just returns to the same word
  // with the same typed sentence still there (never cleared, see submit's
  // own catch above) and remounts the input - its autoFocus prop pops the
  // keyboard back up, same as a brand new word would - so the user decides
  // when to actually retry by hitting enter themselves.
  const returnToActiveFromError = () => {
    if (!currentEntry) return;
    setScreen("active");
  };

  const reloadRotation = useSharedValue(0);
  const reloadOpacity = useSharedValue(0);
  const reloadStyle = useAnimatedStyle(() => ({
    opacity: reloadOpacity.value,
    transform: [{ rotate: `${reloadRotation.value}deg` }],
  }));

  const jiggleY = useSharedValue(0);
  const jiggleStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: jiggleY.value }],
  }));

  // Same shake used for a wrong password on auth-screen.tsx and a duplicate
  // category name in collection.tsx - played on a wrong sentence usage,
  // right before advancePastWord moves on to the next word.
  const shakeX = useSharedValue(0);
  const shakeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: shakeX.value }],
  }));
  const shakeWord = () => {
    shakeX.value = withSequence(
      withTiming(-10, { duration: 45 }),
      withTiming(10, { duration: 45 }),
      withTiming(-8, { duration: 45 }),
      withTiming(8, { duration: 45 }),
      withTiming(0, { duration: 45 }),
    );
  };

  const playReloadAnimation = () => {
    reloadRotation.value = 0;
    reloadRotation.value = withTiming(360, {
      duration: 550,
      easing: Easing.out(Easing.cubic),
    });
    reloadOpacity.value = withSequence(
      withTiming(1, { duration: 120 }),
      withDelay(260, withTiming(0, { duration: 220 })),
    );
  };

  // Swipes the current word away without marking it attempted. It goes on
  // the deprioritized pile so it stays eligible - just pushed to the back
  // until every fresh word for today has been attempted. No context/DB call
  // at all anymore - purely local, same as a wrong answer - so this is just
  // advancePastWord with ensureCurrentDay called right beforehand, same as
  // submit/submitDefinitionChoice both do.
  const skipCurrentWord = useCallback(() => {
    if (!currentEntry) return;
    const word = currentEntry.word;
    const isNewDay = ensureCurrentDay();
    advancePastWord(word, isNewDay);
  }, [currentEntry, ensureCurrentDay, advancePastWord]);

  // Manual refresh from the "done" card - lets a swipe pick up an attempted
  // list that was silently cleared (e.g. midnight rolled over) without
  // waiting for some other trigger to notice. Awaits a fresh, narrow query
  // rather than trusting the attemptedToday closure, which only updates on
  // the next render, so it could still be stale from before midnight if the
  // app's been open continuously since. If it does look like a new day,
  // deprioritizedToday (never persisted, so there's no DB to re-check) just
  // gets cleared here too, alongside it - and clearAttemptedToday() clears
  // the actual context-level attemptedToday too, not just this function's
  // own local `fresh` copy. Skipping that was the bug behind "swipe down
  // shows a word for a blink, then flips right back to done": the very next
  // render, the "recompute screen state" effect below reruns (screen and
  // currentWord both just changed) and rederives `remaining` from
  // attemptedToday - if that's still the old, pre-midnight version (which
  // still lists every word as attempted, since "done" means everything was
  // completed), remaining comes back empty and instantly overwrites screen
  // back to "done" again, undoing the pick made two lines below.
  const refreshFromDone = useCallback(async () => {
    const fresh = await getTodaysActivity();
    if (fresh.attemptedToday.length !== 0) return;
    trackedDayRef.current = todayISO();
    clearAttemptedToday();
    setDeprioritizedToday([]);
    const picked = pickFromPool(entriesByMastery, fresh.attemptedToday, []);
    if (!picked) return;
    applyPickedEntry(picked);
    setScreen("active");
  }, [
    entriesByMastery,
    getTodaysActivity,
    applyPickedEntry,
    clearAttemptedToday,
  ]);

  const onSwipeDown = useCallback(() => {
    if (screen === "done") {
      refreshFromDone();
      playReloadAnimation();
    } else if (screen === "error") {
      returnToActiveFromError();
      playReloadAnimation();
    } else if (screen === "active" && selectedOption) {
      // Mid-reveal on a definition-quiz answer - the tap already happened,
      // just waiting on submitDefinitionChoice's own timeout to actually
      // transition the screen. Same "can't escape mid-check" rule sentence
      // mode already enforces during "verifying" (excluded from the swipe
      // condition below); a correct answer's recordAttempt/recordActivity
      // hasn't fired yet at this point; skipping away here would strand
      // that credit.
    } else if (screen === "active" && currentEntry) {
      skipCurrentWord();
      playReloadAnimation();
    }
  }, [screen, currentEntry, selectedOption, refreshFromDone, skipCurrentWord]);

  const DRAG_RESISTANCE = 0.28;

  const swipeDown = Gesture.Pan()
    .activeOffsetY(40)
    .failOffsetX([-15, 15])
    .onUpdate((e) => {
      jiggleY.value = Math.max(0, e.translationY) * DRAG_RESISTANCE;
    })
    .onEnd((e) => {
      const dragged = Math.max(0, e.translationY);
      jiggleY.value = withTiming(0, {
        duration: 220,
        easing: Easing.out(Easing.quad),
      });
      if (dragged > 80) {
        runOnJS(onSwipeDown)();
      }
    });

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <GestureDetector gesture={swipeDown}>
        <Animated.View
          style={[
            styles.container,
            { backgroundColor: theme.background },
            jiggleStyle,
          ]}
        >
          <Pressable
            style={[
              styles.inner,
              {
                paddingTop: insets.top + Spacing.four,
                paddingBottom: insets.bottom + Spacing.three,
              },
            ]}
            onPress={Keyboard.dismiss}
            accessible={false}
          >
            {screen === "loading" && (
              <View style={styles.centerContent}>
                <ActivityIndicator color={theme.textSecondary} />
              </View>
            )}

            {screen === "empty" && (
              <View style={styles.centerContent}>
                <Text
                  style={[styles.statusText, { color: theme.textSecondary }]}
                >
                  add words to collection and master them !!
                </Text>
              </View>
            )}

            {screen === "done" && (
              <View style={styles.centerContent}>
                <Text style={[styles.statusText, { color: theme.text }]}>
                  learn words again tomorrow! in {formatCountdown(countdownMs)} (utc time)
                </Text>
                <Text style={[styles.subText, { color: theme.textSecondary }]}>
                  (swipe down to refresh)
                </Text>
              </View>
            )}

            {/* Centered like "done" above, not tucked under the word like
                failure's reason text - this isn't a verdict on the current
                word, it's "the app can't reach anything right now". */}
            {screen === "error" && (
              <View style={styles.centerContent}>
                <Text style={[styles.statusText, { color: theme.text }]}>
                  please restore connection
                </Text>
                <Text style={[styles.subText, { color: theme.textSecondary }]}>
                  (swipe down to refresh)
                </Text>
              </View>
            )}

            {(screen === "active" ||
              screen === "verifying" ||
              screen === "success") &&
              currentEntry && (
                <Animated.View style={[styles.topContent, shakeStyle]}>
                  <View style={styles.wordSection}>
                    <Text
                      style={[styles.word, { color: theme.text }]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.4}
                    >
                      {currentEntry.word}
                    </Text>
                    {screen === "verifying" && (
                      <ActivityIndicator color={theme.textSecondary} />
                    )}
                    {(screen === "success" ||
                      // Definition mode: shows the instant the correct
                      // option is picked, same as the option's own
                      // highlight, rather than waiting out
                      // DEFINITION_CORRECT_REVEAL_MS for screen to actually
                      // flip to "success" - sentence mode is untouched, its
                      // checkmark still only ever comes from screen ===
                      // "success" (there's no separate "picked" moment to
                      // key off of there).
                      (promptMode === "definition" &&
                        selectedOption === currentEntry.definition)) && (
                      <Ionicons name="checkmark" size={20} color={theme.text} />
                    )}
                  </View>

                  {(screen === "active" ||
                    screen === "verifying" ||
                    screen === "success") &&
                    (promptMode === "sentence" ? (
                      <View style={styles.inputSection}>
                        <TextInput
                          ref={inputRef}
                          style={[
                            styles.input,
                            {
                              backgroundColor: theme.backgroundElement,
                              color: theme.text,
                            },
                          ]}
                          placeholderTextColor={theme.textSecondary}
                          value={sentence}
                          onChangeText={setSentence}
                          onSubmitEditing={submit}
                          placeholder={`use "${currentEntry.word}" in a sentence`}
                          multiline
                          scrollEnabled
                          maxLength={SENTENCE_MAX_LENGTH}
                          returnKeyType="done"
                          blurOnSubmit
                          autoFocus
                          autoCapitalize="sentences"
                          editable={screen !== "verifying"}
                        />
                      </View>
                    ) : (
                      <View style={styles.quizOptions}>
                        {quizOptions.map((option) => (
                          <DefinitionOptionButton
                            key={option}
                            text={option}
                            onPress={() => submitDefinitionChoice(option)}
                            disabled={selectedOption !== null}
                            state={
                              selectedOption === null
                                ? "idle"
                                : option === selectedOption
                                  ? selectedOption === currentEntry.definition
                                    ? "correct"
                                    : "incorrect"
                                  : // Wrong pick: leave every other option
                                    // alone (no dim) - the shake on the
                                    // tapped one is the only signal. Right
                                    // pick: dim the rest to draw focus to
                                    // the one that just darkened.
                                    selectedOption === currentEntry.definition
                                    ? "dim"
                                    : "idle"
                            }
                            textColor={theme.text}
                            idleColor={theme.backgroundElement}
                            correctColor={theme.backgroundSelected}
                          />
                        ))}
                      </View>
                    ))}
                </Animated.View>
              )}

            <Animated.View
              pointerEvents="none"
              style={[
                styles.reloadOverlay,
                { top: insets.top + Spacing.three },
                reloadStyle,
              ]}
            >
              <Ionicons name="refresh" size={28} color={theme.textSecondary} />
            </Animated.View>
          </Pressable>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  inner: {
    flex: 1,
    paddingHorizontal: Spacing.four,
  },
  reloadOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
  },
  topContent: {
    gap: Spacing.four,
  },
  centerContent: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: Spacing.two,
  },
  statusText: {
    fontSize: 20,
    fontFamily: Fonts?.mono,
    textAlign: "center",
  },
  subText: {
    fontSize: 14,
    fontFamily: Fonts?.mono,
    textAlign: "center",
  },
  wordSection: {
    marginTop: Spacing.six,
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing.three,
  },
  word: {
    fontSize: 42,
    fontWeight: "600",
    fontFamily: Fonts?.mono,
    flexShrink: 1,
  },
  inputSection: {
    gap: Spacing.two,
  },
  input: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
    fontSize: 16,
    fontFamily: Fonts?.mono,
    height: 200,
    textAlignVertical: "top",
  },
  quizOptions: {
    gap: Spacing.two,
  },
  quizOption: {
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.three,
  },
  quizOptionDim: {
    opacity: 0.45,
  },
  quizOptionText: {
    fontSize: 15,
    lineHeight: 21,
    fontFamily: Fonts?.mono,
  },
});
